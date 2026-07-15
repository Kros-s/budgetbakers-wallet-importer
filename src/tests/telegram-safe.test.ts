import test from "node:test";
import assert from "node:assert/strict";

import { escapeMarkdown } from "../bot/telegram-safe.js";

test("escapeMarkdown escapes legacy Markdown special characters", () => {
    const input = "info_at_mercadopago_com_xrnqa7dajtjtb6_9cpp0213@icloud.com";
    assert.equal(
        escapeMarkdown(input),
        "info\\_at\\_mercadopago\\_com\\_xrnqa7dajtjtb6\\_9cpp0213@icloud.com"
    );
});

test("escapeMarkdown escapes asterisks, backticks and brackets", () => {
    assert.equal(escapeMarkdown("*bold* `code` [link]"), "\\*bold\\* \\`code\\` \\[link]");
});

test("escapeMarkdown leaves plain text untouched", () => {
    assert.equal(escapeMarkdown("hola mundo 123"), "hola mundo 123");
});
