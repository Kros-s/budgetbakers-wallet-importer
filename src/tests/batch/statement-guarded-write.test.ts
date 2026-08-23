import { test } from "node:test";
import assert from "node:assert/strict";
import type { AxiosInstance } from "axios";

import {
  commitGuardedWrite, formatGuardReport, guardWrite,
} from "../../statements/guarded-write.js";
import { planWrites } from "../../statements/write-policy.js";
import type { CsvRow } from "../../csv.js";
import type { LookupMaps, WalletRecord } from "../../types.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const ACC_BANAMEX = "-Account_banamex";
const ACC_BANORTE = "-Account_banorte";
const CAT_GROCERIES = "-Category_groceries";
const CAT_TRANSFER = "-Category_transfer";
const CAT_TRASPASO = "-Category_traspaso";

const lookup: LookupMaps = {
  accounts: { Banamex: ACC_BANAMEX, Banorte: ACC_BANORTE },
  accountCurrencies: { Banamex: "-Currency_mxn", Banorte: "-Currency_mxn" },
  categories: {
    Groceries: CAT_GROCERIES,
    "Transfer, withdraw": CAT_TRANSFER,
    // A second, differently named transfer category really exists in the
    // catalog, and the extractor does emit "Traspaso" — that is the whole
    // point of the integrity check below.
    Traspaso: CAT_TRASPASO,
    "Interests, dividends": "-Category_interests",
  },
  currencies: { MXN: "-Currency_mxn" },
  transferCategoryId: CAT_TRANSFER,
  labels: {},
};

const row = (over: Partial<CsvRow> = {}): CsvRow => ({
  date: "2026-02-10 12:00:00",
  account: "Banamex",
  amount: "-5480.00",
  category: "Groceries",
  note: "[Claude reconcile 2026-02]",
  payee: "MERPAGO*SAMSUNG",
  ...over,
});

/**
 * Dates carry no offset on purpose: `convertRows` produces local wall-clock
 * ISO, so the fixtures have to be read the same way or every comparison drifts
 * by the machine's timezone.
 */
const walletRecord = (over: Partial<WalletRecord> & { _id: string }): WalletRecord => ({
  type: 1,
  accountId: ACC_BANAMEX,
  currencyId: "-Currency_mxn",
  categoryId: CAT_GROCERIES,
  amount: 10000,
  refAmount: 10000,
  note: "",
  payee: "MERPAGO*SAMSUNG",
  recordDate: "2026-02-10T12:00:00",
  recordState: 1,
  paymentType: 0,
  transfer: false,
  categoryChanged: true,
  latitude: 0,
  longitude: 0,
  accuracy: 0,
  warrantyInMonth: 0,
  suggestedEnvelopeId: 0,
  photos: [],
  labels: [],
  refObjects: [],
  reservedModelType: "Record",
  reservedSource: "web",
  reservedOwnerId: "user",
  reservedAuthorId: "user",
  reservedCreatedAt: "2026-02-10T12:00:00.000Z",
  ...over,
});

interface BulkCall { docs: Array<Record<string, unknown>> }

function fakeCouch(): { couch: AxiosInstance; calls: BulkCall[] } {
  const calls: BulkCall[] = [];
  const couch = {
    post: async (_url: string, body: BulkCall) => {
      calls.push(body);
      return { data: body.docs.map((d) => ({ id: String(d._id), ok: true, rev: "1-a" })) };
    },
  } as unknown as AxiosInstance;
  return { couch, calls };
}

// ── The duplicate path this module exists to close ──────────────────────────

test("a first instalment is deduped at the full price it will be written at, not the instalment it was matched at", async () => {
  // The open duplicate path. reconcile-statement's diff() looks for the $5,480
  // charged this period, Wallet holds the $32,880 purchase written by an
  // earlier run, so the row reads as missing — and then splitForWriting
  // restates it to $32,880 and posts the purchase a second time. The gate has
  // to run on the amount that will actually land in Wallet.
  const existing = [walletRecord({ _id: "Record_purchase", amount: 3_288_000, type: 1 })];
  const result = await guardWrite([row({ meses: "1/6", montooriginal: "32880.00" })], { lookup, existing });

  assert.equal(result.records.length, 0, "escribió de nuevo una compra a meses ya registrada");
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].kind, "wallet-duplicate");
  assert.equal(result.duplicates[0].existing._id, "Record_purchase");
  assert.equal(result.duplicates[0].record.amount, 3_288_000, "el duplicado se juzgó por el monto equivocado");
});

test("a Wallet record for the instalment amount does not stop the whole purchase from being written", async () => {
  // The mirror of the test above, and the reason the gate cannot simply widen
  // its net: under the user's rule the purchase is recorded ONCE for its full
  // price. A $5,480 record sitting in Wallet is not that purchase — it is some
  // other charge — and letting it veto the write would silently lose $32,880.
  const existing = [walletRecord({ _id: "Record_other", amount: 548_000, type: 1 })];
  const result = await guardWrite([row({ meses: "1/6", montooriginal: "32880.00" })], { lookup, existing });

  assert.equal(result.duplicates.length, 0);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].amount, 3_288_000);
});

