import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// INBOX_DIR resolves against cwd — isolate in a scratch dir, as registry does.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-test-"));
const originalCwd = process.cwd();
process.chdir(scratch);

const { INBOX_DIR, STATEMENT_RETENTION_DAYS, pruneStatementInbox, retireStatement } =
  await import("../../statements/inbox.js");

const DAY = 24 * 60 * 60 * 1000;

function put(name: string, ageDays = 0): string {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const full = path.join(INBOX_DIR, name);
  fs.writeFileSync(full, "%PDF-1.4");
  const when = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(full, when, when);
  return full;
}

beforeEach(() => {
  fs.rmSync(path.join(scratch, "data"), { recursive: true, force: true });
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("a clean month retires its PDF", () => {
  const pdf = put("costco-2026-07.pdf");
  const out = retireStatement(pdf, 0);
  assert.equal(out.removed, true);
  assert.equal(fs.existsSync(pdf), false);
});

test("an ambiguous row keeps the PDF alive", () => {
  // markReceived() stamps the month as reconciled even with rows too uncertain
  // to write, and those rows are exactly what sends you back to the PDF.
  const pdf = put("costco-2026-07.pdf");
  const out = retireStatement(pdf, 3);
  assert.equal(out.removed, false);
  assert.match(out.reason, /3 ambiguo/);
  assert.equal(fs.existsSync(pdf), true);
});

test("a PDF outside the inbox is never deleted", () => {
  // The user may reconcile a file straight out of their Downloads folder.
  const outside = path.join(scratch, "mi-estado.pdf");
  fs.writeFileSync(outside, "%PDF-1.4");
  const out = retireStatement(outside, 0);
  assert.equal(out.removed, false);
  assert.match(out.reason, /no se toca/);
  assert.equal(fs.existsSync(outside), true);
});

test("the age floor sweeps a statement that never reconciled", () => {
  const old = put("abandonado-2026-01.pdf", STATEMENT_RETENTION_DAYS + 1);
  const fresh = put("reciente-2026-07.pdf", 3);
  const res = pruneStatementInbox();
  assert.deepEqual(res.deleted, ["abandonado-2026-01.pdf"]);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});

test("a statement inside the window survives the sweep", () => {
  put("julio.pdf", STATEMENT_RETENTION_DAYS - 1);
  assert.deepEqual(pruneStatementInbox().deleted, []);
});

test("the sweep ignores anything that is not a PDF", () => {
  // The per-bank profiles and the normalized ledgers live nearby; the floor is
  // for statements only.
  put("viejo.pdf", 100);
  fs.writeFileSync(path.join(INBOX_DIR, "notas.md"), "x");
  const notes = path.join(INBOX_DIR, "notas.md");
  const when = new Date(Date.now() - 100 * DAY);
  fs.utimesSync(notes, when, when);
  assert.deepEqual(pruneStatementInbox().deleted, ["viejo.pdf"]);
  assert.equal(fs.existsSync(notes), true);
});

test("a missing inbox is not an error", () => {
  assert.deepEqual(pruneStatementInbox(), { deleted: [], kept: 0 });
});
