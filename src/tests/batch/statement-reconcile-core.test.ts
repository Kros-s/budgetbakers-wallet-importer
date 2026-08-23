import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DATE_SLACK_DAYS, diff, mayMarkReconciled, mayRetireStatement, unresolvedCount,
} from "../../statements/reconcile-core.js";
import type { CsvRow } from "../../csv.js";
import type { WalletRecord } from "../../types.js";

const ACC = "-Account_costco";
const OTHER = "-Account_bancomer";

const row = (over: Partial<CsvRow> = {}): CsvRow => ({
  date: "2026-07-05 12:00:00", account: "Costco", amount: "-540.00",
  category: "Groceries", note: "[Claude reconcile 2026-07]", payee: "COMERCIO XYZ", ...over,
});

let seq = 0;
const rec = (over: Partial<WalletRecord> = {}): WalletRecord => ({
  _id: `Record_${++seq}`, accountId: ACC, amount: 54000, type: 1,
  recordDate: onRowDate(0), payee: "COMERCIO XYZ", ...over,
} as unknown as WalletRecord);

/**
 * A record dated `days` away from the default row's charge date.
 *
 * Built by arithmetic on the row's own parsed date, never by writing an ISO
 * string by hand: the row's date is parsed as LOCAL time and `recordDate` is
 * UTC, so a hand-written "2026-07-10T12:00:00.000Z" is the machine's offset
 * away from five days and the boundary tests would pass or fail by timezone.
 */
function onRowDate(days: number): string {
  return new Date(Date.parse("2026-07-05T12:00:00") + days * 86_400_000).toISOString();
}

// ── diff: the matcher ────────────────────────────────────────────────────────

test("a statement row the Wallet record answers exactly is matched, not written", () => {
  // The base case the whole write path rests on: if this reads as missing,
  // --write books a movement Wallet already holds.
  const d = diff([row()], [rec()], ACC);
  assert.equal(d.matched, 1);
  assert.deepEqual(d.missing, []);
  assert.deepEqual(d.ambiguous, []);
  assert.deepEqual(d.walletOnly, []);
});

test("five days between the alert and the posting still match", () => {
  // The measured operation-to-posting lag reaches five days at Banamex. At
  // three, a purchase recorded from its alert failed to match the statement's
  // posting date, landed in missing, and --write booked it a second time.
  assert.equal(DATE_SLACK_DAYS, 5);
  for (const sign of [1, -1]) {
    const d = diff([row()], [rec({ recordDate: onRowDate(sign * DATE_SLACK_DAYS) })], ACC);
    assert.equal(d.matched, 1, `${sign * DATE_SLACK_DAYS} días debería casar`);
    assert.equal(d.missing.length, 0);
  }
});

test("six days apart is a different movement", () => {
  // The slack has to end somewhere: beyond it the row is reported as missing
  // and the untouched record is reported as Wallet-only, so a human sees both
  // halves of the disagreement instead of a silent match.
  const d = diff([row()], [rec({ recordDate: onRowDate(DATE_SLACK_DAYS + 1) })], ACC);
  assert.equal(d.matched, 0);
  assert.equal(d.missing.length, 1);
  assert.equal(d.walletOnly.length, 1);
});

test("two Wallet candidates for one row are reported as a possible duplicate in Wallet", () => {
  // Wallet holding the movement twice is not something the statement can
  // decide. The row is not written, one record is consumed, and the leftover
  // surfaces as Wallet-only so the duplicate is visible from both sides.
  const d = diff([row()], [rec(), rec({ recordDate: onRowDate(1) })], ACC);
  assert.equal(d.missing.length, 0);
  assert.equal(d.ambiguous.length, 1);
  assert.match(d.ambiguous[0].reason, /2 registros candidatos/);
  // Preserved oddity: an ambiguous row is ALSO counted as matched.
  assert.equal(d.matched, 1);
  assert.equal(d.walletOnly.length, 1);
});

test("one Wallet record cannot answer two identical statement lines", () => {
  // A bank that charged the same amount twice on the same day, against a
  // Wallet holding one record. Letting the second line match the same record
  // would report a genuinely missing charge as already registered; letting it
  // fall to missing would double-book when the extraction read one line twice.
  // It goes to the human, and the record is not offered again.
  const d = diff([row(), row()], [rec()], ACC);
  assert.equal(d.matched, 1);
  assert.equal(d.missing.length, 0);
  assert.equal(d.ambiguous.length, 1);
  assert.match(d.ambiguous[0].reason, /ya casó con otra línea/);
  assert.equal(d.walletOnly.length, 0);
});

test("a row whose posting date is far matches on its operation date", () => {
  // "MERPAGO*SAMSUNG 03/03" was operated 09-ene and charged 10-feb. Wallet
  // holds it under the date the alert fired; only the operation date reaches
  // it, and without that reach the instalment reads as missing every month.
  const d = diff(
    [row({ date: "2026-08-10 12:00:00", opdate: "2026-07-06" })],
    [rec({ recordDate: onRowDate(1) })],
    ACC
  );
  assert.equal(d.matched, 1);
  assert.equal(d.missing.length, 0);
});

