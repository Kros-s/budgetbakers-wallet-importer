/**
 * @file statements/card-detail.ts
 * @description Movements a statement settles in one line and never itemises.
 *
 * DolarApp issues a card and publishes not one purchase made with it. The whole
 * month arrives as a single row — `Liquidación Crédito - Pagos con tarjeta
 * crédito semanal, -$2,403.82` — while the app's transaction list has all
 * twenty-six of them, merchant by merchant. Written as the aggregate, July 2026
 * books one $2,403.82 expense against no merchant and no category, and counts
 * twice the two purchases Wallet already holds individually ($549.41 of them).
 *
 * So the detail is supplied from outside the PDF, in a small file per account
 * and month, and spliced in place of the aggregate. What makes that safe is not
 * trust, it is arithmetic: the detail has to sum to the aggregate **exactly**,
 * or nothing is replaced. July's twenty-five charges less one Amazon refund
 * come to $2,403.82 to the cent, and June's three come to $130.53 — which is
 * also how the transcription was checked, since twenty-six figures do not land
 * on a published total by accident.
 *
 * Everything downstream is unaffected: the ledger's own balance checks compare
 * the same sum, so a spliced month proves out exactly as it did before.
 */

import fs from "fs";
import path from "path";
import type { CsvRow } from "../csv.js";
import { accountSlug } from "./naming.js";

/** Where a month's card detail lives, if anybody supplied it. */
export function cardDetailPath(account: string, month: string): string {
  return path.resolve("data/statements", `detail-${accountSlug(account)}-${month}.json`);
}

export interface CardDetail {
  /** Free text saying where these came from — an app export, a screenshot, a call. */
  source: string;
  rows: CsvRow[];
}

export function loadCardDetail(account: string, month: string): CardDetail | null {
  const file = cardDetailPath(account, month);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CardDetail;
  return parsed.rows?.length ? parsed : null;
}

const cents = (row: CsvRow): number => Math.round(parseFloat(row.amount) * 100);

export interface SpliceResult {
  rows: CsvRow[];
  /** The aggregate that was replaced, or null when nothing was. */
  replaced: CsvRow | null;
  /** Why nothing was replaced, when nothing was. */
  refused: string | null;
}

/**
 * Puts the itemised movements where the aggregate was.
 *
 * The aggregate is found by its amount, never by its wording: a bank is free to
 * rename its own settlement line, and matching on the figure is what ties the
 * two together in the first place. Exactly one row must carry it — two rows of
 * the same size is ambiguity, and ambiguity leaves the statement alone.
 */
export function spliceCardDetail(rows: CsvRow[], detail: CsvRow[]): SpliceResult {
  const total = detail.reduce((sum, r) => sum + cents(r), 0);
  if (!Number.isFinite(total) || total === 0) {
    return { rows, replaced: null, refused: "el detalle no suma un importe legible" };
  }
  const hits = rows.filter((r) => cents(r) === total);
  if (hits.length === 0) {
    const money = (c: number): string => `$${Math.abs(c / 100).toFixed(2)}`;
    return {
      rows,
      replaced: null,
      refused: `el detalle suma ${money(total)} y el estado no publica ningún movimiento de ese importe`,
    };
  }
  if (hits.length > 1) {
    return { rows, replaced: null, refused: `${hits.length} movimientos del mismo importe — no se puede decir cuál agrega` };
  }
  const aggregate = hits[0];
  const out = rows.flatMap((r) => (r === aggregate ? detail : [r]));
  return { rows: out, replaced: aggregate, refused: null };
}

export function describeSplice(result: SpliceResult, detail: CardDetail): string {
  if (!result.replaced) return `⚠️ Detalle de tarjeta NO aplicado: ${result.refused}.`;
  const money = Math.abs(parseFloat(result.replaced.amount)).toFixed(2);
  return (
    `🃏 Detalle de tarjeta aplicado: ${detail.rows.length} movimiento(s) en lugar de ` +
    `"${result.replaced.payee || result.replaced.desc?.slice(0, 40) || "el agregado"}" ($${money}). ` +
    `Fuente: ${detail.source}.`
  );
}
