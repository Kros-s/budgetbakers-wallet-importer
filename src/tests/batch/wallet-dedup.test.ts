import { test } from "node:test";
import assert from "node:assert/strict";

import { matchesExisting } from "../../batch/wallet-dedup.js";

const existing = {
  accountId: "-Account_aaa",
  amount: 12100, // 121.00 in minor units
  type: 1 as const,
  recordDate: "2026-07-23T16:25:35.000+00:00",
  payee: "Chedraui",
};

const base = {
  accountId: "-Account_aaa",
  amount: 12100,
  type: 1 as const,
  recordDate: "2026-07-23T18:00:00.000Z",
  payee: "Chedraui",
};

test("same account+amount+type within 48h and same payee is a duplicate", () => {
  assert.equal(matchesExisting(existing, base), true);
});

test("different account is not a duplicate", () => {
  assert.equal(matchesExisting(existing, { ...base, accountId: "-Account_bbb" }), false);
});

test("different amount is not a duplicate", () => {
  assert.equal(matchesExisting(existing, { ...base, amount: 12101 }), false);
});

test("income vs expense of same amount is not a duplicate", () => {
  assert.equal(matchesExisting(existing, { ...base, type: 0 as const }), false);
});

test("outside the 48h slack is not a duplicate", () => {
  assert.equal(matchesExisting(existing, { ...base, recordDate: "2026-07-26T16:26:00.000Z" }), false);
});

test("mismatched non-empty payees are not duplicates; empty payee still matches", () => {
  assert.equal(matchesExisting(existing, { ...base, payee: "Soriana" }), false);
  assert.equal(matchesExisting(existing, { ...base, payee: undefined }), true);
});

test("payee comparison is case/whitespace-insensitive", () => {
  assert.equal(matchesExisting(existing, { ...base, payee: "  CHEDRAUI " }), true);
});
