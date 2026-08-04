import fs from "fs";
import path from "path";

/**
 * Per-run ledger for the batch processor. One JSON file per local day
 * (data/bot/day-ledger-YYYY-MM-DD.json); a second run on the same day merges
 * into the same file. Written incrementally after EVERY email so a crash
 * mid-run never loses the record of what was already done — that's the
 * idempotency guarantee the old poller lacked.
 */

export interface LedgerRecord {
  couchId: string;
  accountId: string;
  amount: number;   // signed float, as proposed in the CSV row
  payee: string;
  category: string;
  txDate: string;   // recordDate ISO
  uid: number;
}

export interface FailedUid {
  uid: number;
  attempts: number;
  lastError: string;
  from: string;
  subject: string;
}

export interface ClassifiedOut {
  uid: number;
  from: string;
  subject: string;
}

export interface RunLedger {
  day: string;                       // local YYYY-MM-DD of the run
  window: { from: string; to: string };
  status: "running" | "complete" | "failed";
  startedAt: string;
  finishedAt?: string;
  uidsProcessed: number[];
  uidsFailed: FailedUid[];
  classifiedOut: ClassifiedOut[];
  records: LedgerRecord[];
}

const LEDGER_DIR = path.resolve("data/bot");
const LEDGER_RE = /^day-ledger-(\d{4}-\d{2}-\d{2})\.json$/;

export function localDayStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function ledgerPath(day: string): string {
  return path.join(LEDGER_DIR, `day-ledger-${day}.json`);
}

export function loadLedger(day: string): RunLedger | null {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(day), "utf8")) as RunLedger;
  } catch {
    return null;
  }
}

export function saveLedger(ledger: RunLedger): void {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  const p = ledgerPath(ledger.day);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, p); // atomic on the same fs — a crash never corrupts it
}

/**
 * Opens today's ledger for a run over [from, to]. If a ledger already exists
 * for today (earlier manual run + scheduled run), the new window is merged
 * and processed uids are preserved.
 */
export function openLedger(from: Date, to: Date, day = localDayStr()): RunLedger {
  const existing = loadLedger(day);
  if (existing) {
    existing.window = {
      from: new Date(Math.min(Date.parse(existing.window.from), from.getTime())).toISOString(),
      to: new Date(Math.max(Date.parse(existing.window.to), to.getTime())).toISOString(),
    };
    existing.status = "running";
    saveLedger(existing);
    return existing;
  }
  const fresh: RunLedger = {
    day,
    window: { from: from.toISOString(), to: to.toISOString() },
    status: "running",
    startedAt: new Date().toISOString(),
    uidsProcessed: [],
    uidsFailed: [],
    classifiedOut: [],
    records: [],
  };
  saveLedger(fresh);
  return fresh;
}

/** All uids any ledger has fully processed or classified out (idempotency set). */
export function uidsKnownToLedgers(): Set<number> {
  const known = new Set<number>();
  for (const l of listLedgers()) {
    for (const uid of l.uidsProcessed) known.add(uid);
    for (const c of l.classifiedOut) known.add(c.uid);
  }
  return known;
}

export function listLedgers(): RunLedger[] {
  let files: string[];
  try {
    files = fs.readdirSync(LEDGER_DIR);
  } catch {
    return [];
  }
  const out: RunLedger[] = [];
  for (const f of files) {
    if (!LEDGER_RE.test(f)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(LEDGER_DIR, f), "utf8")) as RunLedger);
    } catch { /* unreadable ledger — skip */ }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Watermark: end of the newest COMPLETE ledger window. Next default run
 * covers watermark → now, so downtime (Mac off, migration) self-heals.
 */
export function latestWatermark(): Date | null {
  const complete = listLedgers().filter((l) => l.status === "complete");
  if (complete.length === 0) return null;
  const newest = complete.reduce((a, b) =>
    Date.parse(a.window.to) >= Date.parse(b.window.to) ? a : b);
  return new Date(newest.window.to);
}

export function markUidProcessed(ledger: RunLedger, uid: number): void {
  if (!ledger.uidsProcessed.includes(uid)) ledger.uidsProcessed.push(uid);
  ledger.uidsFailed = ledger.uidsFailed.filter((f) => f.uid !== uid);
  saveLedger(ledger);
}

export function markUidFailed(ledger: RunLedger, uid: number, error: string, from: string, subject: string): void {
  const existing = ledger.uidsFailed.find((f) => f.uid === uid);
  if (existing) {
    existing.attempts += 1;
    existing.lastError = error;
  } else {
    ledger.uidsFailed.push({ uid, attempts: 1, lastError: error, from, subject });
  }
  saveLedger(ledger);
}

export function markClassifiedOut(ledger: RunLedger, entry: ClassifiedOut): void {
  if (!ledger.classifiedOut.some((c) => c.uid === entry.uid)) ledger.classifiedOut.push(entry);
  saveLedger(ledger);
}

export function appendRecords(ledger: RunLedger, records: LedgerRecord[]): void {
  ledger.records.push(...records);
  saveLedger(ledger);
}

export function closeLedger(ledger: RunLedger, status: "complete" | "failed"): void {
  ledger.status = status;
  ledger.finishedAt = new Date().toISOString();
  saveLedger(ledger);
}
