import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chunkLines, formatPendingDetail, formatPendingIndex, looksLikeHandleAnswer,
  parseAnswers, plainExcerpt, questionAmountCents, sortByImportance,
} from "../../bot/pending-view.js";
import type { PendingItem } from "../../bot/pending-view.js";

const item = (shortId: number, question: string, createdAt = 0, messageId = shortId + 1000): PendingItem => ({
  messageId,
  entry: { shortId, chatId: 1, emailFrom: "a@b.c", emailSubject: "s", emailText: "t", claudeQuestion: question, createdAt },
});

test("reads the amount a question names", () => {
  assert.equal(questionAmountCents(item(1, "¿De dónde viene la transferencia de $33,750?").entry), 3_375_000);
  assert.equal(questionAmountCents(item(2, "¿Qué es ABTS 12962?").entry), 0);
});

test("takes the largest amount when a question names several", () => {
  assert.equal(questionAmountCents(item(1, "¿$100 o $6,150.00?").entry), 615_000);
});

test("orders by money, not by date", () => {
  const items = [
    item(1, "¿Qué categoría para OXXO?", 100),
    item(2, "¿De dónde vienen los $33,750?", 200),
    item(3, "¿La compra de $6,150.00?", 300),
  ];
  assert.deepEqual(sortByImportance(items).map((i) => i.entry.shortId), [2, 3, 1]);
});

test("questions without an amount fall back to oldest first", () => {
  const items = [item(1, "¿b?", 200), item(2, "¿a?", 100)];
  assert.deepEqual(sortByImportance(items).map((i) => i.entry.shortId), [2, 1]);
});

test("the index lists every question, not a truncated ten", () => {
  const many = Array.from({ length: 40 }, (_, i) => item(i + 1, `¿pregunta ${i}?`, i));
  const out = formatPendingIndex(many).join("\n");
  assert.match(out, /40 pendientes/);
  for (const n of [1, 20, 40]) assert.match(out, new RegExp(`#${n}\\b`), `falta #${n}`);
});

test("the index separates questions that name money from plain categorisation", () => {
  const out = formatPendingIndex([
    item(1, "¿De dónde vienen los $33,750?"),
    item(2, "¿Qué categoría para HIDROCAR?"),
  ]).join("\n");
  assert.match(out, /Mueven dinero/);
  assert.match(out, /Solo falta categoría/);
  assert.match(out, /33,750\.00/);
});

