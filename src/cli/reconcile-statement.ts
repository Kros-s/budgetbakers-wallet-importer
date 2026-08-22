/**
 * Statement reconciliation (M4): extract a bank statement PDF, diff it
 * against real Wallet records, and close the month.
 *
 *   npx tsx src/cli/reconcile-statement.ts <pdf> --account Costco --month 2026-07
 *   npx tsx src/cli/reconcile-statement.ts <pdf> --account Costco --month 2026-07 --write
 *
 * Default is a DRY diff (writes only the normalized statement ledger).
 * --write commits the unambiguous missing transactions to Wallet with note
 * "[Claude reconcile YYYY-MM]" and reports to Telegram; ambiguous ones are
 * always listed for manual follow-up (statements are the source of truth —
 * email alerts only cover some banks).
 *
 * Extraction runs on Sonnet (statements are the hard case — formats change
 * per bank) with the per-bank profile from data/statements/profiles/<bank>.md
 * prepended when it exists. Each run is a fresh isolated session.
 */
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { Telegraf } from "telegraf";

import { loadEnvLocal } from "../env.js";
import { loadBotConfig } from "../bot/config.js";
import { runClaude } from "../bot/claude-runner.js";
import { extractCsvBlock } from "../bot/handlers.js";
import { sendSafeMessage } from "../bot/telegram-safe.js";
import { buildCouchClient, buildLookupMapsFromData, fetchLookupData } from "../couch.js";
import { loadDirectCredentials } from "../direct-auth.js";
import { convertRows, parseCsv, rowsToCsv } from "../csv.js";
import type { CsvRow } from "../csv.js";
import { listRecordsByDateRange, writeRecords } from "../records.js";
import { CATALOG_PROMPT } from "../webhook/email-processor.js";
import { markReceived } from "../statements/registry.js";
import { retireStatement } from "../statements/inbox.js";
import { loadRegistry } from "../statements/registry.js";
import { calendarPeriod, cutDayMismatch, parsePeriodLine, walletWindow } from "../statements/period.js";
import type { WalletRecord } from "../types.js";

const STATEMENT_MODEL = process.env.STATEMENT_CLAUDE_MODEL ?? "claude-sonnet-5";
const DATE_SLACK_DAYS = 3;

interface Args {
  pdf: string;
  account: string;
  month: string; // YYYY-MM
  write: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const pdf = argv[0] && !argv[0].startsWith("--") ? path.resolve(argv[0]) : undefined;
  const account = get("--account");
  const month = get("--month");
  if (!pdf || !account || !month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error("Uso: reconcile-statement.ts <pdf> --account <nombre> --month YYYY-MM [--write]");
  }
  if (!fs.existsSync(pdf)) throw new Error(`No existe el PDF: ${pdf}`);
  return { pdf, account, month, write: argv.includes("--write") };
}

function profileSlug(account: string): string {
  return account.toLowerCase().replace(/\s+/g, "-");
}

function loadProfile(account: string): string {
  try {
    return fs.readFileSync(path.resolve(`data/statements/profiles/${profileSlug(account)}.md`), "utf8");
  } catch {
    return "";
  }
}

function buildExtractionPrompt(args: Args, profile: string): string {
  const profileSection = profile
    ? `Perfil de este banco (trucos de formato aprendidos — respétalos):\n${profile}\n\n`
    : "";
  return (
    `${profileSection}Lee el estado de cuenta PDF en ${args.pdf} usando la herramienta Read ` +
    `(usa el parámetro pages en tandas si es largo; asegúrate de cubrir TODAS las páginas con movimientos).\n\n` +
    `Extrae TODOS los movimientos del periodo ${args.month} de la cuenta "${args.account}" y emite un único bloque CSV:\n\n` +
    `<<<CSV>>>\n` +
    `date,account,amount,category,note,payee\n` +
    `2026-07-05 12:00:00,${args.account},-123.45,Groceries,"[Claude reconcile ${args.month}]",COMERCIO XYZ\n` +
    `<<<END>>>\n\n` +
    `Reglas:\n` +
    `- account SIEMPRE "${args.account}" (todas las filas).\n` +
    `- amount: negativo = cargo/gasto, positivo = abono/ingreso. Punto decimal, sin separador de miles.\n` +
    `- date: fecha del movimiento según el estado; si no hay hora usa 12:00:00.\n` +
    `- note SIEMPRE exactamente "[Claude reconcile ${args.month}]".\n` +
    `- payee: el nombre del comercio tal como aparece.\n` +
    `- Asigna la categoría más razonable del catálogo. Pagos RECIBIDOS a la tarjeta (abonos "SU PAGO", "PAGO RECIBIDO") usa "Transfer, withdraw".\n` +
    `- NO incluyas: intereses resumidos sin movimiento, saldos, totales, ni líneas informativas.\n` +
    `- Incluye comisiones y cargos del banco como movimientos ("Charges, Fees").\n\n` +
    `${CATALOG_PROMPT}\n\n` +
    `Al final, después del bloque CSV, agrega DOS líneas:\n` +
    `- "TOTAL_MOVIMIENTOS: <n>" con el número de filas.\n` +
    `- "PERIODO: <inicio>..<fin>" en YYYY-MM-DD, con el periodo que el propio estado declara ` +
    `(busca "Periodo", "Fecha de corte", "Fecha inicio/fin"). Cópialo del PDF; no lo deduzcas del nombre del archivo.\n` +
    `Si el PDF no se puede leer (protegido/corrupto), responde solo: PDF_UNREADABLE`
  );
}

