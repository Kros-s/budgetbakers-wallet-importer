/**
 * Batch processor: runs ONCE over a time window of inbox emails and exits.
 * Replaces the always-on IMAP poller (see docs/PLAN-daily-batch-refactor.md).
 *
 *   npx tsx src/cli/process-window.ts                       # watermark → now
 *   npx tsx src/cli/process-window.ts --from 2026-07-23     # explicit window
 *   npx tsx src/cli/process-window.ts --day 2026-07-25      # 20:00 → 20:00
 *   npx tsx src/cli/process-window.ts --dry-run             # propose, write nothing
 *   npx tsx src/cli/process-window.ts --force               # retry failed uids too
 *   npx tsx src/cli/process-window.ts --undo-run 2026-08-04 --yes
 *
 * Guarantees:
 *  - idempotent: uids already in the processed store or any ledger are skipped;
 *    the ledger is persisted after EVERY email, so a crash mid-run is safe.
 *  - a uid is marked processed ONLY when processEmail succeeded (failed ones
 *    are retried on later runs, max 3 attempts, then reported).
 *  - every extraction runs on an isolated fresh Haiku session (EMAIL_MODEL).
 *  - proposals are dedup-checked against real Wallet records (±48 h).
 */
import readline from "readline";
import { v4 as uuidv4 } from "uuid";
import PostalMime from "postal-mime";
import { Telegraf } from "telegraf";

import { loadEnvLocal } from "../env.js";
import { buildImapClient } from "../imap/client.js";
import { htmlToText } from "../imap/poller.js";
import { getProcessed, saveProcessed } from "../imap/processed-store.js";
import { classifyEmail } from "../classifier/email-rules.js";
import {
  appendRecords, closeLedger, latestWatermark, listLedgers, loadLedger,
  localDayStr, markClassifiedOut, markUidFailed, markUidProcessed, openLedger,
  uidsKnownToLedgers,
} from "../batch/ledger.js";
import { buildWalletDedup } from "../batch/wallet-dedup.js";
import { loadBotConfig } from "../bot/config.js";
import { runClaude } from "../bot/claude-runner.js";
import { buildCouchClient, buildLookupMapsFromData, fetchLookupData } from "../couch.js";
import { loadDirectCredentials } from "../direct-auth.js";
import { deleteRecords, getRecord } from "../records.js";
import { sendSafeMessage } from "../bot/telegram-safe.js";
import {
  EMAIL_MODEL, EMAIL_SYSTEM_PROMPT, buildEmailPrompt, processEmail,
} from "../webhook/email-processor.js";
import type { EmailDeps } from "../webhook/email-processor.js";

const MAX_ATTEMPTS = 3;

interface Args {
  from?: string;
  to?: string;
  day?: string;
  dryRun: boolean;
  force: boolean;
  undoRun?: string;
  yes: boolean;
  folder: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    from: get("--from"),
    to: get("--to"),
    day: get("--day"),
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
    undoRun: get("--undo-run"),
    yes: argv.includes("--yes"),
    folder: get("--folder") ?? "INBOX",
  };
}

function resolveWindow(args: Args): { from: Date; to: Date } {
  if (args.day) {
    const from = new Date(`${args.day}T20:00:00`);
    from.setDate(from.getDate() - 1);
    const to = new Date(`${args.day}T20:00:00`);
    return { from, to };
  }
  const to = args.to
    ? new Date(args.to.includes("T") ? args.to : `${args.to}T23:59:59`)
    : new Date();
  if (args.from) {
    return { from: new Date(args.from.includes("T") ? args.from : `${args.from}T00:00:00`), to };
  }
  const watermark = latestWatermark();
  if (!watermark) {
    throw new Error("No hay watermark (ningún ledger complete). Pasa --from la primera vez.");
  }
  return { from: watermark, to };
}

interface Fetched {
  uid: number;
  from: string;
  subject: string;
  date: Date;
  source?: Buffer;
}

