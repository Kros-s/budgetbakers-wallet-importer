/**
 * Applies a user-approved duplicate report: backs up the FULL document body
 * of every record in `proposedDeletions`, then deletes them from CouchDB.
 * The backup (data/bot/cleanup-<date>.json) makes every deletion restorable.
 *
 *   npx tsx src/cli/apply-duplicate-cleanup.ts <duplicate-report.json> --yes
 */
import fs from "fs";
import path from "path";

import { loadEnvLocal } from "../env.js";
import { buildCouchClient } from "../couch.js";
import { loadDirectCredentials } from "../direct-auth.js";
import { deleteRecords, getRecord } from "../records.js";

async function main() {
  const [reportPath, yesFlag] = process.argv.slice(2);
  if (!reportPath) throw new Error("Uso: apply-duplicate-cleanup.ts <reporte.json> --yes");
  if (yesFlag !== "--yes") throw new Error("Este script borra registros; requiere --yes explícito.");

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { proposedDeletions: string[] };
  const ids: string[] = report.proposedDeletions;
  if (!ids?.length) {
    console.log("El reporte no propone borrados.");
    return;
  }

  loadEnvLocal();
  const credentials = loadDirectCredentials();
  const couch = buildCouchClient(credentials.replication);

  console.log(`Respaldando ${ids.length} documento(s) completos antes de borrar…`);
  const backups = [];
  for (const id of ids) backups.push(await getRecord(couch, id));

  const backupPath = path.resolve(`data/bot/cleanup-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({
    deletedAt: new Date().toISOString(),
    sourceReport: path.basename(reportPath),
    documents: backups,
  }, null, 2));
  console.log(`Respaldo: ${backupPath}`);

  const results = await deleteRecords(couch, backups.map((d) => ({ _id: d._id!, _rev: d._rev! })));
  const failed = results.filter((r) => r.error);
  console.log(`Borrados ${results.length - failed.length}/${ids.length}.`);
  if (failed.length) {
    console.error("Fallidos:", failed);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
