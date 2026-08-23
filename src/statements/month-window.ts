/**
 * @file statements/month-window.ts
 * @description One month, many statement periods — and the single Wallet query
 * that covers all of them.
 *
 * `/cross 2026-07` crosses every ledger filed under July against Wallet. But
 * "July" is not one range: the month of a statement is the month its CUT DATE
 * falls in, so Costco's July runs 9-jun→8-jul (cut day 8), Meli's runs
 * 22-jun→21-jul (cut day 21), and MIFEL's really is 1-jul→31-jul. The command
 * fetched Wallet for the calendar month ±3/4 days, which meant:
 *
 *   - Costco rows dated 9-jun..27-jun were crossed against Wallet records that
 *     were never fetched. Every one of them surfaced as an orphan leg — a false
 *     alarm at best, and the invitation to book a duplicate at worst.
 *   - `deferNearBoundary(rows, calendarPeriod(month))` measured "edge of the
 *     month" against 1-jul/31-jul. For Costco that deferred rows in the MIDDLE
 *     of its statement (1-jul..8-jul is its safe tail) and waved through the
 *     genuinely risky ones at 9-jun and 8-jul, which is exactly backwards.
 *
 * So the window is built from the periods themselves. Everything here is pure:
 * the ledgers and the registry are passed in, nothing is read from disk.
 */

import {
  BOUNDARY_DAYS,
  calendarPeriod,
  isNearBoundary,
  walletWindow,
  type StatementPeriod,
} from "./period.js";

/**
 * Where a period came from, in the order of precedence they are tried.
 *
 *   1. "declared" — the `PERIODO:` line the statement itself prints. The
 *      document is the authority; our arithmetic never overrules it.
 *   2. "cutDay"   — derived from the registry's cut day when the extraction
 *      banked no period (older ledgers, or a PDF that hid the line).
 *   3. "calendar" — the whole named month, for an account in neither. This is
 *      the assumption the old code made for EVERY account, kept only as a last
 *      resort so an unknown account still gets a window instead of nothing.
 */
export type PeriodSource = "declared" | "cutDay" | "calendar";

export interface AccountPeriod {
  account: string;
  period: StatementPeriod;
  source: PeriodSource;
  /** The registry cut day, when one was known — for display. */
  cutDay?: number;
}

/** A `StoredLedger` seen through the only two fields this module needs. */
export interface LedgerPeriodInput {
  account: string;
  period?: { from: string; to: string } | null;
}

/** A `Registry` seen through the only field this module needs. */
export type CutDayRegistry = Readonly<Record<string, { cutDay: number }>>;

export interface MonthWindow {
  /** "YYYY-MM", the month the statements are filed under. */
  month: string;
  /** The union of every account's period: earliest open, latest close. */
  span: StatementPeriod;
  /** One entry per contributing account, in the order they were given. */
  accounts: AccountPeriod[];
}

/**
 * A cut day at or past this is an end-of-month account.
 *
 * `registry.ts` caps `cutDay` at 28 so that February still has the day, and
 * `cutDayMismatch` already reads 28 as "closes with the month". MIFEL is stored
 * as 28 and its statement declares 1-jul→31-jul, so deriving 29-jun→28-jul from
 * the raw number would invent a period the bank never used.
 */
export const END_OF_MONTH_CUT_DAY = 28;

