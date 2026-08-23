import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNRESOLVED, describeOwnCounterparty, isOwnCounterparty, namesHolder, ownAccountFor,
} from "../../statements/own-accounts.js";

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

// ── A payment rail is not evidence of whose money it is ───────────────────

const HOLDER = "MARCO ANTONIO MAYEN HERNANDEZ";

test("an unresolved issuer holds only when the movement names the holder", () => {
  // Both arrived in Bancomer through Mercado Pago on consecutive days. One is
  // the user moving his own money; the other is a debtor repaying him. The rail
  // is identical, the ordering party is not.
  const mine = "SPEI RECIBIDO Mercado Pago 3394119MERCADO*PAGO CPO167334871452 MARCO ANTONIO MAYEN HERNANDEZ";
  const theirs = "SPEI RECIBIDO Mercado Pago 9671664Abono parcial 27 de 48 CPO166674076541 OCTAVIO ROA SAAVEDRA";
  assert.equal(ownAccountFor(mine, "Bancomer", HOLDER), UNRESOLVED);
  assert.equal(ownAccountFor(theirs, "Bancomer", HOLDER), null);
});

test("an issuer that resolves to one account needs no holder name", () => {
  // Nobody else sends the user money through DolarApp's sponsor bank, and the
  // ordering party it prints is a company, not him.
  assert.equal(ownAccountFor(ARQ_LINE, "Bancomer", HOLDER), "DolarApp");
});

test("with no holder configured an unresolved issuer still holds", () => {
  // Missing configuration must fail towards holding, never towards writing.
  const theirs = "SPEI RECIBIDO Mercado Pago OCTAVIO ROA SAAVEDRA";
  assert.equal(ownAccountFor(theirs, "Bancomer", undefined), UNRESOLVED);
});

test("the holder is recognised through a truncated name, and a stranger is not", () => {
  // Statements truncate: BBVA prints "MARCO ANTONIO MAYEN" on some lines and
  // the full name on others.
  assert.equal(namesHolder("MARCO ANTONIO MAYEN", HOLDER), true);
  assert.equal(namesHolder("MAYEN HERNANDEZ MARCO ANTONIO", HOLDER), true);
  // One name in common is not the same person.
  assert.equal(namesHolder("MARCO LOPEZ GARCIA", HOLDER), false);
  assert.equal(namesHolder("OCTAVIO ROA SAAVEDRA", HOLDER), false);
  assert.equal(namesHolder("MARCO ANTONIO MAYEN", undefined), false);
});
