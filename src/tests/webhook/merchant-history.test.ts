import test from "node:test";
import assert from "node:assert/strict";

import { applyMerchantHistory, buildMerchantLookup, merchantKey } from "../../webhook/merchant-history.js";
import type { CsvRow } from "../../csv.js";

const CAT: Record<string, string> = {
  r: "Restaurant, fast-food", f: "Fuel", g: "Groceries", s: "Shopping", o: "Others",
  ref: "Refunds (tax, purchase)", gift: "Gifts, joy", tr: "Transfer, withdraw",
};
const spent = (payee: string, categoryId: string, n = 1) =>
  Array.from({ length: n }, () => ({ payee, categoryId, transfer: false, type: 1 as const }));
const row = (payee: string, category: string, amount = "-100.00") =>
  ({ date: "2026-09-13 12:00:00", account: "Costco", amount, category, note: "", payee }) as CsvRow;

test("variants of one business reduce to one merchant", () => {
  assert.equal(merchantKey("TOKS PACHUCA COLOSIO PAC"), "TOKS");
  assert.equal(merchantKey("Toks"), "TOKS");
  assert.equal(merchantKey("EST DE SERV TELLEZ ZEM"), merchantKey("EST SERV TELLEZ"));
  // A generic first word is not an identity: every aggregator is not one shop.
  assert.equal(merchantKey("MERPAGO*QUINTAII"), "MERPAGO QUINTAII");
  assert.notEqual(merchantKey("MERPAGO*QUINTAII"), merchantKey("MERPAGO*OTRO"));
});

test("TOKS is a restaurant, whatever the model says — the 13-sep case", () => {
  const lookup = buildMerchantLookup([...spent("Toks", "r", 14), ...spent("TOKS SATELITE", "s")], CAT);
  const { rows, changes } = applyMerchantHistory([row("TOKS PACHUCA COLOSIO PAC", "Groceries")], lookup);
  assert.equal(rows[0].category, "Restaurant, fast-food");
  assert.equal(changes.length, 1);
});

test("an unknown merchant with a short clear history is filled, not asked about", () => {
  const lookup = buildMerchantLookup(spent("Est de Serv Tellez", "f", 3), CAT);
  const { rows } = applyMerchantHistory([row("EST DE SERV TELLEZ ZEM", "Others")], lookup);
  assert.equal(rows[0].category, "Fuel");
});

test("the same short history is not enough to contradict the model", () => {
  const lookup = buildMerchantLookup(spent("Villanova", "r", 3), CAT);
  const { rows, changes } = applyMerchantHistory([row("VILLANOVA", "Candy")], lookup);
  assert.equal(rows[0].category, "Candy");
  assert.equal(changes.length, 0);
});

test("a store where the purchase decides is never overridden", () => {
  const lookup = buildMerchantLookup(spent("AMAZON MX", "s", 20), CAT);
  assert.equal(applyMerchantHistory([row("AMAZON MX", "Gifts, joy")], lookup).rows[0].category, "Gifts, joy");
  // It may still fill a placeholder: shopping is a better guess than unknown.
  assert.equal(applyMerchantHistory([row("AMAZON MX", "Others")], lookup).rows[0].category, "Shopping");
});

test("returned purchases do not turn a supermarket into a refunds merchant", () => {
  const history = [
    ...spent("Chedraui", "g", 2),
    ...Array.from({ length: 5 }, () => ({ payee: "Chedraui", categoryId: "ref", transfer: false, type: 0 as const })),
  ];
  // Only the two expenses vote: too few to speak, so nothing changes.
  const { rows } = applyMerchantHistory([row("Chedraui", "Groceries")], buildMerchantLookup(history, CAT));
  assert.equal(rows[0].category, "Groceries");
});

test("a split history speaks for nobody — OXXO", () => {
  const lookup = buildMerchantLookup([...spent("OXXO", "g", 5), ...spent("OXXO", "s", 4)], CAT);
  assert.equal(applyMerchantHistory([row("OXXO LOS TECNICOS PAC PA", "Others")], lookup).rows[0].category, "Others");
});

test("transfers and income rows are left exactly as extracted", () => {
  const lookup = buildMerchantLookup(spent("Toks", "r", 14), CAT);
  const { rows } = applyMerchantHistory(
    [row("Toks", "Transfer, withdraw"), row("Toks", "Refunds (tax, purchase)", "250.00")],
    lookup
  );
  assert.equal(rows[0].category, "Transfer, withdraw");
  assert.equal(rows[1].category, "Refunds (tax, purchase)");
});
