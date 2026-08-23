import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeIgnored, isFirstInstallment, isLaterInstallment, parseInstallment, splitForWriting,
} from "../../statements/installments.js";
import type { CsvRow } from "../../csv.js";

const row = (over: Partial<CsvRow> = {}): CsvRow => ({
  date: "2026-02-09 12:00:00", account: "Costco", amount: "-5480.00",
  category: "Others", note: "", payee: "MERCADO PAGO", ...over,
});

test("the statement's own instalment column is read, in both house styles", () => {
  // Banamex writes "004 de 006"; Banorte writes "03/03".
  assert.deepEqual(parseInstallment(row({ meses: "004 de 006" })), { index: 4, total: 6 });
  assert.deepEqual(parseInstallment(row({ meses: "03/03" })), { index: 3, total: 3 });
  assert.deepEqual(parseInstallment(row({ meses: "1/12" })), { index: 1, total: 12 });
});

test("nothing is inferred from a row without the column", () => {
  // A payee ending in "12/25" is a date far more often than an instalment, so
  // the description is never mined for one.
  assert.equal(parseInstallment(row({ payee: "OXXO 12/25" })), null);
  assert.equal(parseInstallment(row()), null);
});

test("a nonsensical marker is refused", () => {
  assert.equal(parseInstallment(row({ meses: "7 de 6" })), null);
  assert.equal(parseInstallment(row({ meses: "1 de 1" })), null);
  assert.equal(parseInstallment(row({ meses: "0 de 6" })), null);
  assert.equal(parseInstallment(row({ meses: "meses" })), null);
});

test("only the first instalment is the purchase", () => {
  assert.equal(isFirstInstallment(row({ meses: "1/6" })), true);
  assert.equal(isFirstInstallment(row({ meses: "4/6" })), false);
  assert.equal(isLaterInstallment(row({ meses: "4/6" })), true);
  assert.equal(isLaterInstallment(row({ meses: "1/6" })), false);
});

test("the purchase is written once, for its full price", () => {
  // The real Banamex case: $32,880 in six, charged $5,480 this period. The
  // point of recording it once is that the whole purchase lands in the month it
  // happened, not a sixth of it.
  const { writable, ignored } = splitForWriting([
    row({ meses: "1/6", amount: "-5480.00", montooriginal: "32880.00" }),
  ]);
  assert.deepEqual(ignored, []);
  assert.equal(writable[0].amount, "-32880.00");
});

test("the later instalments of that purchase are left out", () => {
  const { writable, ignored } = splitForWriting([
    row({ meses: "4/6", amount: "-5480.00" }),
    row({ meses: "5/6", amount: "-5480.00" }),
    row({ amount: "-165.00", payee: "PORTAL DE FUEGO" }),
  ]);
  assert.equal(writable.length, 1);
  assert.equal(writable[0].payee, "PORTAL DE FUEGO");
  assert.equal(ignored.length, 2);
});

test("a first instalment without the original total keeps what it has", () => {
  // A wrong total would be worse than a partial one.
  const { writable } = splitForWriting([row({ meses: "1/6", amount: "-5480.00" })]);
  assert.equal(writable[0].amount, "-5480.00");
});

test("the sign of the purchase survives the restatement", () => {
  const { writable } = splitForWriting([
    row({ meses: "1/3", amount: "-100.00", montooriginal: "300.00" }),
    row({ meses: "1/3", amount: "250.00", montooriginal: "750.00" }),
  ]);
  assert.equal(writable[0].amount, "-300.00");
  assert.equal(writable[1].amount, "750.00");
});

test("an ordinary movement passes straight through", () => {
  const rows = [row({ amount: "-165.00" }), row({ amount: "-242.00" })];
  const { writable, ignored } = splitForWriting(rows);
  assert.deepEqual(writable, rows);
  assert.deepEqual(ignored, []);
});

test("what was ignored is named, with its ordinal", () => {
  const out = describeIgnored([row({ meses: "004 de 006" })]);
  assert.match(out, /MERCADO PAGO \(4\/6\)/);
});

test("a thousands separator does not divide the purchase by a thousand", () => {
  // parseFloat("32,880.00") is 32 — it stops at the comma. The deferred-purchase
  // "Original" column is exactly where a bank prints one.
  const { writable } = splitForWriting([
    row({ meses: "1/6", amount: "-5480.00", montooriginal: "32,880.00" }),
  ]);
  assert.equal(writable[0].amount, "-32880.00");
});

test("a currency symbol or stray space is tolerated too", () => {
  const { writable } = splitForWriting([
    row({ meses: "1/3", amount: "-100.00", montooriginal: " $ 1,234.56 " }),
  ]);
  assert.equal(writable[0].amount, "-1234.56");
});
