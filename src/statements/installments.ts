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
export function splitForWriting(rows: CsvRow[]): WriteSplit {
  const writable: CsvRow[] = [];
  const ignored: CsvRow[] = [];
  for (const row of rows) {
    if (isLaterInstallment(row)) { ignored.push(row); continue; }
    if (isFirstInstallment(row) && row.montooriginal) {
      const full = parseFloat(row.montooriginal);
      const sign = parseFloat(row.amount) < 0 ? -1 : 1;
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
      return `${r.date.slice(0, 10)} $${r.amount} ${r.payee || ""} (${i?.index}/${i?.total})`;
    })
    .join("\n");
}
