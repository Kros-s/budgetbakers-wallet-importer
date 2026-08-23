/**
 * @file csv.ts
 * @description Parser for the custom BudgetBakers importer CSV format.
 *
 * ## Custom format (simpler than the official Wallet export)
 *
 * ```csv
 * date,account,amount,category,note,payee
 * 2026-01-27 02:31:00,First Bank,-53.75,Charges & Fees,Stamp Duty,
 * 2026-01-29 13:33:00,First Bank,-300000,Transfer,,
 * 2026-01-29 13:33:00,Palmpay,300000,Transfer,,
 * 2026-02-10 11:25:00,First Bank,300000,Wage & invoices,,Company XYZ
 * ```
 *
 * ### Columns
 * | Column     | Required | Notes                                              |
 * |------------|----------|----------------------------------------------------|
 * | `date`     | yes      | `YYYY-MM-DD HH:MM:SS` — interpreted as local time  |
 * | `account`  | yes      | Exact account name as it appears in the app        |
 * | `amount`   | yes      | Signed float. Negative = expense, positive = income|
 * | `category` | yes      | Exact app category name, except transfer aliases   |
 * | `note`     | no       | Free text                                          |
 * | `payee`    | no       | Stored as a separate field, not embedded in note   |
 *
 * ### What you don't need to specify
 * - **Currency** — derived from the account's own currency at runtime
 * - **Transfer flag** — detected when category is "Transfer, withdraw" (or
 *   whatever the user named it) AND both rows share the same timestamp
 * - **Payment type** — derived from category: transfer rows → 3, others → 0
 * - **Type (income/expense)** — derived from the sign of `amount`
 *
 * ### Transfer pair rules
 * Two rows form a transfer pair when ALL of:
 *   1. Both have the same category that maps to the "Transfer, withdraw" id
 *   2. Both share the exact same `date` string
 *   3. Both carry the same unsigned amount
 *   4. Their signs are opposite — one leaves an account, one arrives
 *   5. Their accounts differ
 * The pair is linked via a shared `transferId` UUID, with each leg pointing
 * to the other's account in `transferAccountId`. A row that satisfies 1 but
 * finds no counterpart satisfying the rest is skipped, not linked to whatever
 * else shares its date. That includes a cross-currency transfer, whose two
 * legs never carry the same figure: it has to be paired by hand, which beats
 * inventing a pair out of two amounts that have nothing to do with each other.
 */

import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { toLocalIsoDateTime } from "./date-time.js";
import { RECORD_TYPE, PAYMENT_TYPE } from "./records.js";
import type { LookupMaps, NewRecord } from "./types.js";

/** Raw row shape after csv-parse with `columns: true`. */
export interface CsvRow {
  /**
   * When the money moved — the posting/charge date. This is the one Wallet is
   * matched on, because it is also the date the bank's own totals are built
   * from and the date an instalment actually hits.
   */
  date: string;
  account: string;
  amount: string;
  category: string;
  note: string;
  payee: string;
  label?: string;
  /**
   * When the purchase happened, for statements that publish both columns
   * (Banorte Crédito prints "Fecha de la operación" beside "Fecha de cargo").
   *
   * Usually a day before the charge, which the matcher's slack already covers.
   * It matters at the edges of the month — a purchase on the 30th charged on
   * the 2nd belongs to one statement and is recorded in Wallet under the other
   * date — and it matters for instalments, where the two are a month or more
   * apart: "MERPAGO*SAMSUNG 03/03" was operated 09-ene and charged 10-feb.
   */
  opdate?: string;
  /**
   * Instalment marker as the statement prints it, "4/6" — Banamex writes
   * "004 de 006" on the movement line, Banorte "03/03" after the description.
   *
   * Taken from the statement's own column, never guessed from the description:
   * a payee ending in "12/25" is a date far more often than an instalment.
   */
  meses?: string;
  /**
   * The full price of a deferred purchase, from the statement's deferred
   * section ("Original"), present on the first instalment only. A $32,880
   * purchase in six shows $5,480 on the movement line and the full figure here.
   */
  montooriginal?: string;
}

/** A row that could not be converted, with a reason. */
export interface SkippedRow {
  row: CsvRow;
  reason: string;
}

