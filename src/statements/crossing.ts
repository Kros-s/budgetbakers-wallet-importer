/**
 * @file statements/crossing.ts
 * @description Pairing the two legs of a transfer across different statements.
 *
 * Wallet's own pairing only works within one CSV, matching on an identical
 * date, so two legs arriving in two different statements never meet: the card
 * payment shows up on the card's statement and the money leaving shows up on
 * the bank's, and each is written as a standalone movement. That is how an
 * account ends up with orphan transfer legs — `Stocks` carries eight of them —
 * and how the same payment gets booked twice, once from each side.
 *
 * So the crossing runs over the whole month at once, which is also the only
 * view in which "this movement already exists somewhere" can be answered.
 */

import type { CsvRow, } from "../csv.js";
import type { WalletRecord } from "../types.js";
import { isNearBoundary, type StatementPeriod } from "./period.js";

/** Where a row came from — a statement being staged, or Wallet as it stands. */
export type RowSource = "statement" | "wallet";

export interface LedgerRow {
  account: string;
  source: RowSource;
  /** Signed cents: negative leaves the account, positive arrives. */
  cents: number;
  /** Epoch ms of the movement date (when it posted). */
  time: number;
  /**
   * Epoch ms of the operation date, when the statement published both.
   * Either may be the one the counterpart is dated by.
   */
  opTime?: number;
  /** YYYY-MM-DD, for display. */
  date: string;
  category: string;
  payee: string;
  /**
   * Signed cents in the local currency, for a movement on an account held in
   * another one.
   *
   * The equal-amount rule below cannot pair the two legs of a cross-currency
   * transfer: DolarApp records `-9,300 USD` and Bancomer records
   * `+163,202.91 MXN`, and no arithmetic relates them without a rate nobody
   * published. What IS published is the peso figure, printed on the DolarApp
   * statement beside the dollar one, and this is it. Only the foreign leg
   * carries it — the peso leg's own `cents` already are the peso figure.
   */
  pesos?: number;
}

export interface TransferPair {
  out: LedgerRow;
  in: LedgerRow;
  /** Days between the two legs. */
  gapDays: number;
}

export interface CrossResult {
  /** At least one leg is categorised as a transfer — these are real. */
  pairs: TransferPair[];
  /**
   * Neither leg claims to be a transfer; they only happen to be the same size a
   * few days apart. Reported separately because a purchase of $50 in one
   * account and unrelated income of $50 in another is a coincidence, and
   * treating it as a transfer would merge two unrelated movements.
   */
  possible: TransferPair[];
  /**
   * Rows still unaccounted for. A row named in `possible` stays here: that
   * bucket is advisory, and letting a coincidence consume a row would quietly
   * drop a real movement from whatever decides what to write.
   */
  unpaired: LedgerRow[];
}

function isTransferRow(r: LedgerRow): boolean {
  return /transfer|traspaso/i.test(r.category);
}

/** Banks post the two sides on different days; beyond this it stops being one movement. */
export const DEFAULT_GAP_DAYS = 4;

export function toLedgerRows(account: string, rows: CsvRow[]): LedgerRow[] {
  return rows.map((row) => {
    const cents = Math.round(parseFloat(row.amount) * 100);
    return {
      account,
      source: "statement" as const,
      cents,
      // The local figure takes its sign from the movement, never from how the
      // statement chose to print it. DolarApp writes the dollar amount with a
      // sign and the peso equivalent without one on some lines; a peso leg that
      // came out positive would go looking for a counterpart in the wrong
      // direction and find nothing.
      pesos: localCents(row.mxn, cents),
      time: Date.parse(row.date.replace(" ", "T")),
      opTime: row.opdate ? Date.parse(`${row.opdate}T12:00:00`) : undefined,
      date: row.date.slice(0, 10),
      category: row.category ?? "",
      payee: row.payee ?? "",
    };
  }).filter((r) => Number.isFinite(r.cents) && Number.isFinite(r.time));
}

