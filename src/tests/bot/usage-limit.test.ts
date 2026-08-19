import { test } from "node:test";
import assert from "node:assert/strict";

import { isUsageLimitText, UsageLimitError } from "../../bot/claude-runner.js";

test("recognises the ways the CLI reports an exhausted budget", () => {
  for (const text of [
    "Claude usage limit reached. Your limit will reset at 3pm.",
    "Error: rate limit exceeded",
    "429 Too Many Requests",
    "You have exceeded your quota for this month",
    "Insufficient credit balance",
    "Upgrade to increase your limit",
  ]) {
    assert.equal(isUsageLimitText(text), true, `no detectó: ${text}`);
  }
});

test("does not mistake an ordinary per-email failure for a usage limit", () => {
  for (const text of [
    "claude exited with code 1. Stderr tail:\nCould not parse the email body",
    "timeout after 90000ms",
    "ENOTFOUND api.anthropic.com",
    "",
  ]) {
    assert.equal(isUsageLimitText(text), false, `falso positivo: ${text}`);
  }
  assert.equal(isUsageLimitText(null), false);
  assert.equal(isUsageLimitText(undefined), false);
});

test("UsageLimitError is distinguishable from a plain Error", () => {
  const err = new UsageLimitError("limit");
  assert.ok(err instanceof UsageLimitError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, "UsageLimitError");
  assert.equal(new Error("limit") instanceof UsageLimitError, false);
});

test("recognises a resume pointing at a conversation the CLI does not have", async () => {
  const { isStaleSessionText, StaleSessionError } = await import("../../bot/claude-runner.js");
  // The exact stderr seen after the 2026-08-19 host migration.
  assert.equal(
    isStaleSessionText("No conversation found with session ID: f3144c17-0c22-4a5e-a579-bd86129fb6c4"),
    true
  );
  assert.equal(isStaleSessionText("Session abc not found"), true);
  // Must not swallow the unrelated failures.
  assert.equal(isStaleSessionText("Claude usage limit reached"), false);
  assert.equal(isStaleSessionText("timeout after 90000ms"), false);
  assert.equal(isStaleSessionText(null), false);
  const err = new StaleSessionError("x");
  assert.ok(err instanceof StaleSessionError);
  assert.equal(new Error("x") instanceof StaleSessionError, false);
});
