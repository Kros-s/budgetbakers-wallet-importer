import { test } from "node:test";
import assert from "node:assert/strict";
import { chargesMismatch, extractedChargesCents, parseDeclaredCharges } from "../../statements/extraction.js";
import type { CsvRow } from "../../csv.js";

const row = (amount: string): CsvRow =>
  ({ date: "2026-07-01 12:00:00", account: "Meli", amount, category: "Others", note: "", payee: "" }) as CsvRow;

test("the declared total is read, thousands separator and all", () => {
  assert.equal(parseDeclaredCharges("CARGOS_DECLARADOS: 327.08"), 32708);
  assert.equal(parseDeclaredCharges("CARGOS_DECLARADOS: 1,234.50"), 123450);
  assert.equal(parseDeclaredCharges("CARGOS_DECLARADOS: -327.08"), 32708);
});

test("no declared total means no verdict, not a false alarm", () => {
  assert.equal(parseDeclaredCharges("CARGOS_DECLARADOS: NA"), null);
  assert.equal(parseDeclaredCharges("nada"), null);
  assert.equal(chargesMismatch([row("-10")], null), null);
});

test("only the outgoing rows count toward charges", () => {
  assert.equal(extractedChargesCents([row("-197.08"), row("3268.48"), row("-10")]), 20708);
});

test("the real Meli gap is caught", () => {
  // 5 of 7 movements extracted: the 22 and 25 of June, inside the statement's
  // 22-jun→21-jul period, were dropped as "not July". $327.08 declared against
  // $307.08 pulled — exactly the two $10 charges.
  const rows = [row("-197.08"), row("3268.48"), row("-10"), row("-50"), row("-50")];
  const warn = chargesMismatch(rows, parseDeclaredCharges("CARGOS_DECLARADOS: 327.08"));
  assert.match(warn ?? "", /faltan \$20\.00/);
  assert.match(warn ?? "", /sin capturar/);
});

test("a complete extraction says nothing", () => {
  const rows = [row("-197.08"), row("3268.48"), row("-10"), row("-10"), row("-10"), row("-50"), row("-50")];
  assert.equal(chargesMismatch(rows, parseDeclaredCharges("CARGOS_DECLARADOS: 327.08")), null);
});

test("rounding of a peso or less is not a missing movement", () => {
  assert.equal(chargesMismatch([row("-327.50")], 32708), null);
});

test("extracting more than the statement declares is flagged too", () => {
  // Double-counting a row is as wrong as dropping one, and --write would book it.
  const warn = chargesMismatch([row("-327.08"), row("-50")], 32708);
  assert.match(warn ?? "", /sobran \$50\.00/);
  assert.match(warn ?? "", /duplicadas/);
});
