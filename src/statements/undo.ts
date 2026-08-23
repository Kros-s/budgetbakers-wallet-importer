/**
 * @file statements/undo.ts
 * @description Finding what this pipeline wrote, so it can be taken back out.
 *
 * Every record the reconciler writes carries a marker in its note —
 * "[Claude reconcile 2026-07]". That marker is what makes a mistake reversible:
 * without a way to name exactly what a run added, the only recovery from a bad
 * month is restoring nineteen thousand records over a live account, which is a
 * far more dangerous operation than the one that went wrong.
 *
 * Selection is pure and testable here; the deleting happens in the CLI, and
 * never without being asked twice.
 */

import type { WalletRecord } from "../types.js";

/** The note the reconciler stamps on everything it writes. */
export function reconcileMarker(month: string): string {
  return `[Claude reconcile ${month}]`;
}

export interface UndoSelection {
  records: WalletRecord[];
  /** Signed total in cents, so the caller can state what is being undone. */
  netCents: number;
  byAccount: Record<string, { count: number; netCents: number }>;
}

/**
 * Everything a given reconcile run wrote, optionally narrowed to one account.
 *
 * Matching is on the exact marker, not a prefix: "[Claude reconcile 2026-07]"
 * must never select "[Claude reconcile 2026-07-corrected]" or a note the user
 * typed that happens to mention it.
 */
export function selectWritten(
  records: WalletRecord[],
  month: string,
  accountNamesById: Record<string, string>,
  account?: string
): UndoSelection {
  const marker = reconcileMarker(month);
  const chosen = records.filter((r) => {
    if ((r.note ?? "") !== marker) return false;
    if (!account) return true;
    return accountNamesById[r.accountId] === account;
  });

  const byAccount: Record<string, { count: number; netCents: number }> = {};
  let netCents = 0;
  for (const r of chosen) {
    // type 1 is money out, 0 is money in.
    const signed = r.type === 1 ? -r.amount : r.amount;
    netCents += signed;
    const name = accountNamesById[r.accountId] ?? r.accountId;
    byAccount[name] ??= { count: 0, netCents: 0 };
    byAccount[name].count += 1;
    byAccount[name].netCents += signed;
  }
  return { records: chosen, netCents, byAccount };
}

/**
 * Refuses a selection that does not look like one run's work.
 *
 * A marker that matches nothing is a typo, not an empty run, and deleting on a
 * selection nobody checked is how a recovery becomes the incident.
 */
export function describeSelection(sel: UndoSelection, month: string, account?: string): string {
  if (sel.records.length === 0) {
    return `No hay ningún registro con la marca ${reconcileMarker(month)}${account ? ` en ${account}` : ""}.`;
  }
  const lines = [
    `Se quitarían *${sel.records.length}* registro(s) con la marca ${reconcileMarker(month)}:`,
    "",
    ...Object.entries(sel.byAccount).map(
      ([name, s]) => `  ${name.padEnd(22)} ${String(s.count).padStart(4)} · $${(s.netCents / 100).toFixed(2)}`
    ),
    "",
    `Neto que se revierte: $${(sel.netCents / 100).toFixed(2)}`,
  ];
  return lines.join("\n");
}
