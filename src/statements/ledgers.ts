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
import type { StatementSpan } from "./continuity.js";

export const LEDGER_DIR = path.resolve("data/statements");

export interface StoredLedger {
  account: string;
  month: string;
  extractedAt: string;
  period: { from: string; to: string } | null;
  chargesDeclared?: number | null;
  netDeclared?: number | null;
  /** Balances the statement declares, in cents — the chain the next one joins. */
  openingDeclared?: number | null;
  closingDeclared?: number | null;
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

/**
 * Moves an existing ledger aside when the incoming statement covers a different
 * period, and returns where it went.
 *
 * A ledger is named by account and month, and the month comes from the cut
 * date. That held until a bank changed its cycle: Banorte débito cut on the 1st
 * through July and at month end from August, so the statement for 2–31 July and
 * the one for 2 June–1 July are both "2026-07". The second would have silently
 * replaced the first — the extraction that backs everything written for June.
 *
 * Keeping the old file under its period is enough: nothing reads the archived
 * name, and the movements it holds are already in Wallet. Losing it is what
 * must not happen.
 */
export function archiveIfDifferentPeriod(
  account: string,
  month: string,
  period: { from: string; to: string } | null
): string | null {
  const current = loadLedger(account, month);
  if (!current || !period || !current.period) return null;
  if (current.period.from === period.from && current.period.to === period.to) return null;

  const dir = path.dirname(ledgerPath(account, month));
  const archived = path.join(
    dir,
    `${ledgerFileName(account, month).replace(/\.json$/, "")}--${current.period.from}_${current.period.to}.json`
  );
  fs.renameSync(ledgerPath(account, month), archived);
  return archived;
}

/**
 * Every stored statement of one account, as spans for the continuity check.
 *
 * Reads the ledger directory rather than the registry: what matters is what was
 * actually extracted, not what the registry believes should exist.
 */
export function spansFor(account: string): StatementSpan[] {
  const prefix = `ledger-${ledgerSlug(account)}-`;
  let names: string[] = [];
  try {
    names = fs.readdirSync(LEDGER_DIR);
  } catch {
    return [];
  }
  const spans: StatementSpan[] = [];
  for (const name of names) {
    // `--` marks a ledger archived under its own period; it is the same
    // statement the canonical name once held, and counting both invents an
    // overlap that is not there.
    if (!name.startsWith(prefix) || !name.endsWith(".json") || name.includes("--")) continue;
    try {
      const led = JSON.parse(fs.readFileSync(path.join(LEDGER_DIR, name), "utf8")) as StoredLedger;
      if (!led.period) continue;
      spans.push({
        month: led.month,
        period: led.period,
        opening: led.openingDeclared ?? null,
        closing: led.closingDeclared ?? null,
      });
    } catch { /* a ledger we cannot read is not a gap */ }
  }
  return spans;
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
