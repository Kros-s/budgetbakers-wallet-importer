import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crossTransfers, formatCrossing, orphanTransferLegs, toLedgerRows,
} from "../../statements/crossing.js";
import type { CsvRow } from "../../csv.js";

const r = (date: string, amount: string, category = "Others", payee = ""): CsvRow =>
  ({ date: `${date} 12:00:00`, account: "x", amount, category, note: "", payee }) as CsvRow;

const rows = (account: string, ...cs: CsvRow[]) => toLedgerRows(account, cs);

test("the two legs of a card payment meet across two statements", () => {
  // The real case: Meli's July statement carries +$3,268.48 as a payment
  // received, and the paying account's statement carries the matching -$3,268.48.
  // Wallet's own pairing never sees it — it only matches within one CSV.
  const all = [
    ...rows("Meli", r("2026-07-01", "3268.48", "Transfer, withdraw")),
    ...rows("Bancomer", r("2026-07-01", "-3268.48", "Transfer, withdraw")),
  ];
  const out = crossTransfers(all);
  assert.equal(out.pairs.length, 1);
  assert.equal(out.pairs[0].out.account, "Bancomer");
  assert.equal(out.pairs[0].in.account, "Meli");
  assert.deepEqual(out.unpaired, []);
});

test("legs posted a few days apart still pair", () => {
  const all = [
    ...rows("Meli", r("2026-07-03", "3268.48")),
    ...rows("Bancomer", r("2026-07-01", "-3268.48")),
  ];
  const out = crossTransfers(all);
  assert.equal(out.pairs.length, 1);
  assert.equal(out.pairs[0].gapDays, 2);
});

test("beyond the window it stops being one movement", () => {
  const all = [
    ...rows("Meli", r("2026-07-20", "3268.48")),
    ...rows("Bancomer", r("2026-07-01", "-3268.48")),
  ];
  assert.equal(crossTransfers(all).pairs.length, 0);
});

test("two movements of equal size in the same account are never a transfer", () => {
  // A transfer has two accounts by definition; accepting one would merge two
  // unrelated movements that happen to be the same size.
  const all = rows("Bancomer", r("2026-07-01", "-500"), r("2026-07-01", "500"));
  assert.equal(crossTransfers(all).pairs.length, 0);
  assert.equal(crossTransfers(all).unpaired.length, 2);
});

test("each row is consumed once, so repeated amounts do not cross-match", () => {
  // Three $500 movements a month would otherwise produce six bogus pairs.
  const all = [
    ...rows("Bancomer", r("2026-07-01", "-500"), r("2026-07-02", "-500"), r("2026-07-03", "-500")),
    ...rows("Klar", r("2026-07-01", "500"), r("2026-07-02", "500"), r("2026-07-03", "500")),
  ];
  const out = crossTransfers(all);
  assert.equal(out.pairs.length, 3);
  assert.equal(out.unpaired.length, 0);
  // Closest in time wins, so the pairing is day-to-day and not scrambled.
  for (const p of out.pairs) assert.equal(p.gapDays, 0);
});

test("a leg whose counterpart never arrived is reported, not invented", () => {
  const all = rows("Meli", r("2026-07-01", "3268.48", "Transfer, withdraw"));
  const out = crossTransfers(all);
  assert.equal(out.pairs.length, 0);
  assert.equal(orphanTransferLegs(out).length, 1);
  assert.equal(orphanTransferLegs(out)[0].account, "Meli");
});

test("an ordinary purchase left over is not called an orphan transfer", () => {
  const out = crossTransfers(rows("Meli", r("2026-07-09", "-10", "Others")));
  assert.equal(out.unpaired.length, 1);
  assert.deepEqual(orphanTransferLegs(out), []);
});

test("unparseable rows are dropped rather than matched on NaN", () => {
  const bad = toLedgerRows("Meli", [r("2026-07-01", "n/a"), r("no es fecha", "-10")]);
  assert.deepEqual(bad, []);
});

test("the crossing reads as direction and amount", () => {
  const all = [
    ...rows("Meli", r("2026-07-01", "3268.48")),
    ...rows("Bancomer", r("2026-07-01", "-3268.48")),
  ];
  assert.match(formatCrossing(crossTransfers(all)), /2026-07-01 \$3268\.48\s+Bancomer → Meli/);
  assert.match(formatCrossing({ pairs: [], unpaired: [] }), /Sin traspasos pareados/);
});
