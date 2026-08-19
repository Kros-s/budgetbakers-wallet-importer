import { test } from "node:test";
import assert from "node:assert/strict";

import { bodyShowsMovement, challengeNoTransaction, parseVerdict } from "../../webhook/verdict.js";

// ── parseVerdict ────────────────────────────────────────────────────────────

test("a bare verdict is recognised", () => {
  assert.deepEqual(parseVerdict("NO_TRANSACTION"), { isNoTransaction: true, reason: "" });
});

test("a verdict with reasoning is still a verdict, and the reason is kept", () => {
  // The real bug: `responseText === "NO_TRANSACTION"` filed all four of these
  // as questions to the user, because the model always explains itself.
  const v = parseVerdict("NO_TRANSACTION El correo es un aviso de disponibilidad de estado de cuenta.");
  assert.equal(v.isNoTransaction, true);
  assert.match(v.reason, /aviso de disponibilidad/);
});

test("a genuine question is not mistaken for a verdict", () => {
  assert.equal(parseVerdict("¿De qué cuenta salió el pago de $248.00?").isNoTransaction, false);
  // Mentioning the token mid-sentence is not a verdict either.
  assert.equal(parseVerdict("No sé si esto es NO_TRANSACTION, dime tú").isNoTransaction, false);
});

// ── bodyShowsMovement ───────────────────────────────────────────────────────

test("spots an amount sitting next to a verb of movement", () => {
  assert.equal(bodyShowsMovement("Hola MARCO ¡Recibiste una transferencia! Recibiste $5,000.00 MN"), true);
  assert.equal(bodyShowsMovement("Se aplicó un cargo por MXN 1,047.00 a tu tarjeta"), true);
});

test("an amount with no movement around it is not a movement", () => {
  assert.equal(bodyShowsMovement("Tu estado de cuenta ya está disponible. Límite: $50,000.00"), false);
  assert.equal(bodyShowsMovement("Promoción: hasta 20% de descuento"), false);
  assert.equal(bodyShowsMovement(""), false);
});

test("a verb far from the amount does not count", () => {
  const far = "Recibiste este correo porque estás suscrito. " + "x".repeat(200) + " Total del plan: $199.00";
  assert.equal(bodyShowsMovement(far), false);
});

// ── challengeNoTransaction ──────────────────────────────────────────────────

test("challenges a bank verdict contradicted by the body — the $5,000 case", () => {
  const c = challengeNoTransaction({
    from: "notificaciones@banorte.com",
    subject: "Transferencia a Otros Bancos Nacionales - SPEI",
    body: "Hola MARCO ANTONIO ¡Recibiste una transferencia! Recibiste $5,000.00 MN Fecha 03/Ago/2026 Cuenta receptora: *******4615",
    reason: "Este correo es una notificación de una transferencia cancelada, no una transacción que haya ocurrido.",
  });
  assert.ok(c, "no cuestionó un veredicto que contradice al cuerpo");
  assert.match(c.question, /banco/);
  assert.match(c.question, /cancelada/); // la razón del modelo viaja en la pregunta
});

test("challenges a verdict that admits a cash payment — the Domino's case", () => {
  const c = challengeNoTransaction({
    from: "ordenesenlinea@dominos.com.mx",
    subject: "Su Orden de Domino's",
    body: "Total $248.00 Forma de pago: Débito a la puerta",
    reason: 'El correo es una confirmación de orden con pago "Débito a la puerta" (efectivo al repartidor), no una transacción bancaria.',
  });
  assert.ok(c);
  assert.match(c.question, /efectivo/i);
  assert.match(c.question, /Wallet/);
});

test("leaves a correct verdict alone — statement availability", () => {
  assert.equal(
    challengeNoTransaction({
      from: "noreply@openbank.mx",
      subject: "Estado de Cuenta",
      body: "Tu Estado de Cuenta ya está disponible. Consúltalo en la app.",
      reason: "El correo es un aviso de disponibilidad de estado de cuenta sin transacciones específicas.",
    }),
    null
  );
});

test("leaves a correct verdict alone — administrative notice", () => {
  assert.equal(
    challengeNoTransaction({
      from: "notificaciones@cetesdirecto.com",
      subject: "Cambio de politica de reinversion automatica",
      body: "Te informamos que se desactivó la reinversión automática de tu contrato.",
      reason: "Aviso administrativo de un cambio de configuración. No constituye una transacción real.",
    }),
    null
  );
});

test("marketing from a non-bank is never challenged", () => {
  assert.equal(
    challengeNoTransaction({
      from: "costcomx@e.costco.mx",
      subject: "10% de descuento",
      body: "Aprovecha tu compra con 20% off. Cargo diferido a 12 meses desde $999.00",
      reason: "Correo promocional.",
    }),
    null
  );
});
