// Verifies claudeSessionId/turnsSent survive a simulated process restart
// (the in-memory Map is gone but data/bot/sessions.json is read back).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// session.ts resolves its persistence paths from process.cwd() at import
// time, so we chdir into a scratch directory before the first import.
const scratchDir = mkdtempSync(join(tmpdir(), "session-test-"));
const originalCwd = process.cwd();
process.chdir(scratchDir);

// Cache-busting query strings force a fresh module instance (fresh in-memory
// Map), which is what lets us simulate "process A" vs "process B after restart".
const sessionModuleA = await import(`../../bot/session.js?t=${Date.now()}-a`);

test("restores claudeSessionId and turnsSent from disk after a simulated restart", async () => {
  const chatId = 42;

  const original = sessionModuleA.getOrCreateSession(chatId);
  sessionModuleA.markTurnSent(chatId);
  sessionModuleA.markTurnSent(chatId);

  assert.equal(original.turnsSent, 2);

  // Fresh module instance = fresh in-memory Map, as if the process restarted.
  const sessionModuleB = await import(`../../bot/session.js?t=${Date.now()}-b`);
  const restored = sessionModuleB.getOrCreateSession(chatId);

  assert.equal(restored.claudeSessionId, original.claudeSessionId);
  assert.equal(restored.turnsSent, 2);
});

test("resetSession clears persisted state so a new uuid/turn count is restored", async () => {
  const chatId = 43;

  const sessionModuleA = await import(`../../bot/session.js?t=${Date.now()}-c`);
  const original = sessionModuleA.getOrCreateSession(chatId);
  sessionModuleA.markTurnSent(chatId);
  const reset = sessionModuleA.resetSession(chatId);

  assert.notEqual(reset.claudeSessionId, original.claudeSessionId);
  assert.equal(reset.turnsSent, 0);

  const sessionModuleB = await import(`../../bot/session.js?t=${Date.now()}-d`);
  const restored = sessionModuleB.getOrCreateSession(chatId);

  assert.equal(restored.claudeSessionId, reset.claudeSessionId);
  assert.equal(restored.turnsSent, 0);
});

test.after(() => {
  process.chdir(originalCwd);
  rmSync(scratchDir, { recursive: true, force: true });
});
