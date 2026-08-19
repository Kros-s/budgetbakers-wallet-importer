import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { pruneBotLogs, pruneLedgers, pruneOldFiles } from "../../batch/retention.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "retention-test-"));
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-19T12:00:00.000Z");

function write(name: string, ageDays: number): string {
  const full = path.join(scratch, name);
  fs.writeFileSync(full, "x");
  const t = new Date(NOW - ageDays * DAY);
  fs.utimesSync(full, t, t);
  return full;
}

beforeEach(() => {
  for (const f of fs.readdirSync(scratch)) fs.rmSync(path.join(scratch, f), { force: true });
});

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("deletes logs past the window and keeps the recent ones", () => {
  write("bot-old-1.log", 40);
  write("bot-old-2.log", 20);
  write("bot-fresh-1.log", 1);
  write("bot-fresh-2.log", 2);
  write("bot-fresh-3.log", 3);
  const r = pruneBotLogs(scratch, NOW);
  assert.deepEqual(r.deleted.sort(), ["bot-old-1.log", "bot-old-2.log"]);
  assert.equal(fs.readdirSync(scratch).length, 3);
});

test("keepNewest spares recent files even when every file is ancient", () => {
  write("bot-a.log", 100);
  write("bot-b.log", 90);
  write("bot-c.log", 80);
  write("bot-d.log", 70);
  const r = pruneBotLogs(scratch, NOW);
  // The three newest survive by rule, the oldest goes.
  assert.deepEqual(r.deleted, ["bot-a.log"]);
});

test("the newest ledger is never deleted, however stale — the watermark lives in it", () => {
  // Exactly the Aug 5–19 outage: the only ledger was already 14 days old, and
  // deleting it would restart the pipeline from its default lookback.
  write("day-ledger-2026-08-04.json", 14);
  const r = pruneLedgers(scratch, NOW);
  assert.deepEqual(r.deleted, []);
  assert.ok(fs.existsSync(path.join(scratch, "day-ledger-2026-08-04.json")));
});

test("older ledgers go once newer ones exist", () => {
  write("day-ledger-2026-06-01.json", 79);
  write("day-ledger-2026-06-02.json", 78);
  write("day-ledger-2026-08-18.json", 1);
  write("day-ledger-2026-08-19.json", 0);
  const r = pruneLedgers(scratch, NOW);
  assert.deepEqual(r.deleted.sort(), ["day-ledger-2026-06-01.json", "day-ledger-2026-06-02.json"]);
});

test("only matching names are touched — user data is never a candidate", () => {
  // Four old logs so keepNewest cannot spare them all.
  for (const n of ["bot-1.log", "bot-2.log", "bot-3.log", "bot-4.log"]) write(n, 40);
  write("learned-rules.md", 400);
  write("pending-clarifications.json", 400);
  write("sessions.json", 400);
  write("email-rules.json", 400);
  const r = pruneBotLogs(scratch, NOW);
  assert.equal(r.deleted.length, 1, "debería borrar solo el más viejo de los cuatro");
  assert.match(r.deleted[0], /^bot-.*\.log$/);
  for (const survivor of ["learned-rules.md", "pending-clarifications.json", "sessions.json", "email-rules.json"]) {
    assert.ok(fs.existsSync(path.join(scratch, survivor)), `${survivor} fue borrado`);
  }
});

test("a missing directory is not an error", () => {
  assert.deepEqual(pruneOldFiles({
    dir: path.join(scratch, "nope"), pattern: /./, maxAgeDays: 1, keepNewest: 0,
  }), { deleted: [], kept: 0 });
});
