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

test("an unparseable row does not shift the hold onto its neighbour", () => {
  // toLedgerRows drops rows it cannot read, and indexing back by position meant
  // every dropped row shifted the mapping: an unrelated row was held and the
  // one that needed holding was written.
  const elsewhere = toWalletRows(
    [{ accountId: "b", amount: 123400, type: 0, recordDate: "2026-07-09T12:00:00.000Z" } as never],
    { b: "Bancomer" }
  );
  const plan = planWrites(
    [
      row({ account: "Costco", amount: "no-es-un-monto", payee: "FILA MALA" }),
      row({ account: "Costco", amount: "-1234.00", payee: "LA QUE DEBE RETENERSE", date: "2026-07-09 12:00:00" }),
    ],
    { account: "Costco", elsewhere }
  );
  assert.deepEqual(plan.held.map((r) => r.payee), ["LA QUE DEBE RETENERSE"]);
  assert.deepEqual(plan.now.map((r) => r.payee), ["FILA MALA"]);
});

// ── An arrival from one of your own accounts ──────────────────────────────
// Money leaving names where it goes and was already held above. Money arriving
// names only who sent it, in the sender's legal name, and read as income.

const ARQ_DESC =
  "SPEI RECIBIDOARCUS FI 6062885Sent from ARQ Referencia 0194292099 706 " +
  "00706180105819089043 PIER 5, S.A de C.V.";

test("an inflow whose sender is one of your own accounts waits for the crossing", () => {
  // Bancomer's July 2026: three of these, $285,876.01, every one categorised
  // Others because nothing on the line says DolarApp.
  const plan = planWrites(
    [row({ account: "Bancomer", amount: "59485.33", category: "Others", payee: "PIER 5, S.A de C.V.", desc: ARQ_DESC })],
    { account: "Bancomer" }
  );
  assert.equal(plan.now.length, 0);
  assert.equal(plan.held.length, 1);
  assert.equal(plan.heldReasons[0], "contraparte es tu cuenta DolarApp");
});

test("real income from a third party is still written", () => {
  // The same statement, the same shape of line, a genuine client payment.
  const plan = planWrites(
    [row({
      account: "Bancomer", amount: "10000.00", category: "Others",
      payee: "Hosting - Banamex", desc: "SPEI RECIBIDOBANAMEX 0160726Hosting Referencia 0178549454 002",
    })],
    { account: "Bancomer" }
  );
  assert.equal(plan.now.length, 1);
  assert.equal(plan.held.length, 0);
});

test("the hold does not fire on the statement's own issuer", () => {
  // A Banorte statement says "Banorte" on every page; without the guard every
  // row on it would be held as a transfer to itself and the month never closes.
  const plan = planWrites(
    [row({ account: "Banorte débito", amount: "-450.00", category: "Groceries", desc: "COMPRA BANORTE DEBITO SUC 1234" })],
    { account: "Banorte débito" }
  );
  assert.equal(plan.now.length, 1);
});

test("a cash withdrawal leaves as a pair, and is not held waiting for a statement", () => {
  // The cash account issues no statement, so a leg held for its counterpart
  // would wait forever. Both legs are produced here instead.
  const plan = planWrites(
    [row({ account: "Bancomer", amount: "-2600.00", category: "Others", payee: "Retiro sin tarjeta QR", efectivo: "1" })],
    { account: "Bancomer" }
  );
  assert.equal(plan.held.length, 0);
  assert.equal(plan.cash.length, 1);
  assert.deepEqual(plan.now.map((r) => r.account), ["Bancomer", "Wallet"]);
  assert.deepEqual(plan.now.map((r) => r.amount), ["-2600.00", "2600.00"]);
});
