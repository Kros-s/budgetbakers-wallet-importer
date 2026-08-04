/**
 * Read-only duplicate audit over REAL Wallet records written by the bot
 * (note starts with "[Claude"). Clusters likely duplicates and produces a
 * per-day report for user approval — NOTHING is deleted here.
 *
 *   npx tsx src/cli/audit-duplicates.ts [--since 2026-05-11] [--slack-hours 48]
 *
 * Output: console summary + data/bot/duplicate-report-<since>_<today>.json
 * The report's `proposedDeletions` lists the record ids that would be removed
 * (keeping the EARLIEST record of each cluster).
 */
import fs from "fs";
import path from "path";

import { loadEnvLocal } from "../env.js";
import { buildCouchClient } from "../couch.js";
import { loadDirectCredentials } from "../direct-auth.js";
import { listRecordsByDateRange } from "../records.js";
import type { WalletRecord } from "../types.js";

interface BotRecord {
  id: string;
  accountId: string;
  amount: number;      // minor units
  type: 0 | 1;
  recordDate: string;
  createdAt: string;
  note: string;
  payee: string;
}

function normalizePayee(p: string): string {
  return p.trim().toLowerCase().replace(/\s+/g, " ");
}

function toBotRecord(doc: WalletRecord & { _id: string; reservedCreatedAt?: string }): BotRecord {
  return {
    id: doc._id,
    accountId: doc.accountId,
    amount: doc.amount,
    type: doc.type,
    recordDate: doc.recordDate,
    createdAt: doc.reservedCreatedAt ?? "",
    note: doc.note ?? "",
    payee: doc.payee ?? "",
  };
}

/** Transitive clustering inside account+amount+type buckets. */
export function clusterDuplicates(records: BotRecord[], slackMs: number): BotRecord[][] {
  const buckets = new Map<string, BotRecord[]>();
  for (const r of records) {
    const key = `${r.accountId}|${r.amount}|${r.type}`;
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }

  const clusters: BotRecord[][] = [];
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.recordDate.localeCompare(b.recordDate));
    let current: BotRecord[] = [list[0]];
    for (let i = 1; i < list.length; i++) {
      const prev = current[current.length - 1];
      const cur = list[i];
      const dt = Date.parse(cur.recordDate) - Date.parse(prev.recordDate);
      const pp = normalizePayee(prev.payee);
      const cp = normalizePayee(cur.payee);
      const payeeCompatible = !pp || !cp || pp === cp;
      if (dt <= slackMs && payeeCompatible) {
        current.push(cur);
      } else {
        if (current.length > 1) clusters.push(current);
        current = [cur];
      }
    }
    if (current.length > 1) clusters.push(current);
  }
  return clusters;
}

async function main() {
  loadEnvLocal();
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const since = get("--since") ?? "2026-05-11";
  const slackMs = Number(get("--slack-hours") ?? 48) * 60 * 60 * 1000;
  const today = new Date().toISOString().slice(0, 10);

  const credentials = loadDirectCredentials();
  const couch = buildCouchClient(credentials.replication);

  console.log(`\n── Auditoría de duplicados (solo lectura) ── desde ${since}\n`);
  const all = await listRecordsByDateRange(couch, `${since}T00:00:00`, new Date().toISOString());
  const botRecords = all
    .filter((d) => typeof d.note === "string" && d.note.startsWith("[Claude"))
    .map((d) => toBotRecord(d as WalletRecord & { _id: string }));
  console.log(`${all.length} registro(s) en el rango; ${botRecords.length} escritos por el bot ([Claude).`);

  const clusters = clusterDuplicates(botRecords, slackMs);

  const proposedDeletions: string[] = [];
  for (const cluster of clusters) {
    // Keep the earliest write (by createdAt when present, else recordDate).
    const sorted = [...cluster].sort((a, b) =>
      (a.createdAt || a.recordDate).localeCompare(b.createdAt || b.recordDate));
    for (const dup of sorted.slice(1)) proposedDeletions.push(dup.id);

    const r = sorted[0];
    console.log(`\n🔁 ${r.recordDate.slice(0, 10)} · cuenta ${r.accountId.slice(0, 20)}… · $${(r.amount / 100).toFixed(2)} · ${r.payee || r.note}`);
    for (const [i, c] of sorted.entries()) {
      console.log(`   ${i === 0 ? "✅ conservar" : "❌ borrar   "} ${c.id} (${c.recordDate}, creado ${c.createdAt || "?"})`);
    }
  }

  const outPath = path.resolve(`data/bot/duplicate-report-${since}_${today}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    since, generatedAt: new Date().toISOString(), slackMs,
    totalBotRecords: botRecords.length,
    clusters: clusters.map((c) => c.map((r) => ({ ...r }))),
    proposedDeletions,
  }, null, 2));

  console.log(`\n──────────`);
  console.log(`Clusters de duplicados: ${clusters.length} · registros propuestos a borrar: ${proposedDeletions.length}`);
  console.log(`Reporte: ${outPath}`);
  console.log(`Nada fue modificado. El borrado requiere aprobación explícita del usuario.`);
}

const isDirectRun = process.argv[1]?.endsWith("audit-duplicates.ts") || process.argv[1]?.endsWith("audit-duplicates.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
