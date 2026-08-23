import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// INBOX_DIR resolves against cwd — isolate in a scratch dir, as registry does.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-test-"));
const originalCwd = process.cwd();
process.chdir(scratch);

const {
  DOWNLOADS_DIR, DOWNLOAD_RETENTION_DAYS, INBOX_DIR, STATEMENT_RETENTION_DAYS,
  pruneDownloads, pruneStatementInbox, retireStatement,
} = await import("../../statements/inbox.js");

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

test("a row that could not be written keeps the PDF too", () => {
  // A lone transfer leg — a card payment whose other side lives in another
  // account — is refused by design, and the PDF is what you come back to when
  // you pair it. retireStatement sees ambiguous + skipped as one count.
  const pdf = put("meli-2026-07.pdf");
  assert.equal(retireStatement(pdf, 1).removed, false);
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

function putDownload(name: string, ageDays: number): string {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const full = path.join(DOWNLOADS_DIR, name);
  fs.writeFileSync(full, "x");
  const when = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(full, when, when);
  return full;
}

test("a statement sent over Telegram is swept from the landing strip", () => {
  // These used to land in os.tmpdir() and stay there for good — a full month of
  // movements, in the clear, that no sweep could see.
  const old = putDownload("bot_123_9.pdf", DOWNLOAD_RETENTION_DAYS + 1);
  const fresh = putDownload("bot_123_10.pdf", 2);
  assert.deepEqual(pruneDownloads().deleted, ["bot_123_9.pdf"]);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});

test("the landing strip sweep leaves foreign files alone", () => {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const mine = path.join(DOWNLOADS_DIR, "notas-mias.pdf");
  fs.writeFileSync(mine, "x");
  const when = new Date(Date.now() - 400 * DAY);
  fs.utimesSync(mine, when, when);
  assert.deepEqual(pruneDownloads().deleted, []);
  assert.equal(fs.existsSync(mine), true);
});

test("downloads are swept sooner than the statement shelf", () => {
  // Nothing in downloads was deliberately kept; the inbox is a decision.
  assert.ok(DOWNLOAD_RETENTION_DAYS < STATEMENT_RETENTION_DAYS);
});

test("the arrivals record outlives the statements it describes", () => {
  // The whole point of the log is that it survives the retention sweep: the
  // PDF is disposable, the fact that it arrived is not.
  const pdf = put("viejo-2026-01.pdf", 200);
  fs.writeFileSync(path.join(INBOX_DIR, "arrivals.jsonl"), '{"filed":"viejo-2026-01.pdf"}\n');
  const log = path.join(INBOX_DIR, "arrivals.jsonl");
  const when = new Date(Date.now() - 200 * DAY);
  fs.utimesSync(log, when, when);
  pruneStatementInbox();
  assert.equal(fs.existsSync(pdf), false);
  assert.equal(fs.existsSync(log), true);
});
