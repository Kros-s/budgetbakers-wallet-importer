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
