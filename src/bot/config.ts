/**
 * @file bot/config.ts
 * @description Loads bot configuration from environment.
 *
 * Reads from process.env (which the entry point populates from .env.local
 * via the existing direct-auth pattern). Required:
 *   - TELEGRAM_BOT_TOKEN          BotFather token
 *   - TELEGRAM_ALLOWED_CHAT_IDS   comma-separated list of chat ids
 * Optional:
 *   - TELEGRAM_DOWNLOAD_DIR       defaults to /tmp
 *   - CLAUDE_BIN                  defaults to "claude"
 *   - CLAUDE_CWD                  defaults to process.cwd()
 *   - CLAUDE_MODEL                e.g. "sonnet" or "opus"; if unset, uses CLI default
 *   - CLAUDE_PERMISSION_MODE      defaults to "bypassPermissions"
 *   - WHISPER_BIN                 path to whisper CLI; defaults to "whisper"
 *   - WHISPER_MODEL               whisper model size; defaults to "base"
 */

import os from "os";
import path from "path";

export interface BotConfig {
  telegramBotToken: string;
  allowedChatIds: Set<number>;
  downloadDir: string;
  claudeBin: string;
  claudeCwd: string;
  claudeModel: string | null;
  claudePermissionMode: string;
  whisperBin: string;
  whisperModel: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Missing required env var: ${name}. Set it in .env.local or the shell environment.`
    );
  }
  return v.trim();
}

function parseChatIds(raw: string): Set<number> {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));

  if (ids.some((n) => !Number.isFinite(n))) {
    throw new Error(
      `TELEGRAM_ALLOWED_CHAT_IDS must be a comma-separated list of integers (got: ${raw})`
    );
  }
  if (ids.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_CHAT_IDS must contain at least one chat id");
  }
  return new Set(ids);
}

export function loadBotConfig(): BotConfig {
  return {
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    allowedChatIds: parseChatIds(requireEnv("TELEGRAM_ALLOWED_CHAT_IDS")),
    downloadDir: process.env.TELEGRAM_DOWNLOAD_DIR?.trim() || os.tmpdir(),
    claudeBin: process.env.CLAUDE_BIN?.trim() || "claude",
    claudeCwd: process.env.CLAUDE_CWD?.trim() || path.resolve(process.cwd()),
    claudeModel: process.env.CLAUDE_MODEL?.trim() || null,
    claudePermissionMode:
      process.env.CLAUDE_PERMISSION_MODE?.trim() || "bypassPermissions",
    whisperBin: process.env.WHISPER_BIN?.trim() || "whisper",
    whisperModel: process.env.WHISPER_MODEL?.trim() || "small",
  };
}
