import { test } from "node:test";
import assert from "node:assert/strict";

import { candidateAmounts, formatWalletContext } from "../../webhook/wallet-context.js";
import type { ExistingRecord } from "../../webhook/wallet-context.js";

const rec = (o: Partial<ExistingRecord>): ExistingRecord => ({
  amountCents: 615000, type: 1, transfer: false, accountName: "Costco",
  payee: "SANTILLANACOMPARTIR", note: "[Claude 2026-08-19]",
  recordDate: "2026-07-23T22:08:25.000-06:00", ...o,
});

test("reads Mexican amounts out of the email and the reply", () => {
  assert.deepEqual(candidateAmounts("compra de $6,150.00 en SANTILLANA"), [615_000]);
  assert.deepEqual(candidateAmounts("MXN$1,047.00"), [104_700]);
  assert.deepEqual(candidateAmounts("cargo por 25856.73 MXN"), [2_585_673]);
});

test("collapses the same amount seen in several places", () => {
  assert.deepEqual(candidateAmounts("$100.00 aquí", "y $100.00 allá"), [10_000]);
});

test("bare numbers are not amounts", () => {
  assert.deepEqual(candidateAmounts("tarjeta 5432 orden 261510"), []);
});

test("says plainly when nothing matched, instead of staying silent", () => {
  // Silence would read as "the check never ran" and the model would hedge
  // exactly as it did before this existed.
  const out = formatWalletContext([], [615_000]);
  assert.match(out, /NINGUNO/);
  assert.match(out, /NO está registrado/);
});

test("lists the matching records with enough detail to recognise them", () => {
  const out = formatWalletContext([rec({})], [615_000]);
  assert.match(out, /6,150\.00/);
  assert.match(out, /Costco/);
  assert.match(out, /SANTILLANACOMPARTIR/);
  assert.match(out, /2026-07-23/);
  assert.match(out, /NO propongas CSV/);
});

test("names the kind of movement, so a transfer is not read as a purchase", () => {
  assert.match(formatWalletContext([rec({ transfer: true })], [615_000]), /traspaso/);
  assert.match(formatWalletContext([rec({ type: 0 })], [615_000]), /ingreso/);
  assert.match(formatWalletContext([rec({ type: 1 })], [615_000]), /gasto/);
});

test("no amounts in the question means no section at all", () => {
  assert.equal(formatWalletContext([], []), "");
});