interface DiffResult {
  missing: CsvRow[];        // in statement, not in Wallet → candidates to write
  matched: number;
  ambiguous: { row: CsvRow; reason: string }[];
  walletOnly: WalletRecord[]; // in Wallet (this account/month), not in statement
}

function diff(rows: CsvRow[], existing: WalletRecord[], accountId: string): DiffResult {
  const inAccount = existing.filter((r) => r.accountId === accountId);
  const usedRecordIds = new Set<string>();
  const missing: CsvRow[] = [];
  const ambiguous: { row: CsvRow; reason: string }[] = [];
  let matched = 0;

  for (const row of rows) {
    const amt = Math.round(Math.abs(parseFloat(row.amount)) * 100);
    const type = parseFloat(row.amount) < 0 ? 1 : 0;
    const rowTime = Date.parse(row.date.replace(" ", "T"));
    const candidates = inAccount.filter((r) => {
      if (r.amount !== amt || r.type !== type) return false;
      const dt = Math.abs(Date.parse(r.recordDate) - rowTime);
      return dt <= DATE_SLACK_DAYS * 86_400_000;
    });
    const free = candidates.filter((c) => !usedRecordIds.has(c._id!));
    if (free.length === 1) {
      usedRecordIds.add(free[0]._id!);
      matched++;
    } else if (free.length > 1) {
      usedRecordIds.add(free[0]._id!);
      matched++;
      ambiguous.push({ row, reason: `${free.length} registros candidatos con mismo monto/fecha — revisar duplicados en Wallet` });
    } else if (candidates.length > 0) {
      ambiguous.push({ row, reason: "el registro de Wallet que coincide ya casó con otra línea del estado — posible cargo repetido" });
    } else {
      missing.push(row);
    }
  }

  const walletOnly = inAccount.filter((r) => !usedRecordIds.has(r._id!));
  return { missing, matched, ambiguous, walletOnly };
}

