// trackTransaction/findDuplicate/hasEntriesToday resolve data/bot/daily-tracker-*.json
// from process.cwd() at import time (and at call time for storePath), so we
// chdir into a scratch directory before the first import — same pattern as
// bot/session.test.ts and webhook/learned-rules.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const scratchDir = mkdtempSync(join(tmpdir(), "daily-tracker-test-"));
const originalCwd = process.cwd();
process.chdir(scratchDir);

const tracker = await import(`../../webhook/daily-tracker.js?t=${Date.now()}`);

function dayStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// This test must run before any other findDuplicate call in this file: the
// past-days lookup is cached for the current day on first use, so the
// yesterday file has to exist on disk before that cache gets built.
test("findDuplicate finds a match written yesterday, read from disk", () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yDay = dayStr(yesterday);
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  mkdirSync(join(scratchDir, "data/bot"), { recursive: true });
  writeFileSync(
    join(scratchDir, "data/bot", `daily-tracker-${yDay}.json`),
    JSON.stringify({
      day: yDay,
      entries: [
        {
          ts: oneHourAgo,
          account: "Bancomer",
          accountId: "-Account_yesterday",
          amount: -300,
          category: "Groceries",
          payee: "Costco",
          status: "written",
        },
      ],
    })
  );

  const dup = tracker.findDuplicate("-Account_yesterday", -300, "Costco");
  assert.ok(dup);
  assert.equal(dup.accountId, "-Account_yesterday");
});

test("findDuplicate detects a match within the window with the same payee", () => {
  tracker.trackTransaction({
    ts: new Date().toISOString(),
    account: "Bancomer",
    accountId: "-Account_abc",
    amount: -900,
    category: "Groceries",
    payee: "Costco",
    status: "written",
  });

  const dup = tracker.findDuplicate("-Account_abc", -900, "Costco");
  assert.ok(dup);
  assert.equal(dup.payee, "Costco");
});

test("findDuplicate returns null when both payees are non-empty and differ", () => {
  tracker.trackTransaction({
    ts: new Date().toISOString(),
    account: "Bancomer",
    accountId: "-Account_def",
    amount: -900,
    category: "Groceries",
    payee: "Costco",
    status: "written",
  });

  // Same account + amount, but a genuinely different second charge same day.
  const dup = tracker.findDuplicate("-Account_def", -900, "Walmart");
  assert.equal(dup, null);
});

test("findDuplicate returns null outside the time window", () => {
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  tracker.trackTransaction({
    ts: fourHoursAgo,
    account: "Bancomer",
    accountId: "-Account_ghi",
    amount: -500,
    category: "Groceries",
    payee: "Costco",
    status: "written",
  });

  const dup = tracker.findDuplicate("-Account_ghi", -500, "Costco");
  assert.equal(dup, null);
});

test("findDuplicate matches on account+amount+window when one payee is empty", () => {
  tracker.trackTransaction({
    ts: new Date().toISOString(),
    account: "Bancomer",
    accountId: "-Account_jkl",
    amount: -250,
    category: "Groceries",
    payee: "",
    status: "written",
  });

  const dup = tracker.findDuplicate("-Account_jkl", -250, "Costco");
  assert.ok(dup);
});

test("hasEntriesToday is true once a transaction has been tracked today", () => {
  assert.equal(tracker.hasEntriesToday(), true);
});

test("hasEntriesToday is false with no entries tracked", async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "daily-tracker-empty-"));
  process.chdir(emptyDir);
  try {
    const freshTracker = await import(`../../webhook/daily-tracker.js?t=${Date.now()}-empty`);
    assert.equal(freshTracker.hasEntriesToday(), false);
  } finally {
    process.chdir(scratchDir);
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test.after(() => {
  process.chdir(originalCwd);
  rmSync(scratchDir, { recursive: true, force: true });
});
