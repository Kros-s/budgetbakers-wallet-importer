import { test } from "node:test";
import assert from "node:assert/strict";

import { judge, parseLooseDate, findSiblingQuestion } from "../../webhook/pending-audit.js";
import type { SiblingCandidate } from "../../webhook/pending-audit.js";
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

const sibling = (over: Partial<SiblingCandidate> = {}): SiblingCandidate => ({
  shortId: 1, institution: "Banorte", amountCents: 5_875_301,
  movementDate: "04/Sep/2026", reference: null,
  createdAt: Date.parse("2026-09-05T02:00:00Z"), ...over,
});

test("one SPEI seen from both banks is a single question", () => {
  const incoming = sibling({ shortId: 2, institution: "MIFEL" });
  const found = findSiblingQuestion(incoming, [sibling({ shortId: 1 })]);
  assert.equal(found?.shortId, 1);
});

test("the same bank asking twice is two movements, not one", () => {
  // Two genuine charges of equal value at one institution is ordinary; merging
  // them would lose the second for good.
  const incoming = sibling({ shortId: 2 });
  assert.equal(findSiblingQuestion(incoming, [sibling({ shortId: 1 })]), null);
});

test("notifications too far apart are not the same movement", () => {
  const incoming = sibling({
    shortId: 2, institution: "MIFEL",
    createdAt: Date.parse("2026-09-09T02:00:00Z"),
  });
  assert.equal(findSiblingQuestion(incoming, [sibling({ shortId: 1 })]), null);
});

test("a round amount needs both emails to state the same date", () => {
  const base = { amountCents: 500_000, movementDate: null };
  // $5,000 moves between accounts constantly; without dates this is a guess.
  assert.equal(
    findSiblingQuestion(
      sibling({ ...base, shortId: 2, institution: "MIFEL" }),
      [sibling({ ...base, shortId: 1 })]
    ),
    null
  );
  // With both dates agreeing, it is the same movement.
  const dated = { amountCents: 500_000, movementDate: "03/Sep/2026" };
  assert.equal(
    findSiblingQuestion(
      sibling({ ...dated, shortId: 2, institution: "MIFEL" }),
      [sibling({ ...dated, shortId: 1 })]
    )?.shortId,
    1
  );
});

test("two possible siblings means the merge is itself a guess", () => {
  const incoming = sibling({ shortId: 3, institution: "MIFEL" });
  const found = findSiblingQuestion(incoming, [
    sibling({ shortId: 1, institution: "Banorte" }),
    sibling({ shortId: 2, institution: "Bancomer" }),
  ]);
  assert.equal(found, null);
});

test("the bank's own reference merges two notifications of one SPEI", () => {
  // Banorte sends an "Enviaste" and a "Recibiste" for a single transfer, both
  // from banorte.com — the different-institution rule would never merge them.
  // Real pair: $15,000 on 25-ago-2026, reference 260825, same second.
  const shared = {
    institution: "Banorte", amountCents: 1_500_000,
    movementDate: "25/Ago/2026 a las 14:47:01", reference: "260825",
  };
  const found = findSiblingQuestion(
    sibling({ ...shared, shortId: 27 }),
    [sibling({ ...shared, shortId: 26 })]
  );
  assert.equal(found?.shortId, 26);
});

test("two transfers on one day are not merged by a date-derived reference", () => {
  // Banorte builds the reference from the date, so 260825 is shared by every
  // transfer that day. The instant, printed to the second, separates them.
  const base = { institution: "Banorte", amountCents: 1_500_000, reference: "260825" };
  const found = findSiblingQuestion(
    sibling({ ...base, shortId: 27, movementDate: "25/Ago/2026 a las 19:03:44" }),
    [sibling({ ...base, shortId: 26, movementDate: "25/Ago/2026 a las 14:47:01" })]
  );
  assert.equal(found, null);
});

test("a shared reference on different amounts is not one operation", () => {
  const base = { institution: "Banorte", reference: "260825", movementDate: "25/Ago/2026 a las 14:47:01" };
  const found = findSiblingQuestion(
    sibling({ ...base, shortId: 27, amountCents: 2_615_100 }),
    [sibling({ ...base, shortId: 26, amountCents: 1_500_000 })]
  );
  assert.equal(found, null);
});
