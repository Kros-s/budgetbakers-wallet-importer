import test from "node:test";
import assert from "node:assert/strict";

import { toIso, convertRows, parseCsv, rowsToCsv, type CsvRow } from "../csv.js";
import type { LookupMaps } from "../types.js";

test("toIso parses US short date with space separator", () => {
    const parsed = toIso("3/20/26 21:05");
    assert.match(parsed, /^2026-03-20T21:05:00\.000[+-]\d{2}:\d{2}$/);
});

// ── Tolerant lookup tests for convertRows ──────────────────────────────────

function sampleMaps(overrides?: Partial<LookupMaps>): LookupMaps {
    return {
        accounts: { "Banorte débito": "-Account_banorte" },
        accountCurrencies: { "Banorte débito": "-Currency_mxn" },
        categories: {
            "Restaurant, fast-food": "-Category_restaurant",
            "Transfer, withdraw": "-Category_transfer",
        },
        currencies: { MXN: "-Currency_mxn" },
        transferCategoryId: "-Category_transfer",
        labels: { "Work Trip": "-HashTag_worktrip" },
        ...overrides,
    };
}

function makeRow(overrides?: Partial<CsvRow>): CsvRow {
    return {
        date: "2026-01-27 02:31:00",
        account: "Banorte débito",
        amount: "-100",
        category: "Restaurant, fast-food",
        note: "",
        payee: "",
        ...overrides,
    };
}

test("convertRows resolves category without the comma via normalized match", () => {
    const { records, skipped } = convertRows(
        [makeRow({ category: "Restaurant fast-food" })],
        sampleMaps(),
    );
    assert.equal(skipped.length, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0].categoryId, "-Category_restaurant");
});

test("convertRows resolves category regardless of letter case", () => {
    const { records, skipped } = convertRows(
        [makeRow({ category: "RESTAURANT, FAST-FOOD" })],
        sampleMaps(),
    );
    assert.equal(skipped.length, 0);
    assert.equal(records[0].categoryId, "-Category_restaurant");
});

test("convertRows resolves account name written without accents", () => {
    const { records, skipped } = convertRows(
        [makeRow({ account: "banorte debito" })],
        sampleMaps(),
    );
    assert.equal(skipped.length, 0);
    assert.equal(records[0].accountId, "-Account_banorte");
});

test("convertRows resolves the currency for a tolerantly-matched account", () => {
    const { records, skipped } = convertRows(
        [makeRow({ account: "banorte debito" })],
        sampleMaps(),
    );
    assert.equal(skipped.length, 0);
    assert.equal(records[0].currencyId, "-Currency_mxn");
});

test("convertRows does not tolerantly resolve an ambiguous normalized name", () => {
    // "Café" and "Cafe" both normalize to "cafe" — two distinct real accounts
    // collapsing to the same key must not be guessed.
    const maps = sampleMaps({
        accounts: {
            "Banorte débito": "-Account_banorte",
            "Café": "-Account_cafe1",
            "Cafe": "-Account_cafe2",
        },
        accountCurrencies: {
            "Banorte débito": "-Currency_mxn",
            "Café": "-Currency_mxn",
            "Cafe": "-Currency_mxn",
        },
    });
    const { records, skipped } = convertRows(
        [makeRow({ account: "CAFE" })],
        maps,
    );
    assert.equal(records.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /Unknown account/);
});

test("convertRows suggests a close category name in the skip reason", () => {
    const { records, skipped } = convertRows(
        [makeRow({ category: "Restarant" })],
        sampleMaps(),
    );
    assert.equal(records.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /did you mean "Restaurant, fast-food"\?/);
});

// ── Transfer pair linking ──────────────────────────────────────────────────
//
// The old rule paired on the date string alone, and the statement-extraction
// prompt writes "12:00:00" whenever a statement gives no time — so two
// unrelated transfers on one day were linked to each other by construction.

function transferMaps(): LookupMaps {
    return sampleMaps({
        accounts: {
            "Banorte débito": "-Account_banorte",
            "Bancomer": "-Account_bancomer",
            "Costco": "-Account_costco",
            "Stocks": "-Account_stocks",
        },
        accountCurrencies: {
            "Banorte débito": "-Currency_mxn",
            "Bancomer": "-Currency_mxn",
            "Costco": "-Currency_mxn",
            "Stocks": "-Currency_mxn",
        },
    });
}

/** A transfer row: same date for every leg, as a statement without times gives. */
function leg(account: string, amount: string, date = "2026-07-01 12:00:00"): CsvRow {
    return makeRow({ date, account, amount, category: "Transfer, withdraw" });
}

