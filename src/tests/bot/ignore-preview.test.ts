import { test } from "node:test";
import assert from "node:assert/strict";

import { buildIgnorePreview, formatIgnorePreview } from "../../bot/ignore-preview.js";
import { relaxAccents, toLiteralPattern } from "../../webhook/ignore-rules.js";
import type { ClarificationEntry } from "../../webhook/clarification-store.js";

const p = (shortId: number, subject: string, question: string, from = "notificaciones@banorte.com") => ({
  entry: {
    shortId, chatId: 1, emailFrom: from, emailSubject: subject,
    emailText: "cuerpo", claudeQuestion: question, createdAt: 0,
  } as ClarificationEntry,
});

const pat = (t: string) => relaxAccents(toLiteralPattern(t));

test("warns loudest when the rule would silence questions about money", () => {
  const pending = [
    p(1, "Transferencia a Otros Bancos - SPEI", "¿De dónde vienen los $33,750?"),
    p(2, "Transferencia a Otros Bancos - SPEI", "¿y los $1,200?"),
  ];
  const prev = buildIgnorePreview("transferencia", pat("transferencia"), pending);
  assert.equal(prev.matches.length, 2);
  assert.match(prev.warnings[0], /movimiento con monto/);
  assert.match(prev.warnings[0], /#1, #2/);
});

test("warns when the text is too short to aim", () => {
  const prev = buildIgnorePreview("pago", pat("pago"), [p(1, "Pago recibido", "¿qué categoría?")]);
  assert.ok(prev.warnings.some((w) => /muy corto/.test(w)));
});

test("warns when it spans several kinds of notice", () => {
  const pending = [
    p(1, "Cambio de politica de reinversion", "¿categoría?"),
    p(2, "Cambio de domicilio fiscal", "¿categoría?"),
  ];
  const prev = buildIgnorePreview("cambio de", pat("cambio de"), pending);
  assert.equal(prev.distinctSubjects.length, 2);
  assert.ok(prev.warnings.some((w) => /asuntos distintos/.test(w)));
});

test("warns when it matches nothing — usually a typo", () => {
  const prev = buildIgnorePreview("aviso inexistente", pat("aviso inexistente"), [p(1, "Otra cosa", "¿?")]);
  assert.equal(prev.matches.length, 0);
  assert.ok(prev.warnings.some((w) => /No casa con ninguna/.test(w)));
});

test("a precise rule over a notice with no money raises nothing", () => {
  const pending = [p(1, "Cambio de politica de reinversion automatica", "¿qué categoría?", "notificaciones@cetesdirecto.com")];
  const prev = buildIgnorePreview("cambio de politica de reinversion", pat("cambio de politica de reinversion"), pending);
  assert.equal(prev.matches.length, 1);
  assert.deepEqual(prev.warnings, []);
});

test("the preview names what would be dropped, with its amount", () => {
  const out = formatIgnorePreview(
    buildIgnorePreview("spei", pat("spei"), [p(7, "Transferencia SPEI", "¿los $33,750?")])
  );
  assert.match(out, /#7/);
  assert.match(out, /33,750\.00/);
  assert.match(out, /Antes de confirmar/);
});
