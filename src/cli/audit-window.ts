/**
 * Read-only audit: which emails in a date window were never processed?
 *
 * Compares the mailbox against every local register (processed-uids store,
 * daily trackers, bot logs) WITHOUT writing anything — no records, no UID
 * store updates, no Claude invocations. Safe to run any number of times.
 *
 * Usage:
 *   npx tsx src/cli/audit-window.ts --day 2026-07-25
 *   npx tsx src/cli/audit-window.ts --from 2026-07-23 [--to 2026-08-03]
 *   npx tsx src/cli/audit-window.ts                    (from last tracker day → now)
 *   npx tsx src/cli/audit-window.ts --folder Archive   (default INBOX)
 *
 * Output: per-day console report + data/bot/audit-report-<from>_<to>.json
 */
import fs from "fs";
import path from "path";

import { loadEnvLocal } from "../env.js";
import { buildImapClient } from "../imap/client.js";

const BANK_SENDER_PATTERNS = [
  /banamex/i, /banorte/i, /americanexpress|amex/i, /\bnu\b|nubank|nu\.com/i,
  /klar/i, /bbva|bancomer/i, /mifel/i, /uala|ualá/i, /revolut/i,
  /bitso/i, /gbm/i, /binance/i, /dolarapp/i, /mercadopago|mercado pago/i,
  /finsus/i, /didi/i, /pluxee/i, /openbank|open bank/i, /costco.*citi|citibanamex/i,
];
const IGNORED_SENDER_PATTERNS = [/walmart/i, /cashi/i];

interface Args {
  from: Date;
  to: Date;
  folder: string;
}

function localDayStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function lastTrackerDay(): string | null {
  const dir = path.resolve("data/bot");
  const days = fs.readdirSync(dir)
    .map((f) => /^daily-tracker-(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1])
    .filter((d): d is string => Boolean(d))
    .sort();
  return days.at(-1) ?? null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const folder = get("--folder") ?? "INBOX";
  const day = get("--day");
  if (day) {
    const from = new Date(`${day}T00:00:00`);
    const to = new Date(`${day}T00:00:00`);
    to.setDate(to.getDate() + 1);
    return { from, to, folder };
  }
  const fromArg = get("--from") ?? lastTrackerDay();
  if (!fromArg) throw new Error("No --day/--from given and no daily-tracker files found");
  const from = new Date(fromArg.includes("T") ? fromArg : `${fromArg}T00:00:00`);
  const toArg = get("--to");
  const to = toArg ? new Date(toArg.includes("T") ? toArg : `${toArg}T23:59:59`) : new Date();
  return { from, to, folder };
}

interface EnvelopeInfo {
  uid: number;
  date: string; // ISO
  day: string;  // local YYYY-MM-DD
  from: string;
  subject: string;
}

