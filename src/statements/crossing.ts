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

import type { CsvRow } from "../csv.js";

export interface LedgerRow {
  account: string;
  row: CsvRow;
  /** Signed cents: negative leaves the account, positive arrives. */
  cents: number;
  /** Epoch ms of the movement date. */
  time: number;
}

export interface TransferPair {
  out: LedgerRow;
  in: LedgerRow;
  /** Days between the two legs. */
  gapDays: number;
}

export interface CrossResult {
  pairs: TransferPair[];
  /** Rows left over: genuine one-sided movements, or a leg whose other half never arrived. */
  unpaired: LedgerRow[];
}

/** Banks post the two sides on different days; beyond this it stops being one movement. */
export const DEFAULT_GAP_DAYS = 4;

export function toLedgerRows(account: string, rows: CsvRow[]): LedgerRow[] {
  return rows.map((row) => ({
    account,
    row,
    cents: Math.round(parseFloat(row.amount) * 100),
    time: Date.parse(row.date.replace(" ", "T")),
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
export function crossTransfers(rows: LedgerRow[], gapDays = DEFAULT_GAP_DAYS): CrossResult {
  const window = gapDays * 86_400_000;
  const outs = rows.filter((r) => r.cents < 0).sort((a, b) => a.time - b.time);
  const ins = rows.filter((r) => r.cents > 0).sort((a, b) => a.time - b.time);
  const used = new Set<LedgerRow>();
  const pairs: TransferPair[] = [];

  for (const out of outs) {
    let best: LedgerRow | undefined;
    let bestGap = Infinity;
    for (const cand of ins) {
      if (used.has(cand)) continue;
      if (cand.account === out.account) continue;
      if (cand.cents !== -out.cents) continue;
      const gap = Math.abs(cand.time - out.time);
      if (gap > window) continue;
      if (gap < bestGap) { best = cand; bestGap = gap; }
    }
    if (best) {
      used.add(best);
      used.add(out);
      pairs.push({ out, in: best, gapDays: Math.round(bestGap / 86_400_000) });
    }
  }

  return { pairs, unpaired: rows.filter((r) => !used.has(r)) };
}

/** Rows that claim to be a transfer but found no counterpart — the ones worth naming. */
export function orphanTransferLegs(result: CrossResult): LedgerRow[] {
  return result.unpaired.filter((r) => /transfer/i.test(r.row.category ?? ""));
}

export function formatCrossing(result: CrossResult): string {
  if (result.pairs.length === 0) return "Sin traspasos pareados entre cuentas.";
  const lines = result.pairs.map((p) => {
    const amount = (Math.abs(p.out.cents) / 100).toFixed(2);
    const when = p.out.row.date.slice(0, 10);
    const gap = p.gapDays > 0 ? ` (${p.gapDays}d)` : "";
    return `${when} $${amount}  ${p.out.account} → ${p.in.account}${gap}`;
  });
  return lines.join("\n");
}
