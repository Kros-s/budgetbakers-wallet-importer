import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alreadyInWallet, crossTransfers, deferNearBoundary, formatCrossing, orphanTransferLegs,
  toLedgerRows, toWalletRows,
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
  assert.deepEqual(out.possible, []);
});

test("legs posted a few days apart still pair", () => {
  const all = [
    ...rows("Meli", r("2026-07-03", "3268.48", "Transfer, withdraw")),
    ...rows("Bancomer", r("2026-07-01", "-3268.48", "Transfer, withdraw")),
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
  assert.equal(crossTransfers(all).possible.length, 0);
  assert.equal(crossTransfers(all).unpaired.length, 2);
});

test("an amount coincidence is reported apart from a real transfer", () => {
  // A $50 purchase in one account and unrelated $50 income in another, days
  // apart, is a coincidence. Calling it a transfer merges two unrelated
  // movements; hiding it loses a possible match. So it goes in its own bucket.
  const coincidence = [
    ...rows("Costco", r("2026-07-01", "-50", "Others")),
    ...rows("Klar", r("2026-07-02", "50", "Others")),
  ];
  const out = crossTransfers(coincidence);
  assert.equal(out.pairs.length, 0);
  assert.equal(out.possible.length, 1);

  const real = [
    ...rows("Costco", r("2026-07-01", "-50", "Transfer, withdraw")),
    ...rows("Klar", r("2026-07-02", "50", "Others")),
  ];
  assert.equal(crossTransfers(real).pairs.length, 1);
  assert.equal(crossTransfers(real).possible.length, 0);
});

test("a statement row pairs against what Wallet already holds", () => {
  // The point of feeding Wallet into the crossing: a payment already recorded
  // must read as "already there", not as a movement to add.
  const wallet = toWalletRows(
    [{ accountId: "acc-bancomer", amount: 326848, type: 0, recordDate: "2026-07-01T12:00:00.000Z", transfer: true } as never],
    { "acc-bancomer": "Bancomer" }
  );
  const all = [...rows("Meli", r("2026-07-01", "3268.48", "Transfer, withdraw")), ...wallet];
  const out = crossTransfers(all);
  assert.equal(out.pairs.length, 1);
  const already = alreadyInWallet(out);
  assert.equal(already.length, 1, "la pareja cruza estado con Wallet");
  assert.equal(out.unpaired.length, 0);
});

test("a leftover Wallet row is not called an orphan statement leg", () => {
  const wallet = toWalletRows(
    [{ accountId: "a", amount: 5000, type: 0, recordDate: "2026-07-01T12:00:00.000Z", transfer: true } as never],
    { a: "Bancomer" }
  );
  assert.deepEqual(orphanTransferLegs(crossTransfers(wallet)), []);
});

test("each row is consumed once, so repeated amounts do not cross-match", () => {
  // Three $500 movements a month would otherwise produce six bogus pairs.
  const T = "Transfer, withdraw";
  const all = [
    ...rows("Bancomer", r("2026-07-01", "-500", T), r("2026-07-02", "-500", T), r("2026-07-03", "-500", T)),
    ...rows("Klar", r("2026-07-01", "500", T), r("2026-07-02", "500", T), r("2026-07-03", "500", T)),
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
  assert.match(formatCrossing(crossTransfers(all).possible), /2026-07-01 \$3268\.48\s+Bancomer → Meli/);
  assert.match(formatCrossing([]), /Sin traspasos pareados/);
});

test("a coincidence does not consume the row it guessed at", () => {
  // The real case: two Meli charges matched Costco rows of equal size by
  // accident. Letting that consume them would drop two genuine movements from
  // whatever decides what to write, with nothing to notice.
  const all = [
    ...rows("Meli", r("2026-07-09", "-10", "Others")),
    ...rows("Costco", r("2026-07-09", "10", "Others")),
  ];
  const out = crossTransfers(all);
  assert.equal(out.possible.length, 1);
  assert.equal(out.unpaired.length, 2, "ambas siguen pendientes de decisión");
});

test("a real transfer does consume both its legs", () => {
  const all = [
    ...rows("Meli", r("2026-07-01", "3268.48", "Transfer, withdraw")),
    ...rows("Bancomer", r("2026-07-01", "-3268.48", "Transfer, withdraw")),
  ];
  assert.deepEqual(crossTransfers(all).unpaired, []);
});

test("a leg posted late still meets its counterpart via the operation date", () => {
  // Banorte Crédito prints "Fecha de la operación" beside "Fecha de cargo".
  // A payment operated on the 30th and posted on the 2nd sits in the next
  // month's statement; without the operation date the two legs look like two
  // different movements, and each gets written.
  const late: CsvRow = { ...r("2026-08-02", "3268.48", "Transfer, withdraw"), opdate: "2026-07-30" };
  const all = [
    ...toLedgerRows("Meli", [late]),
    ...rows("Bancomer", r("2026-07-30", "-3268.48", "Transfer, withdraw")),
  ];
  const out = crossTransfers(all);
  assert.equal(out.pairs.length, 1, "parean por la fecha de operación");
  assert.equal(out.pairs[0].gapDays, 0);
});

test("without the operation date the same pair falls outside the window", () => {
  const all = [
    ...rows("Meli", r("2026-08-06", "3268.48", "Transfer, withdraw")),
    ...rows("Bancomer", r("2026-07-30", "-3268.48", "Transfer, withdraw")),
  ];
  assert.equal(crossTransfers(all).pairs.length, 0);
});

test("rows at the edge of the month are held back, those inside are not", () => {
  // 92% of Banamex movements post on a day other than the one they happened,
  // up to five later. A movement at the end of the month lands on the next
  // statement, whose account may not be extracted yet — deciding on it before
  // every account is in is how it gets written from both sides.
  const period = { from: "2026-07-01", to: "2026-07-31" };
  const all = [
    ...rows("Costco", r("2026-07-30", "-100"), r("2026-07-15", "-200"), r("2026-07-03", "-300")),
  ];
  const { deferred, inside } = deferNearBoundary(all, period);
  assert.deepEqual(deferred.map((d) => d.date), ["2026-07-30", "2026-07-03"]);
  assert.deepEqual(inside.map((d) => d.date), ["2026-07-15"]);
});

test("a row is held if EITHER of its dates sits at the edge", () => {
  // Operated on the 30th, posted on the 4th: safe by one date, at the edge by
  // the other. The edge wins.
  const late: CsvRow = { ...r("2026-08-04", "-100", "Others"), opdate: "2026-07-30" };
  const { deferred } = deferNearBoundary(toLedgerRows("Costco", [late]), { from: "2026-07-01", to: "2026-07-31" });
  assert.equal(deferred.length, 1);
});