/** The statement's local-currency figure in signed cents, or undefined if it published none. */
function localCents(mxn: string | undefined, cents: number): number | undefined {
  const raw = mxn?.trim();
  if (!raw) return undefined;
  const value = Number(raw.replace(/[^0-9.-]/g, "").replace(/(?!^)-/g, ""));
  if (!Number.isFinite(value) || value === 0) return undefined;
  return Math.round(Math.abs(value) * 100) * (cents < 0 ? -1 : 1);
}

/**
 * Whether two legs are the same movement seen from both sides.
 *
 * Same currency, the figures are each other's negation. Across currencies the
 * only comparable pair is the peso equivalent the foreign statement publishes
 * against the peso account's face value — and at least one side must actually
 * carry one, or this would pair any two rows whose currencies happen to differ.
 */
function sameSize(out: LedgerRow, cand: LedgerRow): boolean {
  if (cand.cents === -out.cents) return true;
  if (out.pesos === undefined && cand.pesos === undefined) return false;
  return (cand.pesos ?? cand.cents) === -(out.pesos ?? out.cents);
}

/**
 * What Wallet already holds for the month, in the same shape.
 *
 * Without these the crossing can only see the statements that arrived, so a
 * payment already recorded reads as a missing movement and gets proposed again.
 * Wallet stores amounts unsigned with a type flag, and it is the opposite way
 * round from the obvious reading: **type 1 is money OUT, type 0 is money in**.
 * Confirmed against the account itself — 848 of 849 Groceries, all 390 Fuel and
 * all 943 Restaurant records are type 1, while all 441 Wage and all 625
 * Interests records are type 0. `convertRows` has always written it this way.
 *
 * Getting it backwards inverted the sign of every Wallet row in the crossing, so
 * a charge on a statement went looking for a Wallet row of the opposite sign and
 * found the very same movement already recorded — pairing a purchase with itself
 * and reporting it as a transfer leg.
 */
export function toWalletRows(
  records: WalletRecord[],
  accountNamesById: Record<string, string>,
  transferCategoryId?: string
): LedgerRow[] {
  return records.map((r) => ({
    account: accountNamesById[r.accountId] ?? r.accountId,
    source: "wallet" as const,
    cents: r.type === 1 ? -r.amount : r.amount,
    time: Date.parse(r.recordDate),
    date: r.recordDate.slice(0, 10),
    category: r.transfer || (transferCategoryId && r.categoryId === transferCategoryId) ? "Transfer, withdraw" : "",
    payee: r.payee ?? r.note ?? "",
  })).filter((r) => Number.isFinite(r.cents) && Number.isFinite(r.time));
}

/**
 * Matches each outgoing row against an incoming row of the same size in a
 * different account.
 *
 * Closest in time wins, and every row is consumed at most once — without that,
 * three $500 movements in a month cross-match into six bogus pairs. Same-account
 * pairs are refused outright: a transfer has two accounts by definition, and
 * accepting one would silently merge two unrelated movements of equal size.
 */
function closestGap(a: LedgerRow, b: LedgerRow): number {
  const at = [a.time, ...(a.opTime !== undefined ? [a.opTime] : [])];
  const bt = [b.time, ...(b.opTime !== undefined ? [b.opTime] : [])];
  let best = Infinity;
  for (const x of at) for (const y of bt) best = Math.min(best, Math.abs(x - y));
  return best;
}

