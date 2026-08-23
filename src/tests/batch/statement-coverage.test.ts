import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-test-"));
const originalCwd = process.cwd();
process.chdir(scratch);

const { formatCoverage, ledgerPath, ledgerSlug, loadLedger, monthCoverage } =
  await import("../../statements/ledgers.js");

const ACCOUNTS = ["Costco", "Meli", "MIFEL"];

function writeLedger(account: string, month: string, rows: unknown[] = []): void {
  const p = ledgerPath(account, month);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ account, month, rows, period: null, sourcePdf: "x.pdf", extractedAt: "" }));
}

beforeEach(() => fs.rmSync(path.join(scratch, "data"), { recursive: true, force: true }));
after(() => { process.chdir(originalCwd); fs.rmSync(scratch, { recursive: true, force: true }); });

test("an account name becomes a stable file slug, accents and all", () => {
  // Accents are stripped now. Keeping them meant one account had its PDF under
  // one spelling and its ledger under another, and made the filenames sensitive
  // to how macOS and Linux normalise Unicode differently.
  assert.equal(ledgerSlug("Platinum Credit Card"), "platinum-credit-card");
  assert.equal(ledgerSlug("Banorte débito"), "banorte-debito");
  assert.equal(ledgerSlug("Banorte débito"), ledgerSlug("Banorte debito"));
});

test("a month with nothing extracted is not complete", () => {
  // complete must not be vacuously true on an empty month, or the crossing
  // would run over no data at all and report a clean sweep.
  const c = monthCoverage("2026-07", ACCOUNTS);
  assert.equal(c.complete, false);
  assert.deepEqual(c.have, []);
  assert.deepEqual(c.missing, ACCOUNTS);
});

test("a partial month names exactly what is still owed", () => {
  writeLedger("Meli", "2026-07");
  const c = monthCoverage("2026-07", ACCOUNTS);
  assert.deepEqual(c.have, ["Meli"]);
  assert.deepEqual(c.missing, ["Costco", "MIFEL"]);
  assert.equal(c.complete, false);
  assert.match(formatCoverage(c), /1 de 3 para 2026-07/);
  assert.match(formatCoverage(c), /Costco, MIFEL/);
});

test("the month closes only when every account is in", () => {
  for (const a of ACCOUNTS) writeLedger(a, "2026-07");
  const c = monthCoverage("2026-07", ACCOUNTS);
  assert.equal(c.complete, true);
  assert.match(formatCoverage(c), /Los 3 estados de 2026-07 están completos/);
});

test("another month's extractions do not count toward this one", () => {
  for (const a of ACCOUNTS) writeLedger(a, "2026-06");
  assert.equal(monthCoverage("2026-07", ACCOUNTS).complete, false);
});

test("a long missing list says how many it did not name", () => {
  const many = Array.from({ length: 13 }, (_, i) => `Cuenta ${i}`);
  assert.match(formatCoverage(monthCoverage("2026-07", many)), /y 5 más/);
});

test("a stored extraction is read back", () => {
  writeLedger("Meli", "2026-07", [{ amount: "-10" }]);
  assert.equal(loadLedger("Meli", "2026-07")?.rows.length, 1);
  assert.equal(loadLedger("Costco", "2026-07"), null);
});
