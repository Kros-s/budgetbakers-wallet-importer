import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// The store resolves data/bot relative to cwd — isolate it in a scratch dir.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "clarif-test-"));
const originalCwd = process.cwd();
process.chdir(scratch);

const { storeClarification, takeClarification, peekLatestClarification } =
  await import("../../webhook/clarification-store.js");

const DAY = 24 * 60 * 60 * 1000;
const entry = (createdAt: number, subject = "s") => ({
  chatId: 1, emailFrom: "a@b.c", emailSubject: subject,
  emailText: "t", claudeQuestion: "q", createdAt,
});

beforeEach(() => {
  fs.rmSync(path.join(scratch, "data"), { recursive: true, force: true });
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("a two-week-old question survives a new one being stored", () => {
  // The 2026-08-19 regression: catching up on a backlog wiped every question
  // raised before the outage, which were exactly the ones awaiting an answer.
  storeClarification(1, entry(Date.now() - 14 * DAY, "vieja pero viva"));
  storeClarification(2, entry(Date.now(), "nueva"));
  assert.ok(takeClarification(1), "la de 14 días fue purgada");
  assert.ok(takeClarification(2));
});

test("only genuinely ancient entries are pruned", () => {
  storeClarification(1, entry(Date.now() - 100 * DAY, "antigua"));
  storeClarification(2, entry(Date.now(), "nueva"));
  assert.equal(takeClarification(1), null);
  assert.ok(takeClarification(2));
});

test("a non-numeric createdAt is never treated as expired", () => {
  const bad = { ...entry(0), createdAt: "2026-08-05" as unknown as number };
  storeClarification(1, bad);
  storeClarification(2, entry(Date.now()));
  assert.ok(takeClarification(1), "una fecha no numérica se purgó por accidente");
});

test("taking a clarification removes only that one", () => {
  storeClarification(10, entry(Date.now(), "a"));
  storeClarification(11, entry(Date.now(), "b"));
  assert.equal(takeClarification(10)?.emailSubject, "a");
  assert.equal(takeClarification(10), null);
  assert.equal(peekLatestClarification(1)?.entry.emailSubject, "b");
});

test("the store file is left as valid JSON, with no temp or lock residue", () => {
  storeClarification(1, entry(Date.now()));
  const dir = path.join(scratch, "data/bot");
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp") || f.endsWith(".lock"));
  assert.deepEqual(leftovers, []);
  JSON.parse(fs.readFileSync(path.join(dir, "pending-clarifications.json"), "utf8"));
});