async function fetchWindow(folder: string, from: Date, to: Date, wantBodies: Set<number> | null): Promise<{ messages: Fetched[]; uidValidity: bigint }> {
  const client = buildImapClient();
  await client.connect();
  const messages: Fetched[] = [];
  let uidValidity = 0n;
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      if (client.mailbox) uidValidity = (client.mailbox as { uidValidity: bigint }).uidValidity;
      const uids = await client.search({ since: from, before: to }, { uid: true });
      if (!uids || uids.length === 0) return { messages, uidValidity };
      const toFetch = wantBodies ? uids.filter((u) => wantBodies.has(u)) : uids;
      if (toFetch.length === 0) return { messages, uidValidity };
      const fetchOpts = wantBodies
        ? { envelope: true, internalDate: true, source: true }
        : { envelope: true, internalDate: true };
      for await (const msg of client.fetch(toFetch, fetchOpts, { uid: true })) {
        if (!msg.envelope) continue;
        const raw = msg.internalDate ?? msg.envelope.date ?? new Date(0);
        messages.push({
          uid: msg.uid,
          from: msg.envelope.from?.[0]?.address ?? "?",
          subject: msg.envelope.subject ?? "",
          date: raw instanceof Date ? raw : new Date(raw),
          source: msg.source,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return { messages, uidValidity };
}

async function extractBody(source: Buffer): Promise<string> {
  const parsed = await PostalMime.parse(source);
  return parsed.text?.trim() || (parsed.html ? htmlToText(parsed.html) : "");
}

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase() === "y");
    });
  });
}

