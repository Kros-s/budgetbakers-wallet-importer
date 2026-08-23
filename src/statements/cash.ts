/**
 * @file statements/cash.ts
 * @description Cash leaving an account is a transfer, not an expense.
 *
 * BBVA prints an ATM withdrawal as `RETIRO SIN TARJETA QR` with no counterparty
 * at all, so the extractor books it the only way the line reads: money gone,
 * category `Others`. But the money is not gone, it is in the user's pocket, and
 * Wallet has a Cash account for exactly that. Their own records say so —
 * 2026-06-01, `Bancomer -1,600 "Retiro QR a Wallet"` paired with
 * `Wallet +1,600`.
 *
 * Booked as an expense it goes wrong twice: the account loses the money once at
 * the withdrawal and again when the cash is spent, and the Cash account slides
 * further negative every month. July 2026 alone carried four of them, $9,100.
 *
 * The expansion happens at the point of writing rather than at extraction, for
 * the same reason instalments do (see `installments.ts`): the statement's own
 * totals count one movement, and emitting two would stop the extraction adding
 * up against the figure the bank publishes — which is the check that guards
 * `--write`.
 *
 * Unlike a transfer between two banks, this pair does not wait for a crossing.
 * The cash account issues no statement, so there is no second document to wait
 * for; the counterpart can only ever be the one written here.
 */

import type { CsvRow } from "../csv.js";
import { TRANSFER_CATEGORY } from "./crossing.js";

/** The Wallet account that holds physical cash. */
export const CASH_ACCOUNT = "Wallet";

export { TRANSFER_CATEGORY };

/** The statement's own marker, set by the extractor — never guessed from the text. */
export function isCashWithdrawal(row: CsvRow): boolean {
  return row.efectivo?.trim() === "1";
}

/**
 * Turns each cash withdrawal into the two legs it actually is.
 *
 * The note is copied verbatim onto the mirror leg, marker and all. `undo`
 * selects on an exact note match, so a leg carrying anything else — however
 * much more helpful it reads — is a record the undo cannot take back out, and
 * undoing one half of a transfer is worse than undoing neither.
 *
 * A row already sitting on the cash account is left alone: a transfer needs two
 * different accounts, and mirroring it would pair `Wallet` with itself.
 */
export function expandCashWithdrawals(rows: CsvRow[], cashAccount = CASH_ACCOUNT): CsvRow[] {
  const out: CsvRow[] = [];
  for (const row of rows) {
    if (!isCashWithdrawal(row) || row.account === cashAccount) {
      out.push(row);
      continue;
    }
    const amount = parseFloat(row.amount);
    // Only money LEAVING an account can become cash in hand. A positive row
    // marked as cash is a deposit of notes, which has no second leg to invent.
    if (!Number.isFinite(amount) || amount >= 0) {
      out.push(row);
      continue;
    }
    // `efectivo` is cleared on both legs so a second pass leaves them alone.
    // `guardWrite` re-runs this defensively for callers that skipped
    // `planWrites`, and expanding an expanded pair yields four legs and two
    // withdrawals where the bank recorded one.
    out.push({ ...row, category: TRANSFER_CATEGORY, payee: row.payee || "Efectivo", efectivo: undefined });
    out.push({
      ...row,
      account: cashAccount,
      amount: Math.abs(amount).toFixed(2),
      category: TRANSFER_CATEGORY,
      payee: row.payee || "Efectivo",
      efectivo: undefined,
      // The mirror leg is ours, not the statement's: it has no operation date,
      // no instalment marker and no foreign-currency figure of its own.
      opdate: undefined,
      meses: undefined,
      montooriginal: undefined,
      mxn: undefined,
      desc: row.desc ? `Contrapartida en efectivo de: ${row.desc}` : undefined,
    });
  }
  return out;
}

/** How the expansion reads in the report. */
export function describeCash(rows: CsvRow[], cashAccount = CASH_ACCOUNT): string {
  return rows
    .filter((r) => isCashWithdrawal(r) && r.account !== cashAccount && parseFloat(r.amount) < 0)
    .map((r) => `${r.date.slice(0, 10)} $${Math.abs(parseFloat(r.amount)).toFixed(2)} ${r.account} → ${cashAccount}`)
    .join("\n");
}