/** The pair a record belongs to, as written: [transferId, otherAccountId]. */
function link(record: { transferId?: string; transferAccountId?: string }) {
    return [record.transferId, record.transferAccountId];
}

test("convertRows links a clean transfer pair both ways", () => {
    const { records, skipped } = convertRows(
        [leg("Banorte débito", "-3268.48"), leg("Bancomer", "3268.48")],
        transferMaps(),
    );

    assert.equal(skipped.length, 0, "una pareja limpia no se salta");
    assert.equal(records.length, 2);

    const [out, income] = records;
    assert.equal(out.type, 1, "la fila negativa es salida de dinero");
    assert.equal(income.type, 0, "la fila positiva es entrada de dinero");
    assert.ok(out.transferId, "la pata de salida lleva transferId");
    assert.equal(out.transferId, income.transferId, "ambas patas comparten el mismo transferId");
    assert.equal(out.transferAccountId, "-Account_bancomer");
    assert.equal(income.transferAccountId, "-Account_banorte");
    assert.equal(out.transfer, true);
    assert.equal(income.transfer, true);
});

test("convertRows keeps two interleaved same-date transfers apart", () => {
    // A-out, B-out, A-in, B-in — the exact order that used to link A-out to
    // B-out and leave each record pointing at the wrong account.
    const { records, skipped } = convertRows(
        [
            leg("Banorte débito", "-1000"),
            leg("Costco", "-250.50"),
            leg("Bancomer", "1000"),
            leg("Stocks", "250.50"),
        ],
        transferMaps(),
    );

    assert.equal(skipped.length, 0, "las cuatro patas se emparejan");
    assert.equal(records.length, 4);

    const [aOut, bOut, aIn, bIn] = records;
    assert.equal(aOut.transferId, aIn.transferId, "los mil pesos van juntos");
    assert.equal(bOut.transferId, bIn.transferId, "los 250.50 van juntos");
    assert.notEqual(aOut.transferId, bOut.transferId, "las dos transferencias no comparten id");

    assert.deepEqual(link(aOut), [aOut.transferId, "-Account_bancomer"]);
    assert.deepEqual(link(aIn), [aOut.transferId, "-Account_banorte"]);
    assert.deepEqual(link(bOut), [bOut.transferId, "-Account_stocks"]);
    assert.deepEqual(link(bIn), [bOut.transferId, "-Account_costco"]);
});

test("convertRows pairs two same-date transfers of the same amount deterministically", () => {
    const rows = [
        leg("Banorte débito", "-500"),
        leg("Costco", "-500"),
        leg("Bancomer", "500"),
        leg("Stocks", "500"),
    ];

    const first = convertRows(rows, transferMaps());
    assert.equal(first.skipped.length, 0, "cuatro patas iguales siguen emparejando");
    assert.equal(first.records.length, 4);

    // Earliest usable counterpart wins, so the CSV order decides the pairs.
    assert.equal(first.records[0].transferAccountId, "-Account_bancomer");
    assert.equal(first.records[2].transferAccountId, "-Account_banorte");
    assert.equal(first.records[1].transferAccountId, "-Account_stocks");
    assert.equal(first.records[3].transferAccountId, "-Account_costco");

    // Same input, same pairing — the transferId changes, the partners never do.
    const second = convertRows(rows, transferMaps());
    assert.deepEqual(
        second.records.map((r) => r.transferAccountId),
        first.records.map((r) => r.transferAccountId),
        "la elección de pareja es determinista",
    );
});

test("convertRows skips a transfer leg with no counterpart", () => {
    const { records, skipped } = convertRows(
        [leg("Banorte débito", "-3268.48"), makeRow({ amount: "-90" })],
        transferMaps(),
    );

    assert.equal(records.length, 1, "sólo sobrevive el gasto normal");
    assert.equal(records[0].transfer, false);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].row.account, "Banorte débito");
    assert.match(skipped[0].reason, /no matching leg/);
});

test("convertRows never links two legs of the same sign", () => {
    // Two withdrawals on one day. They share a date and an amount and used to
    // be linked to each other, producing a transfer with no incoming side.
    const { records, skipped } = convertRows(
        [leg("Banorte débito", "-3268.48"), leg("Bancomer", "-3268.48")],
        transferMaps(),
    );

    assert.equal(records.length, 0, "ninguna salida se escribe sin su entrada");
    assert.equal(skipped.length, 2);
    for (const s of skipped) assert.match(s.reason, /outgoing/);
});