/** Result from `convertRows`. */
export interface ParseResult {
  records: NewRecord[];
  /**
   * The original CSV row for each record, in the same order.
   * `originalRows[i]` is the source row for `records[i]`.
   * Used by cli.ts to write `_success.csv` and `_failure.csv`.
   */
  originalRows: CsvRow[];
  skipped: SkippedRow[];
}

/** The header for our custom CSV format. */
export const CSV_HEADER = ["date", "account", "amount", "category", "note", "payee", "label"] as const;

/**
 * Transfer rows are a special case: we accept common aliases and map them
 * to the runtime "Transfer, withdraw" category id when available.
 */
function isTransferCategoryAlias(category: string): boolean {
  const normalized = category
    .trim()
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();

  return normalized === "transfer" || normalized === "transfer withdraw";
}

/**
 * Normalizes a name for tolerant matching: lowercase, strip accents, collapse
 * any run of non-alphanumeric characters to a single space, trim.
 * e.g. "Restaurant, fast-food" and "Restaurant fast food" both become
 * "restaurant fast food".
 */
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A tolerant lookup index: normalized key → canonical name + id, or "ambiguous". */
interface ToleranceEntry {
  canonicalName: string;
  id: string;
}
type ToleranceIndex = Map<string, ToleranceEntry | "ambiguous">;

/** Per-`maps` cache of tolerant indexes, keyed by the source Record so we don't rebuild per call. */
const toleranceIndexCache = new WeakMap<Record<string, string>, ToleranceIndex>();

/** Builds (or reuses the cached) normalized index for a name→id map. */
function getToleranceIndex(source: Record<string, string>): ToleranceIndex {
  const cached = toleranceIndexCache.get(source);
  if (cached) return cached;

  const index: ToleranceIndex = new Map();
  for (const [name, id] of Object.entries(source)) {
    const key = normalizeName(name);
    const existing = index.get(key);
    if (existing === undefined) {
      index.set(key, { canonicalName: name, id });
    } else if (existing === "ambiguous") {
      // already marked ambiguous, nothing to do
    } else if (existing.canonicalName !== name) {
      // two distinct names collide when normalized — don't guess, mark ambiguous
      index.set(key, "ambiguous");
    }
  }

  toleranceIndexCache.set(source, index);
  return index;
}

/**
 * Resolves `name` against `source` first by exact match, then — if that
 * fails — by normalized match (accents/case/punctuation-insensitive).
 * Returns the canonical name actually matched (so callers can look up
 * related maps, e.g. `accountCurrencies`, using the same key) plus the id.
 */
function resolveTolerant(
  name: string,
  source: Record<string, string>,
): { canonicalName: string; id: string } | undefined {
  const exact = source[name];
  if (exact) return { canonicalName: name, id: exact };

  const index = getToleranceIndex(source);
  const entry = index.get(normalizeName(name));
  if (entry === undefined || entry === "ambiguous") return undefined;
  return entry;
}

/**
 * Returns up to `limit` candidate names from `source` that look close to
 * `name` — same normalized prefix, or a small edit distance. Cheap, no deps.
 */
function suggestCandidates(name: string, source: Record<string, string>, limit = 3): string[] {
  const target = normalizeName(name);
  if (!target) return [];

  // Multi-word category/account names (e.g. "restaurant fast food") are
  // compared word-by-word too, so a typo like "Restarant" still gets close
  // to the "restaurant" token even though the full strings differ a lot.
  const threshold = Math.max(2, Math.ceil(target.length * 0.34));

  const candidates = Object.keys(source);
  const scored = candidates
    .map((candidate) => {
      const normalizedCandidate = normalizeName(candidate);
      const words = normalizedCandidate.split(" ");
      const samePrefix = normalizedCandidate.startsWith(target)
        || target.startsWith(normalizedCandidate)
        || words.some((w) => w.startsWith(target) || target.startsWith(w));
      const distance = Math.min(
        levenshtein(target, normalizedCandidate),
        ...words.map((w) => levenshtein(target, w)),
      );
      return { candidate, samePrefix, distance };
    })
    .filter(({ samePrefix, distance }) => samePrefix || distance <= threshold)
    .sort((a, b) => {
      if (a.samePrefix !== b.samePrefix) return a.samePrefix ? -1 : 1;
      return a.distance - b.distance;
    });

  return scored.slice(0, limit).map(({ candidate }) => candidate);
}