test("a duplicate is recognised by the operation date when the charge date is a month away", async () => {
  // "MERPAGO*SAMSUNG 03/03" was operated 09-ene and charged 10-feb. The alert
  // recorded it the day it was bought; the statement dates it the day it was
  // charged. Checking only the charge date puts 32 days between the two and
  // writes the purchase again.
  const existing = [walletRecord({ _id: "Record_alert", amount: 3_288_000, recordDate: "2026-01-09T13:00:00" })];
  const result = await guardWrite(
    [row({ amount: "-32880.00", opdate: "2026-01-09" })],
    { lookup, existing }
  );

  assert.equal(result.records.length, 0, "no miró la fecha de operación");
  assert.equal(result.duplicates[0].existing._id, "Record_alert");
});

test("later instalments never reach the write even when the caller skipped planWrites", async () => {
  // splitForWriting is applied here too, on purpose. A caller that forgets it
  // books a monthly instalment as a purchase the user never agreed to record.
  const result = await guardWrite([row({ meses: "4/6" })], { lookup, existing: [] });

  assert.equal(result.records.length, 0);
  assert.equal(result.ignored.length, 1);
});

test("running after planWrites does not restate a first instalment a second time", async () => {
  // The real caller already restated the row. Re-applying the restatement must
  // be a no-op, or $32,880 would compound on every pass through the gate.
  const plan = planWrites([row({ meses: "1/6", montooriginal: "32880.00" })]);
  assert.equal(plan.now[0].amount, "-32880.00");

  const result = await guardWrite(plan.now, { lookup, existing: [] });
  assert.equal(result.records[0].amount, 3_288_000);
});

// ── The duplicate gate's boundaries ─────────────────────────────────────────

test("the same amount on the same day in a different account is not a duplicate", async () => {
  // Two cards charged the same subscription on the same day is ordinary. The
  // account is part of the identity of a movement.
  const existing = [walletRecord({ _id: "Record_elsewhere", accountId: ACC_BANORTE, amount: 548_000 })];
  const result = await guardWrite([row()], { lookup, existing });

  assert.equal(result.records.length, 1);
});

test("money in is never mistaken for money out of the same size", async () => {
  // Wallet's flag reads backwards from the obvious: type 1 is money OUT, type 0
  // is money IN. Getting it wrong here would let a refund cancel the charge it
  // refunds, or vice versa.
  const asIncome = [walletRecord({ _id: "Record_in", amount: 548_000, type: 0 })];
  const expense = await guardWrite([row({ amount: "-5480.00" })], { lookup, existing: asIncome });
  assert.equal(expense.records.length, 1, "un ingreso existente bloqueó un gasto del mismo monto");
  assert.equal(expense.records[0].type, 1, "un gasto no se escribió como type 1");

  const asExpense = [walletRecord({ _id: "Record_out", amount: 548_000, type: 1 })];
  const income = await guardWrite([row({ amount: "5480.00" })], { lookup, existing: asExpense });
  assert.equal(income.records.length, 1, "un gasto existente bloqueó un ingreso del mismo monto");
  assert.equal(income.records[0].type, 0, "un ingreso no se escribió como type 0");
});

test("a record more than the statement slack away is a different movement", async () => {
  // Five days is the measured operation-to-posting lag at Banamex. A monthly
  // subscription of the same amount at the same merchant is not a duplicate of
  // last month's.
  const existing = [walletRecord({ _id: "Record_lastmonth", amount: 548_000, recordDate: "2026-01-10T12:00:00" })];
  const result = await guardWrite([row()], { lookup, existing });

  assert.equal(result.records.length, 1);
});

test("a row that cannot be converted is reported, never written", async () => {
  // An unknown category used to mean the row silently vanished from the write
  // with no line item saying so.
  const result = await guardWrite([row({ category: "Categoría Inexistente" })], { lookup, existing: [] });

  assert.equal(result.records.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /Unknown category/);
});

// ── Transfers ───────────────────────────────────────────────────────────────

test("a transfer pair whose other leg is already in Wallet is not written half", async () => {
  // convertRows links the two legs with a shared transferId before any of this
  // runs. Dropping only the duplicated leg leaves the survivor pointing at a
  // record that will never exist — an orphan leg, which is precisely what
  // `Stocks` already carries eight of.
  const existing = [
    walletRecord({
      _id: "Record_in", accountId: ACC_BANORTE, amount: 100_000, type: 0,
      categoryId: CAT_TRANSFER, transfer: true, payee: "", note: "",
    }),
  ];
  const rows = [
    row({ account: "Banamex", amount: "-1000.00", category: "Transfer, withdraw", payee: "", note: "" }),
    row({ account: "Banorte", amount: "1000.00", category: "Transfer, withdraw", payee: "", note: "" }),
  ];
  const result = await guardWrite(rows, { lookup, existing });

  assert.equal(result.records.length, 0, "escribió media transferencia");
  assert.deepEqual(
    result.duplicates.map((d) => d.kind).sort(),
    ["orphan-transfer-half", "wallet-duplicate"]
  );
});

