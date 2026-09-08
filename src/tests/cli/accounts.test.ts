import test from "node:test";
import assert from "node:assert/strict";

import { ACCOUNT_TYPES, buildAccountDoc } from "../../cli/accounts.js";

const base = {
  name: "Plata Card",
  accountType: ACCOUNT_TYPES.debito,
  currencyId: "-Currency_564ff093",
  userId: "user-1",
  position: 685_000,
};

test("the document carries the id prefix every account lookup expects", () => {
  // Records are `Record_…` with no leading dash; accounts are `-Account_…`.
  assert.match(String(buildAccountDoc(base)._id), /^-Account_[0-9a-f-]{36}$/);
});

test("debit and savings land on the type Ualá and Banorte débito already use", () => {
  assert.equal(ACCOUNT_TYPES.debito, 4);
  assert.equal(ACCOUNT_TYPES.ahorro, 4);
  assert.equal(ACCOUNT_TYPES.credito, 3);
});

test("the decimal twins agree with the minor-unit balance", () => {
  // The iOS client writes both; disagreeing is how an account shows one balance
  // on the phone and another on the web.
  const doc = buildAccountDoc({ ...base, initAmount: 4_115_100 });
  assert.equal(doc.initAmount, 4_115_100);
  assert.equal(doc.initRefAmount, 4_115_100);
  assert.equal(doc.decimalInitAmount, "41151");
  assert.equal(doc.decimalInitRefAmount, "41151");
});

test("an account with no starting balance is written as a real zero", () => {
  const doc = buildAccountDoc(base);
  assert.equal(doc.initAmount, 0);
  assert.equal(doc.decimalInitAmount, "0");
});

test("it is created visible and unarchived, or it would sync into nothing", () => {
  const doc = buildAccountDoc(base);
  assert.equal(doc.archived, false);
  assert.equal(doc.excludeFromStats, false);
  assert.equal(doc.reservedModelType, "Account");
});