export function crossTransfers(rows: LedgerRow[], gapDays = DEFAULT_GAP_DAYS): CrossResult {
  const window = gapDays * 86_400_000;
  const outs = rows.filter((r) => r.cents < 0).sort((a, b) => a.time - b.time);
  const ins = rows.filter((r) => r.cents > 0).sort((a, b) => a.time - b.time);
  const used = new Set<LedgerRow>();   // matched at all — stops re-matching
  const settled = new Set<LedgerRow>(); // matched by a REAL transfer pair
  const pairs: TransferPair[] = [];
  const possible: TransferPair[] = [];

  /**
   * Pairs greedily within one class of candidates.
   *
   * Two passes, and the order matters: a transfer must get first refusal on the
   * legs it needs. Walking every outgoing row at once let an unrelated $500
   * purchase claim the incoming leg a genuine $500 transfer was waiting for,
   * and the transfer was then reported as an orphan.
   */
  const sweep = (accept: (out: LedgerRow, cand: LedgerRow) => boolean): void => {
    for (const out of outs) {
      if (used.has(out)) continue;
      let best: LedgerRow | undefined;
      let bestGap = Infinity;
      for (const cand of ins) {
        if (used.has(cand)) continue;
        if (cand.account === out.account) continue;
        if (!sameSize(out, cand)) continue;
        if (!accept(out, cand)) continue;
        const gap = closestGap(out, cand);
        if (gap > window) continue;
        if (gap < bestGap) { best = cand; bestGap = gap; }
      }
      if (!best) continue;
      used.add(best);
      used.add(out);
      const pair = { out, in: best, gapDays: Math.round(bestGap / 86_400_000) };
      if (isTransferRow(out) || isTransferRow(best)) {
        pairs.push(pair);
        settled.add(out);
        settled.add(best);
      } else {
        possible.push(pair);
      }
    }
  };

  sweep((out, cand) => isTransferRow(out) && isTransferRow(cand));
  sweep((out, cand) => isTransferRow(out) || isTransferRow(cand));
  sweep(() => true);

  return { pairs, possible, unpaired: rows.filter((r) => !settled.has(r)) };
}

/** Statement rows that claim to be a transfer but found no counterpart. */
export function orphanTransferLegs(result: CrossResult): LedgerRow[] {
  return result.unpaired.filter((r) => r.source === "statement" && isTransferRow(r));
}

/**
 * Statement rows already accounted for by something in Wallet — the answer to
 * "would writing this duplicate it".
 */
export function alreadyInWallet(result: CrossResult): TransferPair[] {
  return [...result.pairs, ...result.possible].filter(
    (p) => p.out.source !== p.in.source
  );
}

const mark = (p: TransferPair): string =>
  p.out.source === p.in.source ? "" : "  ·ya en Wallet";

export function formatCrossing(pairs: TransferPair[]): string {
  if (pairs.length === 0) return "Sin traspasos pareados entre cuentas.";
  return pairs
    .map((p) => {
      const amount = (Math.abs(p.out.cents) / 100).toFixed(2);
      const gap = p.gapDays > 0 ? ` (${p.gapDays}d)` : "";
      return `${p.out.date} $${amount}  ${p.out.account} → ${p.in.account}${gap}${mark(p)}`;
    })
    .join("\n");
}

export interface BoundarySplit {
  /** Rows at the edge of the period: hold these until the month is complete. */
  deferred: LedgerRow[];
  /** Rows safely inside the period, decidable now. */
  inside: LedgerRow[];
}

/**
 * Holds back the rows at the edges of the month.
 *
 * Banks post a movement days after it happens — measured on the user's own
 * statements, 92% of Banamex movements post on a different day, up to five
 * later — so one made at the end of the month appears on the next statement,
 * and the account it pairs with may not have been extracted yet. Deciding on
 * those before every account is in is how the same movement gets written from
 * both sides. A row inside the period has no such excuse and can be decided.
 */
export function deferNearBoundary(
  rows: LedgerRow[],
  period: StatementPeriod,
  slack?: number
): BoundarySplit {
  const deferred: LedgerRow[] = [];
  const inside: LedgerRow[] = [];
  for (const r of rows) {
    const dates = [r.date, ...(r.opTime !== undefined ? [new Date(r.opTime).toISOString().slice(0, 10)] : [])];
    (dates.some((d) => isNearBoundary(d, period, slack)) ? deferred : inside).push(r);
  }
  return { deferred, inside };
}
