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

test("statement overdue after cutDay + grace, silent before", () => {
  saveRegistry({ Costco: { cutDay: 10, source: "manual", lastReceived: null } });

  // Aug 12: cut was the 10th, grace 5 days → not due yet
  assert.deepEqual(missingStatements(new Date("2026-08-12T12:00:00")), []);

  // Aug 16: past 10+5 → July statement is missing
  const missing = missingStatements(new Date("2026-08-16T12:00:00"));
  assert.equal(missing.length, 1);
  assert.equal(missing[0].account, "Costco");
  assert.equal(missing[0].month, "2026-07");
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
