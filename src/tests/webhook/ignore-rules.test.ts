import { test } from "node:test";
import assert from "node:assert/strict";

import { matchesPattern, relaxAccents, toLiteralPattern } from "../../webhook/ignore-rules.js";

test("typed text is taken literally, never as a regex", () => {
  // A stray "." or "*" from someone describing an email in words would widen
  // the rule silently, and a rule that matches too much drops real movements.
  const p = toLiteralPattern("pago 100% (aprobado) *urgente*");
  assert.equal(matchesPattern(p, "a@b.c", "pago 100% (aprobado) *urgente*"), true);
  assert.equal(matchesPattern(p, "a@b.c", "pago 100X aprobado  urgente"), false);
});

test("accents are ignored, so one rule covers both spellings", () => {
  const p = relaxAccents(toLiteralPattern("cambio de politica de reinversion"));
  assert.equal(matchesPattern(p, "notificaciones@cetesdirecto.com", "Cambio de politica de reinversion automatica"), true);
  assert.equal(matchesPattern(p, "notificaciones@cetesdirecto.com", "Cambio de política de reinversión automática"), true);
});

test("the rule targets the notice, not the institution", () => {
  // CetesDirecto also sends real movements; those must keep coming through.
  const p = relaxAccents(toLiteralPattern("cambio de politica de reinversion"));
  assert.equal(matchesPattern(p, "notificaciones@cetesdirecto.com", "Instruccion de Retiro de Recursos"), false);
});

test("matching looks at the sender as well as the subject", () => {
  const p = toLiteralPattern("promociones@tienda.mx");
  assert.equal(matchesPattern(p, "promociones@tienda.mx", "lo que sea"), true);
});

test("a pattern that cannot compile matches nothing rather than throwing", () => {
  assert.equal(matchesPattern("([", "a@b.c", "x"), false);
});
