import test from "node:test";
import assert from "node:assert/strict";

import { checkContinuity, dayAfter, dayBefore } from "../../statements/continuity.js";
import type { StatementSpan } from "../../statements/continuity.js";

const span = (month: string, from: string, to: string, opening?: number, closing?: number): StatementSpan =>
  ({ month, period: { from, to }, opening, closing });

test("the month a bank never issued is named — the Banorte débito case", () => {
  // Banorte cut on the 1st through July and at month end from August, so 2–31
  // July has no statement. Wallet was $7,200 short and nothing complained.
  const findings = checkContinuity("Banorte débito", [
    span("2026-08", "2026-08-01", "2026-08-31", 6_566_482, 4_495_518),
    span("2026-07", "2026-06-02", "2026-07-01", 5_607_292, 0),
  ]);
  const gap = findings.find((f) => f.kind === "gap");
  assert.ok(gap, "no reportó el hueco");
  assert.match(gap.message, /falta el estado del 2026-07-02 al 2026-07-31/);
});

test("the balances disagree even when the dates look fine", () => {
  // The stronger half: a bank can renumber its periods and still skip money.
  const findings = checkContinuity("Banorte débito", [
    span("2026-07", "2026-06-02", "2026-07-01", 5_607_292, 0),
    span("2026-08", "2026-07-02", "2026-08-31", 6_566_482, 4_495_518),
  ]);
  assert.equal(findings.filter((f) => f.kind === "gap").length, 0);
  const balance = findings.find((f) => f.kind === "balance");
  assert.ok(balance);
  assert.match(balance.message, /faltan \$65,664\.82 por explicar/);
});

test("an unbroken chain says nothing", () => {
  const findings = checkContinuity("Meli", [
    span("2026-07", "2026-06-22", "2026-07-21", -32_708, -15_000),
    span("2026-08", "2026-07-22", "2026-08-21", -15_000, -1_000),
  ]);
  assert.deepEqual(findings, []);
});

test("statements that overlap are flagged as double-counting risk", () => {
  const findings = checkContinuity("Costco", [
    span("2026-06", "2026-05-09", "2026-06-08"),
    span("2026-07", "2026-06-01", "2026-07-08"),
  ]);
  assert.equal(findings[0].kind, "overlap");
  assert.match(findings[0].message, /se traslapan/);
});

test("a statement with no declared period is skipped, not guessed at", () => {
  // A false gap sends someone hunting for a statement that does not exist.
  const findings = checkContinuity("Klar", [
    span("2026-07", "2026-07-01", "2026-07-31", 0, 100),
    { month: "2026-08", period: { from: "", to: "" } } as StatementSpan,
    span("2026-09", "2026-09-01", "2026-09-30", 100, 200),
  ]);
  assert.equal(findings.filter((f) => f.kind === "gap").length, 1);
  assert.match(findings[0].message, /2026-08-01 al 2026-08-31/);
});

test("the day helpers cross month and year ends", () => {
  assert.equal(dayAfter("2026-07-31"), "2026-08-01");
  assert.equal(dayBefore("2026-08-01"), "2026-07-31");
  assert.equal(dayAfter("2026-12-31"), "2027-01-01");
});
