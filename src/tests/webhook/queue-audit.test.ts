import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { AxiosInstance } from "axios";
import type { LookupMaps } from "../../types.js";

// The store resolves data/bot relative to cwd — isolate it in a scratch dir.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "queue-audit-test-"));
const originalCwd = process.cwd();
process.chdir(scratch);

const { storeClarification, listClarifications } = await import("../../webhook/clarification-store.js");
const { auditQueue } = await import("../../webhook/queue-audit.js");

const lookup = { accounts: { Costco: "-Account_costco", "Banorte débito": "-Account_bd" } } as unknown as LookupMaps;

/** A Couch that serves fixed records and counts how often the view is read. */
function fakeCouch(records: Array<Record<string, unknown>>) {
  const calls = { views: 0 };
  const couch = {
    get: async (url: string) => {
      if (url.includes("/_view/")) {
        calls.views++;
        return { data: { rows: records.map((doc) => ({ id: doc._id, key: doc.recordDate, value: null, doc })) } };
      }
      return { data: { _id: "_design/x", views: {} } };
    },
    put: async () => ({ data: { ok: true } }),
  } as unknown as AxiosInstance;
  return { couch, calls };
}

const record = (cents: number, date: string, account = "-Account_bd") => ({
  _id: `Record_${cents}`, amount: cents, type: 1, transfer: false, accountId: account,
  payee: "", note: "", recordDate: `${date}T13:07:00.000Z`,
});

const question = (messageId: number, chatId: number, amount: string, dated: string) =>
  storeClarification(messageId, {
    chatId, emailFrom: "notificaciones@banorte.com", emailSubject: "SPEI",
    emailText: `Fecha y hora: ${dated} a las 13:07:22 horas`,
    claudeQuestion: `¿De dónde viene esta transferencia de ${amount}?`,
    createdAt: Date.now(),
  });

beforeEach(() => fs.rmSync(path.join(scratch, "data"), { recursive: true, force: true }));
after(() => { process.chdir(originalCwd); fs.rmSync(scratch, { recursive: true, force: true }); });

test("a question about a movement written that same night leaves the queue", () => {
  // #69 on 2026-09-15: asked about $46,732.53, which another email had booked.
  question(1001, 7, "$46,732.53", "15/Sep/2026");
  question(1002, 7, "$3,000.00", "14/Sep/2026");
  const { couch } = fakeCouch([record(4_673_253, "2026-09-15")]);
  return auditQueue(couch, lookup, { close: true }).then((audit) => {
    assert.equal(audit.resolved.length, 1);
    const left = listClarifications().map((c) => c.entry.claudeQuestion);
    assert.equal(left.length, 1);
    assert.match(left[0], /\$3,000\.00/);
  });
});

test("without close it reports, and the queue is untouched", async () => {
  question(1001, 7, "$46,732.53", "15/Sep/2026");
  const { couch } = fakeCouch([record(4_673_253, "2026-09-15")]);
  const audit = await auditQueue(couch, lookup, { close: false });
  assert.equal(audit.resolved.length, 1);
  assert.equal(listClarifications().length, 1);
});

test("a match on another date is doubtful and never closed", async () => {
  question(1001, 7, "$46,732.53", "15/Sep/2026");
  const { couch } = fakeCouch([record(4_673_253, "2026-07-01")]);
  const audit = await auditQueue(couch, lookup, { close: true });
  assert.equal(audit.resolved.length, 0);
  assert.equal(audit.doubtful.length, 1);
  assert.equal(listClarifications().length, 1);
});

test("the chat filter keeps another chat's questions out of reach", async () => {
  question(1001, 7, "$46,732.53", "15/Sep/2026");
  question(1002, 8, "$46,732.53", "15/Sep/2026");
  const { couch } = fakeCouch([record(4_673_253, "2026-09-15")]);
  await auditQueue(couch, lookup, { close: true, chatId: 7 });
  const left = listClarifications();
  assert.equal(left.length, 1);
  assert.equal(left[0].entry.chatId, 8);
});

test("the whole queue costs one read of Wallet, not one per question", async () => {
  for (let i = 0; i < 12; i++) question(2000 + i, 7, `$${1000 + i}.37`, "15/Sep/2026");
  const { couch, calls } = fakeCouch([]);
  await auditQueue(couch, lookup, { close: true });
  assert.equal(calls.views, 1);
});