test("convertRows refuses a transfer whose two legs name the same account", () => {
    const { records, skipped } = convertRows(
        [leg("Banorte débito", "-750"), leg("Banorte débito", "750")],
        transferMaps(),
    );

    assert.equal(records.length, 0, "un movimiento no se transfiere a sí mismo");
    assert.equal(skipped.length, 2);
    for (const s of skipped) assert.match(s.reason, /same account/);
});

test("convertRows leaves the third leg of an amount unpaired", () => {
    const { records, skipped } = convertRows(
        [leg("Banorte débito", "-400"), leg("Bancomer", "400"), leg("Costco", "400")],
        transferMaps(),
    );

    assert.equal(records.length, 2, "una pata sólo se consume una vez");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].row.account, "Costco", "la tercera pata es la que sobra");

    const [out, income] = records;
    assert.equal(out.transferId, income.transferId);
    assert.equal(out.transferAccountId, "-Account_bancomer");
    assert.equal(income.transferAccountId, "-Account_banorte");
});

test("convertRows does not pair legs of different amounts on the same date", () => {
    const { records, skipped } = convertRows(
        [leg("Banorte débito", "-1000"), leg("Bancomer", "999.99")],
        transferMaps(),
    );

    assert.equal(records.length, 0, "una diferencia de un centavo no es la misma transferencia");
    assert.equal(skipped.length, 2);
});

test("convertRows does not pair legs on different dates", () => {
    const { records, skipped } = convertRows(
        [
            leg("Banorte débito", "-1000", "2026-07-01 12:00:00"),
            leg("Bancomer", "1000", "2026-07-02 12:00:00"),
        ],
        transferMaps(),
    );

    assert.equal(records.length, 0, "la misma fecha sigue siendo obligatoria");
    assert.equal(skipped.length, 2);
});

test("convertRows keeps the surviving records aligned with their source rows", () => {
    const { records, originalRows, skipped } = convertRows(
        [
            makeRow({ amount: "-10", note: "cafe" }),
            leg("Banorte débito", "-1000"),
            makeRow({ amount: "-20", note: "taxi" }),
            leg("Bancomer", "1000"),
            makeRow({ amount: "-30", note: "pan" }),
            leg("Costco", "-77"),
        ],
        transferMaps(),
    );

    assert.equal(skipped.length, 1, "sólo la pata huérfana se salta");
    assert.equal(records.length, 5);
    assert.equal(originalRows.length, records.length);
    for (let i = 0; i < records.length; i++) {
        assert.equal(records[i].note, originalRows[i].note?.trim() ?? "", `fila ${i} desalineada`);
        assert.equal(records[i].amount, Math.round(Math.abs(parseFloat(originalRows[i].amount)) * 100));
    }
});

// ── Statement columns survive a round trip ────────────────────────────────

test("rowsToCsv keeps the statement columns", () => {
  // The bot re-parses the block it pasted when a proposal is confirmed. A
  // marker dropped here is a later instalment written that should never have
  // been, and a first one written at the instalment price instead of the
  // purchase's.
  const row = {
    date: "2026-07-05 12:00:00", account: "Costco", amount: "-5480.00",
    category: "Electronics", note: "[Claude reconcile 2026-07]", payee: "MERCADO PAGO",
    opdate: "2026-06-04", meses: "1/6", montooriginal: "32880.00",
    desc: "MERPAGO*SAMSUNG 001 de 006", mxn: "", efectivo: "",
  };
  const back = parseCsv(rowsToCsv([row]))[0];
  assert.equal(back.meses, "1/6");
  assert.equal(back.montooriginal, "32880.00");
  assert.equal(back.opdate, "2026-06-04");
  assert.equal(back.desc, "MERPAGO*SAMSUNG 001 de 006");
});

