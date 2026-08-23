/**
 * @file statements/extraction.ts
 * @description Does the extraction add up to what the statement says it should?
 *
 * The self-reported row count catches a parse mismatch and nothing else — the
 * model counts the rows it produced, so dropping a movement keeps the count
 * consistent and the check silent. It stayed silent on Meli's July statement:
 * the extractor returned 5 of 7 movements, having read "los movimientos del
 * periodo 2026-07" as the calendar month and dropped the 22 and 25 of June,
 * which the statement's own period (22-jun to 21-jul) covers.
 *
 * A statement states its own totals. Comparing against those is the one check
 * the extractor cannot satisfy by being self-consistent.
 */

import type { CsvRow } from "../csv.js";

/** Cents of slack: statements round, and a peso either way is not a dropped row. */
const TOLERANCE_CENTS = 100;

export function parseDeclaredCharges(text: string): number | null {
  const m = /CARGOS_DECLARADOS:\s*(-?[\d.,]+)/.exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) : null;
}

/** Sum of the rows that take money out, in cents. */
export function extractedChargesCents(rows: CsvRow[]): number {
  return rows.reduce((sum, r) => {
    const n = parseFloat(r.amount);
    return Number.isFinite(n) && n < 0 ? sum + Math.round(Math.abs(n) * 100) : sum;
  }, 0);
}

/**
 * The gap between what we pulled out and what the statement claims, when it is
 * big enough to mean a missing movement rather than rounding.
 */
export function chargesMismatch(rows: CsvRow[], declaredCents: number | null): string | null {
  if (declaredCents === null) return null;
  const got = extractedChargesCents(rows);
  const diff = declaredCents - got;
  if (Math.abs(diff) <= TOLERANCE_CENTS) return null;
  const peso = (c: number) => `$${(c / 100).toFixed(2)}`;
  return diff > 0
    ? `faltan ${peso(diff)}: el estado declara ${peso(declaredCents)} en cargos y se extrajeron ${peso(got)} — hay movimientos sin capturar`
    : `sobran ${peso(-diff)}: se extrajeron ${peso(got)} en cargos y el estado declara ${peso(declaredCents)} — puede haber filas duplicadas o informativas`;
}


/**
 * The change in the account's total balance, as the statement itself states it.
 *
 * A stronger check than the charges total, and the one that catches a statement
 * with internal buckets. Klar's July shows why: money moved from its fixed-term
 * pot back to its main account, and the extractor emitted that $210,000 as an
 * inflow while emitting none of the $2,420.82 of earnings that were the month's
 * only real change. Charges balanced — there were none — so nothing objected.
 * Against the declared opening and closing balances it cannot hide: the sum of
 * what was extracted has to equal what the account actually moved.
 */
export function parseDeclaredNet(text: string): number | null {
  const grab = (label: string): number | null => {
    const m = new RegExp(`${label}:\\s*(-?[\\d.,]+)`).exec(text);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ""));
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };
  const from = grab("SALDO_INICIAL");
  const to = grab("SALDO_FINAL");
  return from === null || to === null ? null : to - from;
}

/** Signed sum of every extracted row, in cents. */
export function extractedNetCents(rows: CsvRow[]): number {
  return rows.reduce((sum, r) => {
    const n = Number(String(r.amount).replace(/,/g, ""));
    return Number.isFinite(n) ? sum + Math.round(n * 100) : sum;
  }, 0);
}

export function netMismatch(rows: CsvRow[], declaredNetCents: number | null): string | null {
  if (declaredNetCents === null) return null;
  const got = extractedNetCents(rows);
  const diff = declaredNetCents - got;
  if (Math.abs(diff) <= TOLERANCE_CENTS) return null;
  const peso = (c: number) => `$${(c / 100).toFixed(2)}`;
  return (
    `el saldo de la cuenta se movió ${peso(declaredNetCents)} en el periodo y lo extraído suma ` +
    `${peso(got)} — faltan o sobran ${peso(Math.abs(diff))}. Revisa si el estado tiene bolsas internas ` +
    `(inversión, apartados, plazo fijo): un traspaso entre ellas NO mueve la cuenta y no debe extraerse.`
  );
}
