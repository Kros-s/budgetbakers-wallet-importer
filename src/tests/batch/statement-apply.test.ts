import { test } from "node:test";
import assert from "node:assert/strict";
import { countBy, formatPlan, planMonth, writableRows } from "../../statements/apply.js";
import { toWalletRows } from "../../statements/crossing.js";
import type { CsvRow } from "../../csv.js";

const r = (over: Partial<CsvRow> = {}): CsvRow => ({
  date: "2026-07-09 12:00:00", account: "x", amount: "-50.00",
  category: "Others", note: "", payee: "", ...over,
});

const wallet = (recs: { account: string; cents: number; date: string }[]) =>
  toWalletRows(
    recs.map((x, i) => ({
      accountId: `a${i}`, amount: Math.abs(x.cents), type: x.cents < 0 ? 1 : 0,
      recordDate: `${x.date}T12:00:00.000Z`,
    })) as never[],
    Object.fromEntries(recs.map((x, i) => [`a${i}`, x.account]))
  );

test("a purchase nobody else knows about is simply written", () => {
  const plan = planMonth("2026-07", [{ account: "Costco", rows: [r({ amount: "-540.00" })] }], []);
  assert.deepEqual(countBy(plan), { recorded: 0, write: 1, pair: 0, complete: 0, hold: 0 });
});

test("a movement already in Wallet is never written again", () => {
  const plan = planMonth(
    "2026-07",
    [{ account: "Costco", rows: [r({ amount: "-540.00" })] }],
    wallet([{ account: "Costco", cents: -54000, date: "2026-07-09" }])
  );
  assert.equal(countBy(plan).recorded, 1);
  assert.deepEqual(writableRows(plan), []);
});

test("the posting lag does not make an existing movement look missing", () => {
  // A purchase recorded from its alert carries the operation date while the
  // statement publishes the posting date — measured up to five days apart.
  const plan = planMonth(
    "2026-07",
    [{ account: "Costco", rows: [r({ amount: "-540.00", date: "2026-07-14 12:00:00" })] }],
    wallet([{ account: "Costco", cents: -54000, date: "2026-07-09" }])
  );
  assert.equal(countBy(plan).recorded, 1);
});

test("the two legs of a transfer meet across two statements and are written as a pair", () => {
  // The whole reason a month is the unit: deciding one statement at a time
  // cannot see the other half, so it writes half a movement and writes it again
  // when the counterpart arrives.
  const plan = planMonth("2026-07", [
    { account: "Meli", rows: [r({ amount: "3268.48", category: "Transfer, withdraw", date: "2026-07-01 12:00:00" })] },
    { account: "Bancomer", rows: [r({ amount: "-3268.48", category: "Transfer, withdraw", date: "2026-07-01 12:00:00" })] },
  ], []);
  assert.equal(countBy(plan).pair, 2);
  assert.equal(countBy(plan).hold, 0);
  const meli = plan.planned.find((p) => p.account === "Meli");
  assert.equal(meli?.withAccount, "Bancomer");
});

test("a transfer whose counterpart is already booked completes it instead of waiting", () => {
  const plan = planMonth(
    "2026-07",
    [{ account: "Klar", rows: [r({ amount: "210000.00", category: "Financial investments", date: "2026-07-31 12:00:00" })] }],
    wallet([{ account: "Banorte débito", cents: -21000000, date: "2026-07-31" }])
  );
  const [p] = plan.planned;
  assert.equal(p.disposition, "complete");
  assert.equal(p.withAccount, "Banorte débito");
});

test("a transfer leg with no counterpart anywhere waits", () => {
  // Klar's real July: +$210,000 whose other half is in Banorte débito's July
  // statement, which has not arrived. Writing it alone books a quarter of a
  // million as standalone income.
  const plan = planMonth("2026-07", [
    { account: "Meli", rows: [r({ amount: "3268.48", category: "Transfer, withdraw" })] },
  ], []);
  assert.equal(countBy(plan).hold, 1);
  assert.deepEqual(writableRows(plan), []);
});

