import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatPendingList, looksLikeHandleAnswer, parseAnswers,
  questionAmountCents, sortByImportance,
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

test("the list shows handles, amounts and a worked example", () => {
  const out = formatPendingList([
    item(7, "¿De dónde viene la transferencia de $33,750?"),
    item(9, "¿Qué categoría para HIDROCAR?"),
  ]);
  assert.match(out, /#7/);
  assert.match(out, /33,750\.00/);
  assert.match(out, /Responde así: #7/);
});

test("a long queue is truncated and says how to see the rest", () => {
  const many = Array.from({ length: 42 }, (_, i) => item(i + 1, `pregunta ${i}`, i));
  const out = formatPendingList(many, 10);
  assert.match(out, /42 pendientes/);
  assert.match(out, /y 32 más/);
  assert.match(out, /\/pending 30/);
});

test("an empty queue says so", () => {
  assert.match(formatPendingList([]), /No hay aclaraciones pendientes/);
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