function lastDayOf(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function isoDay(d: Date): string {
  // Local components on purpose: every date in this codebase is a local wall
  // date, and `toISOString()` would shift it a day for anyone east of UTC.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The period a cut day implies for a given month.
 *
 * The month of a statement is the month its cut date falls in — checked against
 * fourteen real statements from seven banks — so the period CLOSES inside the
 * named month and OPENS the day after the previous cut. Costco, cut day 8,
 * July: 9-jun→8-jul. Meli, cut day 21, July: 22-jun→21-jul.
 */
export function periodFromCutDay(month: string, cutDay: number): StatementPeriod {
  const [y, m] = month.split("-").map(Number);
  if (!Number.isFinite(cutDay) || cutDay >= END_OF_MONTH_CUT_DAY) return calendarPeriod(month);
  // `m - 1` is this month's index, `m - 2` the previous one — negative on
  // January, which Date resolves to December of the year before.
  const close = Math.min(Math.max(Math.trunc(cutDay), 1), lastDayOf(y, m - 1));
  // Clamped so a cut day past the previous month's length cannot roll the open
  // date forward into this month. Registry cut days are 1-28, so this only
  // guards against a bad entry.
  const openDay = Math.min(close + 1, lastDayOf(y, m - 2));
  return {
    from: isoDay(new Date(y, m - 2, openDay)),
    to: `${month}-${String(close).padStart(2, "0")}`,
  };
}

/**
 * The period to judge one account's rows by, applying the precedence above:
 * declared period → cut day → calendar month.
 */
export function resolveAccountPeriod(
  account: string,
  month: string,
  declared?: { from: string; to: string } | null,
  cutDay?: number
): AccountPeriod {
  if (declared && declared.from && declared.to && declared.from <= declared.to) {
    return { account, period: { from: declared.from, to: declared.to }, source: "declared", cutDay };
  }
  if (typeof cutDay === "number" && Number.isFinite(cutDay)) {
    return { account, period: periodFromCutDay(month, cutDay), source: "cutDay", cutDay };
  }
  return { account, period: calendarPeriod(month), source: "calendar", cutDay };
}

/** Earliest open, latest close. ISO days compare correctly as strings. */
export function unionPeriod(periods: readonly StatementPeriod[]): StatementPeriod | null {
  if (periods.length === 0) return null;
  let from = periods[0].from;
  let to = periods[0].to;
  for (const p of periods) {
    if (p.from < from) from = p.from;
    if (p.to > to) to = p.to;
  }
  return { from, to };
}

/**
 * The month's window: what each contributing account covers, and the span that
 * contains all of them.
 *
 * `ledgers` are the extractions actually filed for the month — those are the
 * accounts whose rows will be crossed, so those are the accounts the Wallet
 * fetch has to cover. An account in the registry with no ledger contributes no
 * rows and therefore needs no coverage.
 */
export function buildMonthWindow(
  month: string,
  ledgers: readonly LedgerPeriodInput[],
  cutDays: CutDayRegistry = {}
): MonthWindow {
  const accounts = ledgers.map((l) =>
    resolveAccountPeriod(l.account, month, l.period, cutDays[l.account]?.cutDay)
  );
  // With no ledger at all there is nothing to take a union of, and the calendar
  // month is the only honest guess left.
  const span = unionPeriod(accounts.map((a) => a.period)) ?? calendarPeriod(month);
  return { month, span, accounts };
}

/**
 * The single CouchDB range that covers every account's period.
 *
 * The span alone is not enough: a movement inside a period can be POSTED in
 * Wallet up to five days later (Banamex's measured maximum), so the query is
 * widened by the matcher's slack the same way `reconcile-statement` widens a
 * single period. Five also covers the crossing's own `DEFAULT_GAP_DAYS` of 4,
 * so one query still serves both.
 */
export function walletFetchRange(
  window: MonthWindow,
  slackDays: number = BOUNDARY_DAYS
): { from: string; to: string } {
  return walletWindow(window.span, slackDays);
}

/** The period this account is judged by; the calendar month for a stranger. */
export function periodFor(window: MonthWindow, account: string): StatementPeriod {
  return window.accounts.find((a) => a.account === account)?.period ?? calendarPeriod(window.month);
}

/** A `LedgerRow` seen through the only three fields this module needs. */
export interface BoundaryRow {
  account: string;
  /** YYYY-MM-DD, the posting date. */
  date: string;
  /** Epoch ms of the operation date, when the statement published both. */
  opTime?: number;
}

/**
 * Is this row near the edge of ITS OWN statement period?
 *
 * The row is checked on both dates it carries. A statement prints the operation
 * date and the posting date, and the counterpart in another account may be
 * dated by either — so a row is at the edge if either date is.
 */
export function isNearAccountBoundary(
  row: BoundaryRow,
  window: MonthWindow,
  slack: number = BOUNDARY_DAYS
): boolean {
  const period = periodFor(window, row.account);
  const days = [row.date];
  if (row.opTime !== undefined && Number.isFinite(row.opTime)) days.push(isoDay(new Date(row.opTime)));
  return days.some((d) => isNearBoundary(d, period, slack));
}

export interface AccountBoundarySplit<T extends BoundaryRow> {
  /** At the edge of its own period: hold until the month is complete. */
  deferred: T[];
  /** Safely inside its own period: decidable now. */
  inside: T[];
}

/**
 * `deferNearBoundary`, but each row measured against its own account's period.
 *
 * The failure this replaces: crossing July with the calendar period deferred
 * Costco's 1-jul..8-jul rows — the middle of nothing, they are its safe tail —
 * while 8-jul, its actual cut, was waved straight through into a decision taken
 * before the accounts it pairs with had even been extracted.
 */
export function splitAtAccountBoundary<T extends BoundaryRow>(
  rows: readonly T[],
  window: MonthWindow,
  slack: number = BOUNDARY_DAYS
): AccountBoundarySplit<T> {
  const deferred: T[] = [];
  const inside: T[] = [];
  for (const r of rows) (isNearAccountBoundary(r, window, slack) ? deferred : inside).push(r);
  return { deferred, inside };
}

const SOURCE_LABEL: Record<PeriodSource, string> = {
  declared: "declarado",
  cutDay: "corte",
  calendar: "calendario",
};

/**
 * Which account contributes which period, for the `/cross` reply.
 *
 * User-facing text is Spanish here, as everywhere the bot speaks. Showing the
 * source is the point: a row judged by "calendario" is being judged by the
 * assumption that caused the false orphans, and seeing that in the output is
 * how the missing registry entry gets noticed.
 */
export function formatAccountPeriods(window: MonthWindow): string {
  if (window.accounts.length === 0) return `Sin extracciones de ${window.month}.`;
  return window.accounts
    .map((a) => {
      const name = a.account.padEnd(20).slice(0, 20);
      const tag = a.source === "cutDay" && a.cutDay !== undefined
        ? `corte ${a.cutDay}`
        : SOURCE_LABEL[a.source];
      return `${name} ${a.period.from}..${a.period.to}  ${tag}`;
    })
    .join("\n");
}
