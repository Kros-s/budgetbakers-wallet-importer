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
