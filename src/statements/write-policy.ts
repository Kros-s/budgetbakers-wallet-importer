/**
 * @file statements/write-policy.ts
 * @description What can be written the moment a statement is extracted, and
 * what has to wait for the month.
 *
 * The reason for holding a whole month was never the movements themselves — it
 * was transfers. A transfer has two legs in two different statements, so
 * writing the one you have books half a movement and books it again when the
 * counterpart arrives. A purchase or an interest payment has no counterpart:
 * it exists on one statement only, and no statement still in the post can
 * duplicate it.
 *
 * So the wait is narrowed to what actually needs it.
 */

import type { CsvRow } from "../csv.js";
import { splitForWriting } from "./installments.js";

/** The categories Wallet uses for a transfer leg, in the spellings the extractor emits. */
export function isTransferRow(row: CsvRow): boolean {
  return /transfer|traspaso/i.test(row.category ?? "");
}

export interface WritePlan {
  /** No counterpart anywhere: safe to write as soon as the statement is read. */
  now: CsvRow[];
  /** Transfer legs: they wait for the month's crossing to find their other half. */
  held: CsvRow[];
  /** Later instalments of a deferred purchase, deliberately left out. */
  ignored: CsvRow[];
}

export function planWrites(rows: CsvRow[]): WritePlan {
  const { writable, ignored } = splitForWriting(rows);
  const now: CsvRow[] = [];
  const held: CsvRow[] = [];
  for (const row of writable) (isTransferRow(row) ? held : now).push(row);
  return { now, held, ignored };
}

export function describeHeld(held: CsvRow[]): string {
  return held
    .map((r) => `${r.date.slice(0, 10)} $${r.amount} ${r.payee || r.note || ""}`)
    .join("\n");
}
