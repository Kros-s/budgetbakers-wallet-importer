/**
 * @file statements/month-runner.ts
 * @description Loading a month and asking `planMonth` what it means.
 *
 * The one place that reads ledgers and Wallet for a month. Telegram and a
 * terminal session both come through here, so neither can form its own opinion
 * about what a month contains — the surfaces differ, the answer does not.
 */

import type { AxiosInstance } from "axios";
import { listRecordsByDateRange } from "../records.js";
import type { LookupMaps } from "../types.js";
import { planMonth, type MonthPlan } from "./apply.js";
import { toWalletRows } from "./crossing.js";
import { loadLedger, monthCoverage, type Coverage } from "./ledgers.js";

export interface MonthView {
  coverage: Coverage;
  plan: MonthPlan;
  /** The Wallet range consulted, for reporting. */
  window: { from: string; to: string };
}

/**
 * How far outside the month to look for Wallet records.
 *
 * Statement periods do not line up with calendar months — an account cutting on
 * the 8th covers the 9th of the previous month — so the query has to reach a
 * full month back, plus the posting slack. Fetching only the calendar month
 * crossed rows against records that were never loaded and called them orphans.
 */
const LOOKBEHIND_DAYS = 40;
const LOOKAHEAD_DAYS = 10;

export async function loadMonth(
  month: string,
  couch: AxiosInstance,
  lookup: LookupMaps
): Promise<MonthView> {
  const coverage = monthCoverage(month);
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1 - LOOKBEHIND_DAYS)).toISOString();
  const to = new Date(Date.UTC(y, m, LOOKAHEAD_DAYS)).toISOString();

  const namesById: Record<string, string> = {};
  for (const [name, id] of Object.entries(lookup.accounts)) namesById[id] = name;

  const records = await listRecordsByDateRange(couch, from, to);
  const wallet = toWalletRows(records, namesById, lookup.transferCategoryId ?? undefined);

  const ledgers = coverage.have
    .map((account) => ({ account, led: loadLedger(account, month) }))
    .filter((x): x is { account: string; led: NonNullable<typeof x.led> } => x.led !== null)
    .map(({ account, led }) => ({ account, rows: led.rows }));

  return {
    coverage,
    plan: planMonth(month, ledgers, wallet, { coverageComplete: coverage.complete }),
    window: { from, to },
  };
}
