import { test } from "node:test";
import assert from "node:assert/strict";
import { UNRESOLVED, describeOwnCounterparty, isOwnCounterparty, ownAccountFor } from "../../statements/own-accounts.js";

// Verbatim from the user's BBVA statement for the period 17/06–16/07/2026, the
// line that would have been written as $59,485.33 of income.
const ARQ_LINE =
  "SPEI RECIBIDOARCUS FI 6062885Sent from ARQ Referencia 0194292099 706 " +
  "00706180105819089043 PIER 5, S.A de C.V.";

test("an arrival from DolarApp is recognised through the sponsor bank's name", () => {
  assert.equal(ownAccountFor(ARQ_LINE, "Bancomer"), "DolarApp");
  assert.equal(isOwnCounterparty(ARQ_LINE, "Bancomer"), true);
});

test("a statement does not resolve movements to the account it was read from", () => {
  // Every page of a Banorte statement says "Banorte", and every page of a BBVA
  // one says "BBVA". Matching those would make each row a transfer to itself.
  assert.equal(ownAccountFor("SPEI ENVIADO BANORTE traspaso", "Banorte débito"), null);
  assert.equal(ownAccountFor("SPEI ENVIADO BANORTE traspaso", "Banorte"), null);
  assert.equal(ownAccountFor("Grupo Financiero BBVA México", "Bancomer"), null);
  // …but the same text seen from a different account still resolves.
  assert.equal(ownAccountFor("SPEI ENVIADO BANORTE traspaso", "Bancomer"), UNRESOLVED);
});

test("an issuer holding two Wallet accounts refuses to pick one", () => {
  // Banorte is both "Banorte débito" and "Banorte" the credit card; Nu and
  // Mercado Pago are the same shape. A SPEI could be a transfer or a card
  // payment, and guessing books the movement against the wrong account.
  assert.equal(ownAccountFor("SPEI ENVIADO BANORTE", "Bancomer"), UNRESOLVED);
  assert.equal(ownAccountFor("SPEI RECIBIDO Mercado Pago", "Bancomer"), UNRESOLVED);
  assert.equal(ownAccountFor("SPEI RECIBIDO NU MEXICO", "Bancomer"), UNRESOLVED);
  assert.equal(describeOwnCounterparty(UNRESOLVED), "contraparte es una cuenta propia (sin identificar cuál)");
  assert.equal(describeOwnCounterparty("DolarApp"), "contraparte es tu cuenta DolarApp");
});

test("a genuine third party is left alone", () => {
  // All three are real counterparties from the same statement. Treating any of
  // them as an internal transfer would delete real income from the month.
  assert.equal(ownAccountFor("SPEI RECIBIDOSCOTIABANK ESPECTACULOS TEATRALES DE CALI", "Bancomer"), null);
  assert.equal(ownAccountFor("SPEI RECIBIDOBANAMEX 0010726julio 2026 LUIS ALBERTO,JIMENEZ/CASILLAS", "Bancomer"), null);
  assert.equal(ownAccountFor("SAMS CLUB ZONA PLATEAD RFC: NWM 9709244W4", "Bancomer"), null);
  assert.equal(ownAccountFor("", "Bancomer"), null);
});

test("MIFEL, FinSus and Klar name themselves and resolve to one account each", () => {
  assert.equal(ownAccountFor("SPEI ENVIADO MIFEL 0506260traspaso", "Bancomer"), "MIFEL");
  assert.equal(ownAccountFor("SPEI ENVIADO FINSUS", "Bancomer"), "FinSus");
  assert.equal(ownAccountFor("Transferencia SPEI a Klar", "Bancomer"), "Klar");
});
