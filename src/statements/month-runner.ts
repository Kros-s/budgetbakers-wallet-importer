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
import type { LookupMaps, WalletRecord } from "../types.js";
import { planMonth, type MonthPlan } from "./apply.js";
import { toWalletRows } from "./crossing.js";
import { loadLedger, monthCoverage, type Coverage } from "./ledgers.js";
import { buildMonthWindow, walletFetchRange, type MonthWindow } from "./month-window.js";
import { loadRegistry } from "./registry.js";

export interface MonthView {
  coverage: Coverage;
  plan: MonthPlan;
  /** The Wallet range consulted, for reporting. */
  window: { from: string; to: string };
  /** Which period each account contributed, and where that period came from. */
  periods: MonthWindow;
  /** The Wallet records the window returned, so a caller can write without re-fetching. */
  records: WalletRecord[];
}

export async function loadMonth(
  month: string,
  couch: AxiosInstance,
  lookup: LookupMaps
): Promise<MonthView> {
  const coverage = monthCoverage(month);

  const stored = coverage.have
    .map((account) => ({ account, led: loadLedger(account, month) }))
    .filter((x): x is { account: string; led: NonNullable<typeof x.led> } => x.led !== null);

  // The range covers every contributing account's real period, not the calendar
  // month: an account cutting on the 8th covers the 9th of the previous month,
  // and fetching only the calendar month crossed those rows against records
  // that were never loaded and called them orphans.
  const periods = buildMonthWindow(
    month,
    stored.map(({ account, led }) => ({ account, period: led.period ?? undefined })),
    loadRegistry()
  );
  const { from, to } = walletFetchRange(periods);

  const namesById: Record<string, string> = {};
  for (const [name, id] of Object.entries(lookup.accounts)) namesById[id] = name;

  const records = await listRecordsByDateRange(couch, from, to);
  const wallet = toWalletRows(records, namesById, lookup.transferCategoryId ?? undefined);

  const ledgers = stored.map(({ account, led }) => ({ account, rows: led.rows }));

  return {
    coverage,
    plan: planMonth(month, ledgers, wallet, { coverageComplete: coverage.complete }),
    window: { from, to },
    periods,
    records,
  };
}
