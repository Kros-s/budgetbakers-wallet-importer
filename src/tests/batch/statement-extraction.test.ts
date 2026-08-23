import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chargesMismatch, extractedChargesCents, extractedNetCents, netMismatch,
  parseDeclaredCharges, parseDeclaredNet,
} from "../../statements/extraction.js";
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

test("the account's own opening and closing balances catch what charges cannot", () => {
  // Klar's real July: $210,000 moved from its fixed-term pot back to its main
  // account, and the extractor emitted that as the month's only movement while
  // emitting none of the $2,420.82 of earnings that were the only real change.
  // There were no charges, so the charges check had nothing to object to.
  const wrong = [row("210000.00")];
  const declared = parseDeclaredNet("SALDO_INICIAL: 251,325.80\nSALDO_FINAL: 253,746.62");
  assert.equal(declared, 242082);
  const warn = netMismatch(wrong, declared);
  assert.match(warn ?? "", /se movió \$2420\.82/);
  assert.match(warn ?? "", /bolsas internas/);
});

test("the right extraction of that month balances", () => {
  const right = [row("1967.67"), row("485.36"), row("-32.21")];
  assert.equal(netMismatch(right, 242082), null);
});

test("a net that the statement does not declare yields no verdict", () => {
  assert.equal(parseDeclaredNet("SALDO_INICIAL: NA\nSALDO_FINAL: NA"), null);
  assert.equal(netMismatch([row("-10")], null), null);
});

test("the net counts money in and money out, not just charges", () => {
  assert.equal(extractedNetCents([row("-197.08"), row("3268.48")]), 307140);
});
