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
import { bankProfileFileName } from "../statements/naming.js";
import { commitGuardedWrite, formatGuardReport, guardWrite } from "../statements/guarded-write.js";
import { ledgerPath as ledgerPathFor } from "../statements/ledgers.js";
import { loadRegistry } from "../statements/registry.js";
import {
  calendarPeriod, cutDayMismatch, isNearBoundary, parsePeriodLine, walletWindow,
} from "../statements/period.js";
import { chargesMismatch, parseDeclaredCharges } from "../statements/extraction.js";
import { describeIgnored } from "../statements/installments.js";
import { describeHeld, planWrites } from "../statements/write-policy.js";
import { toWalletRows } from "../statements/crossing.js";
import type { WalletRecord } from "../types.js";

const STATEMENT_MODEL = process.env.STATEMENT_CLAUDE_MODEL ?? "claude-sonnet-5";
/**
 * How far a statement row and a Wallet record may sit apart and still be the
 * same movement.
 *
 * Five, not three, and for the same reason as period.ts's BOUNDARY_DAYS: the
 * measured operation-to-posting lag reaches five days at Banamex. At three, a
 * purchase already recorded from its alert under the operation date failed to
 * match the statement's posting date, landed in `missing`, and --write booked
 * it again. The boundary heuristic was already flagging exactly those rows as
 * edge cases while the matcher refused to reach them.
 */
const DATE_SLACK_DAYS = 5;

interface Args {
  pdf: string;
  account: string;
  month: string; // YYYY-MM
  write: boolean;
  /** Reuse the stored extraction instead of running a new one. */
  fromLedger: boolean;
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
    throw new Error(
      "Uso: reconcile-statement.ts <pdf> --account <nombre> --month YYYY-MM [--write] [--from-ledger]"
    );
  }
  if (!fs.existsSync(pdf)) throw new Error(`No existe el PDF: ${pdf}`);
  return {
    pdf, account, month,
    write: argv.includes("--write"),
    fromLedger: argv.includes("--from-ledger"),
  };
}



