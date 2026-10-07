import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type AiMode = "auto" | "claude" | "codex";
export type AiProvider = "claude" | "codex";
export interface AiHealth { until: number; reason: string }
export function statePath(name: string): string { return path.resolve("data/bot", name); }
export function readState<T>(name: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(statePath(name), "utf8")) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw e; }
}
export function writeState(name: string, value: unknown): void {
  const dest = statePath(name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, dest);
}
export function isAiMode(mode: string): mode is AiMode { return ["auto", "claude", "codex"].includes(mode); }
export function getAiMode(): AiMode {
  const mode = readState<{mode?: string}>("ai-policy.json", {}).mode ?? process.env.AI_PROVIDER ?? "auto";
  if (!isAiMode(mode)) throw new Error(`Invalid AI_PROVIDER: ${mode}`);
  return mode;
}
export function setAiMode(mode: AiMode): void { writeState("ai-policy.json", { mode }); }
export function getAiHealth(): AiHealth { return readState("ai-claude-health.json", { until: 0, reason: "" }); }
export function clearAiHealth(): void { writeState("ai-claude-health.json", { until: 0, reason: "" }); }
export function pauseClaude(reason: string, durationMs = 3_600_000): void {
  writeState("ai-claude-health.json", { until: Date.now() + durationMs, reason });
}
export function providerOrder(mode: AiMode, health: AiHealth, now = Date.now()): AiProvider[] {
  return mode === "auto" ? health.until > now ? ["codex"] : ["claude", "codex"] : [mode];
}
export function aiModels() {
  return {
    email: process.env.CODEX_EMAIL_MODEL || "gpt-6-luna",
    chat: process.env.CODEX_CHAT_MODEL || "gpt-6-luna",
    statement: process.env.CODEX_STATEMENT_MODEL || "gpt-6.1-sol",
  };
}
export function aiStatus(): string {
  const mode = getAiMode(), health = getAiHealth(), models = aiModels();
  return `Modo global: ${mode}\nRuta: ${providerOrder(mode, health).join(" → ")}\n` +
    (health.until > Date.now() ? `Claude pausado hasta ${new Date(health.until).toLocaleString("es-MX", { timeZone: "America/Mexico_City" })} CDMX: ${health.reason}\n` : "") +
    `Codex: correos ${models.email} / low; chat ${models.chat} / low; estados ${models.statement} / medium.\n` +
    `Claude: correos ${process.env.EMAIL_CLAUDE_MODEL || "claude-haiku-4-5-20251001"}; chat ${process.env.CLAUDE_MODEL || "haiku"}; estados ${process.env.STATEMENT_CLAUDE_MODEL || "claude-sonnet-5"}.\n` +
    `Aplicación: siguiente tarea; también batch diario. /ai auto | claude | codex | retry`;
}
