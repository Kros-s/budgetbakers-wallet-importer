/**
 * One-shot script: checks the Archive mailbox for the last 3 days and
 * processes any unseen emails through the same pipeline as the IMAP poller.
 *
 * Run once with:
 *   npx tsx src/imap/check-archive-once.ts
 */
import path from "path";
import fs from "fs";
import { Telegraf } from "telegraf";

import { loadBotConfig } from "../bot/config.js";
import { buildCouchClient, buildLookupMapsFromData, fetchLookupData } from "../couch.js";
import { loadDirectCredentials } from "../direct-auth.js";
import { pollOnce } from "./poller.js";

function loadEnv(): void {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function main() {
  loadEnv();

  const config = loadBotConfig();
  const credentials = loadDirectCredentials();
  const couch = buildCouchClient(credentials.replication);
  const lookupData = await fetchLookupData(couch);
  const lookup = buildLookupMapsFromData(lookupData);
  const bot = new Telegraf(config.telegramBotToken);
  const notificationChatId = [...config.allowedChatIds][0];

  const folder = process.argv[2] ?? "Archive";
  console.log(`Checking "${folder}" for the last 3 days...\n`);

  await pollOnce(
    { bot, config, couch, userId: credentials.userId, lookup, notificationChatId },
    folder,
    true  // skipStore: process everything regardless of prior runs
  );

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
