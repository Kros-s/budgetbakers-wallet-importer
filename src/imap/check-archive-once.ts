/**
 * One-shot interactive script: checks Archive (or any folder) for the last 3
 * days and processes emails one by one, pausing after each real transaction
 * so you can act on it in Telegram before continuing.
 *
 * Usage:
 *   npx tsx src/imap/check-archive-once.ts [folder]
 *
 * Defaults to "Archive". NO_TRANSACTION emails are skipped automatically.
 */
import readline from "readline";
import { Telegraf } from "telegraf";

import { loadEnvLocal } from "../env.js";
import { loadBotConfig } from "../bot/config.js";
import { buildCouchClient, buildLookupMapsFromData, fetchLookupData } from "../couch.js";
import { loadDirectCredentials } from "../direct-auth.js";
import { pollOnce } from "./poller.js";

function waitForEnter(message: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  loadEnvLocal();

  const config = loadBotConfig();
  const credentials = loadDirectCredentials();
  const couch = buildCouchClient(credentials.replication);
  const lookupData = await fetchLookupData(couch);
  const lookup = buildLookupMapsFromData(lookupData);
  const bot = new Telegraf(config.telegramBotToken);
  const notificationChatId = [...config.allowedChatIds][0];

  const folder = process.argv[2] ?? "Archive";
  console.log(`Checking "${folder}" — last 3 days, interactive mode.\n`);
  console.log("NO_TRANSACTION emails se saltan automáticamente.");
  console.log("Para cada transacción encontrada, actúa en Telegram y presiona Enter aquí.\n");

  await pollOnce(
    { bot, config, couch, userId: credentials.userId, lookup, notificationChatId },
    folder,
    true,  // skipStore: process everything regardless of prior runs
    async (status, total, current) => {
      if (status === "no_transaction") return; // auto-skip, no pause

      const label: Record<string, string> = {
        written:              "✅ Escrito automáticamente",
        pending_confirmation: "📋 Propuesta enviada a Telegram — confirma con ✅ o ❌",
        clarification:        "💬 Claude preguntó algo — responde en Telegram",
        duplicate:            "🔁 Duplicado detectado — omitido",
      };

      console.log(`\n[${current}/${total}] ${label[status] ?? status}`);
      await waitForEnter("Presiona Enter para continuar con el siguiente correo...");
    }
  );

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
