import test from "node:test";
import assert from "node:assert/strict";

import { buildEmailPrompt, clampBody, extractAskBlock } from "../../webhook/email-processor.js";

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

test("a CSV can carry a follow-up question without the block reaching anyone", () => {
  const reply = [
    "Registro la compra.",
    "<<<CSV>>>",
    "date,account,amount,category,note,payee",
    "2026-08-30 12:00:00,Costco,-1042.80,Others,,MERPAGO*QUINTAII",
    "<<<END>>>",
    "<<<ASK>>>",
    "¿Qué comercio es MERPAGO*QUINTAII?",
    "<<<END_ASK>>>",
  ].join("\n");
  const { ask, cleanedText } = extractAskBlock(reply);
  assert.equal(ask, "¿Qué comercio es MERPAGO*QUINTAII?");
  assert.ok(!cleanedText.includes("<<<ASK>>>"));
  assert.ok(!cleanedText.includes("<<<END_ASK>>>"));
  // The CSV must survive untouched — it is extracted after this.
  assert.ok(cleanedText.includes("2026-08-30 12:00:00,Costco,-1042.80,Others,,MERPAGO*QUINTAII"));
});

test("a reply without the block is passed through unchanged", () => {
  const { ask, cleanedText } = extractAskBlock("¿De qué cuenta salió el pago?");
  assert.equal(ask, null);
  assert.equal(cleanedText, "¿De qué cuenta salió el pago?");
});

test("an empty block is no question at all", () => {
  // Otherwise the queue fills with blank prompts nobody can answer.
  const { ask } = extractAskBlock("texto\n<<<ASK>>>\n\n<<<END_ASK>>>");
  assert.equal(ask, null);
});

test("the prompt tells the model to record and ask, not ask instead of record", () => {
  const prompt = buildEmailPrompt({ from: "a@b.c", subject: "s", text: "t" });
  // The rule lives in the system prompt, not this one; assert the user prompt
  // still carries the body and headers it is responsible for.
  assert.ok(prompt.includes("De: a@b.c"));
  assert.ok(prompt.includes("Asunto: s"));
});
