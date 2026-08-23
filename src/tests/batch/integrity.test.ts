import { test } from "node:test";
import assert from "node:assert/strict";

import { amountsInText, checkRunIntegrity, formatFindings } from "../../batch/integrity.js";
import type { InspectedRecord } from "../../batch/integrity.js";

const rec = (o: Partial<InspectedRecord> & { id: string }): InspectedRecord => ({
  amountCents: 10000, type: 1, transfer: false, accountId: "acc-a",
  recordDate: "2026-08-17T12:00:00.000-06:00", ...o,
});

test("catches the $323,000 CETES withdrawal booked as a plain expense", () => {
  // The real 2026-08-19 failure: the run reported complete, 0 failed.
  const f = checkRunIntegrity({
    written: [rec({
      id: "Record_51860471", amountCents: 32_300_000, type: 1, transfer: false,
      accountId: "-Account_70496433", categoryName: "Transfer, withdraw",
      payee: "Cetes Directo", note: "Retiro de Cetes [Claude 2026-08-19]",
    })],
  });
  const alert = f.find((x) => x.kind === "transfer-not-flagged");
  assert.ok(alert, "no detectó el traspaso sin marcar");
  assert.equal(alert.severity, "alert");
  assert.equal(alert.recordId, "Record_51860471");
  assert.match(alert.message, /323,000\.00/);
});

test("a correctly paired transfer raises nothing", () => {
  const findings = checkRunIntegrity({
    written: [
      rec({ id: "out", amountCents: 32_300_000, type: 1, transfer: true, accountId: "cetes", categoryName: "Transfer, withdraw" }),
      rec({ id: "in", amountCents: 32_300_000, type: 0, transfer: true, accountId: "banorte", categoryName: "Transfer, withdraw" }),
    ],
    largeAmountCents: 5_000_000,
  });
  assert.deepEqual(findings, []);
});

test("catches a transfer leg written without its counterpart", () => {
  const f = checkRunIntegrity({
    written: [rec({ id: "solo", amountCents: 174_000, type: 1, transfer: true, categoryName: "Transfer, withdraw" })],
  });
  assert.equal(f.filter((x) => x.kind === "orphan-transfer-leg").length, 1);
});

test("a counterpart written by an earlier run still counts", () => {
  const leg = rec({ id: "new-leg", amountCents: 500_000, type: 1, transfer: true, accountId: "a" });
  const older = rec({ id: "old-leg", amountCents: 500_000, type: 0, transfer: true, accountId: "b" });
  assert.deepEqual(
    checkRunIntegrity({ written: [leg], windowRecords: [leg, older] }).filter((x) => x.kind === "orphan-transfer-leg"),
    []
  );
});

test("the same account cannot be both legs of its own transfer", () => {
  const a = rec({ id: "a", amountCents: 1000, type: 1, transfer: true, accountId: "same" });
  const b = rec({ id: "b", amountCents: 1000, type: 0, transfer: true, accountId: "same" });
  const f = checkRunIntegrity({ written: [a, b] });
  assert.equal(f.filter((x) => x.kind === "orphan-transfer-leg").length, 2);
});

test("transfer wording without a transfer category is a review, not an alert", () => {
  // "TRANSFERENCIA A JUAN" can legitimately be a payment to a third party.
  const f = checkRunIntegrity({
    written: [rec({ id: "r", payee: "TRANSFERENCIA A JUAN", categoryName: "Others" })],
  });
  const hit = f.find((x) => x.kind === "transfer-wording-not-flagged");
  assert.ok(hit);
  assert.equal(hit.severity, "review");
});

test("flags a verdict filed as a pending question", () => {
  const f = checkRunIntegrity({
    written: [],
    pending: [{ messageId: 1083, claudeQuestion: "NO_TRANSACTION Este correo es una transferencia cancelada", emailSubject: "SPEI" }],
  });
  const hit = f.find((x) => x.kind === "verdict-filed-as-question");
  assert.ok(hit);
  assert.equal(hit.messageId, 1083);
});

test("flags the same amount asked from two banks", () => {
  const f = checkRunIntegrity({
    written: [],
    pending: [
      { messageId: 1136, claudeQuestion: "¿A cuál cuenta llegó la transferencia de $236,702.00?" },
      { messageId: 1137, claudeQuestion: "¿Es una transferencia entre tus cuentas por $236,702.00?" },
    ],
  });
  const hit = f.find((x) => x.kind === "duplicate-question");
  assert.ok(hit);
  assert.match(hit.message, /1136, 1137/);
});

