import test from "node:test";
import assert from "node:assert/strict";
import { classifyEmail, setRulesForTest } from "../classifier/email-rules.js";
const rules = { block: [], allow: [] };
test("shipping order total is not a new charge", () => {
  setRulesForTest(rules);
  assert.equal(classifyEmail("shipment-tracking@amazon.com.mx", "Enviado: Tu pedido"), "block");
  assert.equal(classifyEmail("shipment-tracking_at_amazon_com_mx_26t25nvwt74291_e252d3bb@icloud.com", "Entregado: Tu pedido"), "block");
});
test("purchase confirmations and refunds remain eligible", () => {
  setRulesForTest(rules);
  assert.equal(classifyEmail("shipment-tracking@amazon.com.mx", "Pedido: Tu compra"), "unknown");
  assert.equal(classifyEmail("payments@amazon.com.mx", "Enviado: Tu reembolso"), "unknown");
});
test("a shipping-looking subject from another sender is not suppressed", () => {
  setRulesForTest(rules);
  assert.equal(classifyEmail("notificaciones@banamex.com", "Enviado: comprobante"), "unknown");
});
