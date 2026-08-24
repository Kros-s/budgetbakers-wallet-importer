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
import {
  DATE_SLACK_DAYS, diff, mayMarkReconciled, unresolvedCount,
} from "../statements/reconcile-core.js";
import { commitGuardedWrite, formatGuardReport, guardWrite } from "../statements/guarded-write.js";
import { ledgerPath as ledgerPathFor, loadLedger } from "../statements/ledgers.js";
import { addMonths, loadRegistry } from "../statements/registry.js";
import {
  calendarPeriod, cutDayMismatch, isNearBoundary, parsePeriodLine, walletWindow,
} from "../statements/period.js";
import { parseDeclaredCharges, parseDeclaredNet, weighTotals } from "../statements/extraction.js";
import { describeIgnored } from "../statements/installments.js";
import { describeCash } from "../statements/cash.js";
import { describeSplice, loadCardDetail, spliceCardDetail } from "../statements/card-detail.js";
import type { ExtractionVerdict } from "../statements/extraction.js";
import { describeHeld, planWrites } from "../statements/write-policy.js";
import { type LedgerRow, toLedgerRows, toWalletRows } from "../statements/crossing.js";
import type { WalletRecord } from "../types.js";

const STATEMENT_MODEL = process.env.STATEMENT_CLAUDE_MODEL ?? "claude-sonnet-5";

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



/**
 * Every other account's statement around this month, in the crossing's shape.
 *
 * A statement is read one at a time, but a transfer is not: its other leg is in
 * a document that may already be on disk and not yet in Wallet. Reading the
 * siblings costs a few file reads and turns "write this now" into "wait for the
 * crossing" exactly where it should.
 *
 * The neighbouring months are read too, and that is not caution — it is the
 * only way the pair can be found. A month label is not a date range: FinSus
 * sent $10,155.21 to Bancomer on 22-jun, which is in FinSus's JUNE statement
 * and in Bancomer's JULY one, because Bancomer cuts on the 16th. Reading only
 * the matching label left each leg looking for a counterpart that was on disk
 * the whole time, one file over.
 */