function loadProfile(account: string): string {
  try {
    return fs.readFileSync(path.resolve("data/statements/profiles", bankProfileFileName(account)), "utf8");
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
    `Primero localiza el PERIODO que el propio estado declara (p.ej. "Periodo: 22 junio - 21 julio"). ` +
    `Extrae TODOS los movimientos de ESE periodo completo de la cuenta "${args.account}".\n` +
    `El periodo puede abarcar dos meses calendario: si empieza en junio y cierra en julio, los de junio ` +
    `TAMBIÉN van. NO recortes al mes ${args.month} — ese es solo la etiqueta del estado.\n\n` +
    `Emite un único bloque CSV:\n\n` +
    `<<<CSV>>>\n` +
    `date,account,amount,category,note,payee,opdate,meses,montooriginal\n` +
    `2026-07-05 12:00:00,${args.account},-123.45,Groceries,"[Claude reconcile ${args.month}]",COMERCIO XYZ,2026-07-04,,\n` +
    `<<<END>>>\n\n` +
    `Reglas:\n` +
    `- account SIEMPRE "${args.account}" (todas las filas).\n` +
    `- amount: negativo = cargo/gasto, positivo = abono/ingreso. Punto decimal, sin separador de miles.\n` +
    `- date: la fecha en que el movimiento SE CARGÓ (fecha de cargo/aplicación); si no hay hora usa 12:00:00.\n` +
    `- opdate: si el estado publica DOS fechas por movimiento (p.ej. "Fecha de la operación" junto a ` +
    `"Fecha de cargo"), pon aquí la de la operación en YYYY-MM-DD. Si solo hay una fecha, déjala vacía.\n` +
    `- note SIEMPRE exactamente "[Claude reconcile ${args.month}]".\n` +
    `- payee: el nombre del comercio tal como aparece.\n` +
    `- Asigna la categoría más razonable del catálogo. Pagos RECIBIDOS a la tarjeta (abonos "SU PAGO", "PAGO RECIBIDO") usa "Transfer, withdraw".\n` +
    `- INTERESES GANADOS: cada pago de intereses que el estado publique como movimiento es UN renglón, ` +
    `con la fecha en que se pagó. NO los sumes ni los agregues en uno solo: si el banco publica 23 pagos ` +
    `diarios, van 23 renglones. Categoría "Interests, dividends" (rendimientos que RECIBES).\n` +
    `- No la confundas con "Loan, interests", que son intereses que PAGAS por un crédito, ni con ` +
    `"Financial expenses" (comisiones).\n` +
    `- NO incluyas: los totales de intereses del resumen (el renglón "Intereses brutos" o similar es la ` +
    `SUMA de los pagos individuales, no un movimiento aparte), saldos, ni líneas informativas.\n` +
    `- Incluye comisiones y cargos del banco como movimientos ("Charges, Fees").\n` +
    `- COMPRAS A MESES: si el estado marca la parcialidad (Banamex escribe "004 de 006" en la línea del ` +
    `movimiento; Banorte "03/03" tras la descripción), copia ese marcador en la columna \`meses\` como ` +
    `"4/6". El \`amount\` sigue siendo lo cargado ESTE periodo, para que la suma cuadre.\n` +
    `- Si además es la PRIMERA parcialidad, busca el precio total de la compra en la sección de compras ` +
    `diferidas (columna "Original") y ponlo en \`montooriginal\`. Si no aparece, déjala vacía.\n` +
    `- No deduzcas la parcialidad de la descripción: un comercio que termina en "12/25" casi siempre es ` +
    `una fecha. Solo copia lo que el estado publique en su propia columna.\n\n` +
    `${CATALOG_PROMPT}\n\n` +
    `Al final, después del bloque CSV, agrega DOS líneas:\n` +
    `- "TOTAL_MOVIMIENTOS: <n>" con el número de filas.\n` +
    `- "PERIODO: <inicio>..<fin>" en YYYY-MM-DD, con el periodo que el propio estado declara ` +
    `(busca "Periodo", "Fecha de corte", "Fecha inicio/fin"). Cópialo del PDF; no lo deduzcas del nombre del archivo.\n` +    `- "CARGOS_DECLARADOS: <n>" con el total de cargos/compras del periodo TAL COMO lo declara el estado ` +
    `en su resumen (no lo sumes tú). Si el estado no da ese total, escribe "CARGOS_DECLARADOS: NA".\n` +
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
    // Either date may be the one Wallet holds: an alert fires when the purchase
    // happens, the statement books it when it posts, and for an instalment the
    // two are a month apart. Matching on the closest of the two is what keeps a
    // movement from reading as missing and being written a second time.
    const times = [Date.parse(row.date.replace(" ", "T"))];
    if (row.opdate) times.push(Date.parse(`${row.opdate}T12:00:00`));
    const candidates = inAccount.filter((r) => {
      if (r.amount !== amt || r.type !== type) return false;
      const rec = Date.parse(r.recordDate);
      return times.some((t) => Number.isFinite(t) && Math.abs(rec - t) <= DATE_SLACK_DAYS * 86_400_000);
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

/**
 * Everything after the rows exist: compare against Wallet, report, and — only
 * with --write — commit. Shared by the fresh-extraction path and the replay of
 * a stored ledger so an approved run cannot diverge from what was shown.
 */
interface ReconcileCtx {
  config: ReturnType<typeof loadBotConfig>;
  couch: ReturnType<typeof buildCouchClient>;
  lookup: ReturnType<typeof buildLookupMapsFromData>;
  userId: string;
  accountId: string;
}

async function reconcile(
  args: Args,
  ctx: ReconcileCtx,
  rows: CsvRow[],
  declared: { from: string; to: string } | null,
  chargeWarn: string | null
): Promise<void> {
  const { config, couch, lookup, accountId } = ctx;
  if (chargeWarn) {
    console.warn(`⚠️ Cuadre contra el estado: ${chargeWarn}.`);
    console.warn(`   NO uses --write hasta resolverlo: escribiría un mes incompleto.`);
  }

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
  const edge = d.missing.filter((r) => isNearBoundary(r.date.slice(0, 10), period));
  if (edge.length) {
    console.log(
      `📅 ${edge.length} de los faltantes caen al filo del periodo — puede que el banco los refleje ` +
        `en el estado del mes vecino. No son anomalía; se resuelven al cruzar el mes.`
    );
  }
  console.log(`👀 Solo en Wallet (no aparecen en el estado): ${d.walletOnly.length}`);
  for (const w of d.walletOnly) console.log(`   ${w.recordDate.slice(0, 10)} $${(w.amount / 100) * (w.type === 1 ? -1 : 1)} ${w.payee ?? w.note ?? ""}`);

  // A purchase in instalments is recorded once, for its full price, in the
  // month it was bought; the monthly instalments are ignored. They were still
  // extracted and still counted toward the arithmetic above — dropping them
  // earlier would make the extraction stop adding up against the statement's
  // own totals and trip the check that guards the write.
  // A transfer leg waits for the month's crossing to find its other half; a
  // purchase or an interest payment exists on one statement only and nothing
  // still in the post can duplicate it.
  // Wallet's own records for the window are the counterparts already known;
  // a candidate that one of them answers is not ours to write yet.
  const otherAccounts: Record<string, string> = {};
  for (const [name, id] of Object.entries(lookup.accounts)) otherAccounts[id] = name;
  const elsewhere = toWalletRows(existing, otherAccounts, lookup.transferCategoryId ?? undefined)
    .filter((r) => r.account !== args.account);

  const { now: writable, held, heldReasons, ignored } = planWrites(d.missing, {
    account: args.account,
    elsewhere,
  });
  if (held.length > 0) {
    console.log(`⏸️ ${held.length} en espera del cruce del mes:`);
    console.log(describeHeld(held, heldReasons).split("\n").map((l) => `   ${l}`).join("\n"));
  }
  if (ignored.length > 0) {
    console.log(`🔁 ${ignored.length} parcialidad(es) de compras a meses, ignoradas a propósito:`);
    console.log(describeIgnored(ignored).split("\n").map((l) => `   ${l}`).join("\n"));
  }
  for (const r of writable.filter((x) => x.montooriginal && x.meses)) {
    console.log(`🧾 Compra a meses ${r.meses} — se registra completa por $${r.amount}, no la parcialidad.`);
  }

  if (!args.write) {
    console.log(
      `\nDry — nada escrito en Wallet. Con --write se agregarían ${writable.length}` +
        (held.length ? `; ${held.length} espera(n) al cruce` : "") + `.`
    );
    return;
  }

  if (chargeWarn) {
    throw new Error(
      `El extracto no cuadra contra los totales del estado (${chargeWarn}). ` +
        `--write escribiría un mes incompleto; corrige la extracción primero.`
    );
  }

  // ── Write missing (unambiguous only) ──
  // Through the safeguards, not around them. This was the only write path that
  // called writeRecords directly: no dedup against what Wallet already holds
  // and no integrity pass over what it was about to post, on the one path that
  // writes a whole month at a time. It also closes the instalment gap — dedup
  // now runs on the amount that will actually be posted rather than on the
  // instalment figure the diff matched.
  let skippedRows = 0;
  let blocked = false;
  if (writable.length > 0) {
    const guard = await guardWrite(writable, { lookup, existing });
    skippedRows = guard.skipped.length;
    blocked = guard.blocked;
    const report = formatGuardReport(guard);
    if (report.trim()) console.log(report);
    if (guard.blocked) {
      console.error(`\n⛔ No se escribe nada: la verificación de integridad levantó alerta(s).`);
    } else if (guard.records.length > 0) {
      await commitGuardedWrite(guard, { lookup, existing, couch, userId: ctx.userId });
      console.log(`\n✍️ Escritos ${guard.records.length} registro(s) con nota [Claude reconcile ${args.month}].`);
    } else {
      console.log(`\nNada que escribir después del dedup.`);
    }
  }
  // A month with rows still waiting for the crossing is not reconciled. Marking
  // it anyway turned /statements green while its transfer legs were unwritten.
  // Anything unresolved leaves the month open. Marking it on `held` alone let
  // ambiguous rows and rows the converter refused vanish into a month the
  // registry then never chased again.
  const unresolved = held.length + d.ambiguous.length + skippedRows;
  if (unresolved === 0 && !blocked) {
    markReceived(args.account, args.month);
  } else {
    console.log(
      `↩️ ${args.account} · ${args.month} NO se marca conciliado: ` +
        `${held.length} en espera, ${d.ambiguous.length} ambiguo(s), ${skippedRows} sin convertir` +
        (blocked ? ", integridad bloqueó la escritura" : "") + "."
    );
  }

  // The PDF has served its purpose — unless something in it is still unresolved.
  // A skipped row counts as unresolved: a lone transfer leg (a card payment
  // whose other side lives in another account) is refused by design, and it is
  // the PDF you go back to when you come to pair it.
  // Held rows count as unresolved: the PDF is what you come back to when the
  // month is crossed. Before the write-policy refactor a held transfer leg
  // arrived here as a `skipped` row and kept the PDF by accident; now it does
  // not reach convertRows at all, so it has to be counted explicitly.
  const retired = retireStatement(args.pdf, d.ambiguous.length + skippedRows + held.length);
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

async function main() {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  const config = loadBotConfig();
  const credentials = loadDirectCredentials();
  const couch = buildCouchClient(credentials.replication);
  const lookup = buildLookupMapsFromData(await fetchLookupData(couch));

  const accountId = lookup.accounts[args.account];
  if (!accountId) throw new Error(`Cuenta desconocida: "${args.account}"`);
  const ctx: ReconcileCtx = { config, couch, lookup, userId: credentials.userId, accountId };

  console.log(`\n── reconcile-statement ── ${args.account} · ${args.month} · ${args.write ? "WRITE" : "dry"} · model=${STATEMENT_MODEL}\n`);

  // ledgerPath(), not concatenation: the hand-built copy is how the writer and
  // the reader drifted apart in the first place.
  const ledgerPath = ledgerPathFor(args.account, args.month);

  // ── Reuse a stored extraction ──
  // The approve-then-write flow runs this twice, and a second extraction is not
  // guaranteed to produce the first one's rows. What the user approved is what
  // must be written, so the write pass replays the ledger instead of re-reading
  // the PDF — cheaper, and it removes a whole class of "that is not what I saw".
  if (args.fromLedger) {
    if (!fs.existsSync(ledgerPath)) {
      throw new Error(`No hay extracción guardada en ${ledgerPath}. Corre primero sin --from-ledger.`);
    }
    const stored = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as {
      rows: CsvRow[]; period: { from: string; to: string } | null; chargesDeclared?: number | null;
    };
    console.log(`Reutilizando la extracción guardada: ${stored.rows.length} movimiento(s) de ${ledgerPath}`);
    await reconcile(args, ctx, stored.rows, stored.period, chargesMismatch(stored.rows, stored.chargesDeclared ?? null));
    return;
  }

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

  // The row count is self-reported and stays consistent when a movement is
  // dropped. The statement's own totals are the only figure the extractor
  // cannot satisfy by being self-consistent.
  const chargeWarn = chargesMismatch(rows, parseDeclaredCharges(result.text));
  const declared = parsePeriodLine(result.text);

  // ── Persist normalized statement ledger ──
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify({
    account: args.account, month: args.month, extractedAt: new Date().toISOString(),
    period: declared,
    chargesDeclared: parseDeclaredCharges(result.text),
    sourcePdf: path.basename(args.pdf), rows,
  }, null, 2));
  console.log(`Ledger del estado: ${ledgerPath}`);

  await reconcile(args, ctx, rows, declared, chargeWarn);

}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