async function undoRun(day: string, yes: boolean): Promise<void> {
  const ledger = loadLedger(day);
  if (!ledger) throw new Error(`No existe ledger para ${day}`);
  if (ledger.records.length === 0) {
    console.log(`Ledger ${day} no tiene registros escritos — nada que deshacer.`);
    return;
  }
  console.log(`Se borrarán ${ledger.records.length} registro(s) escritos por el run del ${day}:`);
  for (const r of ledger.records) console.log(`  ${r.couchId} ${r.txDate} $${r.amount} ${r.payee || r.category}`);
  if (!yes && !(await confirm("¿Borrar de Wallet?"))) {
    console.log("Cancelado.");
    return;
  }

  loadEnvLocal();
  const credentials = loadDirectCredentials();
  const couch = buildCouchClient(credentials.replication);
  const refs = [];
  for (const r of ledger.records) {
    const doc = await getRecord(couch, r.couchId);
    refs.push({ _id: doc._id, _rev: doc._rev! });
  }
  const results = await deleteRecords(couch, refs);
  const failed = results.filter((r) => r.error);
  console.log(`Borrados ${results.length - failed.length}/${refs.length}.`);
  if (failed.length) console.log("Fallidos:", failed);

  ledger.records = [];
  ledger.status = "failed"; // window no longer counts toward the watermark
  closeLedger(ledger, "failed");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.undoRun) {
    await undoRun(args.undoRun, args.yes);
    return;
  }

  loadEnvLocal();
  const { from, to } = resolveWindow(args);
  console.log(`\n── process-window ${args.dryRun ? "(DRY-RUN) " : ""}──`);
  console.log(`   ventana: ${from.toISOString()} → ${to.toISOString()} · folder=${args.folder} · model=${EMAIL_MODEL}\n`);

  // ── Phase 1: envelopes only, classify, decide what needs bodies ──
  const { messages: envelopes, uidValidity } = await fetchWindow(args.folder, from, to, null);
  console.log(`${envelopes.length} correo(s) en la ventana.`);

  const oldStore = getProcessed(args.folder, uidValidity);
  const ledgerKnown = uidsKnownToLedgers();
  const failedRetryable = new Map<number, number>(); // uid → attempts so far
  for (const l of listLedgers()) {
    for (const f of l.uidsFailed) {
      if (args.force || f.attempts < MAX_ATTEMPTS) failedRetryable.set(f.uid, f.attempts);
    }
  }

  const skipped: Fetched[] = [];
  const blocked: Fetched[] = [];
  const toProcess: Fetched[] = [];
  for (const env of envelopes) {
    const known = oldStore.has(env.uid) || ledgerKnown.has(env.uid);
    if (known && !failedRetryable.has(env.uid)) {
      skipped.push(env);
    } else if (classifyEmail(env.from, env.subject) === "block") {
      blocked.push(env);
    } else {
      toProcess.push(env);
    }
  }
  console.log(`ya procesados: ${skipped.length} · bloqueados por clasificador: ${blocked.length} · a procesar: ${toProcess.length}\n`);

  if (blocked.length + toProcess.length === 0) {
    console.log("Ventana ya procesada — nada que hacer.");
    return;
  }

  if (args.dryRun) {
    await dryRun(toProcess, blocked, args.folder, from, to);
    return;
  }

  // ── Live run ──
  const config = loadBotConfig();
  const credentials = loadDirectCredentials();
  const couch = buildCouchClient(credentials.replication);
  const lookupData = await fetchLookupData(couch);
  const lookup = buildLookupMapsFromData(lookupData);
  const bot = new Telegraf(config.telegramBotToken);
  const notificationChatId = [...config.allowedChatIds][0];
  const { check: walletDedup, existingCount } = await buildWalletDedup(couch, from, to);
  console.log(`dedup Wallet: ${existingCount} registro(s) existentes en ventana ±48h.\n`);

  const deps: EmailDeps = { bot, config, couch, userId: credentials.userId, lookup, notificationChatId, walletDedup };
  const ledger = openLedger(from, to);

  for (const env of blocked) {
    markClassifiedOut(ledger, { uid: env.uid, from: env.from, subject: env.subject });
  }

  // ── Phase 2: bodies for the emails that survived classification ──
  const wanted = new Set(toProcess.map((m) => m.uid));
  const { messages: full } = await fetchWindow(args.folder, from, to, wanted);
  const bodyByUid = new Map(full.map((m) => [m.uid, m] as const));

  const counts = { written: 0, duplicate: 0, no_transaction: 0, pending: 0, clarification: 0, failed: 0 };
  const succeededUids: number[] = [];

  for (let i = 0; i < toProcess.length; i++) {
    const env = toProcess[i];
    const msg = bodyByUid.get(env.uid);
    console.log(`[${i + 1}/${toProcess.length}] uid=${env.uid} ${env.from} — "${env.subject.slice(0, 70)}"`);
    try {
      if (!msg?.source) throw new Error("no se pudo descargar el cuerpo");
      const text = await extractBody(msg.source);
      if (!text) {
        markUidProcessed(ledger, env.uid);
        succeededUids.push(env.uid);
        counts.no_transaction++;
        continue;
      }
      const result = await processEmail(deps, { from: env.from, subject: env.subject, text });
      if (result.status === "written") {
        counts.written += result.written;
        appendRecords(ledger, (result.writtenIds ?? []).map((id) => ({
          couchId: id, accountId: "", amount: 0, payee: "", category: "",
          txDate: env.date.toISOString(), uid: env.uid,
        })));
      } else if (result.status === "duplicate") counts.duplicate++;
      else if (result.status === "no_transaction") counts.no_transaction++;
      else if (result.status === "pending_confirmation") counts.pending++;
      else if (result.status === "clarification") counts.clarification++;
      markUidProcessed(ledger, env.uid);
      succeededUids.push(env.uid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`   ✖ falló: ${message.slice(0, 200)}`);
      markUidFailed(ledger, env.uid, message.slice(0, 500), env.from, env.subject);
      counts.failed++;
    }
  }

  // Keep the legacy store coherent (uids that fully succeeded + blocked ones).
  const storeUids = [...succeededUids, ...blocked.map((b) => b.uid)];
  if (storeUids.length > 0) saveProcessed(args.folder, uidValidity, storeUids);

  const exhausted = ledger.uidsFailed.filter((f) => f.attempts >= MAX_ATTEMPTS);
  closeLedger(ledger, counts.failed === 0 ? "complete" : "failed");

  const summary =
    `📦 *Batch ${localDayStr()}*\n` +
    `Ventana: ${from.toISOString().slice(0, 16)} → ${to.toISOString().slice(0, 16)}\n` +
    `✅ Escritos: ${counts.written}\n` +
    `🔁 Duplicados evitados: ${counts.duplicate}\n` +
    `🚫 Bloqueados (clasificador): ${blocked.length}\n` +
    `▫️ Sin transacción: ${counts.no_transaction}\n` +
    `📋 Esperando confirmación: ${counts.pending} · 💬 Aclaraciones: ${counts.clarification}\n` +
    (counts.failed > 0 ? `⚠️ Fallidos (se reintentan): ${counts.failed}\n` : "") +
    (exhausted.length > 0
      ? `❌ Agotados (${MAX_ATTEMPTS} intentos): ${exhausted.map((f) => `"${f.subject.slice(0, 40)}"`).join(", ")}`
      : "");
  console.log(`\n${summary.replace(/\*/g, "")}`);
  try {
    await sendSafeMessage(bot.telegram, notificationChatId, summary);
  } catch (err) {
    console.error("No se pudo enviar el resumen a Telegram:", err instanceof Error ? err.message : err);
  }
  process.exit(counts.failed > 0 ? 1 : 0);
}

