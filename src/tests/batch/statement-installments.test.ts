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

// ── A purchase deferred inside the statement that charged it ──────────────

const platinum = (over: Partial<CsvRow>): CsvRow => ({
  date: "2026-07-06 12:00:00", account: "Platinum Credit Card", amount: "-2656.67",
  category: "Others", note: "[Claude reconcile 2026-07]", payee: "MESES EN AUTOMATICO NACIONAL",
  ...over,
});

test("a deferral that happens inside one statement is not written twice", () => {
  // Amex Platinum's July carries all three sides of one $7,970 purchase: the
  // charge, a credit taking it back out of the revolving balance, and the first
  // instalment. Read separately it wrote $7,970 twice and held the credit
  // forever as a transfer nothing will ever answer.
  const rows = [
    platinum({ date: "2026-06-22 12:00:00", amount: "-7970.00", payee: "NETPAY*REAL SPORT", category: "Active sport, fitness" }),
    platinum({ amount: "7970.00", payee: "AMERICAN EXPRESS", category: "Transfer, withdraw" }),
    platinum({ amount: "-2656.67", meses: "1/3", montooriginal: "7970.00" }),
  ];
  const { writable, ignored } = splitForWriting(rows);
  // The purchase survives, at its real date and its real merchant.
  assert.deepEqual(writable.map((r) => r.payee), ["NETPAY*REAL SPORT"]);
  assert.equal(writable[0].amount, "-7970.00");
  assert.equal(ignored.length, 2);
});

test("a first instalment whose purchase predates the statement is still restated", () => {
  // No credit, no original charge: the purchase was billed in an earlier
  // period, and the instalment row is all there is.
  const { writable, ignored } = splitForWriting([
    platinum({ amount: "-2656.67", meses: "1/3", montooriginal: "7970.00" }),
  ]);
  assert.equal(writable.length, 1);
  assert.equal(writable[0].amount, "-7970.00");
  assert.equal(ignored.length, 0);
});

test("the deferral credit goes even when the original charge does not appear", () => {
  // The credit is an entry of the issuer's, not money that moved, so it never
  // survives — but without the charge the instalment still carries the purchase.
  const { writable, ignored } = splitForWriting([
    platinum({ amount: "7970.00", payee: "AMERICAN EXPRESS", category: "Transfer, withdraw" }),
    platinum({ amount: "-2656.67", meses: "1/3", montooriginal: "7970.00" }),
  ]);
  assert.deepEqual(writable.map((r) => r.amount), ["-7970.00"]);
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].payee, "AMERICAN EXPRESS");
});

test("an unrelated charge of the same size is not mistaken for the purchase", () => {
  // Without a deferral credit there is no deferral to resolve, so a coincidence
  // of amount changes nothing.
  const { writable } = splitForWriting([
    platinum({ date: "2026-06-22 12:00:00", amount: "-7970.00", payee: "OTRA COMPRA" }),
    platinum({ amount: "-2656.67", meses: "1/3", montooriginal: "7970.00" }),
  ]);
  assert.equal(writable.length, 2);
});

test("a deferral resolves against the whole statement, not just what is missing", () => {
  // Amex Platinum's June: the charge (`WALMART VENTA EN LINEA`, 17-may, $6,316)
  // is already recorded in Wallet, so it is not among the missing rows.
  // Looking only there found nothing, kept the `1/3`, restated it to $6,316 and
  // wrote the purchase a second time.
  const charge = platinum({ date: "2026-05-17 12:00:00", amount: "-6316.00", payee: "WALMART VENTA EN LINEA", category: "Shopping" });
  const credit = platinum({ date: "2026-06-06 12:00:00", amount: "6316.00", payee: "MONTO A DIFERIR", category: "Transfer, withdraw" });
  const first = platinum({ date: "2026-06-06 12:00:00", amount: "-2105.34", meses: "1/3", montooriginal: "6316.00" });
  const statement = [charge, credit, first];

  // Only the credit and the instalment are missing; the charge is in Wallet.
  const { writable, ignored } = splitForWriting([credit, first], statement);
  assert.equal(writable.length, 0);
  assert.equal(ignored.length, 2);

  // Without the statement for context, the old behaviour: the purchase again.
  const blind = splitForWriting([credit, first]);
  assert.deepEqual(blind.writable.map((r) => r.amount), ["-6316.00"]);
});