async function main() {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  const config = loadBotConfig();
  const credentials = loadDirectCredentials();
  const couch = buildCouchClient(credentials.replication);
  const lookupData = await fetchLookupData(couch);
  const lookup = buildLookupMapsFromData(lookupData);

  const accountId = lookup.accounts[args.account];
  if (!accountId) throw new Error(`Cuenta desconocida: "${args.account}"`);

  console.log(`\n── reconcile-statement ── ${args.account} · ${args.month} · ${args.write ? "WRITE" : "dry"} · model=${STATEMENT_MODEL}\n`);

  // ── Extract (fresh isolated Sonnet session; Read tool only) ──
  const profile = loadProfile(args.account);
  const result = await runClaude({
    config,
    sessionId: uuidv4(),
    isFirstTurn: true,
    prompt: buildExtractionPrompt(args, profile),
    allowedTools: ["Read"],
    timeoutMs: 600_000,
    model: STATEMENT_MODEL,
  });
  if (!result.ok) throw new Error(`Claude error: ${result.text.slice(0, 300)}`);
  if (result.text.includes("PDF_UNREADABLE")) {
    throw new Error("Claude no pudo leer el PDF (¿protegido con contraseña? desprotégelo primero, p.ej. qpdf --decrypt).");
  }
  const { csv } = extractCsvBlock(result.text);
  if (!csv) throw new Error(`Sin bloque CSV en la respuesta:\n${result.text.slice(0, 400)}`);
  const rows = parseCsv(csv);
  const claimed = /TOTAL_MOVIMIENTOS:\s*(\d+)/.exec(result.text)?.[1];
  console.log(`Extraídos ${rows.length} movimiento(s)${claimed ? ` (Claude declara ${claimed})` : ""}.`);
  if (claimed && Number(claimed) !== rows.length) {
    console.warn(`⚠️ El conteo declarado (${claimed}) no coincide con las filas (${rows.length}) — revisar extracción.`);
  }

  const declared = parsePeriodLine(result.text);

  // ── Persist normalized statement ledger ──
  const ledgerPath = path.resolve(`data/statements/ledger-${profileSlug(args.account)}-${args.month}.json`);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify({
    account: args.account, month: args.month, extractedAt: new Date().toISOString(),
    period: declared,
    sourcePdf: path.basename(args.pdf), rows,
  }, null, 2));
  console.log(`Ledger del estado: ${ledgerPath}`);

  // ── Diff vs Wallet ──
  // The window follows the statement's own period. Using the calendar month
  // instead left a mid-month cut comparing against records it never covered,
  // and every unmatched row was a duplicate waiting for --write.
  if (!declared) {
    console.warn(
      `⚠️ El estado no declaró su periodo — se compara contra el mes calendario ${args.month}. ` +
        `Si esta cuenta corta a media mes, revisa el diff con cuidado antes de --write.`
    );
  }
  const period = declared ?? calendarPeriod(args.month);
  console.log(`Periodo del estado: ${period.from} → ${period.to}${declared ? "" : " (supuesto)"}`);

  const cutDay = loadRegistry()[args.account]?.cutDay;
  if (declared && cutDay !== undefined) {
    const warn = cutDayMismatch(period, cutDay);
    if (warn) console.warn(`⚠️ ${warn}`);
  }

  const { from, to } = walletWindow(period, DATE_SLACK_DAYS);
  const existing = await listRecordsByDateRange(couch, from, to);
  const d = diff(rows, existing, accountId);

  console.log(`\n✅ Ya en Wallet: ${d.matched}`);
  console.log(`➕ Faltantes (se agregarían): ${d.missing.length}`);
  for (const r of d.missing) console.log(`   ${r.date.slice(0, 10)} $${r.amount} ${r.payee || ""} (${r.category})`);
  console.log(`⚠️ Ambiguos (revisar a mano): ${d.ambiguous.length}`);
  for (const a of d.ambiguous) console.log(`   ${a.row.date.slice(0, 10)} $${a.row.amount} ${a.row.payee || ""} — ${a.reason}`);
  console.log(`👀 Solo en Wallet (no aparecen en el estado): ${d.walletOnly.length}`);
  for (const w of d.walletOnly) console.log(`   ${w.recordDate.slice(0, 10)} $${(w.amount / 100) * (w.type === 1 ? -1 : 1)} ${w.payee ?? w.note ?? ""}`);

  if (!args.write) {
    console.log(`\nDry — nada escrito en Wallet. Repite con --write para agregar los ${d.missing.length} faltantes.`);
    return;
  }

  // ── Write missing (unambiguous only) ──
  if (d.missing.length > 0) {
    const { records, skipped } = convertRows(d.missing, lookup);
    if (skipped.length > 0) {
      console.warn(`⚠️ ${skipped.length} fila(s) no convirtieron y NO se escriben: ${skipped.map((s) => s.reason).join("; ")}`);
    }
    if (records.length > 0) {
      await writeRecords(couch, credentials.userId, records);
      console.log(`\n✍️ Escritos ${records.length} registro(s) con nota [Claude reconcile ${args.month}].`);
    }
  }
  markReceived(args.account, args.month);

  // The PDF has served its purpose — unless something in it is still unresolved.
  const retired = retireStatement(args.pdf, d.ambiguous.length);
  console.log(retired.removed ? `🗑️ PDF retirado: ${retired.reason}.` : `📎 PDF conservado: ${retired.reason}.`);

  const bot = new Telegraf(config.telegramBotToken);
  const chatId = [...config.allowedChatIds][0];
  const msg =
    `📄 *Reconciliación ${args.account} · ${args.month}*\n` +
    `✅ Ya registrados: ${d.matched}\n` +
    `➕ Agregados del estado: ${d.missing.length}\n` +
    (d.ambiguous.length ? `⚠️ Ambiguos por revisar: ${d.ambiguous.length}\n` : "") +
    (d.walletOnly.length ? `👀 Solo en Wallet (verifica: efectivo/otros): ${d.walletOnly.length}\n` : "") +
    (d.missing.length ? `\n\`\`\`\n${rowsToCsv(d.missing).slice(0, 1500)}\n\`\`\`` : "");
  await sendSafeMessage(bot.telegram, chatId, msg);
  console.log("Resumen enviado a Telegram.");
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