/** Dry-run: fresh Haiku per email, print proposals, write NOTHING anywhere. */
async function dryRun(toProcess: Fetched[], blocked: Fetched[], folder: string, from: Date, to: Date): Promise<void> {
  const config = loadBotConfig();
  const credentials = loadDirectCredentials();
  const couch = buildCouchClient(credentials.replication);
  const { check: walletDedup, existingCount } = await buildWalletDedup(couch, from, to);
  console.log(`dedup Wallet: ${existingCount} registro(s) existentes en ventana ±48h.\n`);
  void walletDedup; // full row→record conversion happens live; dry-run reports raw CSV

  for (const b of blocked) console.log(`🚫 uid=${b.uid} ${b.from} — "${b.subject.slice(0, 60)}" (clasificador)`);

  const wanted = new Set(toProcess.map((m) => m.uid));
  const { messages: full } = await fetchWindow(folder, from, to, wanted);
  const bodyByUid = new Map(full.map((m) => [m.uid, m] as const));

  for (let i = 0; i < toProcess.length; i++) {
    const env = toProcess[i];
    const msg = bodyByUid.get(env.uid);
    process.stdout.write(`[${i + 1}/${toProcess.length}] uid=${env.uid} ${env.from} — "${env.subject.slice(0, 60)}" → `);
    try {
      if (!msg?.source) throw new Error("sin cuerpo");
      const text = await extractBody(msg.source);
      if (!text) {
        console.log("(cuerpo vacío)");
        continue;
      }
      const result = await runClaude({
        config,
        sessionId: uuidv4(),
        isFirstTurn: true,
        prompt: buildEmailPrompt({ from: env.from, subject: env.subject, text }),
        appendSystemPrompt: EMAIL_SYSTEM_PROMPT,
        timeoutMs: 90_000,
        model: EMAIL_MODEL,
      });
      const line = result.text.trim();
      if (line === "NO_TRANSACTION" || line.endsWith("NO_TRANSACTION")) console.log("NO_TRANSACTION");
      else console.log(`\n${line}\n`);
    } catch (err) {
      console.log(`✖ ${err instanceof Error ? err.message.slice(0, 150) : err}`);
    }
  }
  console.log("\nDRY-RUN terminado — no se escribió nada (ni ledger, ni store, ni Wallet, ni Telegram).");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
