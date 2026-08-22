import { test } from "node:test";
import assert from "node:assert/strict";
import { cellFor, formatStatementsTable, gridMonths } from "../../bot/statements-view.js";
import type { AccountStatus } from "../../statements/registry.js";

const AUG = new Date("2026-08-22T12:00:00");

function status(over: Partial<AccountStatus> = {}): AccountStatus {
  return { account: "Costco", source: "manual", cutDay: 10, lastReceived: null, missing: [], ...over };
}

test("the grid ends at the previous month — the current one cannot be due", () => {
  assert.deepEqual(gridMonths(AUG, 6), ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"]);
});

test("the grid crosses the year boundary backwards", () => {
  assert.deepEqual(gridMonths(new Date("2026-02-10T12:00:00"), 4), ["2025-10", "2025-11", "2025-12", "2026-01"]);
});

test("a month at or below lastReceived is settled", () => {
  const s = status({ lastReceived: "2026-05" });
  assert.equal(cellFor(s, "2026-04"), "✅");
  assert.equal(cellFor(s, "2026-05"), "✅");
});

test("a chased month is missing, an unchased future one is merely not due", () => {
  const s = status({ lastReceived: "2026-05", missing: ["2026-06", "2026-07"] });
  assert.equal(cellFor(s, "2026-06"), "❌");
  assert.equal(cellFor(s, "2026-07"), "❌");
  assert.equal(cellFor(s, "2026-08"), "⬜");
});

test("a fresh account shows blanks, not a wall of red", () => {
  // startMonth keeps the registry from chasing it backwards; the grid must
  // agree, or a brand-new account looks like six months of neglect.
  const s = status({ lastReceived: null, missing: ["2026-07"] });
  assert.deepEqual(gridMonths(AUG, 6).map((m) => cellFor(s, m)), ["⬜", "⬜", "⬜", "⬜", "⬜", "❌"]);
});

test("the table leads with the account that is furthest behind", () => {
  const out = formatStatementsTable(
    [
      status({ account: "Bancomer", lastReceived: "2026-06", missing: ["2026-07"] }),
      status({ account: "Costco", lastReceived: "2026-04", missing: ["2026-05", "2026-06", "2026-07"] }),
    ],
    AUG
  );
  const body = out.split("```")[1];
  assert.ok(body.indexOf("Costco") < body.indexOf("Bancomer"), "la más atrasada va primero");
  assert.match(out, /Faltan \*4\* meses en \*2\* cuentas/);
});

test("a long account name is cut so the columns stay aligned", () => {
  const out = formatStatementsTable([status({ account: "Platinum Credit Card" })], AUG);
  assert.match(out, /Platinum Cred…/);
});

test("everything reconciled says so instead of showing an empty prompt", () => {
  const out = formatStatementsTable([status({ lastReceived: "2026-07" })], AUG);
  assert.match(out, /✅ Todo conciliado\./);
  assert.doesNotMatch(out, /Mándame el PDF/);
});

test("gaps older than the grid are named, not silently dropped", () => {
  // Truncating the window without saying so makes a two-year hole read as a
  // clean table — the exact failure the all-months fix was for.
  const out = formatStatementsTable(
    [status({ lastReceived: "2025-10", missing: ["2025-11", "2025-12", "2026-07"] })],
    AUG
  );
  assert.match(out, /2 meses quedan antes de feb/);
  assert.match(out, /2025-11, 2025-12/);
});

test("an empty registry says it is empty", () => {
  assert.match(formatStatementsTable([], AUG), /No hay ninguna cuenta en el registro/);
});
