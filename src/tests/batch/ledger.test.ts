import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// The ledger module resolves data/bot relative to cwd — run the whole file
// inside a scratch dir so tests never touch the real ledgers.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
const originalCwd = process.cwd();
process.chdir(scratch);

const {
  openLedger, loadLedger, latestWatermark, markUidProcessed, markUidFailed,
  markClassifiedOut, closeLedger, uidsKnownToLedgers, localDayStr,
} = await import("../../batch/ledger.js");

beforeEach(() => {
  fs.rmSync(path.join(scratch, "data"), { recursive: true, force: true });
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(scratch, { recursive: true, force: true });
});

const from = new Date("2026-08-03T20:00:00Z");
const to = new Date("2026-08-04T20:00:00Z");

test("openLedger creates a running ledger and persists incrementally", () => {
  const ledger = openLedger(from, to, "2026-08-04");
  assert.equal(ledger.status, "running");

  markUidProcessed(ledger, 100);
  markClassifiedOut(ledger, { uid: 101, from: "noreply@walmart.com", subject: "pedido" });

  const reloaded = loadLedger("2026-08-04");
  assert.deepEqual(reloaded?.uidsProcessed, [100]);
  assert.equal(reloaded?.classifiedOut[0].uid, 101);
});

test("watermark comes only from complete ledgers", () => {
  const ledger = openLedger(from, to, "2026-08-04");
  assert.equal(latestWatermark(), null); // running doesn't count

  closeLedger(ledger, "complete");
  assert.equal(latestWatermark()?.toISOString(), to.toISOString());
});

test("failed ledgers never advance the watermark", () => {
  const ledger = openLedger(from, to, "2026-08-04");
  closeLedger(ledger, "failed");
  assert.equal(latestWatermark(), null);
});

test("reopening the same day merges windows and keeps processed uids", () => {
  const first = openLedger(from, to, "2026-08-04");
  markUidProcessed(first, 7);
  closeLedger(first, "complete");

  const later = new Date("2026-08-04T23:00:00Z");
  const merged = openLedger(to, later, "2026-08-04");
  assert.deepEqual(merged.uidsProcessed, [7]);
  assert.equal(merged.window.from, from.toISOString());
  assert.equal(merged.window.to, later.toISOString());
});

test("failed uid retry bookkeeping: attempts accumulate, success clears", () => {
  const ledger = openLedger(from, to, "2026-08-04");
  markUidFailed(ledger, 55, "boom", "a@b.c", "x");
  markUidFailed(ledger, 55, "boom again", "a@b.c", "x");
  assert.equal(loadLedger("2026-08-04")?.uidsFailed[0].attempts, 2);

  markUidProcessed(ledger, 55);
  const done = loadLedger("2026-08-04");
  assert.deepEqual(done?.uidsFailed, []);
  assert.ok(done?.uidsProcessed.includes(55));
});

test("uidsKnownToLedgers unions processed and classified-out across days", () => {
  const a = openLedger(from, to, "2026-08-03");
  markUidProcessed(a, 1);
  closeLedger(a, "complete");
  const b = openLedger(from, to, "2026-08-04");
  markClassifiedOut(b, { uid: 2, from: "x@y.z", subject: "s" });

  const known = uidsKnownToLedgers();
  assert.ok(known.has(1) && known.has(2));
});

test("localDayStr formats local date", () => {
  assert.match(localDayStr(new Date("2026-08-04T12:00:00")), /^\d{4}-\d{2}-\d{2}$/);
});