test("a Wallet record the statement never mentions is reported, never touched", () => {
  // Cash the user typed by hand, or a movement the extraction dropped. Either
  // way it is not the statement's to write or delete — only to show.
  const ghost = rec({ amount: 12300, payee: "EFECTIVO" });
  const d = diff([row()], [rec(), ghost], ACC);
  assert.equal(d.matched, 1);
  assert.deepEqual(d.walletOnly.map((r) => r._id), [ghost._id]);
});

test("another account's records are neither matched nor reported", () => {
  // The window is fetched across ALL accounts for the transfer crossing, so
  // the diff has to filter. Without it, Bancomer's July would show up as this
  // statement's Wallet-only rows and a same-amount purchase would match here.
  const d = diff([row()], [rec({ accountId: OTHER })], ACC);
  assert.equal(d.matched, 0);
  assert.equal(d.missing.length, 1);
  assert.deepEqual(d.walletOnly, []);
});

test("direction is part of the identity: a refund does not match the charge", () => {
  // type 1 = money out, 0 = money in, and `amount` is unsigned, so the sign of
  // the statement row is the ONLY thing separating a $540 charge from a $540
  // refund. Matching on the absolute amount alone would hide both.
  const d = diff([row({ amount: "540.00" })], [rec({ type: 1 })], ACC);
  assert.equal(d.matched, 0);
  assert.equal(d.missing.length, 1);
  assert.equal(d.walletOnly.length, 1);
});

test("the amount is compared in cents, rounded, not in floats", () => {
  // parseFloat("-1234.56") * 100 is 123455.99999999999 in IEEE 754. Without
  // the rounding every centavo-precise row on the statement would read as
  // missing and be written again.
  const d = diff([row({ amount: "-1234.56" })], [rec({ amount: 123456 })], ACC);
  assert.equal(d.matched, 1);
});

test("a row with an unreadable date finds nothing instead of matching everything", () => {
  // Date.parse returns NaN and every comparison against it is false; the guard
  // is what stops that NaN from being treated as "within slack of anything".
  const d = diff([row({ date: "not a date" })], [rec()], ACC);
  assert.equal(d.matched, 0);
  assert.equal(d.missing.length, 1);
  assert.equal(d.walletOnly.length, 1);
});

test("a month with nothing to reconcile diffs to an empty verdict", () => {
  const d = diff([], [], ACC);
  assert.deepEqual(d, { missing: [], matched: 0, ambiguous: [], walletOnly: [], grouped: [] });
});

// ── Closing the month and retiring the PDF ───────────────────────────────────

const clean = { held: 0, ambiguous: 0, skipped: 0, blocked: false };

test("a month is marked reconciled only when nothing at all is left open", () => {
  assert.equal(mayMarkReconciled(clean), true);
  assert.equal(unresolvedCount(clean), 0);
});

test("each kind of leftover keeps the month open on its own", () => {
  // Marking on `held` alone let ambiguous rows and rows the converter refused
  // vanish into a month the registry then never chased again.
  assert.equal(mayMarkReconciled({ ...clean, held: 1 }), false);
  assert.equal(mayMarkReconciled({ ...clean, ambiguous: 1 }), false);
  assert.equal(mayMarkReconciled({ ...clean, skipped: 1 }), false);
  assert.equal(unresolvedCount({ held: 2, ambiguous: 3, skipped: 4 }), 9);
});

test("a write the integrity check blocked does not close the month", () => {
  // Nothing reached Wallet, so there is nothing to call reconciled — even
  // though no single row is held, ambiguous or skipped.
  assert.equal(mayMarkReconciled({ ...clean, blocked: true }), false);
});

test("the PDF is kept while any row still needs it", () => {
  // Held and skipped rows are why you come back to the PDF: a lone transfer
  // leg is refused by design and is paired by hand from the statement.
  assert.equal(mayRetireStatement(clean), true);
  assert.equal(mayRetireStatement({ held: 1, ambiguous: 0, skipped: 0 }), false);
  assert.equal(mayRetireStatement({ held: 0, ambiguous: 1, skipped: 0 }), false);
  assert.equal(mayRetireStatement({ held: 0, ambiguous: 0, skipped: 1 }), false);
});

test("integrity blocking the write does NOT keep the PDF — preserved as it is", () => {
  // Deliberate mirror of today's CLI, not an endorsement: the month stays open
  // while the PDF that would let you re-run it is deleted. Documented in the
  // module; changing it is a behaviour change, not part of the extraction.
  const blockedRun = { ...clean, blocked: true };
  assert.equal(mayMarkReconciled(blockedRun), false);
  assert.equal(mayRetireStatement(blockedRun), true);
});

