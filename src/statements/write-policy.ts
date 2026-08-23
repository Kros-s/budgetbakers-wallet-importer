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
import { crossTransfers, type LedgerRow, toLedgerRows } from "./crossing.js";
import { describeOwnCounterparty, ownAccountFor } from "./own-accounts.js";
import { CASH_ACCOUNT, expandCashWithdrawals, isCashWithdrawal } from "./cash.js";

/** The categories Wallet uses for a transfer leg, in the spellings the extractor emits. */
export function isTransferRow(row: CsvRow): boolean {
  return /transfer|traspaso/i.test(row.category ?? "");
}

export interface WritePlan {
  /** No counterpart anywhere: safe to write as soon as the statement is read. */
  now: CsvRow[];
  /** Transfer legs: they wait for the month's crossing to find their other half. */
  held: CsvRow[];
  /** Why each held row is held, parallel to `held`. */
  heldReasons: string[];
  /** Later instalments of a deferred purchase, deliberately left out. */
  ignored: CsvRow[];
  /** Cash withdrawals that became a transfer pair against the cash account. */
  cash: CsvRow[];
}

/**
 * Holds a row whose amount is answered by an opposite movement in another
 * account, whatever category it was given.
 *
 * The category alone is not enough. Klar's July statement carried a single
 * +$210,000 row categorised "Financial investments"; its other leg, -$210,000
 * leaving Banorte débito, was already in Wallet. Written on the strength of its
 * category it would have booked a quarter of a million as standalone income.
 *
 * Holding costs a delay; writing costs a duplicate, so a doubtful row waits.
 */
function counterpartHold(
  candidates: CsvRow[],
  account: string,
  elsewhere: LedgerRow[]
): Map<CsvRow, string> {
  if (elsewhere.length === 0) return new Map();
  // Each candidate is converted on its own so the LedgerRow can be tied back to
  // the CsvRow it came from. Converting the batch and indexing by position was
  // wrong: toLedgerRows drops unparseable rows, and every dropped row shifted
  // the mapping — holding an unrelated row and writing the one that needed
  // holding, silently.
  const origin = new Map<LedgerRow, CsvRow>();
  const mine: LedgerRow[] = [];
  for (const row of candidates) {
    for (const led of toLedgerRows(account, [row])) {
      origin.set(led, row);
      mine.push(led);
    }
  }
  const { pairs, possible } = crossTransfers([...mine, ...elsewhere]);
  const byRow = new Map<CsvRow, string>();
  for (const p of [...pairs, ...possible]) {
    for (const [leg, other] of [[p.out, p.in], [p.in, p.out]] as const) {
      const src = origin.get(leg);
      if (!src || other.account === account) continue;
      byRow.set(src, `contraparte de $${Math.abs(other.cents / 100).toFixed(2)} en ${other.account}`);
    }
  }
  return byRow;
}

export function planWrites(
  rows: CsvRow[],
  opts: { account?: string; elsewhere?: LedgerRow[] } = {}
): WritePlan {
  const { writable, ignored } = splitForWriting(rows);
  const now: CsvRow[] = [];
  const held: CsvRow[] = [];
  const heldReasons: string[] = [];

  // Cash first, and ahead of the transfer-category hold. BBVA's withdrawals
  // arrive categorised as a transfer AND marked as cash, and held on the
  // category they would wait for a counterpart no statement will ever bring:
  // the cash account issues none. Its counterpart is the leg written beside it.
  const cash = writable.filter(isCashOut);
  const writable2 = writable.filter((r) => !isCashOut(r));

  const byCategory = writable2.filter(isTransferRow);
  const rest = writable2.filter((r) => !isTransferRow(r));
  for (const row of byCategory) { held.push(row); heldReasons.push("categoría de traspaso"); }

  const hold = opts.account ? counterpartHold(rest, opts.account, opts.elsewhere ?? []) : new Map();
  for (const row of rest) {
    // A counterparty the statement names as one of the user's own accounts,
    // whatever category the extractor reached for. Money leaving says where it
    // goes and was already caught above; money arriving says only who sent it,
    // in the sender's legal name, and read as income — three of those in one
    // month were $285,876.01 of earnings the user never had. Checked before the
    // amount-based hold because it explains itself, and a reason a human can
    // act on is worth more than "some other account had the same figure".
    const own = opts.account
      ? ownAccountFor(counterpartyText(row), opts.account, { payee: row.payee })
      : null;
    if (own) { held.push(row); heldReasons.push(describeOwnCounterparty(own)); continue; }
    const why = hold.get(row);
    if (why) { held.push(row); heldReasons.push(why); } else { now.push(row); }
  }
  return { now: expandCashWithdrawals([...cash, ...now]), held, heldReasons, ignored, cash };
}

/** Money in cash leaving an account — the only shape with a leg to invent. */
function isCashOut(row: CsvRow): boolean {
  return isCashWithdrawal(row) && row.account !== CASH_ACCOUNT && parseFloat(row.amount) < 0;
}

/** Everything on a row that could name the account on the other side. */
function counterpartyText(row: CsvRow): string {
  return [row.desc, row.payee].filter(Boolean).join(" ");
}

export { counterpartyText };

export function describeHeld(held: CsvRow[], reasons: string[] = []): string {
  return held
    .map((r, i) => {
      const why = reasons[i] ? ` — ${reasons[i]}` : "";
      return `${r.date.slice(0, 10)} $${r.amount} ${r.payee || r.note || ""}${why}`;
    })
    .join("\n");
}
