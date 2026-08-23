import { test } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeStatement, monthOf, parseDetection, resolveAccount,
} from "../../statements/detect.js";

const block = (issuer: string, kind: string, producto = "", from = "2026-06-22", to = "2026-07-21") =>
  `ES_ESTADO_DE_CUENTA: si\nEMISOR: ${issuer}\nTIPO: ${kind}\nPRODUCTO: ${producto}\nPERIODO: ${from}..${to}`;

function account(issuer: string, kind: string, producto = ""): string | null {
  const d = parseDetection(block(issuer, kind, producto));
  assert.ok(d, "el bloque debería parsear");
  return resolveAccount(d);
}

test("no PDF calls the account what Wallet calls it", () => {
  assert.equal(account("Banamex", "tarjeta de crédito"), "Costco");
  assert.equal(account("BBVA Bancomer", "cuenta de débito"), "Bancomer");
  assert.equal(account("DolarApp México S.A. de C.V.", "cuenta de inversión"), "DolarApp");
  assert.equal(account("Klar Technologies", "cuenta de débito"), "Klar");
  assert.equal(account("Banco Mifel", "cuenta de débito"), "MIFEL");
});

test("the two Banorte accounts are told apart, and the card wins the tie", () => {
  assert.equal(account("Banorte", "tarjeta de crédito"), "Banorte");
  assert.equal(account("Banorte", "cuenta de débito"), "Banorte débito");
});

test("the two Amex accounts are told apart", () => {
  assert.equal(account("American Express Platinum", "tarjeta de crédito"), "Platinum Credit Card");
  assert.equal(account("American Express Gold", "tarjeta de crédito"), "American Express");
  assert.equal(account("American Express", "tarjeta de crédito", "Platinum"), "Platinum Credit Card");
});

test("an Amex that names neither product is asked about, not filed as Gold", () => {
  // Falling through to Gold files a month of Platinum charges against the wrong
  // card. Refusing to choose between two known accounts is the same rule as
  // refusing to guess an unknown issuer; only the unknown case was guarded.
  assert.equal(account("American Express", "tarjeta de crédito"), null);
  assert.equal(account("American Express", "tarjeta de crédito", "no dice"), null);
});

test("a Banorte whose kind is unclear is asked about too", () => {
  assert.equal(account("Banorte", "otro"), null);
  assert.equal(account("Banorte", "otro", "Enlace Personal"), "Banorte débito");
});

test("Meli is not Mercado pago", () => {
  // One is the credit card, the other the investment balance; conflating them
  // files a month of card charges against the wrong account.
  assert.equal(account("Mercado Pago", "tarjeta de crédito"), "Meli");
  assert.equal(account("Mercado Pago", "cuenta de inversión"), "Mercado pago");
});

test("the two Nu accounts are told apart", () => {
  assert.equal(account("Nu México", "tarjeta de crédito"), "Nu crédito");
  assert.equal(account("Nu México", "cuenta de débito"), "NuBank Débito");
});

test("an unknown issuer resolves to nothing rather than to a guess", () => {
  // Filing a statement against the wrong account writes a month of movements
  // into an account that never saw them.
  assert.equal(account("Scotiabank", "tarjeta de crédito"), null);
});

test("the month is the one the cut falls in, not the one the period opened", () => {
  const d = parseDetection(block("Mercado Pago", "tarjeta de crédito", "", "2026-06-22", "2026-07-21"));
  assert.ok(d);
  assert.equal(monthOf(d), "2026-07");
});

test("a malformed or backwards block is refused", () => {
  assert.equal(parseDetection("EMISOR: Banamex"), null);
  assert.equal(parseDetection("PERIODO: 2026-07-01..2026-07-31"), null);
  assert.equal(parseDetection(block("Banamex", "x", "", "2026-07-31", "2026-07-01")), null);
});

test("a document that is not a statement is not routed as one", () => {
  assert.equal(looksLikeStatement("ES_ESTADO_DE_CUENTA: no"), false);
  assert.equal(looksLikeStatement(block("Banamex", "tarjeta de crédito")), true);
});

test("Banamex is Costco, not an Amex", () => {
  // "Banamex" contains "amex". Matching it loosely sent every Costco statement
  // into the Amex ambiguity check, which then refused to file it at all.
  assert.equal(account("Banamex", "tarjeta de crédito"), "Costco");
  assert.equal(account("Tarjeta de Crédito COSTCO BANAMEX", "tarjeta de crédito"), "Costco");
});
