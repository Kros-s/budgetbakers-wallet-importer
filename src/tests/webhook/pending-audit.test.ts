import { test } from "node:test";
import assert from "node:assert/strict";

import { judge, parseLooseDate } from "../../webhook/pending-audit.js";
import type { ExistingRecord } from "../../webhook/wallet-context.js";

const rec = (o: Partial<ExistingRecord> = {}): ExistingRecord => ({
  amountCents: 140_000, type: 1, transfer: false, accountName: "Mercado pago",
  payee: "Marlene", note: "", recordDate: "2026-08-06T12:09:00.000-06:00", ...o,
});

test("reads the date formats banks actually write", () => {
  assert.equal(parseLooseDate("17/Ago/2026 a las 14:19:17")?.getMonth(), 7);
  assert.equal(parseLooseDate("2026/07/23 07:18:21 PM")?.getDate(), 23);
  assert.equal(parseLooseDate("02/08/2026")?.getMonth(), 7);
  assert.equal(parseLooseDate(null), null);
  assert.equal(parseLooseDate("el mes pasado"), null);
});

test("same amount and same date is resolved", () => {
  const v = judge({ shortId: 21, amountCents: 140_000, movementDate: "06/08/2026", matches: [rec()] });
  assert.equal(v.resolved, true);
});

test("same amount on a distant date is not the same movement", () => {
  // Two $1,400 transfers months apart are two transfers.
  const v = judge({ shortId: 21, amountCents: 140_000, movementDate: "06/02/2026", matches: [rec()] });
  assert.equal(v.resolved, false);
  assert.match(v.reason, /otra fecha/);
});

test("no match at all is never resolved", () => {
  const v = judge({ shortId: 9, amountCents: 25_000, movementDate: "06/08/2026", matches: [] });
  assert.equal(v.resolved, false);
});

test("a round amount with several identical records is left to the user", () => {
  // $250.00 twice in a month is exactly the case where closing the wrong one
  // hides a real movement.
  const v = judge({
    shortId: 9, amountCents: 25_000, movementDate: null,
    matches: [rec({ amountCents: 25_000 }), rec({ amountCents: 25_000, recordDate: "2026-08-20T00:00:00.000Z" })],
  });
  assert.equal(v.resolved, false);
  assert.match(v.reason, /no puedo distinguirlos/);
});

test("a distinctive amount resolves even without a date", () => {
  const v = judge({ shortId: 28, amountCents: 2_585_673, movementDate: null, matches: [rec({ amountCents: 2_585_673 })] });
  assert.equal(v.resolved, true);
});
