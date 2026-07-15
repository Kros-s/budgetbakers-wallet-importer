import test from "node:test";
import assert from "node:assert/strict";

import { toIso, convertRows, type CsvRow } from "../csv.js";
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
