import test from "node:test";
import assert from "node:assert/strict";

import { isAlreadyHandled, assertReplaySafe } from "../../cli/window-scope.js";

const base = {
  processed: new Set<number>([10]),
  ledgerKnown: new Set<number>([11]),
  failedRetryable: new Map<number, number>(),
  replay: false,
};

test("a uid in the processed store or in a ledger is skipped", () => {
  assert.equal(isAlreadyHandled(10, base), true);
  assert.equal(isAlreadyHandled(11, base), true);
  assert.equal(isAlreadyHandled(12, base), false);
});

test("a retryable failure is processed again even though it is known", () => {
  const opts = { ...base, failedRetryable: new Map([[10, 2]]) };
  assert.equal(isAlreadyHandled(10, opts), false);
});

test("replay ignores the processed store, which is the whole point of it", () => {
  // Without this there is no way to ask whether the Codex fallback missed
  // anything between 07-oct and 11-oct: --force only revives failures.
  assert.equal(isAlreadyHandled(10, { ...base, replay: true }), false);
  assert.equal(isAlreadyHandled(11, { ...base, replay: true }), false);
});

test("replay is refused outside a dry run, before any email is fetched", () => {
  assert.throws(() => assertReplaySafe({ replay: true, dryRun: false }), /solo se permite con --dry-run/);
  assertReplaySafe({ replay: true, dryRun: true });
  assertReplaySafe({ replay: false, dryRun: false });
});
