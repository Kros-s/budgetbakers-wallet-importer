import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarPeriod, cutDayMismatch, isNearBoundary, parsePeriodLine, walletWindow,
} from "../../statements/period.js";

test("the period line is read from the extractor's answer", () => {
  const out = parsePeriodLine("bla\nPERIODO: 2026-06-22..2026-07-21\nTOTAL_MOVIMIENTOS: 12");
  assert.deepEqual(out, { from: "2026-06-22", to: "2026-07-21" });
});

test("spaces around the separator are tolerated", () => {
  assert.deepEqual(parsePeriodLine("PERIODO:  2026-07-01 .. 2026-07-31"), {
    from: "2026-07-01", to: "2026-07-31",
  });
});

test("a backwards or absent period is refused rather than guessed", () => {
  assert.equal(parsePeriodLine("PERIODO: 2026-07-31..2026-07-01"), null);
  assert.equal(parsePeriodLine("no dice nada"), null);
  assert.equal(parsePeriodLine("PERIODO: julio"), null);
});

test("the calendar fallback spans the whole month, February included", () => {
  assert.deepEqual(calendarPeriod("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(calendarPeriod("2026-07"), { from: "2026-07-01", to: "2026-07-31" });
});

test("the Wallet window covers the real period, not the calendar month", () => {
  // Costco's "March" statement runs 7-feb to 6-mar. The old calendar window
  // started 26-feb and left 19 of its 28 days with no candidate to match — each
  // one a duplicate waiting for --write.
  const { from, to } = walletWindow({ from: "2026-02-07", to: "2026-03-06" }, 3);
  assert.ok(Date.parse(from) <= Date.parse("2026-02-04T23:59:59"), "abarca desde antes del 7-feb");
  assert.ok(Date.parse(to) >= Date.parse("2026-03-09T00:00:00"), "abarca hasta después del 6-mar");
});

test("a cut day that matches within the weekend drift is not flagged", () => {
  // Costco cuts on the 8th and slides to Friday the 6th when the 8th is Sunday.
  assert.equal(cutDayMismatch({ from: "2026-02-07", to: "2026-03-06" }, 8), null);
  assert.equal(cutDayMismatch({ from: "2026-03-07", to: "2026-04-08" }, 8), null);
});

test("an end-of-month account is not flagged for closing on the 31st", () => {
  // The registry caps cutDay at 28; a period closing the 31st is the same thing.
  assert.equal(cutDayMismatch({ from: "2026-07-01", to: "2026-07-31" }, 28), null);
  assert.equal(cutDayMismatch({ from: "2026-02-01", to: "2026-02-28" }, 28), null);
});

test("the wrong PDF filed against the wrong account is caught", () => {
  const warn = cutDayMismatch({ from: "2026-06-22", to: "2026-07-21" }, 8);
  assert.match(warn ?? "", /cierra el día 21.*corte 8/);
});

test("a movement at the edge of the period is expected, not an anomaly", () => {
  // A purchase on the 30th charged on the 2nd belongs to one statement while
  // Wallet holds it under the other date.
  const p = { from: "2026-07-01", to: "2026-07-31" };
  assert.equal(isNearBoundary("2026-07-30", p), true);
  assert.equal(isNearBoundary("2026-07-02", p), true);
  assert.equal(isNearBoundary("2026-07-15", p), false);
});

test("the boundary reaches just past the edge, where the neighbour's rows sit", () => {
  const p = { from: "2026-07-01", to: "2026-07-31" };
  assert.equal(isNearBoundary("2026-08-02", p), true);
  assert.equal(isNearBoundary("2026-08-05", p), false);
  assert.equal(isNearBoundary("no es fecha", p), false);
});