test("the two legs of a cross-currency transfer link on the published peso figure", () => {
  // DolarApp records 9,300 USD for the movement Bancomer records as
  // 163,202.91 MXN. Bucketing on the face amount puts them in different
  // buckets, so both were left over and neither was written.
  const maps: LookupMaps = {
    accounts: { DolarApp: "-Account_usd", Bancomer: "-Account_mxn" },
    accountCurrencies: { DolarApp: "-Currency_usd", Bancomer: "-Currency_mxn" },
    categories: { "Transfer, withdraw": "-Category_transfer" },
    currencies: { USD: "-Currency_usd", MXN: "-Currency_mxn" },
    transferCategoryId: "-Category_transfer",
    labels: {},
  };
  const { records, skipped } = convertRows([
    {
      date: "2026-07-01 12:00:00", account: "DolarApp", amount: "-9300.00",
      category: "Transfer, withdraw", note: "", payee: "Marco Mayen", mxn: "-163202.91",
    },
    {
      date: "2026-07-01 12:00:00", account: "Bancomer", amount: "163202.91",
      category: "Transfer, withdraw", note: "", payee: "PIER 5, S.A de C.V.",
    },
  ], maps);
  assert.equal(skipped.length, 0);
  assert.equal(records.length, 2);
  assert.ok(records[0].transferId);
  assert.equal(records[0].transferId, records[1].transferId);
  // Each leg keeps the amount its own account is denominated in.
  assert.equal(records[0].amount, 930000);
  assert.equal(records[1].amount, 16320291);
});

test("without a published equivalent the cross-currency legs are left unpaired", () => {
  // The rate is not ours to invent, and two amounts that have nothing to do
  // with each other must not be linked on a shared date.
  const maps: LookupMaps = {
    accounts: { DolarApp: "-Account_usd", Bancomer: "-Account_mxn" },
    accountCurrencies: { DolarApp: "-Currency_usd", Bancomer: "-Currency_mxn" },
    categories: { "Transfer, withdraw": "-Category_transfer" },
    currencies: { USD: "-Currency_usd", MXN: "-Currency_mxn" },
    transferCategoryId: "-Category_transfer",
    labels: {},
  };
  const { records, skipped } = convertRows([
    { date: "2026-07-01 12:00:00", account: "DolarApp", amount: "-9300.00", category: "Transfer, withdraw", note: "", payee: "" },
    { date: "2026-07-01 12:00:00", account: "Bancomer", amount: "163202.91", category: "Transfer, withdraw", note: "", payee: "" },
  ], maps);
  assert.equal(records.length, 0);
  assert.equal(skipped.length, 2);
});

test("two legs the crossing paired link even when the bank dated them differently", () => {
  // Bancomer sent $50,187.53 on 15-jun and Banorte débito received it on
  // 13-jun. One movement by every measure except the identical date string
  // `linkTransferPairs` used to demand — both legs were refused and the month
  // would not write.
  const maps: LookupMaps = {
    accounts: { Bancomer: "-Account_bbva", "Banorte débito": "-Account_banorte" },
    accountCurrencies: { Bancomer: "-Currency_mxn", "Banorte débito": "-Currency_mxn" },
    categories: { "Transfer, withdraw": "-Category_transfer" },
    currencies: { MXN: "-Currency_mxn" },
    transferCategoryId: "-Category_transfer",
    labels: {},
  };
  const key = "Bancomer|2026-06-15|-5018753~Banorte débito|2026-06-13|5018753";
  const { records, skipped } = convertRows([
    { date: "2026-06-15 12:00:00", account: "Bancomer", amount: "-50187.53", category: "Transfer, withdraw", note: "", payee: "Banorte", pareja: key },
    { date: "2026-06-13 12:00:00", account: "Banorte débito", amount: "50187.53", category: "Transfer, withdraw", note: "", payee: "Bancomer", pareja: key },
  ], maps);
  assert.equal(skipped.length, 0);
  assert.ok(records[0].transferId);
  assert.equal(records[0].transferId, records[1].transferId);
  assert.equal(records[0].transferAccountId, "-Account_banorte");
  assert.equal(records[1].transferAccountId, "-Account_bbva");
});

test("a pair key does not link two legs of the same account", () => {
  // A transfer has two accounts by definition; a shared key is not licence to
  // merge two movements that never left one.
  const maps: LookupMaps = {
    accounts: { Bancomer: "-Account_bbva" },
    accountCurrencies: { Bancomer: "-Currency_mxn" },
    categories: { "Transfer, withdraw": "-Category_transfer" },
    currencies: { MXN: "-Currency_mxn" },
    transferCategoryId: "-Category_transfer",
    labels: {},
  };
  const { records, skipped } = convertRows([
    { date: "2026-06-15 12:00:00", account: "Bancomer", amount: "-100.00", category: "Transfer, withdraw", note: "", payee: "", pareja: "k" },
    { date: "2026-06-13 12:00:00", account: "Bancomer", amount: "100.00", category: "Transfer, withdraw", note: "", payee: "", pareja: "k" },
  ], maps);
  assert.equal(records.length, 0);
  assert.equal(skipped.length, 2);
});