test("the dot sizes the amount, so the queue is scanned not read", () => {
  const out = formatPendingIndex([
    item(1, "¿los $33,750?"),
    item(2, "¿los $1,200?"),
    item(3, "¿los $80?"),
    item(4, "¿qué categoría?"),
  ]).join("\n");
  assert.match(out, /🔴.*#1/s);
  assert.match(out, /🟠.*#2/s);
  assert.match(out, /🟡.*#3/s);
  assert.match(out, /⚪.*#4/s);
});

test("the index is split into messages Telegram will accept", () => {
  const many = Array.from({ length: 400 }, (_, i) => item(i + 1, `¿pregunta larguísima número ${i} con bastante texto?`, i));
  for (const chunk of formatPendingIndex(many)) {
    assert.ok(chunk.length <= 3500, `chunk de ${chunk.length} caracteres`);
  }
});

test("an empty queue says so", () => {
  assert.match(formatPendingIndex([]).join("\n"), /No hay aclaraciones pendientes/);
});

test("the detail carries the full question and part of the email", () => {
  const it = item(35, "¿De dónde viene esta transferencia de $33,750? Necesito la cuenta de origen.");
  it.entry.emailText = "Banorte te informa: recibiste $33,750.00 el 15 de agosto en la cuenta ****5933.";
  it.entry.emailSubject = "Transferencia SPEI";
  const out = formatPendingDetail(it);
  assert.match(out, /#35/);
  assert.match(out, /33,750\.00/);
  assert.match(out, /Necesito la cuenta de origen/);   // pregunta completa, no truncada
  assert.match(out, /cuenta (?:\\\*){4}5933/);          // contexto del correo, escapado
  assert.match(out, /#35 tu respuesta/);
  assert.match(out, /🏦/);                              // la institución, con icono
  assert.doesNotMatch(out, /@/);                        // nunca la dirección cruda
});

test("HTML in a stored body never reaches the user", () => {
  assert.equal(plainExcerpt("<html><head><style>a{}</style></head><body><p>Total $248</p></body></html>", 200), "Total $248");
});

test("chunkLines never splits a line in half", () => {
  const lines = ["aaaa", "bbbb", "cccc"];
  const chunks = chunkLines(lines, 10);
  assert.ok(chunks.every((c) => c.split("\n").every((l) => lines.includes(l))));
});

test("parses one answer and several at once", () => {
  assert.deepEqual(parseAnswers("#56 es de la Costco"), [{ shortId: 56, answer: "es de la Costco" }]);
  assert.deepEqual(parseAnswers("#12 Groceries\n#19 es la Amex Gold\n#23 Fuel"), [
    { shortId: 12, answer: "Groceries" },
    { shortId: 19, answer: "es la Amex Gold" },
    { shortId: 23, answer: "Fuel" },
  ]);
});

test("ignores lines that are not answers, including a bare handle", () => {
  assert.deepEqual(parseAnswers("hola\n#7\n#8 Fuel\n   "), [{ shortId: 8, answer: "Fuel" }]);
});

test("free text is never mistaken for a handle answer", () => {
  assert.equal(looksLikeHandleAnswer("50 tacos efectivo"), false);
  assert.equal(looksLikeHandleAnswer("#hashtag no cuenta"), false);
  assert.equal(looksLikeHandleAnswer("#7 Groceries"), true);
  assert.equal(looksLikeHandleAnswer("  #7 Groceries"), true);
});

test("/remind and /pending <handle> render the same way", () => {
  // They drifted apart once: /remind kept a plain template with no amount, no
  // dot and no extracted facts, so the redesign appeared not to have landed.
  const it = item(14, "¿Con qué cuenta pagaste la compra de $379.00?");
  it.entry.emailText = "Cinépolis. Total $379.00 el 02/08/2026 con tarjeta ****5432.";
  it.entry.emailSubject = "Confirmación de compra";
  const full = formatPendingDetail(it);
  const compact = formatPendingDetail(it, { excerpt: false });
  for (const out of [full, compact]) {
    assert.match(out, /#14/);
    assert.match(out, /379\.00/);
    assert.match(out, /🏦/);
    assert.match(out, /💳.*5432/);      // los datos extraídos, en ambas
    assert.match(out, /Lo que falta/);
  }
  // The compact one drops only the raw excerpt.
  assert.match(full, /Texto del correo/);
  assert.doesNotMatch(compact, /Texto del correo/);
  assert.ok(compact.length < full.length);
});

test("a question that names no amount inherits the email's, when unambiguous", () => {
  // #21: "¿qué día de agosto fue este pago a la psicóloga?" — no figure in the
  // question, one in the email. It was showing up as a categorisation chore.
  const it = item(21, "¿Qué día de agosto fue este pago a Marlene?");
  it.entry.emailText = "Tu transferencia fue enviada. Monto $1,400.00";
  assert.equal(questionAmountCents(it.entry), 140_000);
});

test("several amounts in the email is a guess, so it stays unranked", () => {
  // A card notice carries the charge, the minimum payment and the limit.
  const it = item(4, "¿Qué es el comercio ABTS 12962?");
  it.entry.emailText = "Monto $375.00 Mínimo a pagar $820.00 Límite $50,000.00";
  assert.equal(questionAmountCents(it.entry), 0);
});

test("the question's own amount always wins over the email's", () => {
  const it = item(5, "¿De dónde vienen los $33,750?");
  it.entry.emailText = "Comisión $0.00";
  assert.equal(questionAmountCents(it.entry), 3_375_000);
});

test("a missing movement date is stated, not left blank", () => {
  const it = item(21, "¿qué día fue?");
  it.entry.emailText = "Tu transferencia fue enviada. Monto $1,400.00";
  assert.match(formatPendingDetail(it), /Movimiento:.*no indicado/);
});

test("content from the email cannot break the message formatting", () => {
  // "NO_TRANSACTION" alone did it: one unmatched underscore makes Telegram
  // reject the Markdown, and the message arrives with its asterisks showing.
  const it = item(40, "NO_TRANSACTION Este correo es un aviso *administrativo*");
  it.entry.emailSubject = "Cambio de politica [automatica]";
  it.entry.emailText = "Saldo $10,097.91 en la cuenta **9775";
  const out = formatPendingDetail(it);

  assert.match(out, /NO\\_TRANSACTION/, "el guion bajo del veredicto no se escapó");
  assert.doesNotMatch(out, /(?<!\\)\*administrativo/, "un asterisco del correo llegó sin escapar");
  assert.match(out, /\\\[automatica\\?\]/, "el corchete del asunto no se escapó");
  // Y el formato propio sigue intacto.
  assert.match(out, /\*#40\*/);
  assert.match(out, /\*Lo que falta\*/);
});
