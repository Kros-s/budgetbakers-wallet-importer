#!/usr/bin/env node
/**
 * @file bot/index.ts
 * @description Telegram bot entry point.
 *
 * Boots in this order:
 *   1. Load .env.local into process.env (same file the --direct CLI mode uses).
 *   2. Build the bot config (Telegram token, allowlist, claude bin/cwd, ...).
 *   3. Load CouchDB direct credentials and build a CouchDB client.
 *   4. Fetch lookup data (accounts/categories/currencies) so the bot can
 *      convert proposed CSV rows into NewRecord docs without round-trips.
 *   5. Wire telegraf with the handlers and start long-polling.
 *
 * Run with `pnpm bot` (tsx) or `pnpm bot:built` (compiled to dist/).
 */

import fs from "fs";
import path from "path";
import { Telegraf } from "telegraf";

import { loadDirectCredentials } from "../direct-auth.js";
import { buildCouchClient, buildLookupMapsFromData, fetchLookupData } from "../couch.js";
import { createLogger } from "../logger.js";

import { loadBotConfig } from "./config.js";
import { registerHandlers } from "./handlers.js";

function loadEnvLocalIntoProcess(): void {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

async function main() {
  console.log("\n── BudgetBakers Telegram Bot ──\n");

  loadEnvLocalIntoProcess();

  const config = loadBotConfig();
  const logFilePath = path.resolve("data", "bot", `bot-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const log = createLogger(true, logFilePath, "info");
  log("Bot config loaded", {
    allowedChatIds: Array.from(config.allowedChatIds),
    downloadDir: config.downloadDir,
    claudeBin: config.claudeBin,
    claudeCwd: config.claudeCwd,
    claudeModel: config.claudeModel,
    claudePermissionMode: config.claudePermissionMode,
  });

  const credentials = loadDirectCredentials();
  log("Direct credentials loaded", { userId: credentials.userId });
  const couch = buildCouchClient(credentials.replication);

  console.log("Loading lookup data from CouchDB...");
  const lookupData = await fetchLookupData(couch);
  const lookup = buildLookupMapsFromData(lookupData);
  log("Lookup maps loaded", {
    accounts: Object.keys(lookup.accounts).length,
    categories: Object.keys(lookup.categories).length,
    currencies: Object.keys(lookup.currencies).length,
  });
  console.log(
    `  ${Object.keys(lookup.accounts).length} accounts · ` +
      `${Object.keys(lookup.categories).length} categories · ` +
      `${Object.keys(lookup.currencies).length} currencies\n`
  );

  const bot = new Telegraf(config.telegramBotToken, { handlerTimeout: 300_000 });
  registerHandlers({
    bot,
    config,
    couch,
    userId: credentials.userId,
    lookup,
    log,
  });

  bot.catch((err, ctx) => {
    log.error("Telegraf unhandled error", {
      chatId: ctx.chat?.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  process.once("SIGINT", () => {
    console.log("\nReceived SIGINT, stopping bot...");
    bot.stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    console.log("\nReceived SIGTERM, stopping bot...");
    bot.stop("SIGTERM");
  });

  console.log("Starting bot (long-polling)...");
  await bot.launch();
}

main().catch((err) => {
  console.error("\nFatal error:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
