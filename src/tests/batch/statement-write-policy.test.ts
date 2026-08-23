import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransferRow, planWrites } from "../../statements/write-policy.js";
import { toWalletRows } from "../../statements/crossing.js";
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

test("a row is held when Wallet already holds its counterpart", () => {
  // The category alone is not enough: a leg can arrive under any category. If
  // an opposite movement of the same size sits in another account, writing this
  // one books the same money twice.
  const elsewhere = toWalletRows(
    [{ accountId: "b", amount: 21000000, type: 1, recordDate: "2026-07-31T12:00:00.000Z" } as never],
    { b: "Banorte débito" }
  );
  const plan = planWrites(
    [row({ account: "Klar", category: "Financial investments", amount: "210000.00", date: "2026-07-31 12:00:00" })],
    { account: "Klar", elsewhere }
  );
  assert.equal(plan.now.length, 0);
  assert.equal(plan.held.length, 1);
  assert.match(plan.heldReasons[0], /contraparte de \$210000\.00 en Banorte débito/);
});

test("an ordinary purchase is not held just because Wallet is busy", () => {
  // Holding costs a delay and writing costs a duplicate, but holding everything
  // would stall the month. Only an OPPOSITE movement of the same size counts.
  const elsewhere = toWalletRows(
    [{ accountId: "b", amount: 5000, type: 1, recordDate: "2026-07-09T12:00:00.000Z" } as never],
    { b: "Bancomer" }
  );
  const plan = planWrites(
    [row({ account: "Costco", category: "Groceries", amount: "-50.00", date: "2026-07-09 12:00:00" })],
    { account: "Costco", elsewhere }
  );
  assert.equal(plan.now.length, 1, "dos salidas del mismo monto no son contraparte");
  assert.equal(plan.held.length, 0);
});

test("without context nothing is held beyond the transfer categories", () => {
  // planWrites must stay usable with no Wallet snapshot to consult.
  const plan = planWrites([row({ category: "Groceries", amount: "-50.00" })]);
  assert.equal(plan.now.length, 1);
});