/** Small, dependency-free Levenshtein distance for close-match suggestions. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prevRow = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const currRow = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow.push(Math.min(currRow[j - 1] + 1, prevRow[j] + 1, prevRow[j - 1] + cost));
    }
    prevRow = currRow;
  }
  return prevRow[n];
}

/** Formats a "did you mean" suffix from candidate names, or "" if none. */
function suggestionSuffix(candidates: string[]): string {
  if (candidates.length === 0) return "";
  const quoted = candidates.map((c) => `"${c}"`).join(", ");
  return ` — did you mean ${quoted}?`;
}

/**
 * Parses the custom importer CSV string into raw row objects.
 * Strips the UTF-8 BOM and skips blank lines.
 */
export function parseCsv(content: string): CsvRow[] {
  return parse(content.replace(/^\uFEFF/, ""), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as CsvRow[];
}

/**
 * Converts a date string from the custom format to full ISO-8601.
 *
 * The CSV value is treated as local wall-clock time so the app shows the
 * same hour the user entered.
 *
 * Input:  `"2026-01-27 02:31:00"`
 * Output: `"2026-01-27T02:31:00.000+01:00"` (offset varies by machine/date)
 */
export function toIso(date: string): string {
  return toLocalIsoDateTime(date);
}

/**
 * Serialises a list of CsvRow objects back to a CSV string with header.
 * Used when writing `_success.csv` and `_failure.csv`.
 */
export function rowsToCsv(rows: CsvRow[]): string {
  if (rows.length === 0) return CSV_HEADER.join(",") + "\n";
  return stringify(rows, { header: true, columns: CSV_HEADER as unknown as string[] });
}

/**
 * Serialises skipped rows (with their failure reason) to a CSV string.
 * Adds a `reason` column so the user knows exactly what went wrong.
 */
export function skippedRowsToCsv(skipped: SkippedRow[]): string {
  const columns = [...CSV_HEADER, "reason"];
  if (skipped.length === 0) return columns.join(",") + "\n";
  const data = skipped.map(({ row, reason }) => ({ ...row, reason }));
  return stringify(data, { header: true, columns });
}

/** A transfer leg waiting to be paired, with everything the pairing needs. */
interface TransferLeg {
  /** Index into the `records` array being built. */
  index: number;
  /** The row's `date` column, trimmed. Legs only pair within the same date. */
  dateKey: string;
  /** Unsigned cents, exactly as the record stores it. */
  amount: number;
  /** RECORD_TYPE.EXPENSE (1) = money out, RECORD_TYPE.INCOME (0) = money in. */
  type: 0 | 1;
  accountId: string;
  /** The account as the CSV named it, for the skip reason. */
  accountName: string;
}

/** A leg that found no counterpart, and why. */
interface UnpairedLeg {
  index: number;
  reason: string;
}

/** Explains, in the row's own terms, why this leg was left over. */
function unpairedReason(leg: TransferLeg, bucket: TransferLeg[]): string {
  const amount = (leg.amount / 100).toFixed(2);
  const opposite = bucket.filter((l) => l.type !== leg.type);

  if (opposite.length > 0 && opposite.every((l) => l.accountId === leg.accountId)) {
    return `Transfer row at "${leg.dateKey}" for ${amount} finds its only counterpart on the same account `
      + `"${leg.accountName}" — a transfer moves money between two different accounts`;
  }

  const direction = leg.type === RECORD_TYPE.EXPENSE ? "outgoing" : "incoming";
  return `Transfer row at "${leg.dateKey}" for ${amount} (${direction}) has no matching leg — a pair needs `
    + `the same date, the same amount, opposite signs and two different accounts`;
}

/**
 * Links transfer legs in pairs and hands back the ones left over.
 *
 * The date string alone used to be the entire rule, which is why this function
 * exists. The statement-extraction prompt writes `12:00:00` whenever a
 * statement publishes no time, so every transfer on a given day carries the
 * identical date string: the second transfer row of the day was linked to the
 * first, whatever it was. Two unrelated transfers on one date came out sharing
 * a `transferId`, each pointing at the other's account and both possibly the
 * same sign — the shape of the $323,000 CETES withdrawal booked as an expense
 * that `batch/integrity.ts` was written to catch after the fact.
 *
 * Nothing here widens the same-date requirement; it only adds the three checks
 * that make "same date" mean one movement instead of one day.
 */
function linkTransferPairs(records: NewRecord[], legs: TransferLeg[]): UnpairedLeg[] {
  // Same date + same unsigned amount is the only bucket in which two legs may
  // meet. Buckets and their contents stay in CSV order, which is what makes the
  // choice below deterministic: interleaved rows (A-out, B-out, A-in, B-in)
  // fall into separate buckets by amount, and inside a bucket the earliest
  // usable counterpart always wins, so the same CSV always pairs the same way.
  const buckets = new Map<string, TransferLeg[]>();
  for (const leg of legs) {
    const key = `${leg.dateKey}|${leg.amount}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(leg);
    else buckets.set(key, [leg]);
  }

  const paired = new Set<number>();
  for (const bucket of buckets.values()) {
    const ins = bucket.filter((l) => l.type === RECORD_TYPE.INCOME);

    for (const out of bucket) {
      if (out.type !== RECORD_TYPE.EXPENSE) continue;

      // `paired` is what keeps a leg from being consumed twice: with three legs
      // of one amount the third has no partner left and must stay unpaired,
      // rather than reusing a leg that already belongs to a finished pair.
      // The account check refuses an equal-sized in and out on the SAME
      // account — that is two unrelated movements, not a transfer.
      const partner = ins.find((l) => !paired.has(l.index) && l.accountId !== out.accountId);
      if (!partner) continue;

      paired.add(out.index);
      paired.add(partner.index);

      const sharedTransferId = crypto.randomUUID();
      const outRecord = records[out.index];
      const inRecord = records[partner.index];

      outRecord.transferId = sharedTransferId;
      outRecord.transferAccountId = inRecord.accountId;
      inRecord.transferId = sharedTransferId;
      inRecord.transferAccountId = outRecord.accountId;
    }
  }

  const unpaired: UnpairedLeg[] = [];
  for (const bucket of buckets.values()) {
    for (const leg of bucket) {
      if (paired.has(leg.index)) continue;
      unpaired.push({ index: leg.index, reason: unpairedReason(leg, bucket) });
    }
  }

  return unpaired.sort((a, b) => a.index - b.index);
}

/**
 * Converts parsed CSV rows to `NewRecord` objects using runtime lookup maps.
 *
 * Resolution logic:
 * - `accountId`   — maps.accounts[row.account]         (full -Account_ id)
 * - `currencyId`  — maps.accountCurrencies[row.account] (no CSV column needed)
 * - `categoryId`  — maps.categories[row.category]      (full -Category_ id)
 * - `type`        — sign of amount: negative → EXPENSE, positive → INCOME
 * - `paymentType` — transfer rows → TRANSFER (3), everything else → CASH (0)
 * - `transfer`    — true when categoryId === maps.transferCategoryId
 *
 * Transfer pair linking:
 * - Pairs identified by: same category (transfer) + same date string + same
 *   unsigned amount + opposite signs + two different accounts
 * - Each pair gets a shared `transferId` UUID; each leg gets the other's
 *   accountId in `transferAccountId`
 * - Every leg that finds no such counterpart goes to `skipped`
 *
 * The returned `originalRows` array is parallel to `records` — index i in
 * `originalRows` is the source CSV row for `records[i]`. This allows cli.ts
 * to write success/failure output CSVs after the CouchDB write completes.
 */
export function convertRows(rows: CsvRow[], maps: LookupMaps): ParseResult {
  const records: NewRecord[] = [];
  const originalRows: CsvRow[] = [];
  const skipped: SkippedRow[] = [];

  // Transfer legs are collected here and paired once every row is converted:
  // a leg's counterpart may be any later row, and the pairing needs the amount,
  // the direction and the account of both sides before it can decide anything.
  const transferLegs: TransferLeg[] = [];

  for (const row of rows) {
    if (!row.date?.trim() || !row.account?.trim()) continue;

    // ── Resolve CouchDB ids ─────────────────────────────────────────────────
    // Account: exact match, then normalized (accent/case/punctuation-insensitive).
    // The canonical name the account resolved to is reused to look up its
    // currency, so a tolerant account match still finds the right currency.
    let accountId = maps.accounts[row.account];
    let accountCanonicalName = row.account;
    if (!accountId) {
      const resolved = resolveTolerant(row.account, maps.accounts);
      if (resolved) {
        accountId = resolved.id;
        accountCanonicalName = resolved.canonicalName;
      }
    }
    const currencyId = accountId ? maps.accountCurrencies[accountCanonicalName] : undefined;

    // Category: exact match, then transfer alias, then normalized match.
    const rawCategory = row.category?.trim() || "";
    let categoryId = maps.categories[rawCategory];

    if (!categoryId && maps.transferCategoryId !== null && isTransferCategoryAlias(rawCategory)) {
      categoryId = maps.transferCategoryId;
    }

    if (!categoryId) {
      const resolved = resolveTolerant(rawCategory, maps.categories);
      if (resolved) categoryId = resolved.id;
    }

    if (!accountId) {
      const suggestions = suggestCandidates(row.account, maps.accounts);
      skipped.push({ row, reason: `Unknown account: "${row.account}"${suggestionSuffix(suggestions)}` });
      continue;
    }
    if (!currencyId) {
      skipped.push({ row, reason: `No currency found for account: "${row.account}"` });
      continue;
    }
    if (!categoryId) {
      const suggestions = suggestCandidates(rawCategory, maps.categories);
      const suffix = suggestions.length > 0 ? suggestionSuffix(suggestions) : " — check app for exact name";
      skipped.push({ row, reason: `Unknown category: "${row.category}"${suffix}` });
      continue;
    }

    // ── Amount → minor units ────────────────────────────────────────────────
    const rawAmount = parseFloat(row.amount);
    if (isNaN(rawAmount)) {
      skipped.push({ row, reason: `Invalid amount: "${row.amount}"` });
      continue;
    }
    const amount = Math.round(Math.abs(rawAmount) * 100);

    // ── Derived fields ──────────────────────────────────────────────────────
    const type = rawAmount < 0 ? RECORD_TYPE.EXPENSE : RECORD_TYPE.INCOME;
    let recordDate: string;
    try {
      recordDate = toIso(row.date);
    } catch {
      skipped.push({
        row,
        reason: `Invalid date: "${row.date}" — expected a parseable local date/time`,
      });
      continue;
    }

    const isTransfer = maps.transferCategoryId !== null
      && categoryId === maps.transferCategoryId;

    const paymentType = isTransfer ? PAYMENT_TYPE.TRANSFER : PAYMENT_TYPE.CASH;

    const rawLabel = row.label?.trim() || "";
    let labelIds: string[] | undefined;
    if (rawLabel) {
      let labelId = maps.labels[rawLabel];
      if (!labelId) {
        const resolved = resolveTolerant(rawLabel, maps.labels);
        if (resolved) labelId = resolved.id;
      }
      if (!labelId) {
        const suggestions = suggestCandidates(rawLabel, maps.labels);
        const suffix = suggestions.length > 0 ? suggestionSuffix(suggestions) : " — check app for exact name";
        skipped.push({ row, reason: `Unknown label: "${rawLabel}"${suffix}` });
        continue;
      }
      labelIds = [labelId];
    }

    const record: NewRecord = {
      accountId,
      currencyId,
      categoryId,
      amount,
      type,
      note: row.note?.trim() || "",
      payee: row.payee?.trim() || undefined,
      recordDate,
      paymentType,
      transfer: isTransfer,
      labelIds,
    };

    // ── Transfer pair linking ───────────────────────────────────────────────
    if (isTransfer) {
      transferLegs.push({
        index: records.length,
        dateKey: row.date.trim(),
        amount,
        type,
        accountId,
        accountName: row.account.trim(),
      });
    }

    records.push(record);
    originalRows.push(row);
  }

  // Move any leg that found no counterpart to skipped. Half a transfer written
  // on its own is the orphan leg `statements/crossing.ts` goes hunting for, and
  // a leg linked to the wrong partner is worse still, so neither is written.
  const unpairedLegs = linkTransferPairs(records, transferLegs);
  for (const { index, reason } of unpairedLegs) {
    skipped.push({ row: originalRows[index], reason });
  }
  // Splice in reverse so removing one leg doesn't shift the index of the next.
  for (const { index } of [...unpairedLegs].reverse()) {
    records.splice(index, 1);
    originalRows.splice(index, 1);
  }

  return { records, originalRows, skipped };
}
