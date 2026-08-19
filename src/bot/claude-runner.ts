/**
 * @file bot/claude-runner.ts
 * @description Spawns the `claude` CLI in headless `-p` mode and parses its
 * JSON output.
 *
 * We pass:
 *   --print                  non-interactive
 *   --output-format json     single structured result
 *   --session-id <uuid>      first turn — explicit UUID we control
 *   --resume <uuid>          subsequent turns — same UUID for context reuse
 *   --append-system-prompt   bot rules (don't write without "confirmar", etc.)
 *   --permission-mode        bypassPermissions by default
 *   --model                  optional override
 *
 * The CLI inherits the user's Claude Max auth from the keychain, so no
 * ANTHROPIC_API_KEY is needed.
 */

import { spawn } from "child_process";
import type { BotConfig } from "./config.js";

/**
 * Thrown when the CLI failed because the account ran out of usage budget
 * rather than because this particular prompt was bad.
 *
 * The distinction matters to the batch: a per-email failure burns one of the
 * three retry attempts for that email, so a limit hit mid-run would silently
 * exhaust every remaining email over a few nights. Callers are expected to
 * stop the run instead and resume in the next window.
 */
export class UsageLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageLimitError";
  }
}

// The CLI has no machine-readable code for this, so we match its text. Kept
// broad on purpose: a false positive costs one paused run (harmless, it
// resumes), a false negative costs three retry attempts per pending email.
const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage limit/i,
  /limit reached/i,
  /rate[ _-]?limit/i,
  /\bquota\b/i,
  /too many requests/i,
  /\b429\b/,
  /limit will reset/i,
  /upgrade to increase/i,
  /insufficient credit|credit balance/i,
];

export function isUsageLimitText(text: string | null | undefined): boolean {
  if (!text) return false;
  return USAGE_LIMIT_PATTERNS.some((r) => r.test(text));
}

export interface ClaudeRunResult {
  /** The text Claude produced for this turn (the `result` field of json output) */
  text: string;
  /** Total cost in USD if reported, else null */
  costUsd: number | null;
  /** Wall time in ms */
  durationMs: number;
  /** "stop" reason / subtype reported by the CLI */
  subtype: string | null;
  /** True if the CLI reported success (not an error envelope) */
  ok: boolean;
}

export interface ClaudeRunOptions {
  config: BotConfig;
  sessionId: string;
  /** True on the very first turn for this session. Uses --session-id. */
  isFirstTurn: boolean;
  /** Plain user text + any embedded file path references */
  prompt: string;
  /** Optional system prompt appended to the default Claude Code system prompt */
  appendSystemPrompt?: string;
  /** Whitelist of tools Claude is allowed to call this turn */
  allowedTools?: string[];
  /** Tools to deny — useful to forbid Bash invocations of the writer */
  disallowedTools?: string[];
  /** Hard wall-clock cap. Default: 180s. */
  timeoutMs?: number;
  /** Per-call model override. Takes precedence over config.claudeModel. */
  model?: string;
}

interface ClaudeJsonEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  error?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  session_id?: string;
}

export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const { config, sessionId, isFirstTurn, prompt } = opts;
  const args: string[] = ["--print", "--output-format", "json"];

  if (isFirstTurn) {
    args.push("--session-id", sessionId);
  } else {
    args.push("--resume", sessionId);
  }

  args.push("--permission-mode", config.claudePermissionMode);

  const model = opts.model ?? config.claudeModel;
  if (model) {
    args.push("--model", model);
  }
  if (opts.appendSystemPrompt) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }
  if (opts.disallowedTools && opts.disallowedTools.length > 0) {
    args.push("--disallowedTools", opts.disallowedTools.join(","));
  }

  // The prompt is sent via stdin. Passing it as a positional argument is
  // unsafe because commander's variadic flags (--allowedTools <tools...>,
  // --disallowedTools <tools...>) greedily consume the next argv slot.
  args.push("--input-format", "text");

  const start = Date.now();
  const child = spawn(config.claudeBin, args, {
    cwd: config.claudeCwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

  child.stdin.write(prompt);
  child.stdin.end();

  const timeoutMs = opts.timeoutMs ?? 180_000;
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

  const code: number | null = await new Promise((resolve) => {
    child.on("close", (c) => resolve(c));
  });
  clearTimeout(timer);

  const durationMs = Date.now() - start;

  if (code !== 0) {
    const tail = stderr.trim().split("\n").slice(-5).join("\n");
    if (isUsageLimitText(stderr) || isUsageLimitText(stdout)) {
      throw new UsageLimitError(
        `claude hit a usage limit (exit ${code}). Stderr tail:\n${tail || "<empty>"}`
      );
    }
    throw new Error(
      `claude exited with code ${code} after ${durationMs}ms. Stderr tail:\n${tail || "<empty>"}`
    );
  }

  let parsed: ClaudeJsonEnvelope;
  try {
    parsed = JSON.parse(stdout) as ClaudeJsonEnvelope;
  } catch (err) {
    throw new Error(
      `Could not parse claude JSON output. Raw stdout (first 500 chars):\n${stdout.slice(0, 500)}`,
      { cause: err }
    );
  }

  if (parsed.is_error) {
    const envelopeText = parsed.error ?? parsed.result ?? "";
    if (isUsageLimitText(envelopeText) || isUsageLimitText(parsed.subtype)) {
      throw new UsageLimitError(`claude hit a usage limit: ${envelopeText.slice(0, 200)}`);
    }
    return {
      text: parsed.error ?? parsed.result ?? "(unknown error)",
      costUsd: parsed.total_cost_usd ?? null,
      durationMs: parsed.duration_ms ?? durationMs,
      subtype: parsed.subtype ?? null,
      ok: false,
    };
  }

  return {
    text: parsed.result ?? "",
    costUsd: parsed.total_cost_usd ?? null,
    durationMs: parsed.duration_ms ?? durationMs,
    subtype: parsed.subtype ?? null,
    ok: true,
  };
}
