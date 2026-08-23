import { test } from "node:test";
import assert from "node:assert/strict";
import { countBy, formatPlan, planMonth, writableRows } from "../../statements/apply.js";
import { toWalletRows } from "../../statements/crossing.js";
import { MONTH_SPEC, monthsInSpec } from "../../statements/month-runner.js";
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

test("one Wallet record cannot settle two identical statement rows", () => {
  // Two $10 charges days apart against a single recorded $10: without consuming
  // the match, both reported "already in Wallet" and the second real movement
  // vanished from the plan.
  const plan = planMonth(
    "2026-07",
    [{ account: "Meli", rows: [
      r({ amount: "-10.00", date: "2026-07-09 12:00:00" }),
      r({ amount: "-10.00", date: "2026-07-11 12:00:00" }),
    ] }],
    wallet([{ account: "Meli", cents: -1000, date: "2026-07-09" }])
  );
  assert.equal(countBy(plan).recorded, 1);
  assert.equal(countBy(plan).write, 1);
});

// ── A month's plan and an arrival from your own account ───────────────────

test("planMonth holds an arrival from your own account even with the month complete", () => {
  // `isUnexplainedInflow` releases an inflow once every statement is in.
  // Completing the coverage does nothing for this one: DolarApp's other leg is
  // in dollars, and no equal-amount rule will ever reach it. Released, it is
  // $163,202.91 of income the user never earned.
  const arq = {
    date: "2026-07-01 12:00:00", account: "Bancomer", amount: "163202.91",
    category: "Others", note: "", payee: "PIER 5, S.A de C.V.",
    desc: "SPEI RECIBIDOARCUS FI 6286879Sent from ARQ 00706180105819089043 PIER 5, S.A de C.V.",
  };
  const plan = planMonth("2026-07", [{ account: "Bancomer", rows: [arq] }], [], { coverageComplete: true });
  assert.equal(plan.planned.length, 1);
  assert.equal(plan.planned[0].disposition, "hold");
  assert.equal(plan.planned[0].reason, "contraparte es tu cuenta DolarApp");
});

test("planMonth still writes genuine income once the month is complete", () => {
  const client = {
    date: "2026-07-16 12:00:00", account: "Bancomer", amount: "10000.00",
    category: "Others", note: "", payee: "Hosting - Banamex",
    desc: "SPEI RECIBIDOBANAMEX 0160726Hosting Referencia 0178549454 002",
  };
  const plan = planMonth("2026-07", [{ account: "Bancomer", rows: [client] }], [], { coverageComplete: true });
  assert.equal(plan.planned[0].disposition, "write");
});

test("a paired leg is restated to the transfer category so the write can link it", () => {
  // The crossing decides two rows are one movement; convertRows links them only
  // if BOTH carry the transfer category. Bancomer's arrival from DolarApp was
  // extracted as "Wage, invoices": paired here, written as income there.
  const out = {
    date: "2026-07-01 12:00:00", account: "DolarApp", amount: "-9300.00",
    category: "Transfer, withdraw", note: "", payee: "Marco Mayen", mxn: "-163202.91",
  };
  const into = {
    date: "2026-07-01 12:00:00", account: "Bancomer", amount: "163202.91",
    category: "Wage, invoices", note: "", payee: "PIER 5, S.A de C.V.",
  };
  const plan = planMonth("2026-07", [
    { account: "DolarApp", rows: [out] },
    { account: "Bancomer", rows: [into] },
  ], [], { coverageComplete: true });
  const paired = plan.planned.filter((p) => p.disposition === "pair");
  assert.equal(paired.length, 2);
  for (const p of paired) assert.equal(p.row.category, "Transfer, withdraw");
});

// ── A range of months ─────────────────────────────────────────────────────

test("a month spec names one month or a run of them", () => {
  assert.deepEqual(monthsInSpec("2026-07"), ["2026-07"]);
  assert.deepEqual(monthsInSpec("2026-06..2026-07"), ["2026-06", "2026-07"]);
  assert.deepEqual(monthsInSpec("2026-11..2027-01"), ["2026-11", "2026-12", "2027-01"]);
  // A backwards range is empty rather than infinite.
  assert.deepEqual(monthsInSpec("2026-07..2026-06"), []);
  // And a typo cannot walk a decade of ledgers.
  assert.equal(monthsInSpec("2020-01..2030-12").length, 24);
});

test("the spec accepts a month or a range and refuses anything else", () => {
  for (const good of ["2026-07", "2026-01", "2026-06..2026-07"]) {
    assert.equal(MONTH_SPEC.test(good), true, good);
  }
  for (const bad of ["2026-13", "2026-7", "julio", "2026-06..", "2026-06..2026-13", ""]) {
    assert.equal(MONTH_SPEC.test(bad), false, bad);
  }
});

test("a cash withdrawal is paired in the month's plan, not held forever", () => {
  // BBVA categorises `RETIRO SIN TARJETA QR` as a transfer, so left whole the
  // month's plan held it for a counterpart no statement will ever bring — the
  // cash account issues none.
  const withdrawal: CsvRow = {
    date: "2026-06-09 12:00:00", account: "Bancomer", amount: "-2400.00",
    category: "Transfer, withdraw", note: "[Claude reconcile 2026-06]",
    payee: "Retiro sin tarjeta QR", efectivo: "1",
  };
  const plan = planMonth("2026-06", [{ account: "Bancomer", rows: [withdrawal] }], []);
  const paired = plan.planned.filter((p) => p.disposition === "pair");
  assert.equal(paired.length, 2);
  assert.deepEqual(paired.map((p) => p.account).sort(), ["Bancomer", "Wallet"]);
  assert.equal(plan.planned.filter((p) => p.disposition === "hold").length, 0);
});