// ── A movement the statement itemises and Wallet holds netted ─────────────

test("a deposit and its fee are answered by the single net record Wallet holds", () => {
  // DolarApp publishes `Compra USDc +3,600` and `Comisión -3`; Wallet holds the
  // $3,597 that actually arrived. Row by row neither matches, so both were
  // written on top of the record already there — $7,154 duplicated in June.
  const rows: CsvRow[] = [
    { date: "2026-06-22 12:00:00", account: "DolarApp", amount: "3600.00", category: "Others", note: "", payee: "TRUSTPOINT IT ST" },
    { date: "2026-06-22 12:00:00", account: "DolarApp", amount: "-3.00", category: "Charges, Fees", note: "", payee: "Compra USDc comisión" },
  ];
  const net: WalletRecord = {
    _id: "Record_net", accountId: "-Account_dolarapp", amount: 359700, type: 0,
    recordDate: "2026-06-22T12:00:00.000-06:00", payee: "TRUSTPOINT IT ST",
  } as WalletRecord;
  const d = diff(rows, [net], "-Account_dolarapp");
  assert.equal(d.missing.length, 0);
  assert.equal(d.matched, 2);
  assert.equal(d.walletOnly.length, 0);
  assert.equal(d.grouped.length, 1);
  assert.deepEqual(d.grouped[0].rows.map((r) => r.amount).sort(), ["-3.00", "3600.00"]);
});

const bd = (amount: string, payee: string, date = "2026-05-22 12:00:00"): CsvRow =>
  ({ date, account: "Banorte débito", amount, category: "Others", note: "", payee });

test("four same-day lines are answered by the one record Wallet holds for them", () => {
  // Banorte débito publishes an early mortgage payoff as four lines on one day;
  // Wallet holds a single $202,967.00 record. Same-sign, so no opposite-sign
  // rule could ever reach it, and `--write` would have posted all four on top.
  const rows = [
    bd("-299.00", "ADMINISTRACION"),
    bd("-178901.66", "PAGO DE CAPITAL"),
    bd("-21568.34", "INTERESES"),
    bd("-2198.00", "PAGO DE SEGUROS"),
  ];
  const lump: WalletRecord = {
    _id: "Record_lump", accountId: "-Account_banorte", amount: 20296700, type: 1,
    recordDate: "2026-05-22T12:00:00.000-06:00", note: "[Claude] Pago anticipado hipoteca",
  } as WalletRecord;
  const d = diff(rows, [lump], "-Account_banorte");
  assert.equal(d.missing.length, 0);
  assert.equal(d.walletOnly.length, 0);
  assert.equal(d.grouped.length, 1);
  assert.equal(d.grouped[0].rows.length, 4);
});

test("two different combinations reaching the same figure are left for a human", () => {
  // That is what a coincidence looks like, and guessing between them writes
  // some real movements and hides others.
  const rows = [bd("-50.00", "A"), bd("-50.00", "B"), bd("-100.00", "C")];
  const rec: WalletRecord = {
    _id: "Record_100", accountId: "-Account_banorte", amount: 10000, type: 1,
    recordDate: "2026-05-22T12:00:00.000-06:00",
  } as WalletRecord;
  const d = diff(rows, [rec], "-Account_banorte");
  assert.equal(d.grouped.length, 0);
});

test("lines spread across days are not one movement", () => {
  // A bank splits one movement across lines on the day it happens, not across
  // a week — and a week of unmatched rows is where subset-sum finds ghosts.
  const rows = [bd("-182.00", "A", "2026-05-20 12:00:00"), bd("-18.00", "B", "2026-05-22 12:00:00")];
  const rec: WalletRecord = {
    _id: "Record_200", accountId: "-Account_banorte", amount: 20000, type: 1,
    recordDate: "2026-05-21T12:00:00.000-06:00",
  } as WalletRecord;
  const d = diff(rows, [rec], "-Account_banorte");
  assert.equal(d.grouped.length, 0);
  assert.equal(d.missing.length, 2);
});

test("a pair too far from the record is not grouped", () => {
  const rows: CsvRow[] = [
    { date: "2026-06-01 12:00:00", account: "DolarApp", amount: "3600.00", category: "Others", note: "", payee: "X" },
    { date: "2026-06-01 12:00:00", account: "DolarApp", amount: "-3.00", category: "Charges, Fees", note: "", payee: "Y" },
  ];
  const net: WalletRecord = {
    _id: "Record_far", accountId: "-Account_dolarapp", amount: 359700, type: 0,
    recordDate: "2026-06-22T12:00:00.000-06:00",
  } as WalletRecord;
  const d = diff(rows, [net], "-Account_dolarapp");
  assert.equal(d.grouped.length, 0);
  assert.equal(d.missing.length, 2);
  assert.equal(d.walletOnly.length, 1);
});
