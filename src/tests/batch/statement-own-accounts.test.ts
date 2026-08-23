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

test("a bank name holds only when the movement is the holder's own", () => {
  // Both arrived in Bancomer through Mercado Pago on consecutive days. One is
  // the user moving his own money; the other is a debtor repaying him. The rail
  // is identical, the party at the other end is not.
  const mine = "SPEI RECIBIDO Mercado Pago 3394119MERCADO*PAGO CPO167334871452 MARCO ANTONIO MAYEN HERNANDEZ";
  const theirs = "SPEI RECIBIDO Mercado Pago 9671664Abono parcial 27 de 48 CPO166674076541 OCTAVIO ROA SAAVEDRA";
  assert.equal(ownAccountFor(mine, "Bancomer", { holder: HOLDER, payee: "Marco Antonio Mayen Hernandez" }), UNRESOLVED);
  assert.equal(ownAccountFor(theirs, "Bancomer", { holder: HOLDER, payee: "Octavio Roa Saavedra" }), null);
});

test("a bank name is not evidence of whose money it is", () => {
  // Banorte débito's July: two SPEIs to a third party who banks at BBVA, which
  // the bank-name rule claimed as internal transfers to Bancomer.
  const toMarlene =
    "COMPRA ORDEN DE PAGO SPEI 0260615 =REFERENCIA CTA/CLABE: 012180015169092289, BXI " +
    "SPEI BCO:012 BENEF:Marlene Miriam Vazquez Peña";
  assert.equal(
    ownAccountFor(toMarlene, "Banorte débito", { holder: HOLDER, payee: "Marlene Miriam Vazquez Peña" }),
    null
  );
  // The same statement's inflow from his own BBVA account, which does name him.
  const fromHim = "2026061540012NNNN0000465284 SPEI RECIBIDO, BCO:0012 BBVA MEXICO HR LIQ: 03:33:36 DEL CLIENTE MARCO ANTONIO MAYEN HERNANDEZ";
  assert.equal(ownAccountFor(fromHim, "Banorte débito", { holder: HOLDER, payee: "Bancomer" }), "Bancomer");
});

test("a movement that names nobody is held, not written", () => {
  // Naming nobody is not evidence of a third party. BBVA's `SPEI RECIBIDO STP`
  // named no sender at all and was $10,155.21 of the user's own money.
  const anonymous = "SPEI RECIBIDO Mercado Pago 0260622 Referencia 0126700458";
  assert.equal(ownAccountFor(anonymous, "Bancomer", { holder: HOLDER, payee: "" }), UNRESOLVED);
  assert.equal(ownAccountFor(anonymous, "Bancomer", { holder: HOLDER, payee: "Mercado Pago" }), UNRESOLVED);
});

test("a sponsor rail that serves one product needs no holder name", () => {
  // Money from DolarApp's operating company can only be the user's own DolarApp
  // balance, and the ordering party it prints is that company, not him.
  assert.equal(
    ownAccountFor(ARQ_LINE, "Bancomer", { holder: HOLDER, payee: "PIER 5, S.A de C.V." }),
    "DolarApp"
  );
});

test("with no holder configured a named third party is still not yours", () => {
  // The holder test cannot run, but a payee that names somebody is evidence on
  // its own — and one that names nobody still holds.
  const theirs = "SPEI RECIBIDO Mercado Pago OCTAVIO ROA SAAVEDRA";
  assert.equal(ownAccountFor(theirs, "Bancomer", { payee: "Octavio Roa Saavedra" }), null);
  assert.equal(ownAccountFor(theirs, "Bancomer", { payee: "" }), UNRESOLVED);
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

test("the holder's own name is enough, with no bank named at all", () => {
  // Mercado Pago's July: `Transferencia enviada Marco antonio mayen Hernandez`,
  // twice, naming no bank. Both were transfers to his own accounts and both
  // were written as ordinary expenses, because no issuer pattern could reach
  // them.
  const own = "Transferencia enviada Marco antonio mayen Hernandez";
  assert.equal(
    ownAccountFor(own, "Mercado pago", { holder: HOLDER, payee: "Marco antonio mayen Hernandez" }),
    UNRESOLVED
  );
  // A transfer to somebody else, same wording, is still somebody else's.
  assert.equal(
    ownAccountFor("Transferencia enviada Oriana Alvarado Carrillo", "Mercado pago", {
      holder: HOLDER, payee: "Oriana Alvarado Carrillo",
    }),
    null
  );
});

test("a payee that names the institution is not a stranger who banks there", () => {
  // Mercado Pago prints `Transferencia enviada UALA MARCO` for $6,000 going to
  // the user's own Ualá account. One name in common with the holder is not
  // enough to recognise him, and the payee is not empty — so the row was
  // written as an ordinary expense.
  assert.equal(
    ownAccountFor("Transferencia enviada UALA MARCO", "Mercado pago", {
      holder: HOLDER, payee: "Uala Marco",
    }),
    "Uala"
  );
  // A person who merely banks at BBVA still is not the account.
  assert.equal(
    ownAccountFor("SPEI BCO:012 BENEF:Marlene Miriam Vazquez Peña", "Banorte débito", {
      holder: HOLDER, payee: "Marlene Miriam Vazquez Peña",
    }),
    null
  );
});

test("an acquirer processing for a shop is not the shop's bank account", () => {
  // `MERPAGO*KALAG` is a $750 charge at a shop that takes Mercado Pago, not
  // money moving to the user's own Mercado Pago balance. The asterisk is the
  // card-network convention for exactly that — `PAYPAL *ROBLOXCORPO`,
  // `STR*AMAZON`, `CONEKTA*BUHOCONTABLE` all appear on these statements.
  assert.equal(
    ownAccountFor("MERPAGO*KALAG CIUDAD DE MEX MX MAG 2105031W3", "Banorte", {
      holder: HOLDER, payee: "MERPAGO*KALAG CIUDAD DE MEX MX MAG 2105031W3",
    }),
    null
  );
  // The plain institution still resolves.
  assert.equal(
    ownAccountFor("Transferencia enviada UALA MARCO", "Mercado pago", { holder: HOLDER, payee: "Uala Marco" }),
    "Uala"
  );
});
