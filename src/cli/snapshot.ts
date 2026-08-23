/**
 * Backups and the undo that makes them usable.
 *
 *   npx tsx src/cli/snapshot.ts take
 *   npx tsx src/cli/snapshot.ts list
 *   npx tsx src/cli/snapshot.ts undo 2026-07 [--account MIFEL] [--write]
 *
 * A snapshot of nineteen thousand records is the last resort, not the first:
 * restoring it over a live account is a more dangerous operation than most of
 * the mistakes it would be recovering from. `undo` is the first resort — it
 * removes exactly what one reconcile run added, named by the marker that run
 * stamped on every record it wrote.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { loadEnvLocal } from "../env.js";
import { buildCouchClient, buildLookupMapsFromData, fetchLookupData } from "../couch.js";
import { loadDirectCredentials } from "../direct-auth.js";
import { deleteRecords } from "../records.js";
import type { WalletRecord } from "../types.js";
import { describeSelection, selectWritten } from "../statements/undo.js";

const DIR = path.resolve("data/backups-full");

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function take(couch: ReturnType<typeof buildCouchClient>): Promise<void> {
  const res = await couch.get("/_all_docs", { params: { include_docs: true } });
  const rows = (res.data as { rows: unknown[] }).rows ?? [];
  fs.mkdirSync(DIR, { recursive: true });
  const out = path.join(DIR, `couch-full-${stamp()}.json.gz`);
  fs.writeFileSync(out, zlib.gzipSync(Buffer.from(JSON.stringify(res.data)), { level: 9 }));
  fs.chmodSync(out, 0o600);
  console.log(`${rows.length} documento(s) → ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB, 600)`);
}

function list(): void {
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.startsWith("couch-full-")).sort() : [];
  if (!files.length) { console.log("Sin respaldos completos. Corre: snapshot.ts take"); return; }
  for (const f of files) {
    const p = path.join(DIR, f);
    // Read it back, not just stat it: a snapshot nobody can open is not a backup.
    let docs = "ilegible";
    try {
      docs = String((JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString()) as { rows: unknown[] }).rows.length);
    } catch { /* leave it as ilegible — that is the finding */ }
    console.log(`  ${f}  ${(fs.statSync(p).size / 1048576).toFixed(1)} MB  ${docs} docs`);
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const argv = process.argv.slice(2);
  const [cmd, arg] = argv;
  if (cmd === "list") return list();

  const credentials = loadDirectCredentials();
  const couch = buildCouchClient(credentials.replication);
  if (!cmd || cmd === "take") return take(couch);

  if (cmd === "undo") {
    if (!/^\d{4}-\d{2}$/.test(arg ?? "")) throw new Error("Uso: snapshot.ts undo YYYY-MM [--account X] [--write]");
    const i = argv.indexOf("--account");
    const account = i !== -1 ? argv[i + 1] : undefined;
    const write = argv.includes("--write");

    const lookup = buildLookupMapsFromData(await fetchLookupData(couch));
    const namesById: Record<string, string> = {};
    for (const [name, id] of Object.entries(lookup.accounts)) namesById[id] = name;

    const res = await couch.get("/_all_docs", {
      params: { startkey: '"Record_"', endkey: '"Record_￰"', include_docs: true },
    });
    const all = ((res.data as { rows: { doc?: WalletRecord }[] }).rows ?? [])
      .map((r) => r.doc)
      .filter((d): d is WalletRecord => Boolean(d));

    const sel = selectWritten(all, arg, namesById, account);
    console.log(describeSelection(sel, arg, account));
    if (!sel.records.length) return;
    if (!write) {
      console.log(`\nNada borrado. Repite con --write para quitarlos.`);
      return;
    }
    const out = await deleteRecords(couch, sel.records.map((r) => ({ _id: r._id!, _rev: (r as { _rev: string })._rev })));
    const failed = out.filter((o) => (o as { error?: string }).error);
    console.log(`\n🗑️ ${out.length - failed.length} quitado(s)${failed.length ? `, ${failed.length} fallaron` : ""}.`);
    return;
  }
  throw new Error(`Comando desconocido: ${cmd}`);
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