function siblingLedgerRows(account: string, month: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const months = [addMonths(month, -1), month, addMonths(month, 1)];
  for (const other of Object.keys(loadRegistry())) {
    if (other === account) continue;
    for (const m of months) {
      const led = loadLedger(other, m);
      if (led) rows.push(...toLedgerRows(other, led.rows));
    }
  }
  return rows;
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
    `date,account,amount,category,note,payee,opdate,meses,montooriginal,desc,mxn,efectivo\n` +
    `2026-07-05 12:00:00,${args.account},-123.45,Groceries,"[Claude reconcile ${args.month}]",COMERCIO XYZ,2026-07-04,,,"COMPRA COMERCIO XYZ REF 998",,\n` +
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
    `- BOLSAS INTERNAS: si el estado divide la cuenta en varias bolsas (p.ej. Klar tiene "Cuenta ` +
    `Principal", "Apartados de inversión", "Plazo Fijo"), un movimiento ENTRE ellas NO mueve la cuenta y ` +
    `NO se extrae — el dinero sigue en la misma institución. Ejemplo real: un "Monto Invertido" de ` +
    `$210,000 que va del plazo fijo a la cuenta principal netea a cero. Extrae solo lo que cambia el ` +
    `TOTAL: rendimientos, comisiones, impuestos, y el dinero que entra o sale de la institución.\n` +
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
    `una fecha. Solo copia lo que el estado publique en su propia columna.\n` +
    `- desc: la descripción COMPLETA del movimiento tal como la imprime el estado, incluyendo el bloque ` +
    `de referencia que va debajo (concepto, CLABE, nombre del ordenante). Ejemplo real de BBVA: ` +
    `"SPEI RECIBIDO ARCUS FI 6062885Sent from ARQ Referencia 0194292099 706 00706180105819089043 ` +
    `PIER 5, S.A de C.V.". En una sola línea, entre comillas. Es lo único que identifica a la ` +
    `contraparte: sin ella un traspaso desde otra cuenta del usuario se registra como ingreso.\n` +
    `- mxn: SOLO si la cuenta está en otra moneda y el estado publica además el equivalente en pesos ` +
    `(DolarApp imprime "Venta USDc -9,300 | MXN | -163,202.91"). Pon ahí el equivalente en MXN; el ` +
    `\`amount\` sigue en la moneda de la cuenta. Si el estado no publica un equivalente en pesos para ` +
    `ese movimiento, déjala VACÍA — no la calcules tú con un tipo de cambio.\n` +
    `- efectivo: pon "1" cuando el movimiento sea dinero en efectivo SALIENDO de la cuenta — retiro en ` +
    `cajero, "RETIRO SIN TARJETA", "DISPOSICION DE EFECTIVO", retiro por QR. Vacía en cualquier otro ` +
    `caso. No la uses para pagos con tarjeta ni para transferencias.\n\n` +
    `${CATALOG_PROMPT}\n\n` +
    `Al final, después del bloque CSV, agrega DOS líneas:\n` +
    `- "TOTAL_MOVIMIENTOS: <n>" con el número de filas.\n` +
    `- "PERIODO: <inicio>..<fin>" en YYYY-MM-DD, con el periodo que el propio estado declara ` +
    `(busca "Periodo", "Fecha de corte", "Fecha inicio/fin"). Cópialo del PDF; no lo deduzcas del nombre del archivo.\n` +    `- "CARGOS_DECLARADOS: <n>" con el total de cargos/compras del periodo TAL COMO lo declara el estado ` +
    `en su resumen (no lo sumes tú). Si el estado no da ese total, escribe "CARGOS_DECLARADOS: NA".\n` +
    `- "SALDO_INICIAL: <n>" y "SALDO_FINAL: <n>" con el saldo TOTAL de la cuenta al abrir y al cerrar el ` +
    `periodo. Si el estado tiene varias bolsas internas (cuenta principal, apartados, plazo fijo, ` +
    `depósito garantizado), SUMA todas: es el saldo de la cuenta completa. "NA" si no lo declara.\n` +
    `- EN UNA TARJETA DE CRÉDITO el saldo es lo que DEBES, así que va en NEGATIVO: SALDO_INICIAL es ` +
    `"Adeudo del periodo anterior" con signo menos y SALDO_FINAL es el "Saldo deudor total" (o "Saldo ` +
    `al corte") también con signo menos. Ejemplo real de Banorte: adeudo anterior $21,823.19 y saldo ` +
    `deudor $32,453.04 se escriben SALDO_INICIAL: -21823.19 y SALDO_FINAL: -32453.04, y lo extraído ` +
    `(50 cargos menos 3 pagos) suma exactamente esa diferencia. NUNCA los pongas en positivo: eso ` +
    `invertiría el cuadre y lo daría por bueno al revés.\n` +
    `- Si una tarjeta imprime "Saldo deudor total: $0.00" pero en el mismo bloque declara un ` +
    `"Pago para no generar intereses" o un "Saldo cargos regulares" distinto de cero, el $0.00 es un ` +
    `error del propio estado: usa esa otra cifra como SALDO_FINAL. Nu lo hace todos los meses — ` +
    `imprime "Saldo deudor total $0.00" junto a "Saldo cargos regulares $1,738.56" y un crédito ` +
    `disponible de $138,261.44 sobre una línea de $140,000, que solo cuadra con los $1,738.56.\n` +
    `Si el PDF no se puede leer (protegido/corrupto), responde solo: PDF_UNREADABLE`
  );
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
  totals: ExtractionVerdict
): Promise<void> {
  const { config, couch, lookup, accountId } = ctx;
  if (totals.blocking) {
    console.warn(`⚠️ Cuadre contra el estado: ${totals.blocking}.`);
    console.warn(`   NO uses --write hasta resolverlo: escribiría un mes incompleto.`);
  } else if (totals.note) {
    console.log(`ℹ️ ${totals.note}.`);
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
  // "Faltan en Wallet", not "se agregarían": what is written comes out of this
  // list further down, after held legs, ignored instalments and rows the guard
  // answers are removed. The old label promised a number no run produced.
  console.log(`➕ Faltan en Wallet: ${d.missing.length}`);
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
  if (d.grouped.length) {
    console.log(
      `🧮 ${d.grouped.length} movimiento(s) que el estado desglosa y Wallet tiene netos — ya registrados:`
    );
    for (const g of d.grouped) {
      const net = ((g.record.amount / 100) * (g.record.type === 1 ? -1 : 1)).toFixed(2);
      const parts = g.rows.map((r) => `$${r.amount} ${r.payee || ""}`.trim()).join(" + ");
      console.log(`   ${g.record.recordDate.slice(0, 10)} $${net} en Wallet = ${parts}`);
    }
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
  // Wallet's records, plus the OTHER statements already extracted for this
  // month. Wallet alone was not enough: Mercado Pago's July pays $3,268.48 to
  // the Meli card and Meli's own July ledger holds the matching +$3,268.48,
  // but neither is in Wallet yet — so the leg sailed through as an ordinary
  // expense and would have been booked twice, once from each statement.
  const elsewhere = [
    ...toWalletRows(existing, otherAccounts, lookup.transferCategoryId ?? undefined),
    ...siblingLedgerRows(args.account, args.month),
  ].filter((r) => r.account !== args.account);

  const { now: writable, held, heldReasons, ignored, cash } = planWrites(d.missing, {
    account: args.account,
    elsewhere,
    ledger: rows,
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

  if (cash.length > 0) {
    console.log(`💵 ${cash.length} retiro(s) de efectivo — se registran como traspaso a la cuenta de efectivo:`);
    console.log(describeCash(cash).split("\n").map((l) => `   ${l}`).join("\n"));
  }

  if (!args.write) {
    // The same guard the write runs, reporting only. A dry run that says
    // nothing about duplicates or integrity is a preview of a different
    // decision from the one --write will make, and the alerts it raises — three
    // arrivals from DolarApp booked as $285,876.01 of income — are worth
    // reading before the flag goes on, not after.
    if (writable.length > 0) {
      const preview = await guardWrite(writable, { lookup, existing, ledger: rows });
      const report = formatGuardReport(preview);
      if (report.trim()) console.log(`\n${report}`);
    }
    console.log(
      `\nDry — nada escrito en Wallet. Con --write se agregarían ${writable.length}` +
        (held.length ? `; ${held.length} espera(n) al cruce` : "") + `.`
    );
    return;
  }

  if (totals.blocking) {
    throw new Error(
      `El extracto no cuadra contra los totales del estado (${totals.blocking}). ` +
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
  // What actually reached Wallet, which is not what the diff found: held legs,
  // ignored instalments and rows the dedup answered all come out in between,
  // and cash withdrawals go in as two. Reporting `missing.length` told the user
  // a number no run had produced.
  let written = 0;
  if (writable.length > 0) {
    const guard = await guardWrite(writable, { lookup, existing, ledger: rows });
    skippedRows = guard.skipped.length;
    blocked = guard.blocked;
    const report = formatGuardReport(guard);
    if (report.trim()) console.log(report);
    if (guard.blocked) {
      console.error(`\n⛔ No se escribe nada: la verificación de integridad levantó alerta(s).`);
    } else if (guard.records.length > 0) {
      await commitGuardedWrite(guard, { lookup, existing, ledger: rows, couch, userId: ctx.userId });
      written = guard.records.length;
      console.log(`\n✍️ Escritos ${written} registro(s) con nota [Claude reconcile ${args.month}].`);
    } else {
      console.log(`\nNada que escribir después del dedup.`);
    }
  }
  // A month with rows still waiting for the crossing is not reconciled. Marking
  // it anyway turned /statements green while its transfer legs were unwritten.
  // Anything unresolved leaves the month open. Marking it on `held` alone let
  // ambiguous rows and rows the converter refused vanish into a month the
  // registry then never chased again.
  const outstanding = { held: held.length, ambiguous: d.ambiguous.length, skipped: skippedRows, blocked };
  if (mayMarkReconciled(outstanding)) {
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
  // A blocked run counts as unresolved too: it wrote nothing and left the month
  // open, and the PDF is exactly what you need to run it again. Without this it
  // was thrown away on the one outcome that guarantees you will come back to it.
  const retired = retireStatement(args.pdf, unresolvedCount(outstanding) + (blocked ? 1 : 0));
  console.log(retired.removed ? `🗑️ PDF retirado: ${retired.reason}.` : `📎 PDF conservado: ${retired.reason}.`);

  const bot = new Telegraf(config.telegramBotToken);
  const chatId = [...config.allowedChatIds][0];
  const msg =
    `📄 *Reconciliación ${args.account} · ${args.month}*\n` +
    `✅ Ya registrados: ${d.matched}\n` +
    `➕ Escritos en Wallet: ${written}\n` +
    (held.length ? `⏸️ En espera del cruce: ${held.length}\n` : "") +
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
      rows: CsvRow[];
      period: { from: string; to: string } | null;
      chargesDeclared?: number | null;
      // Both totals, or the replay weighs the charges gap without the balance
      // movement that explains it and refuses a month that is right to the cent.
      netDeclared?: number | null;
    };
    console.log(`Reutilizando la extracción guardada: ${stored.rows.length} movimiento(s) de ${ledgerPath}`);
    await reconcile(
      args, ctx, stored.rows, stored.period,
      weighTotals(stored.rows, stored.chargesDeclared ?? null, stored.netDeclared ?? null)
    );
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
  const extracted = parseCsv(csv);
  const claimed = /TOTAL_MOVIMIENTOS:\s*(\d+)/.exec(result.text)?.[1];
  console.log(`Extraídos ${extracted.length} movimiento(s)${claimed ? ` (Claude declara ${claimed})` : ""}.`);
  if (claimed && Number(claimed) !== extracted.length) {
    console.warn(`⚠️ El conteo declarado (${claimed}) no coincide con las filas (${extracted.length}) — revisar extracción.`);
  }

  // Movements the statement settles in one line and never itemises. Spliced
  // before anything else looks at the rows — including the balance checks,
  // which are unaffected because the detail has to sum to the aggregate exactly
  // or nothing is replaced.
  const detail = loadCardDetail(args.account, args.month);
  let rows = extracted;
  if (detail) {
    const splice = spliceCardDetail(extracted, detail.rows);
    console.log(describeSplice(splice, detail));
    rows = splice.rows;
  }

  // The row count is self-reported and stays consistent when a movement is
  // dropped. The statement's own totals are the only figure the extractor
  // cannot satisfy by being self-consistent.
  // Two balances, and the second is the stronger one: charges can balance while
  // the extraction is entirely wrong about which movements exist.
  const totals = weighTotals(rows, parseDeclaredCharges(result.text), parseDeclaredNet(result.text));
  const declared = parsePeriodLine(result.text);

  // ── Persist normalized statement ledger ──
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify({
    account: args.account, month: args.month, extractedAt: new Date().toISOString(),
    period: declared,
    chargesDeclared: parseDeclaredCharges(result.text),
    netDeclared: parseDeclaredNet(result.text),
    sourcePdf: path.basename(args.pdf), rows,
  }, null, 2));
  console.log(`Ledger del estado: ${ledgerPath}`);

  await reconcile(args, ctx, rows, declared, totals);

}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
