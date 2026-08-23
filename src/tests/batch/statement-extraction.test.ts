import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chargesMismatch, extractedChargesCents, extractedNetCents, netMismatch,
  parseDeclaredCharges, parseDeclaredNet, weighTotals,
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

// ── The two totals, weighed against each other ────────────────────────────

test("a charges gap the balance explains does not block the write", () => {
  // Banorte's summary prints "Total de retiros $413,739.25" and lists
  // "Total de comisiones $299.00" and "Intereses Cobrados $19,095.75"
  // separately. All twenty movements captured correctly sum to $433,134.00 in
  // charges and look $19,394.75 over.
  const rows: CsvRow[] = [
    { date: "2026-07-01 12:00:00", account: "Banorte débito", amount: "-413739.25", category: "Others", note: "", payee: "" },
    { date: "2026-07-01 12:00:00", account: "Banorte débito", amount: "-299.00", category: "Charges, Fees", note: "", payee: "" },
    { date: "2026-07-01 12:00:00", account: "Banorte débito", amount: "-19095.75", category: "Loan, interests", note: "", payee: "" },
    { date: "2026-06-02 12:00:00", account: "Banorte débito", amount: "377061.08", category: "Others", note: "", payee: "" },
  ];
  const verdict = weighTotals(rows, 41373925, -5607292);
  assert.equal(verdict.blocking, null);
  assert.match(verdict.note ?? "", /diferencia de definición/);
});

test("a balance that does not close blocks, whatever the charges total says", () => {
  // Rows missing or invented: nothing else matters.
  const rows: CsvRow[] = [
    { date: "2026-07-01 12:00:00", account: "Klar", amount: "210000.00", category: "Others", note: "", payee: "" },
  ];
  const verdict = weighTotals(rows, null, 242082);
  assert.ok(verdict.blocking);
  assert.match(verdict.blocking ?? "", /bolsas internas/);
});

test("with no declared balance the charges total is all there is", () => {
  const rows: CsvRow[] = [
    { date: "2026-07-01 12:00:00", account: "Meli", amount: "-307.08", category: "Others", note: "", payee: "" },
  ];
  const verdict = weighTotals(rows, 32708, null);
  assert.match(verdict.blocking ?? "", /faltan \$20\.00/);
  assert.equal(verdict.note, null);
});

test("a balance read backwards is named as such, not sent hunting for pots", () => {
  // A credit card states what you owe. Banorte's July grew from $21,823.19 to
  // $32,453.04 of debt: the account moved -$10,629.85. Written positive, the
  // check would report a $21,259.70 gap and blame internal buckets.
  const rows: CsvRow[] = [
    { date: "2026-06-15 12:00:00", account: "Banorte", amount: "-32453.04", category: "Shopping", note: "", payee: "" },
    { date: "2026-06-11 12:00:00", account: "Banorte", amount: "21823.19", category: "Transfer, withdraw", note: "", payee: "" },
  ];
  assert.equal(netMismatch(rows, -1062985), null);
  assert.match(netMismatch(rows, 1062985) ?? "", /signo contrario/);
});