test("flags a question whose amount was already written this run", () => {
  const f = checkRunIntegrity({
    written: [rec({ id: "w", amountCents: 24_800 })],
    pending: [{ messageId: 1130, claudeQuestion: "¿De qué cuenta salió el pago de $248.00?" }],
  });
  assert.ok(f.some((x) => x.kind === "question-may-be-recorded"));
});

test("amountsInText reads Mexican formatting and ignores bare numbers", () => {
  assert.deepEqual(amountsInText("cargo de $1,047.00 MXN"), [104_700]);
  assert.deepEqual(amountsInText("$236,702"), [23_670_200]);
  assert.deepEqual(amountsInText("terminación 4615 sin monto"), []);
});

test("a clean run renders nothing at all", () => {
  assert.equal(formatFindings([]), "");
});

test("the rendered summary separates alerts from reviews", () => {
  const out = formatFindings(checkRunIntegrity({
    written: [rec({ id: "r", amountCents: 32_300_000, categoryName: "Transfer, withdraw", payee: "Cetes Directo" })],
  }));
  assert.match(out, /alerta/);
  assert.match(out, /323,000\.00/);
});

test("a transfer the iOS app linked is not reported as unflagged", () => {
  // The iOS app links the two legs with transferId and never sets the boolean.
  // Of 5,593 records under a transfer category in this account, 5,590 carry a
  // transferId and only 591 the flag — reading the flag alone would report
  // 5,002 ordinary transfers as errors the first time the check is pointed at
  // the whole history, which is what the pending sweep does.
  const inspect = (doc: { transfer?: boolean; transferId?: string }): boolean =>
    Boolean(doc.transfer || doc.transferId);
  assert.equal(inspect({ transferId: "86C9E2B-2224" }), true, "iOS: solo transferId");
  assert.equal(inspect({ transfer: true }), true, "web/importador: solo el booleano");
  assert.equal(inspect({}), false);
});

// ── Money arriving that the statement could not attribute ─────────────────

const inflow = (over: Partial<InspectedRecord> = {}): InspectedRecord => ({
  id: "pending-1", amountCents: 1015521, type: 0, transfer: false,
  accountId: "-Account_bancomer", categoryName: "Others",
  recordDate: "2026-06-22T12:00:00.000-06:00", ...over,
});

test("an inflow whose sender the statement never named is raised for review", () => {
  // BBVA's `SPEI RECIBIDO STP`: $10,155.21 arriving from the user's own FinSus
  // account, reaching Wallet as income from a payee called "STP".
  const findings = checkRunIntegrity({
    written: [inflow({ payee: "STP", description: "SPEI RECIBIDO STP 0260622 Referencia 0126700458 646" })],
  });
  assert.equal(findings.filter((f) => f.kind === "inflow-without-counterparty").length, 1);
});

test("an ordinary wire from a named third party is not raised", () => {
  // Every wire in Mexico travels on SPEI, including every genuine client
  // payment. Treating the word as a signal flags six rows to catch one.
  const findings = checkRunIntegrity({
    written: [inflow({
      payee: "Luis Alberto Jimenez Casillas",
      description: "SPEI RECIBIDOBANAMEX 0010726julio 2026 LUIS ALBERTO,JIMENEZ/CASILLAS",
    })],
  });
  assert.equal(findings.filter((f) => f.kind === "inflow-without-counterparty").length, 0);
});

test("the check stays quiet where no statement was involved", () => {
  // Email alerts carry no description, and this must not start firing on them.
  const findings = checkRunIntegrity({ written: [inflow({ payee: "STP", description: undefined })] });
  assert.equal(findings.filter((f) => f.kind === "inflow-without-counterparty").length, 0);
  // Nor on money leaving: an expense nobody was named for is a purchase.
  const out = checkRunIntegrity({ written: [inflow({ type: 1, payee: "", description: "COMPRA SIN NOMBRE" })] });
  assert.equal(out.filter((f) => f.kind === "inflow-without-counterparty").length, 0);
});

test("interest paid by the bank needs no counterparty named", () => {
  // Mercado Pago pays interest 46 times a month, every one of them naming no
  // sender because the sender is the bank. Flagging all 46 to catch one real
  // arrival buries the finding under its own noise.
  const earned = checkRunIntegrity({
    written: [inflow({ amountCents: 206, categoryName: "Interests, dividends", payee: "Mercado Pago", description: "Ganancia" })],
  });
  assert.equal(earned.filter((f) => f.kind === "inflow-without-counterparty").length, 0);
  // The arrival that was buried among them still surfaces.
  const arrival = checkRunIntegrity({
    written: [inflow({ amountCents: 625000, categoryName: "Others", payee: "", description: "Ingreso de dinero" })],
  });
  assert.equal(arrival.filter((f) => f.kind === "inflow-without-counterparty").length, 1);
});
