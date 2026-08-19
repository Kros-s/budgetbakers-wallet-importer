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
  assert.match(out, /Con monto/);
  assert.match(out, /Categorización/);
  assert.match(out, /33,750\.00/);
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
  assert.match(out, /cuenta \*\*\*\*5933/);             // contexto del correo
  assert.match(out, /#35 tu respuesta/);
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
