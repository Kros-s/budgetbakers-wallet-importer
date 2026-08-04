#!/usr/bin/env node
import path from "path";
import { Telegraf } from "telegraf";

import { loadEnvLocal } from "./env.js";
import { loadDirectCredentials } from "./direct-auth.js";
import { buildCouchClient, buildLookupMapsFromData, fetchLookupData } from "./couch.js";
import { createLogger } from "./logger.js";
import { loadBotConfig } from "./bot/config.js";
import { acquireInstanceLock } from "./bot/instance-lock.js";
import { registerHandlers } from "./bot/handlers.js";
import { startWebhookServer } from "./webhook/server.js";
import { buildDailySummary, hasEntriesToday, scheduleDailyAt } from "./webhook/daily-tracker.js";
import { startImapPoller } from "./imap/poller.js";

async function main() {
  console.log("\n── BudgetBakers ──\n");

  loadEnvLocal();

  // Refuse to start a second instance (launchd + manual run, or a restart
  // where the old process didn't die) — that causes duplicate Telegram sends.
  acquireInstanceLock();

  const config = loadBotConfig();
  const logFilePath = path.resolve("data", "bot", `bot-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const log = createLogger(true, logFilePath, "info");

  const credentials = loadDirectCredentials();
  const couch = buildCouchClient(credentials.replication);

  console.log("Loading lookup data from CouchDB...");
  const lookupData = await fetchLookupData(couch);
  const lookup = buildLookupMapsFromData(lookupData);
  console.log(
    `  ${Object.keys(lookup.accounts).length} accounts · ` +
    `${Object.keys(lookup.categories).length} categories · ` +
    `${Object.keys(lookup.labels).length} labels\n`
  );

  const bot = new Telegraf(config.telegramBotToken, { handlerTimeout: 300_000 });

  // Webhook server — shares bot, couch, lookup with the Telegram bot
  const notificationChatId = [...config.allowedChatIds][0];
  startWebhookServer({ bot, config, couch, userId: credentials.userId, lookup, notificationChatId });
  startImapPoller({ bot, config, couch, userId: credentials.userId, lookup, notificationChatId });

  // Daily summary at 21:00 local time
  scheduleDailyAt(21, async () => {
    // Skip the send entirely on a quiet day — no point notifying "no transactions".
    if (!hasEntriesToday()) return;
    const date = new Date().toISOString().slice(0, 10);
    const summary = buildDailySummary(date);
    try {
      await bot.telegram.sendMessage(notificationChatId, summary, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[daily-summary] failed to send:", err instanceof Error ? err.message : err);
    }
  });

  // Telegram bot
  registerHandlers({ bot, config, couch, userId: credentials.userId, lookup, log });

  bot.catch((err, ctx) => {
    log.error("Telegraf unhandled error", {
      chatId: ctx.chat?.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  process.once("SIGINT", () => { bot.stop("SIGINT"); });
  process.once("SIGTERM", () => { bot.stop("SIGTERM"); });

  console.log("Starting bot (long-polling) + webhook server...");
  await bot.launch();
}

main().catch((err) => {
  console.error("\nFatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
