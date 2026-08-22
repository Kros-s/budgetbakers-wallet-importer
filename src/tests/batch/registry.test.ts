import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// registry resolves data/statements relative to cwd — isolate in a scratch dir.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "registry-test-"));
const originalCwd = process.cwd();
process.chdir(scratch);

const { loadRegistry, saveRegistry, markReceived, missingStatements } =
  await import("../../statements/registry.js");

beforeEach(() => {
  fs.rmSync(path.join(scratch, "data"), { recursive: true, force: true });
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("nothing is chased before the cut plus its grace", () => {
  saveRegistry({ Costco: { cutDay: 10, source: "manual", lastReceived: "2026-05", startMonth: "2026-06" } });

  // Aug 12: the 10th + 5 days has not passed, so July is not due yet.
  assert.deepEqual(missingStatements(new Date("2026-08-12T12:00:00")).map((m) => m.month), ["2026-06"]);

  // Aug 16: past 10+5, so July joins it.
  assert.deepEqual(missingStatements(new Date("2026-08-16T12:00:00")).map((m) => m.month), ["2026-06", "2026-07"]);
});

test("every missing month is reported, not only the most recent", () => {
  // Three months behind used to produce one nag, and the older two were never
  // mentioned again — the reconciliation quietly narrowed to the newest.
  saveRegistry({ Costco: { cutDay: 10, source: "manual", lastReceived: "2026-04" } });
  const months = missingStatements(new Date("2026-08-16T12:00:00")).map((m) => m.month);
  assert.deepEqual(months, ["2026-05", "2026-06", "2026-07"]);
});

test("an account never reconciled is chased from its startMonth", () => {
  saveRegistry({ Costco: { cutDay: 10, source: "manual", lastReceived: null, startMonth: "2026-07" } });
  assert.deepEqual(missingStatements(new Date("2026-08-16T12:00:00")).map((m) => m.month), ["2026-07"]);
});

test("without a startMonth the lookback is capped, not unbounded", () => {
  saveRegistry({ Costco: { cutDay: 10, source: "manual", lastReceived: null } });
  const months = missingStatements(new Date("2026-08-16T12:00:00")).map((m) => m.month);
  assert.equal(months.length, 6, "debería mirar 6 meses hacia atrás, no desde el principio de los tiempos");
  assert.equal(months[months.length - 1], "2026-07");
});

test("the status view pairs each account with what it owes", async () => {
  const { statementStatus } = await import("../../statements/registry.js");
  saveRegistry({
    Costco: { cutDay: 10, source: "manual", lastReceived: "2026-06" },
    "Open bank": { cutDay: 1, source: "email", lastReceived: "2026-07" },
  });
  const status = statementStatus(new Date("2026-08-16T12:00:00"));
  const costco = status.find((s) => s.account === "Costco");
  assert.ok(costco);
  assert.deepEqual(costco.missing, ["2026-07"]);
  const open = status.find((s) => s.account === "Open bank");
  assert.ok(open);
  assert.deepEqual(open.missing, []);
});

test("received statement stops the nag; older months don't regress it", () => {
  saveRegistry({ Costco: { cutDay: 10, source: "manual", lastReceived: null } });
  markReceived("Costco", "2026-07");
  assert.deepEqual(missingStatements(new Date("2026-08-16T12:00:00")), []);
  assert.equal(loadRegistry().Costco.lastReceived, "2026-07");

  markReceived("Costco", "2026-05"); // late arrival of an old one
  assert.equal(loadRegistry().Costco.lastReceived, "2026-07");
});

test("unknown account in markReceived is a no-op", () => {
  saveRegistry({ Costco: { cutDay: 10, source: "manual", lastReceived: null } });
  markReceived("Nu crédito", "2026-07");
  assert.equal(loadRegistry().Costco.lastReceived, null);
});
