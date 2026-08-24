import { test } from "node:test";
import assert from "node:assert/strict";
import { cardDetailPath, describeSplice, spliceCardDetail } from "../../statements/card-detail.js";
import type { CsvRow } from "../../csv.js";

const row = (amount: string, payee: string, over: Partial<CsvRow> = {}): CsvRow => ({
  date: "2026-07-31 12:00:00", account: "DolarApp", amount,
  category: "Others", note: "[Claude reconcile 2026-07]", payee, ...over,
});

// DolarApp's July 2026, trimmed to the shape that matters: a month of card
// purchases the statement never itemises, settled in one line at the close.
const statement = [
  row("3597.00", "TRUSTPOINT IT ST", { date: "2026-07-06 12:00:00" }),
  row("-2403.82", "DolarApp", { desc: "Liquidación Crédito - Pagos con tarjeta crédito semanal" }),
  row("-9300.00", "Marco Mayen", { date: "2026-07-01 12:00:00", mxn: "-163202.91" }),
];
const detail = [
  row("-2451.47", "todo el mes"),
  row("47.65", "Amazon (devolución)"),
];

test("the itemised movements take the aggregate's place", () => {
  const res = spliceCardDetail(statement, detail);
  assert.equal(res.refused, null);
  assert.equal(res.replaced?.amount, "-2403.82");
  assert.deepEqual(res.rows.map((r) => r.amount), ["3597.00", "-2451.47", "47.65", "-9300.00"]);
  // The sum is untouched, which is why every balance check still proves out.
  const before = statement.reduce((s, r) => s + Math.round(parseFloat(r.amount) * 100), 0);
  const after = res.rows.reduce((s, r) => s + Math.round(parseFloat(r.amount) * 100), 0);
  assert.equal(before, after);
});

test("a detail that does not sum to any published movement replaces nothing", () => {
  // This is the whole safety of the mechanism: the arithmetic is the check, and
  // a transcription that lost a purchase cannot get in.
  const short = [row("-2451.47", "todo el mes")];
  const res = spliceCardDetail(statement, short);
  assert.equal(res.replaced, null);
  assert.match(res.refused ?? "", /no publica ningún movimiento de ese importe/);
  assert.deepEqual(res.rows, statement);
});

test("two movements of the same size leave the statement alone", () => {
  // Ambiguity is not resolved by picking one: the wrong choice deletes a real
  // movement and books the detail against a line that was not the settlement.
  const twins = [...statement, row("-2403.82", "otra cosa del mismo tamaño")];
  const res = spliceCardDetail(twins, detail);
  assert.equal(res.replaced, null);
  assert.match(res.refused ?? "", /mismo importe/);
  assert.equal(res.rows.length, twins.length);
});

test("the aggregate is found by its figure, never by its wording", () => {
  // A bank is free to rename its own settlement line; the amount is what ties
  // the detail to it in the first place.
  const renamed = statement.map((r) =>
    r.amount === "-2403.82" ? { ...r, payee: "", desc: "CARGO CONSOLIDADO MENSUAL" } : r
  );
  assert.equal(spliceCardDetail(renamed, detail).replaced?.amount, "-2403.82");
});

test("an unreadable detail is refused rather than summed to zero", () => {
  assert.match(spliceCardDetail(statement, [row("no", "x")]).refused ?? "", /no suma/);
  assert.match(spliceCardDetail(statement, []).refused ?? "", /no suma/);
});

test("the detail file is named by account and month", () => {
  assert.match(cardDetailPath("DolarApp", "2026-07"), /detail-dolarapp-2026-07\.json$/);
  assert.match(cardDetailPath("Banorte débito", "2026-06"), /detail-banorte-debito-2026-06\.json$/);
});

test("the report says what was replaced and where it came from", () => {
  const res = spliceCardDetail(statement, detail);
  const text = describeSplice(res, { source: "la app ARQ", rows: detail });
  assert.match(text, /2 movimiento\(s\)/);
  assert.match(text, /2403\.82/);
  assert.match(text, /la app ARQ/);
});
