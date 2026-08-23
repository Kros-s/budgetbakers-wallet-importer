import { test } from "node:test";
import assert from "node:assert/strict";
import { CASH_ACCOUNT, describeCash, expandCashWithdrawals, isCashWithdrawal } from "../../statements/cash.js";
import type { CsvRow } from "../../csv.js";

const row = (over: Partial<CsvRow> = {}): CsvRow => ({
  date: "2026-06-25 12:00:00", account: "Bancomer", amount: "-2600.00",
  category: "Others", note: "[Claude reconcile 2026-07]", payee: "Retiro sin tarjeta QR",
  efectivo: "1", ...over,
});

test("a withdrawal becomes two legs that convertRows can pair", () => {
  // The four conditions convertRows links a pair on: same transfer category,
  // identical date string, equal unsigned amount, opposite sign, two accounts.
  const [out, into] = expandCashWithdrawals([row()]);
  assert.equal(out.account, "Bancomer");
  assert.equal(into.account, CASH_ACCOUNT);
  assert.equal(out.date, into.date);
  assert.equal(out.category, into.category);
  assert.equal(out.amount, "-2600.00");
  assert.equal(into.amount, "2600.00");
});

test("the mirror leg carries the marker verbatim so undo can take it back", () => {
  // `selectWritten` matches the note exactly. A leg with a friendlier note is a
  // record the undo cannot remove, and half an undone transfer is worse than none.
  const [, into] = expandCashWithdrawals([row()]);
  assert.equal(into.note, "[Claude reconcile 2026-07]");
});

test("expanding twice yields the same two legs", () => {
  // guardWrite re-runs this for callers that skipped planWrites. Without the
  // marker being cleared, one withdrawal would become two.
  const once = expandCashWithdrawals([row()]);
  const twice = expandCashWithdrawals(once);
  assert.equal(twice.length, 2);
  assert.deepEqual(twice, once);
});

test("only money leaving an account becomes cash in hand", () => {
  // A positive row has no second leg to invent, and a row already on the cash
  // account would pair Wallet with itself.
  assert.deepEqual(expandCashWithdrawals([row({ amount: "500.00" })]).length, 1);
  assert.deepEqual(expandCashWithdrawals([row({ account: CASH_ACCOUNT })]).length, 1);
  assert.deepEqual(expandCashWithdrawals([row({ efectivo: "" })]).length, 1);
  assert.deepEqual(expandCashWithdrawals([row({ amount: "no" })]).length, 1);
});

test("the marker is the statement's, never guessed from the description", () => {
  assert.equal(isCashWithdrawal(row()), true);
  assert.equal(isCashWithdrawal(row({ efectivo: undefined })), false);
  // The payee says "retiro" but the extractor did not mark it: a transfer to
  // another bank reads the same way and is not cash.
  assert.equal(isCashWithdrawal(row({ efectivo: "", payee: "RETIRO SIN TARJETA QR" })), false);
});

test("the statement's own figures survive on the leg that came from it", () => {
  const [out, into] = expandCashWithdrawals([row({ opdate: "2026-06-24", desc: "RETIRO SIN TARJETA QR ******6513" })]);
  assert.equal(out.opdate, "2026-06-24");
  // The mirror leg is ours, not the bank's: it has no operation date of its own.
  assert.equal(into.opdate, undefined);
  assert.match(into.desc ?? "", /Contrapartida en efectivo/);
});

test("the report names the account the cash went to", () => {
  assert.equal(describeCash([row()]), "2026-06-25 $2600.00 Bancomer → Wallet");
});
