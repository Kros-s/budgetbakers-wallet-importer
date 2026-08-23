/**
 * @file statements/installments.ts
 * @description Deferred purchases — "compras a meses".
 *
 * The user's rule: a purchase in instalments is recorded ONCE, for its full
 * price, at the moment it was bought. The monthly instalments are ignored.
 *
 * That cannot be done by dropping instalment rows on the floor, because the
 * statement's own totals count them: the extraction would stop adding up
 * against the figure the statement publishes, and the check that guards
 * --write would fire on every card that has one. So they are extracted and
 * tagged, they count toward the arithmetic, and they are excluded only at the
 * point of writing.
 */

import type { CsvRow } from "../csv.js";

/**
 * Reads a money figure the way a statement writes one.
 *
 * `parseFloat("32,880.00")` is 32 — it stops at the comma. The prompt forbids a
 * thousands separator in `amount`, but the deferred-purchases "Original" column
 * is exactly where a bank prints one, and a $32,880 purchase silently became a
 * $32 one.
 */
export function parseMoney(text: string | undefined): number {
  if (!text) return NaN;
  const cleaned = text.replace(/[^0-9.,-]/g, "");
  // A comma is a thousands separator here; Mexican statements use a dot decimal.
  return Number(cleaned.replace(/,/g, ""));
}

export interface Installment {
  index: number;
  total: number;
}

/** Reads the statement's own instalment column. "004 de 006" arrives as "4/6". */
export function parseInstallment(row: CsvRow): Installment | null {
  const raw = row.meses?.trim();
  if (!raw) return null;
  const m = /^0*(\d{1,3})\s*(?:\/|de)\s*0*(\d{1,3})$/i.exec(raw);
  if (!m) return null;
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (!index || !total || index > total || total < 2) return null;
  return { index, total };
}

/** The purchase month: the one instalment that becomes a record. */
export function isFirstInstallment(row: CsvRow): boolean {
  return parseInstallment(row)?.index === 1;
}

/** Every later instalment — charged, counted, and never written. */
export function isLaterInstallment(row: CsvRow): boolean {
  const i = parseInstallment(row);
  return i !== null && i.index > 1;
}

export interface WriteSplit {
  /** Rows to write, with a first instalment restated at its full price. */
  writable: CsvRow[];
  /** Later instalments, deliberately left out. */
  ignored: CsvRow[];
}

/**
 * Splits extracted rows into what gets written and what is deliberately not.
 *
 * A first instalment is rewritten to the purchase's full price when the
 * statement published it — the point of recording it once is that the whole
 * purchase lands in the month it happened, not a sixth of it. Without that
 * figure the instalment amount is kept and flagged, since a wrong total is
 * worse than a partial one.
 */
const cents = (text: string | undefined): number => Math.round(parseMoney(text) * 100);

/**
 * A purchase deferred to instalments inside the very statement that charged it.
 *
 * Amex Platinum's July 2026 carries all three sides of one $7,970 purchase:
 * the charge itself (`NETPAY*REAL SPORT`, 22-jun), a credit of exactly $7,970
 * (`MONTO A DIFERIR MESES EN AUTOMATICO`, 6-jul) taking it back out of the
 * revolving balance, and the first instalment of $2,656.67. The statement is
 * consistent — the three come to the $2,656.67 actually owed this period — but
 * the write policy read them separately: it wrote the purchase, restated the
 * `1/3` to its full price and wrote $7,970 a second time, and held the credit
 * forever as a transfer whose counterpart no account will ever have.
 *
 * So the three are resolved against each other, and only where the statement
 * itself supplies the whole set:
 *
 *   - the deferral credit is always dropped. It is an internal entry of the
 *     issuer's, not money that moved.
 *   - if the original charge is in the same ledger, the instalment row is
 *     dropped and the charge is kept: it has the real date and the real
 *     merchant, where the instalment row has the deferral date and the
 *     issuer's own wording.
 *   - if it is not — the purchase was charged in an earlier period — the
 *     instalment is restated to the full price as before.
 *
 * Nothing here changes the arithmetic. Every row was extracted and still counts
 * toward the totals the statement publishes; this decides only what is written.
 */
function resolveDeferrals(rows: CsvRow[], context: CsvRow[]): Set<CsvRow> {
  const drop = new Set<CsvRow>();
  for (const first of rows) {
    if (!isFirstInstallment(first) || !first.montooriginal) continue;
    const full = cents(first.montooriginal);
    if (!Number.isFinite(full) || full === 0) continue;

    const credit = context.find((r) => r !== first && !drop.has(r) && cents(r.amount) === full);
    if (!credit) continue;
    drop.add(credit);

    // The purchase itself: same size, money going out, and not an instalment
    // line of its own — those are the parts of this same deferral.
    //
    // Searched in `context`, the whole statement, rather than in the rows being
    // written. Amex Platinum's June has the charge (`WALMART VENTA EN LINEA`,
    // 17-may, $6,316) already recorded in Wallet, so it is not among the
    // missing rows — and looking there found nothing, kept the `1/3`, restated
    // it to $6,316 and wrote the purchase a second time.
    const charge = context.find(
      (r) => r !== first && r !== credit && !drop.has(r) &&
        cents(r.amount) === -full && !parseInstallment(r)
    );
    if (charge) drop.add(first);
  }
  return drop;
}

/**
 * @param rows    the rows being considered for writing.
 * @param context the whole statement, when `rows` is only part of it. A
 *                deferral is resolved against everything the statement holds,
 *                including lines already recorded in Wallet and therefore
 *                absent from `rows`.
 */
export function splitForWriting(rows: CsvRow[], context: CsvRow[] = rows): WriteSplit {
  const writable: CsvRow[] = [];
  const ignored: CsvRow[] = [];
  const drop = resolveDeferrals(rows, context);
  for (const row of rows) {
    if (isLaterInstallment(row)) { ignored.push(row); continue; }
    if (drop.has(row)) { ignored.push(row); continue; }
    if (isFirstInstallment(row) && row.montooriginal) {
      const full = parseMoney(row.montooriginal);
      const sign = parseMoney(row.amount) < 0 ? -1 : 1;
      if (Number.isFinite(full) && full !== 0) {
        writable.push({ ...row, amount: (sign * Math.abs(full)).toFixed(2) });
        continue;
      }
    }
    writable.push(row);
  }
  return { writable, ignored };
}

export function describeIgnored(ignored: CsvRow[]): string {
  return ignored
    .map((r) => {
      const i = parseInstallment(r);
      const why = i
        ? i.index > 1
          ? `${i.index}/${i.total}`
          : `${i.index}/${i.total} — la compra ya viene completa en este mismo estado`
        : "asiento del diferimiento, no es dinero que se movió";
      return `${r.date.slice(0, 10)} $${r.amount} ${r.payee || ""} (${why})`;
    })
    .join("\n");
}