test("a complete transfer pair that Wallet does not hold yet raises nothing", async () => {
  // Both legs present, opposite types, different accounts: the counterpart
  // check has to find them in each other, or every legitimate transfer would
  // be blocked as an orphan and no month would ever close.
  const rows = [
    row({ account: "Banamex", amount: "-1000.00", category: "Transfer, withdraw", payee: "", note: "" }),
    row({ account: "Banorte", amount: "1000.00", category: "Transfer, withdraw", payee: "", note: "" }),
  ];
  const result = await guardWrite(rows, { lookup, existing: [] });

  assert.equal(result.records.length, 2);
  assert.deepEqual(result.findings, []);
  assert.equal(result.blocked, false);
});

// ── Integrity, before the write instead of after ────────────────────────────

test("a transfer category that is not flagged as a transfer blocks the whole write", async () => {
  // The 2026-08-19 failure, moved forward in time: a $323,000 withdrawal filed
  // under a transfer category but not linked, so the money vanishes from net
  // worth instead of moving. It was found AFTER the write. "Traspaso" is a
  // catalog category of its own, so convertRows leaves the flag off.
  const result = await guardWrite(
    [row({ category: "Traspaso", amount: "-323000.00", payee: "Cetes Directo" })],
    { lookup, existing: [] }
  );

  assert.equal(result.blocked, true);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].kind, "transfer-not-flagged");
  assert.match(result.alerts[0].message, /323,000\.00/);
  // The records are still reported: the caller needs to see what it refused.
  assert.equal(result.records.length, 1);
});

test("an unusually large ordinary movement is flagged for review but does not block", async () => {
  // "review" is a human glance, not a stop. Blocking on it would stall every
  // month that happens to contain one big legitimate purchase.
  const result = await guardWrite([row({ amount: "-60000.00" })], { lookup, existing: [] });

  assert.equal(result.blocked, false);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.findings.map((f) => f.kind), ["large-non-transfer"]);
});

test("a finding names a row the caller can actually find", async () => {
  // A finding reported against a record id that does not exist yet is not
  // actionable. Every candidate carries a stand-in id and its source row.
  const result = await guardWrite(
    [row({ category: "Traspaso", amount: "-323000.00", payee: "Cetes Directo" })],
    { lookup, existing: [] }
  );

  assert.equal(result.alerts[0].recordId, result.writable[0].id);
  assert.equal(result.writable[0].row.payee, "Cetes Directo");
});

// ── Committing ──────────────────────────────────────────────────────────────

test("commitGuardedWrite refuses to write while a serious alert stands", async () => {
  // The point of the whole module: the alert has to stop the write, not
  // describe it afterwards.
  const { couch, calls } = fakeCouch();
  const result = await guardWrite(
    [row({ category: "Traspaso", amount: "-323000.00" })],
    { lookup, existing: [] }
  );

  await assert.rejects(
    () => commitGuardedWrite(result, { lookup, existing: [], couch, userId: "user" }),
    /alerta/i
  );
  assert.equal(calls.length, 0, "tocó CouchDB pese a la alerta");
});

test("commitGuardedWrite posts exactly the records that cleared, and nothing else", async () => {
  // The rejected rows must not slip into the bulk payload — the gate would be
  // decorative if the caller still handed convertRows' full output to Couch.
  const { couch, calls } = fakeCouch();
  const existing = [walletRecord({ _id: "Record_dup", amount: 548_000 })];
  const result = await guardWrite(
    [row(), row({ amount: "-120.50", payee: "OXXO" })],
    { lookup, existing }
  );

  assert.equal(result.duplicates.length, 1);
  const bulk = await commitGuardedWrite(result, { lookup, existing, couch, userId: "user" });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].docs.map((d) => d.amount), [12_050]);
  assert.equal(bulk.length, 1);
});

test("nothing to write means no CouchDB call at all", async () => {
  // An empty _bulk_docs is a pointless round trip, and writeRecords would
  // otherwise be handed an empty batch on every fully-deduped month.
  const { couch, calls } = fakeCouch();
  const result = await guardWrite([], { lookup, existing: [] });

  assert.deepEqual(await commitGuardedWrite(result, { lookup, existing: [], couch, userId: "user" }), []);
  assert.equal(calls.length, 0);
  assert.equal(result.blocked, false);
});

test("the report names every rejection so nothing disappears silently", async () => {
  // A row that is neither written nor mentioned is the failure mode that
  // started all of this: a run that reports success while holding an error.
  const existing = [walletRecord({ _id: "Record_dup", amount: 548_000 })];
  const result = await guardWrite(
    [row(), row({ meses: "4/6" }), row({ category: "Categoría Inexistente" })],
    { lookup, existing }
  );
  const report = formatGuardReport(result);

  assert.match(report, /Record_dup/);
  assert.match(report, /Parcialidades ignoradas/);
  assert.match(report, /Unknown category/);
});
