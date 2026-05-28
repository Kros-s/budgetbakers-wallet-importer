/**
 * @file couch.ts
 * @description CouchDB client factory and runtime lookup fetchers.
 *
 * ## Auth
 * Every CouchDB request uses HTTP Basic auth derived from the `replication`
 * block in `user.getUser`:
 *   Authorization: Basic base64("<replication.login>:<replication.token>")
 *
 * ## Database URL
 *   https://couch-prod-eu-2.budgetbakers.com/bb-{userId}/
 *
 * ## Document key prefixes (confirmed)
 *   -Account_   → account documents
 *   -Category_  → category documents
 *   -Currency_  → currency documents
 *   Record_     → transaction records
 */

import axios, { type AxiosInstance } from "axios";
import { WEB_ORIGIN } from "./auth.js";
import type {
  AccountDoc,
  CategoryDoc,
  CurrencyDoc,
  LabelDoc,
  LookupData,
  LookupMaps,
  ReplicationConfig,
} from "./types.js";

/**
 * Builds an Axios instance pre-configured with Basic auth for CouchDB.
 * baseURL is set to the user's personal database root, so all paths are relative.
 */
export function buildCouchClient(rep: ReplicationConfig): AxiosInstance {
  const credentials = Buffer.from(`${rep.login}:${rep.token}`).toString("base64");
  return axios.create({
    baseURL: `${rep.url}/${rep.dbName}`,
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: WEB_ORIGIN,
      Referer: `${WEB_ORIGIN}/`,
    },
  });
}

/**
 * Generic helper — fetches all CouchDB documents whose `_id` starts with
 * `prefix` using `_all_docs` with a startkey/endkey range query.
 *
 * Uses GET with query params because CouchDB's `_all_docs` only recognises
 * `startkey`/`endkey` from the URL; passing them in the body of a POST is
 * silently ignored and the entire database is returned. That manifested
 * as the "Pluxee" account name being shadowed by a `-StandingOrder_` doc
 * sharing the same name, so records imported with `account: "Pluxee"`
 * landed in the cash "Wallet" fallback (since the StandingOrder id is not
 * a valid accountId in the records collection).
 *
 * `startkey`/`endkey` must be JSON-encoded (CouchDB requires quotes
 * around string keys in query params).
 */
async function fetchDocsWithPrefix<T>(
  couch: AxiosInstance,
  prefix: string
): Promise<T[]> {
  const res = await couch.get<{ rows: Array<{ doc: T }> }>(
    "/_all_docs",
    {
      params: {
        include_docs: true,
        startkey: JSON.stringify(prefix),
        endkey: JSON.stringify(`${prefix}\uffff`),
      },
    }
  );
  return res.data.rows.map((r) => r.doc).filter(Boolean);
}

/**
 * Fetches all account documents from CouchDB, sorted by `position`.
 *
 * @example
 * const accounts = await fetchAccounts(couch);
 * // [{ _id: "-Account_15230f1e-...", name: "First Bank", ... }, ...]
 */
export async function fetchAccounts(couch: AxiosInstance): Promise<AccountDoc[]> {
  const docs = await fetchDocsWithPrefix<AccountDoc>(couch, "-Account_");
  return docs.sort((a, b) => a.position - b.position);
}

/**
 * Fetches all category documents from CouchDB.
 * Categories with an empty `name` are system categories and are excluded.
 */
export async function fetchCategories(couch: AxiosInstance): Promise<CategoryDoc[]> {
  const docs = await fetchDocsWithPrefix<CategoryDoc>(couch, "-Category_");
  return docs.filter((d) => d.name?.trim());
}

/**
 * Fetches all currency documents from CouchDB.
 */
export async function fetchCurrencies(couch: AxiosInstance): Promise<CurrencyDoc[]> {
  return fetchDocsWithPrefix<CurrencyDoc>(couch, "-Currency_");
}

/**
 * Fetches all label (HashTag) documents from CouchDB, excluding archived ones.
 */
export async function fetchLabels(couch: AxiosInstance): Promise<LabelDoc[]> {
  const docs = await fetchDocsWithPrefix<LabelDoc>(couch, "-HashTag_");
  return docs.filter((d) => !d.archived && d.name?.trim());
}

/**
 * Fetches the raw lookup documents needed by the importer in one batch.
 */
export async function fetchLookupData(couch: AxiosInstance): Promise<LookupData> {
  const [accounts, categories, currencies, labels] = await Promise.all([
    fetchAccounts(couch),
    fetchCategories(couch),
    fetchCurrencies(couch),
    fetchLabels(couch),
  ]);

  return { accounts, categories, currencies, labels };
}

/**
 * Fetches accounts, categories, and currencies in parallel and returns
 * runtime lookup maps.
 *
 * - `accounts`   — account name → full `-Account_<uuid>`
 * - `accountCurrencies` — account name → full `-Currency_<uuid>` (derived
 *                  from the account's own `currencyId` field, so the user
 *                  never needs to specify currency in the CSV)
 * - `categories` — category name → full `-Category_<uuid>` (names match
 *                  CouchDB exactly — user types what they see in the app)
 * - `currencies` — ISO 4217 code → full `-Currency_<uuid>` (kept for
 *                  reference / edge cases)
 * - `transferCategoryId` — the `-Category_<uuid>` for "Transfer, withdraw",
 *                  used by csv.ts to detect transfer rows without relying on
 *                  a hardcoded id
 *
 * @example
 * const maps = await buildLookupMaps(couch);
 * maps.accounts["First Bank"]          // "-Account_15230f1e-..."
 * maps.accountCurrencies["First Bank"] // "-Currency_38481cb0-..." (NGN)
 * maps.categories["Charges, Fees"]     // "-Category_8013274a-..."
 * maps.transferCategoryId              // "-Category_16b2df8a-..."
 */
export function buildLookupMapsFromData(data: LookupData): LookupMaps {
  const { accounts, categories, currencies } = data;

  // currency code → full -Currency_<uuid>
  const currencyMap: Record<string, string> = {};
  for (const c of currencies) {
    currencyMap[c.code] = c._id;  // "NGN" → "-Currency_..."
  }

  const accountMap: Record<string, string> = {};
  const accountCurrencyMap: Record<string, string> = {};
  for (const a of accounts) {
    accountMap[a.name] = a._id;          // full "-Account_<uuid>"
    accountCurrencyMap[a.name] = a.currencyId;   // already a full "-Currency_<uuid>"
  }

  const categoryMap: Record<string, string> = {};
  for (const c of categories) {
    categoryMap[c.name] = c._id; // full "-Category_<uuid>"
  }

  const labelMap: Record<string, string> = {};
  for (const l of data.labels) {
    labelMap[l.name] = l._id;  // "Sentra" → "-HashTag_<uuid>"
  }

  // The transfer category is looked up by name at runtime — no hardcoding.
  const transferCategoryId = categoryMap["Transfer, withdraw"] ?? null;

  return {
    accounts: accountMap,
    accountCurrencies: accountCurrencyMap,
    categories: categoryMap,
    currencies: currencyMap,
    transferCategoryId,
    labels: labelMap,
  };
}

/**
 * Convenience wrapper used by existing callers that only need maps.
 */
export async function buildLookupMaps(couch: AxiosInstance): Promise<LookupMaps> {
  const data = await fetchLookupData(couch);
  return buildLookupMapsFromData(data);
}