test("a purchase is not held merely for lacking a counterpart", () => {
  // Only a transfer waits. Holding every unmatched row would stall the month.
  const plan = planMonth("2026-07", [
    { account: "Costco", rows: [r({ amount: "-50.00", category: "Groceries" })] },
  ], []);
  assert.equal(countBy(plan).write, 1);
  assert.equal(countBy(plan).hold, 0);
});

test("later instalments never reach a decision at all", () => {
  const plan = planMonth("2026-07", [
    { account: "Costco", rows: [r({ amount: "-5480.00", meses: "4/6" }), r({ amount: "-50.00" })] },
  ], []);
  assert.equal(plan.ignored.length, 1);
  assert.equal(countBy(plan).write, 1);
});

test("a first instalment is matched against Wallet at the price it will be written", () => {
  // It is diffed at the instalment amount but written at the full purchase
  // price, so matching on the instalment finds nothing and books a second copy
  // of a purchase Wallet already holds.
  const plan = planMonth(
    "2026-07",
    [{ account: "Costco", rows: [r({ amount: "-5480.00", meses: "1/6", montooriginal: "32,880.00" })] }],
    wallet([{ account: "Costco", cents: -3288000, date: "2026-07-09" }])
  );
  assert.equal(countBy(plan).recorded, 1, "se reconoce la compra completa ya registrada");
  assert.deepEqual(writableRows(plan), []);
});

test("an unreadable row is held, not guessed at", () => {
  const plan = planMonth("2026-07", [{ account: "Costco", rows: [r({ amount: "no-es-monto" })] }], []);
  assert.equal(countBy(plan).hold, 1);
});

test("the summary names what waits and does not hide a long tail", () => {
  const many = Array.from({ length: 14 }, (_, i) =>
    r({ amount: "100.00", category: "Transfer, withdraw", date: `2026-07-${String(i + 1).padStart(2, "0")} 12:00:00` }));
  const out = formatPlan(planMonth("2026-07", [{ account: "Meli", rows: many }], []));
  assert.match(out, /⏸️ en espera: 14/);
  assert.match(out, /…y 4 más/);
});

test("a timezone offset does not turn five days into five days and six hours", () => {
  // The statement row's date has no timezone and parses as local; a Wallet
  // record carries an offset. Measured in milliseconds a five-day gap came out
  // larger than five days and fell outside the slack. Banks post by day.
  const plan = planMonth(
    "2026-07",
    [{ account: "Costco", rows: [r({ amount: "-540.00", date: "2026-07-14 23:59:00" })] }],
    wallet([{ account: "Costco", cents: -54000, date: "2026-07-09" }])
  );
  assert.equal(countBy(plan).recorded, 1);
});

test("six days apart is still too far", () => {
  const plan = planMonth(
    "2026-07",
    [{ account: "Costco", rows: [r({ amount: "-540.00", date: "2026-07-15 12:00:00" })] }],
    wallet([{ account: "Costco", cents: -54000, date: "2026-07-09" }])
  );
  assert.equal(countBy(plan).write, 1);
});

test("money arriving with no known origin waits while the month is incomplete", () => {
  // Klar's real July: +$210,000 as "Financial investments", no counterpart yet
  // because its other half is in a statement that has not arrived. Written as
  // standalone income it models a quarter of a million as if it appeared.
  const rows = [r({ amount: "210000.00", category: "Financial investments", date: "2026-07-31 12:00:00" })];
  const partial = planMonth("2026-07", [{ account: "Klar", rows }], []);
  assert.equal(countBy(partial).hold, 1);

  // With every statement in, there is nothing left to wait for.
  const whole = planMonth("2026-07", [{ account: "Klar", rows }], [], { coverageComplete: true });
  assert.equal(countBy(whole).write, 1);
});

test("interest is external income and is written even on a partial month", () => {
  // MIFEL pays interest daily; holding it until all fourteen statements arrive
  // would stall the one thing that never needs a counterpart.
  const plan = planMonth("2026-07", [
    { account: "MIFEL", rows: [r({ amount: "72.27", category: "Interests, dividends" })] },
  ], []);
  assert.equal(countBy(plan).write, 1);
});

test("an expense never waits on the month being complete", () => {
  const plan = planMonth("2026-07", [
    { account: "Costco", rows: [r({ amount: "-540.00", category: "Groceries" })] },
  ], []);
  assert.equal(countBy(plan).write, 1);
});
