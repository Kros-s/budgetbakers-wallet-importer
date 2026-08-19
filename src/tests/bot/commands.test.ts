import { test } from "node:test";
import assert from "node:assert/strict";

import { BOT_COMMANDS, HELP_TEXT } from "../../bot/commands.js";

test("command names are English, lowercase and Telegram-legal", () => {
  for (const c of BOT_COMMANDS) {
    assert.match(c.command, /^[a-z][a-z0-9_]{0,31}$/, `nombre inválido: ${c.command}`);
    assert.ok(c.description.length > 0 && c.description.length <= 256, c.command);
  }
});

test("no command is registered twice", () => {
  const names = BOT_COMMANDS.map((c) => c.command);
  assert.equal(new Set(names).size, names.length);
});

test("every command the help mentions is registered", () => {
  const registered = new Set(BOT_COMMANDS.map((c) => c.command));
  for (const [, name] of HELP_TEXT.matchAll(/\/([a-z]+)/g)) {
    assert.ok(registered.has(name), `/${name} aparece en la ayuda pero no está registrado`);
  }
});

test("the help explains the three ways to answer and the guided window", () => {
  assert.match(HELP_TEXT, /\/pending/);
  assert.match(HELP_TEXT, /#35/);          // por handle
  assert.match(HELP_TEXT, /Responder al mensaje/);
  assert.match(HELP_TEXT, /2 minutos/);    // la ventana del modo guiado
});

test("the help does not promise a command that does not exist", () => {
  // El resumen del batch prometía /statement, que nunca existió.
  assert.doesNotMatch(HELP_TEXT, /\/statement/);
});
