import { test } from "node:test";
import assert from "node:assert/strict";

import { extractFacts, formatFacts, senderDomain, senderInstitution } from "../../bot/email-facts.js";

test("undoes Apple private relay to recover the real domain", () => {
  // These read as icloud.com and identify nothing until unmangled.
  assert.equal(senderDomain("costcomx_at_e_costco_mx_hqb5pwb4zdfbtt_92524291@icloud.com"), "e.costco.mx");
  assert.equal(senderDomain("info_at_mercadopago_com_xrnqa7dajtjtb6_9cpp0213@icloud.com"), "mercadopago.com");
});

test("plain senders keep their domain", () => {
  assert.equal(senderDomain("notificaciones@banamex.com"), "banamex.com");
});

test("names the institution the user thinks in, not the local part", () => {
  // The old view printed "notificaciones", which says nothing at all.
  assert.equal(senderInstitution("notificaciones@banamex.com"), "Banamex");
  assert.equal(senderInstitution("notificaciones@banorte.com"), "Banorte");
  assert.equal(senderInstitution("info_at_mercadopago_com_xrnqa7dajtjtb6_9cpp0213@icloud.com"), "Mercado Pago");
  assert.equal(senderInstitution("clientes@envios.santander.com.mx"), "Santander");
});

test("an unknown sender falls back to its domain, never to nothing", () => {
  assert.equal(senderInstitution("hola@tiendita.mx"), "tiendita.mx");
});

test("pulls the identifying details out of a real notification", () => {
  const body =
    "Hola MARCO ¡Recibiste una transferencia! Recibiste $33,750.00 MN " +
    "Fecha y hora: 15/Ago/2026 a las 06:25:08 horas Cuenta receptora: *******1977 " +
    "Número de referencia: 260815 Comisión más IVA: $0.00 MN";
  const f = extractFacts(body);
  assert.ok(f.amounts.includes("$33,750.00"), "no encontró el monto");
  assert.equal(f.amounts[0], "$33,750.00", "el mayor debe ir primero");
  assert.ok(f.accounts.some((a) => a.includes("1977")), "no encontró la cuenta");
  assert.ok(f.references.includes("260815"), "no encontró la referencia");
  assert.ok(f.dates.some((d) => /15\/Ago\/2026/.test(d)), "no encontró la fecha");
});

test("reads details through HTML left over from older emails", () => {
  const f = extractFacts("<p>Total <b>$248.00</b></p><div>terminación: 5432</div>");
  assert.ok(f.amounts.includes("$248.00"));
  assert.ok(f.accounts.some((a) => a.includes("5432")));
});

test("an email with nothing to extract yields nothing to show", () => {
  assert.deepEqual(formatFacts(extractFacts("Tu estado de cuenta ya está disponible.")), []);
});

test("each kind of detail gets its own icon, so the block is scanned not read", () => {
  const out = formatFacts(extractFacts("Cargo por $1,047.00 a la tarjeta ****5432 el 16/08/2026 referencia 260815")).join("\n");
  assert.match(out, /💵.*1,047\.00/);
  assert.match(out, /💳.*5432/);
  assert.match(out, /📅.*16\/08\/2026/);
  assert.match(out, /🔖.*260815/);
});

test("the dot grades the amount by how much it deserves attention", async () => {
  const { amountDot } = await import("../../bot/email-facts.js");
  assert.equal(amountDot(0), "⚪");
  assert.equal(amountDot(8_000), "🟡");        // $80
  assert.equal(amountDot(120_000), "🟠");      // $1,200
  assert.equal(amountDot(3_375_000), "🔴");    // $33,750
});

test("relay with either one or two trailing hash segments", () => {
  // Relay hashes always carry digits — that is what tells them apart from
  // domain labels, some of which are long ("mercadopago") and must survive.
  assert.equal(senderDomain("security_at_facebookmail_com_ced4z6rcqd50xc_h1y70213@icloud.com"), "facebookmail.com");
  assert.equal(senderDomain("ordenesenlinea_at_dominos_com_mx_sh8sj2xtpn_714c2d6a@privaterelay.appleid.com"), "dominos.com.mx");
  assert.equal(senderDomain("flyover_at_buq_mx_j479m814vc77mr_07540213@icloud.com"), "buq.mx");
});
