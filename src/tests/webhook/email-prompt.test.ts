import test from "node:test";
import assert from "node:assert/strict";

import { buildEmailPrompt, clampBody } from "../../webhook/email-processor.js";

test("a body within budget is passed through untouched", () => {
  assert.equal(clampBody("Recibiste $700.00 MN", 8_000), "Recibiste $700.00 MN");
});

test("an over-long body keeps its end, not just its beginning", () => {
  // Mercado Pago wraps one line of fact in 17,000 characters of markup, with
  // the beneficiary past the cap. Keeping only the head lost exactly the datum
  // the model then asked the user for.
  const body = `Enviaste $700.00${"·".repeat(20_000)}Beneficiario: Oriana Alvarado`;
  const clamped = clampBody(body, 8_000);
  assert.ok(clamped.includes("Enviaste $700.00"), "el monto sobrevive");
  assert.ok(clamped.includes("Beneficiario: Oriana Alvarado"), "el destinatario sobrevive");
  assert.ok(clamped.length < body.length);
});

test("the clamp says how much it dropped, so nothing looks complete when it is not", () => {
  const clamped = clampBody("x".repeat(10_000), 8_000);
  assert.match(clamped, /se omitieron 2000 caracteres del centro/);
});

test("the prompt carries the envelope date the body never states", () => {
  // The date was on the payload all along; it just never reached the model,
  // which then asked the user for it.
  const prompt = buildEmailPrompt({
    from: "notificaciones@mercadopago.com",
    subject: "¡Enviamos tu transferencia!",
    text: "Ya enviamos tu transferencia de $700",
    date: "2026-09-02T18:04:00.000Z",
  });
  assert.ok(prompt.includes("Recibido: 2026-09-02T18:04:00.000Z"));
});

test("a payload without a date says so instead of omitting the line", () => {
  const prompt = buildEmailPrompt({
    from: "x@y.com", subject: "s", text: "t",
  });
  assert.ok(prompt.includes("Recibido: (fecha desconocida)"));
});
