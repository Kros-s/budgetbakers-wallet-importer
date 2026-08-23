import { loadEnvLocal } from "./src/env.js";
import { buildCouchClient, fetchLookupData } from "./src/couch.js";
import { loadDirectCredentials } from "./src/direct-auth.js";
import { listRecordsByDateRange } from "./src/records.js";

async function main() {
  loadEnvLocal();
  const creds = await loadDirectCredentials();
  const couch = buildCouchClient(creds as any);
  const data: any = await fetchLookupData(couch);
  const recs: any[] = await listRecordsByDateRange(couch, "2026-06-20T00:00:00", "2026-08-05T00:00:00");
  const hits = recs.filter((r: any) => Math.abs(r.amount) === 174000);
  for (const h of hits) console.log(JSON.stringify(h));
  console.log("KEYS", Object.keys(data));
}
main();
