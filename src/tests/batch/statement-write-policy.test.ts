import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransferRow, planWrites } from "../../statements/write-policy.js";
import type { CsvRow } from "../../csv.js";

const row = (over: Partial<CsvRow> = {}): CsvRow => ({
  date: "2026-07-09 12:00:00", account: "MIFEL", amount: "-10.00",
  category: "Others", note: "", payee: "", ...over,
});

test("a transfer leg waits; everything else does not", () => {
  // A transfer has two legs in two statements, so writing the one you have
  // books half a movement and books it again when the counterpart arrives.
  // A purchase or an interest payment exists on one statement only.
  const plan = planWrites([
    row({ category: "Interests, dividends", amount: "72.27" }),
    row({ category: "Taxes", amount: "-6.50" }),
    row({ category: "Transfer, withdraw", amount: "3268.48" }),
    row({ category: "Groceries", amount: "-540.00" }),
  ]);
  assert.deepEqual(plan.now.map((r) => r.category), ["Interests, dividends", "Taxes", "Groceries"]);
  assert.deepEqual(plan.held.map((r) => r.category), ["Transfer, withdraw"]);
});

test("the transfer category is recognised in the spellings the extractor emits", () => {
  assert.equal(isTransferRow(row({ category: "Transfer, withdraw" })), true);
  assert.equal(isTransferRow(row({ category: "Traspaso" })), true);
  assert.equal(isTransferRow(row({ category: "Interests, dividends" })), false);
  assert.equal(isTransferRow(row({ category: "" })), false);
});

test("instalments are still excluded, and are not confused with held transfers", () => {
  // Three separate outcomes: written now, waiting for the month, never written.
  const plan = planWrites([
    row({ meses: "4/6", amount: "-5480.00" }),
    row({ category: "Transfer, withdraw", amount: "3268.48" }),
    row({ category: "Interests, dividends", amount: "72.27" }),
  ]);
  assert.equal(plan.ignored.length, 1);
  assert.equal(plan.held.length, 1);
  assert.equal(plan.now.length, 1);
});

test("a first instalment is written now, at its full price", () => {
  // It is a purchase, not a transfer — nothing about it needs the month.
  const plan = planWrites([row({ meses: "1/6", amount: "-5480.00", montooriginal: "32880.00" })]);
  assert.equal(plan.now.length, 1);
  assert.equal(plan.now[0].amount, "-32880.00");
});

test("MIFEL's July is entirely writable on arrival", () => {
  // 23 interest payments and 23 tax withholdings, no transfers: nothing about
  // that month needs another statement to exist first.
  const rows = Array.from({ length: 23 }).flatMap(() => [
    row({ category: "Interests, dividends", amount: "72.27" }),
    row({ category: "Taxes", amount: "-6.50" }),
  ]);
  const plan = planWrites(rows);
  assert.equal(plan.now.length, 46);
  assert.equal(plan.held.length, 0);
});
