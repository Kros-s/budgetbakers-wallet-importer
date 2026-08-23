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

/**
 * The months a `/cross`, `/plan` or `/apply` argument asks for.
 *
 * "2026-07" is one month; "2026-06..2026-07" is every month from the first to
 * the last, inclusive. The range exists because a month cannot be closed alone:
 * Bancomer's July runs 17-jun→16-jul and Banorte débito's runs 02-jun→01-jul,
 * so a transfer between the two has one leg filed under July and the other
 * under June. Crossing them separately reports both as orphans and holds them
 * forever; crossing them together pairs them, and each row keeps the marker of
 * the month it was extracted under, so `snapshot undo` still works per month.
 */
export function monthsInSpec(spec: string): string[] {
  const [from, to] = spec.split("..");
  if (!to) return [from];
  const months: string[] = [];
  let cursor = from;
  // Bounded on purpose: a typo like "2020-01..2030-12" would otherwise read a
  // hundred and thirty months of ledgers before anybody noticed.
  for (let i = 0; i < 24 && cursor <= to; i++) {
    months.push(cursor);
    const [y, m] = cursor.split("-").map(Number);
    cursor = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  }
  return months;
}

/** Whether an argument names a month or a range of them. */
export const MONTH_SPEC = /^\d{4}-(0[1-9]|1[0-2])(\.\.\d{4}-(0[1-9]|1[0-2]))?$/;

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
  spec: string,
  couch: AxiosInstance,
  lookup: LookupMaps
): Promise<MonthView> {
  const months = monthsInSpec(spec);

  // Coverage is reported for the LAST month of a range — the one being closed.
  // Reporting the union would call June's missing Costco a gap in July, and
  // reporting the first would be stranger still.
  const coverage = monthCoverage(months[months.length - 1]);

  const stored = months.flatMap((month) =>
    monthCoverage(month).have
      .map((account) => ({ account, led: loadLedger(account, month) }))
      .filter((x): x is { account: string; led: NonNullable<typeof x.led> } => x.led !== null)
  );

  // The range covers every contributing account's real period, not the calendar
  // month: an account cutting on the 8th covers the 9th of the previous month,
  // and fetching only the calendar month crossed those rows against records
  // that were never loaded and called them orphans.
  const periods = buildMonthWindow(
    spec,
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
    plan: planMonth(spec, ledgers, wallet, { coverageComplete: coverage.complete }),
    window: { from, to },
    periods,
    records,
  };
}
