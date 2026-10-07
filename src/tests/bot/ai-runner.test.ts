import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent, parseCodexOutput, fallbackReason, UsageLimitError, type AgentOptions, type AgentRunners } from "../../bot/ai-runner.js";
import { setAiMode, clearAiHealth, getAiHealth, providerOrder, type AiMode } from "../../bot/ai-policy.js";
const result = { text: "NO_TRANSACTION", ok: true, costUsd: null, durationMs: 1, subtype: null };
const opts: AgentOptions = { config: { telegramBotToken: "test", allowedChatIds: new Set([1]), downloadDir: "/tmp", claudeBin: "claude", claudeCwd: process.cwd(), claudeModel: "haiku", claudePermissionMode: "default", whisperBin: "", whisperModel: "" }, sessionId: "test-session", isFirstTurn: true, prompt: "test", task: "email" };
test("routing, cooldown, manual override and failure boundaries", async () => {
 const previous = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), "bbw-ai-"));
 process.chdir(temp);
 try {
  let calls: string[] = [];
  const runners: AgentRunners = { claude: async () => { calls.push("claude"); return result; }, codex: async () => { calls.push("codex"); return result; } };
  setAiMode("auto"); clearAiHealth();
  assert.equal((await runAgent(opts, runners)).provider, "claude"); assert.deepEqual(calls, ["claude"]);
  calls = []; runners.claude = async () => { calls.push("claude"); throw new UsageLimitError("quota"); };
  assert.equal((await runAgent(opts, runners)).provider, "codex"); assert.deepEqual(calls, ["claude", "codex"]);
  calls = []; await runAgent(opts, runners); assert.deepEqual(calls, ["codex"]);
  assert.ok(getAiHealth().until > Date.now());
  setAiMode("claude"); calls = []; await assert.rejects(runAgent(opts, runners), UsageLimitError); assert.deepEqual(calls, ["claude"]);
  clearAiHealth(); setAiMode("auto"); calls = [];
  runners.claude = async () => { calls.push("claude"); throw new Error("Could not parse claude JSON output"); };
  await assert.rejects(runAgent(opts, runners), /Could not parse/); assert.deepEqual(calls, ["claude"]);
  runners.claude = async () => { calls.push("claude"); return { ...result, text: "¿Qué cuenta?" }; };
  calls = []; await runAgent(opts, runners); assert.deepEqual(calls, ["claude"]);
  for (const mode of ["codex", "claude"] as AiMode[]) assert.deepEqual(providerOrder(mode, {until: Infinity, reason: "quota"}), [mode]);
  assert.deepEqual(providerOrder("auto", {until: 100, reason: "quota"}, 101), ["claude", "codex"]);
 } finally { process.chdir(previous); fs.rmSync(temp, { recursive: true }); }
});
test("switching providers carries conversation context without resuming Claude ids in Codex", async () => {
 const previous = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), "bbw-ai-chat-")); process.chdir(temp);
 try {
  setAiMode("claude");
  const runners: AgentRunners = { claude: async () => ({...result, text: "¿Qué cuenta?"}), codex: async (_, history) => { assert.equal(history[0].assistant, "¿Qué cuenta?"); return result; } };
  await runAgent({...opts, task: "chat", prompt: "50 tacos"}, runners);
  setAiMode("codex"); await runAgent({...opts, task: "chat", isFirstTurn: false, prompt: "Banorte débito"}, runners);
  setAiMode("claude"); runners.claude = async o => { assert.equal(o.isFirstTurn, true); assert.match(o.prompt, /Banorte débito/); return result; };
  await runAgent({...opts, task: "chat", isFirstTurn: false, prompt: "corrige"}, runners);
 } finally { process.chdir(previous); fs.rmSync(temp, { recursive: true }); }
});
test("Codex JSONL requires completed turn and captures errors", () => {
 const parsed = parseCodexOutput('{"type":"thread.started","thread_id":"abc"}\n{"type":"item.completed","item":{"type":"agent_message","text":"NO_TRANSACTION"}}\n{"type":"turn.completed"}');
 assert.deepEqual(parsed, {text: "NO_TRANSACTION", error: "", complete: true});
 assert.equal(parseCodexOutput('{"type":"turn.failed","error":{"message":"quota"}}').error, "quota");
 assert.equal(fallbackReason(new Error("invalid CSV")), null);
 assert.equal(fallbackReason(new Error("AI_PROVIDER_TIMEOUT")), "indisponibilidad del proveedor");
});