async function fetchEnvelopes(args: Args): Promise<{ envelopes: EnvelopeInfo[]; uidValidity: bigint }> {
  const client = buildImapClient();
  await client.connect();
  const envelopes: EnvelopeInfo[] = [];
  let uidValidity = 0n;
  try {
    const lock = await client.getMailboxLock(args.folder);
    try {
      if (client.mailbox) uidValidity = (client.mailbox as { uidValidity: bigint }).uidValidity;
      const uids = await client.search({ since: args.from, before: args.to }, { uid: true });
      if (!uids || uids.length === 0) return { envelopes, uidValidity };
      for await (const msg of client.fetch(uids, { envelope: true, internalDate: true }, { uid: true })) {
        if (!msg.envelope) continue;
        const raw = msg.internalDate ?? msg.envelope.date ?? new Date(0);
        const date = raw instanceof Date ? raw : new Date(raw);
        envelopes.push({
          uid: msg.uid,
          date: date.toISOString(),
          day: localDayStr(date),
          from: msg.envelope.from?.[0]?.address ?? "?",
          subject: msg.envelope.subject ?? "",
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return { envelopes, uidValidity };
}

function loadProcessedUids(folder: string, uidValidity: bigint): Set<number> {
  try {
    const store = JSON.parse(fs.readFileSync(path.resolve("data/imap/processed-uids.json"), "utf8"));
    const entry = store[folder];
    if (!entry) return new Set();
    if (entry.uidValidity !== uidValidity.toString()) {
      console.warn(`⚠️  uidValidity mismatch for ${folder} (store=${entry.uidValidity}, mailbox=${uidValidity}) — store entries unusable`);
      return new Set();
    }
    return new Set(entry.uids as number[]);
  } catch {
    return new Set();
  }
}

/** UIDs that appear anywhere in the bot logs ("uid=NNN"), i.e. the bot at least saw them. */
function uidsSeenInLogs(): Set<number> {
  const seen = new Set<number>();
  const dir = path.resolve("data/bot");
  const logFiles = ["launchd.out.log", "launchd.err.log", "main.log"]
    .map((f) => path.join(dir, f))
    .filter((p) => fs.existsSync(p));
  for (const file of logFiles) {
    const content = fs.readFileSync(file, "utf8");
    for (const m of content.matchAll(/uid=(\d+)/g)) seen.add(Number(m[1]));
  }
  return seen;
}

interface TrackerEntry { ts: string; account: string; amount: number; category: string; payee: string; status: string }

function loadTrackerEntries(from: Date, to: Date): Map<string, TrackerEntry[]> {
  const byDay = new Map<string, TrackerEntry[]>();
  const dir = path.resolve("data/bot");
  for (const f of fs.readdirSync(dir)) {
    const day = /^daily-tracker-(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1];
    if (!day) continue;
    const d = new Date(`${day}T12:00:00`);
    if (d < from || d > to) continue;
    try {
      const store = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      byDay.set(day, store.entries as TrackerEntry[]);
    } catch { /* unreadable tracker — skip */ }
  }
  return byDay;
}

function classify(env: EnvelopeInfo): "ignored" | "bank" | "other" {
  const hay = `${env.from} ${env.subject}`;
  if (IGNORED_SENDER_PATTERNS.some((r) => r.test(hay))) return "ignored";
  if (BANK_SENDER_PATTERNS.some((r) => r.test(env.from))) return "bank";
  return "other";
}

async function main() {
  loadEnvLocal();
  if (!process.env.ICLOUD_EMAIL || !process.env.ICLOUD_APP_PASSWORD) {
    throw new Error("ICLOUD_EMAIL / ICLOUD_APP_PASSWORD not set (.env.local)");
  }
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n── Audit (read-only) ── folder=${args.folder}`);
  console.log(`   window: ${args.from.toISOString()} → ${args.to.toISOString()}\n`);

  const { envelopes, uidValidity } = await fetchEnvelopes(args);
  console.log(`Fetched ${envelopes.length} envelope(s) from ${args.folder}.`);

  const processed = loadProcessedUids(args.folder, uidValidity);
  const logged = uidsSeenInLogs();
  const trackers = loadTrackerEntries(args.from, args.to);

  const report: Record<string, unknown>[] = [];
  const days = [...new Set(envelopes.map((e) => e.day))].sort();

  for (const day of days) {
    const dayEnvs = envelopes.filter((e) => e.day === day).sort((a, b) => a.uid - b.uid);
    const missing = dayEnvs.filter((e) => !processed.has(e.uid) && !logged.has(e.uid));
    const written = trackers.get(day) ?? [];

    const missingBank = missing.filter((e) => classify(e) === "bank");
    const missingOther = missing.filter((e) => classify(e) === "other");
    const missingIgnored = missing.filter((e) => classify(e) === "ignored");

    console.log(`\n📅 ${day} — ${dayEnvs.length} correo(s) | procesados: ${dayEnvs.length - missing.length} | sin procesar: ${missing.length} | registros escritos ese día: ${written.length}`);
    if (missingBank.length > 0) {
      console.log(`   ❗ Bancarios SIN procesar (candidatos a transacción perdida):`);
      for (const e of missingBank) console.log(`      uid=${e.uid} ${e.date.slice(11, 16)}Z ${e.from} — "${e.subject.slice(0, 80)}"`);
    }
    if (missingIgnored.length > 0) console.log(`   🚫 Sin procesar pero ignorables (Walmart/Cashi): ${missingIgnored.length}`);
    if (missingOther.length > 0) console.log(`   ▫️ Otros sin procesar (probable marketing): ${missingOther.length}`);
    if (written.length > 0) {
      for (const t of written) console.log(`   ✅ escrito: ${t.ts.slice(11, 16)}Z ${t.account} $${t.amount} ${t.payee || t.category}`);
    }

    report.push({
      day,
      totalEmails: dayEnvs.length,
      unprocessed: missing.map((e) => ({ ...e, class: classify(e) })),
      recordsWritten: written,
    });
  }

  // Tracker days with no email at all in the window (sanity view)
  for (const [day, entries] of trackers) {
    if (!days.includes(day)) {
      console.log(`\n📅 ${day} — 0 correos en ventana, pero ${entries.length} registro(s) en tracker`);
    }
  }

  const outPath = path.resolve(`data/bot/audit-report-${localDayStr(args.from)}_${localDayStr(args.to)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ window: { from: args.from.toISOString(), to: args.to.toISOString() }, folder: args.folder, uidValidity: uidValidity.toString(), days: report }, null, 2));

  const totalMissingBank = report.reduce((s, r) => s + (r.unprocessed as { class: string }[]).filter((u) => u.class === "bank").length, 0);
  console.log(`\n──────────`);
  console.log(`Reporte: ${outPath}`);
  console.log(`Total correos bancarios sin procesar en la ventana: ${totalMissingBank}`);
  console.log(`Nada fue modificado (auditoría de solo lectura).`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
