import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSelection, reconcileMarker, selectWritten } from "../../statements/undo.js";
import type { WalletRecord } from "../../types.js";

const NAMES = { a: "MIFEL", b: "Meli" };
const rec = (over: Partial<WalletRecord> = {}): WalletRecord => ({
  _id: "Record_1", accountId: "a", amount: 7227, type: 0,
  recordDate: "2026-07-09T12:00:00.000-06:00", note: reconcileMarker("2026-07"),
  ...over,
} as WalletRecord);

test("only what that run wrote is selected", () => {
  const sel = selectWritten(
    [rec(), rec({ _id: "Record_2", note: "otra cosa" }), rec({ _id: "Record_3", note: "" })],
    "2026-07", NAMES
  );
  assert.equal(sel.records.length, 1);
});

test("the marker matches exactly, never as a prefix", () => {
  // "[Claude reconcile 2026-07]" must not select a note that merely starts the
  // same way — a recovery that takes more than it was asked to is worse than
  // the mistake it is undoing.
  const sel = selectWritten(
    [rec({ note: "[Claude reconcile 2026-07] corregido a mano" }), rec({ _id: "R2" })],
    "2026-07", NAMES
  );
  assert.equal(sel.records.length, 1);
  assert.equal(sel.records[0]._id, "R2");
});

test("another month's run is untouched", () => {
  assert.equal(selectWritten([rec()], "2026-06", NAMES).records.length, 0);
});

test("one account can be undone without the others", () => {
  const all = [rec(), rec({ _id: "R2", accountId: "b" })];
  assert.equal(selectWritten(all, "2026-07", NAMES, "Meli").records.length, 1);
  assert.equal(selectWritten(all, "2026-07", NAMES).records.length, 2);
});

test("the net states what is being reversed, with the right sign", () => {
  // type 1 is money out, 0 is money in — reading it the other way round would
  // report a refund as a charge in the very message meant to confirm a deletion.
  const sel = selectWritten(
    [rec({ amount: 7227, type: 0 }), rec({ _id: "R2", amount: 650, type: 1 })],
    "2026-07", NAMES
  );
  assert.equal(sel.netCents, 7227 - 650);
  assert.match(describeSelection(sel, "2026-07"), /Neto que se revierte: \$65\.77/);
});

test("a marker that matches nothing says so instead of reporting an empty success", () => {
  const out = describeSelection(selectWritten([], "2026-07", NAMES), "2026-07");
  assert.match(out, /No hay ningún registro/);
});

test("the breakdown names every account it would touch", () => {
  const sel = selectWritten([rec(), rec({ _id: "R2", accountId: "b", amount: 1000, type: 1 })], "2026-07", NAMES);
  const out = describeSelection(sel, "2026-07");
  assert.match(out, /MIFEL/);
  assert.match(out, /Meli/);
  assert.match(out, /Se quitarían \*2\*/);
});
