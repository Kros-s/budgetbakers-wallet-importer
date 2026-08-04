import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { classifyEmail, setRulesForTest, DEFAULT_RULES } from "../../classifier/email-rules.js";

beforeEach(() => setRulesForTest(DEFAULT_RULES));

// Senders/subjects taken from the 2026-07/08 audit report.
test("Walmart order emails are blocked (family account)", () => {
  assert.equal(classifyEmail("noreply@walmart.com", "Recibimos tu solicitud"), "block");
});

test("Cashi payments are blocked", () => {
  assert.equal(classifyEmail("noreply@walmart.com", "Pagaste con Cashi"), "block");
});

test("Banamex marketing subdomain is blocked, transactional sender is bank", () => {
  assert.equal(classifyEmail("marketingdir@email.banamex.com", "Regreso a clases"), "block");
  assert.equal(classifyEmail("notificaciones@banamex.com", "Retiro/Compra con tarjeta Banamex"), "bank");
});

test("Banorte SPEI notifications classify as bank", () => {
  assert.equal(classifyEmail("notificaciones@banorte.com", "Transferencia a Otros Bancos Nacionales - SPEI"), "bank");
});

test("iCloud-relayed Mercado Pago sender classifies as bank", () => {
  assert.equal(
    classifyEmail("info_at_mercadopago_com_xrnqa7dajtjtb6_9cpp0213@icloud.com", "Tu transferencia fue enviada"),
    "bank"
  );
});

test("Starbucks and shop.app noise is blocked", () => {
  assert.equal(classifyEmail("info@starbucks.com.mx", "Descubre el sabor del Ube"), "block");
  assert.equal(classifyEmail("noreply@email.shop.app", "Your cart? Saved"), "block");
});

test("unknown senders fall through to processing", () => {
  assert.equal(classifyEmail("serviciosalclienteafore@suramexico.com", "Tu saldo actualizado"), "unknown");
});
