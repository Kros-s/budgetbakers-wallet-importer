/**
 * @file statements/ledgers.ts
 * @description The stored extractions, and how much of a month they cover.
 *
 * Statements are extracted as they arrive but crossed only once the month is
 * complete. Writing account by account cannot see a transfer whose other leg is
 * in a statement that has not arrived yet, so it books the leg it has and
 * duplicates it when the counterpart shows up. The whole month at once is the
 * only view in which "this movement already exists somewhere" is answerable.
 */

import fs from "fs";
import path from "path";
import type { CsvRow } from "../csv.js";
import { loadRegistry } from "./registry.js";
import { accountSlug, ledgerFileName } from "./naming.js";

export const LEDGER_DIR = path.resolve("data/statements");

export interface StoredLedger {
  account: string;
  month: string;
  extractedAt: string;
  period: { from: string; to: string } | null;
  chargesDeclared?: number | null;
  sourcePdf: string;
  rows: CsvRow[];
}

// Accents stripped, like every other name the pipeline writes: this used to
// keep them, so one account had a PDF under one spelling and its ledger under
// another, and the filenames were sensitive to how macOS and Linux normalise
// Unicode.
export const ledgerSlug = accountSlug;

export function ledgerPath(account: string, month: string): string {
  return path.join(LEDGER_DIR, ledgerFileName(account, month));
}

export function loadLedger(account: string, month: string): StoredLedger | null {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(account, month), "utf8")) as StoredLedger;
  } catch {
    return null;
  }
}

export interface Coverage {
  month: string;
  have: string[];
  missing: string[];
  complete: boolean;
}

/**
 * Which accounts of the registry already have an extraction for this month.
 *
 * The registry is the denominator on purpose: "all the statements" means every
 * account that produces one, not every PDF that happened to be sent.
 */
export function monthCoverage(month: string, accounts = Object.keys(loadRegistry())): Coverage {
  const have: string[] = [];
  const missing: string[] = [];
  for (const account of accounts) {
    (fs.existsSync(ledgerPath(account, month)) ? have : missing).push(account);
  }
  return { month, have, missing, complete: missing.length === 0 && have.length > 0 };
}

export function formatCoverage(c: Coverage): string {
  if (c.complete) return `✅ Los ${c.have.length} estados de ${c.month} están completos.`;
  const shown = c.missing.slice(0, 8);
  const tail = c.missing.length > shown.length ? ` y ${c.missing.length - shown.length} más` : "";
  return (
    `📥 ${c.have.length} de ${c.have.length + c.missing.length} para ${c.month}. ` +
    `Faltan: ${shown.join(", ")}${tail}.`
  );
}
