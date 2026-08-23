/**
 * @file statements/guarded-write.ts
 * @description The last gate before statement rows become Wallet records.
 *
 * There are three paths that write to Wallet. Two of them — the email batch
 * (`cli/process-window.ts`) and the interactive bot — pass through the two
 * safeguards that exist: the duplicate gate against real Wallet records
 * (`batch/wallet-dedup.ts`) and the structural sanity check over what was
 * written (`batch/integrity.ts`). The statement path
 * (`cli/reconcile-statement.ts`) passes through neither: its own `diff()` is
 * the only thing standing between an extracted PDF and `writeRecords`.
 *
 * That is not merely an omission, it is an open duplicate path, because
 * `diff()` and the write disagree about the amount:
 *
 *   A first instalment is DIFFED at the amount the statement charged this
 *   period ($5,480 of a $32,880 purchase) and WRITTEN at the full purchase
 *   price ($32,880), because the user's rule is that a deferred purchase is
 *   recorded once, whole, in the month it was bought (see installments.ts).
 *   So the record that already exists in Wallet — written by an earlier
 *   reconcile run, or from the purchase's own email alert — is invisible to
 *   `diff()`: it is looking for $5,480 and Wallet holds $32,880. The row lands
 *   in `missing`, gets restated to the full price, and is written a second
 *   time.
 *
 * So this module deliberately runs its duplicate check AFTER conversion, on
 * the record that will actually be posted, not on the row that was matched.
 * It also checks both dates a statement publishes — the charge date and the
 * operation date — because for an instalment those are a month or more apart
 * and the existing record may be dated by either.
 *
 * Nothing here writes on its own initiative. `guardWrite` produces a verdict;
 * `commitGuardedWrite` refuses to act on a verdict that carries a serious
 * integrity alert. Discovering that a $323,000 movement was booked as a plain
 * expense is worth much more before the write than after it — after is what
 * happened on 2026-08-19.
 */

import type { AxiosInstance } from "axios";

import { checkRunIntegrity } from "../batch/integrity.js";
import type { IntegrityFinding, InspectedRecord } from "../batch/integrity.js";
import { matchesExisting } from "../batch/wallet-dedup.js";
import { convertRows } from "../csv.js";
import type { CsvRow, SkippedRow } from "../csv.js";
import { writeRecords } from "../records.js";
import type { BulkResult, LookupMaps, NewRecord, WalletRecord } from "../types.js";
import { splitForWriting } from "./installments.js";
import { expandCashWithdrawals } from "./cash.js";

/**
 * How far a proposal and an existing record may sit apart and still be the same
 * movement.
 *
 * Five days, not the batch path's 48 h. The batch compares email alerts, which
 * fire as the movement happens; a statement compares against a posting date,
 * and the measured operation-to-posting lag reaches five days at Banamex — the
 * same figure `reconcile-statement.ts` matches on and `period.ts` defers on.
 * At 48 h a purchase already recorded under its operation date would read as
 * new and be written again.
 */
export const STATEMENT_SLACK_MS = 5 * 24 * 60 * 60 * 1000;

/** Why a converted record is not going to be written. */
export type RejectionKind =
  /** An equivalent record already exists in Wallet. */
  | "wallet-duplicate"
  /** Its transfer counterpart in this same batch was rejected as a duplicate. */
  | "orphan-transfer-half";

export interface RejectedRecord {
  row: CsvRow;
  record: NewRecord;
  kind: RejectionKind;
  /** The Wallet record that answers for it — the reason it is not written. */
  existing: WalletRecord;
  reason: string;
}

/** A record cleared for writing, tied back to the statement row it came from. */
export interface GuardedRecord {
  /**
   * A stand-in id. These records do not exist yet, so they have no CouchDB id,
   * but the integrity check reports findings by id and a finding nobody can
   * trace back to a row is not actionable.
   */
  id: string;
  row: CsvRow;
  record: NewRecord;
}

export interface GuardedWriteResult {
  /** Cleared to write, with the source row alongside. */
  writable: GuardedRecord[];
  /** The same records, in the same order, ready for `writeRecords`. */
  records: NewRecord[];
  /** Rows answered by something already in Wallet. */
  duplicates: RejectedRecord[];
  /** Rows `convertRows` refused: unknown account/category/label, bad amount or date. */
  skipped: SkippedRow[];
  /** Later instalments of a deferred purchase — counted by the statement, never written. */
  ignored: CsvRow[];
  /** Everything the integrity check saw in what WOULD be written. */
  findings: IntegrityFinding[];
  /** The subset that is almost certainly wrong. Non-empty means: do not write. */
  alerts: IntegrityFinding[];
  /** `alerts.length > 0`. The caller must not commit while this is true. */
  blocked: boolean;
}

/** What `guardWrite` needs to reach a verdict. No CouchDB access. */
export interface GuardInput {
  lookup: LookupMaps;
  /**
   * Every Wallet record in the statement's window, across ALL accounts —
   * `reconcile-statement.ts` has already fetched exactly this for its diff.
   *
   * All accounts, not just this one: a transfer's counterpart lives in another
   * account by definition, and a counterpart written by an earlier run is what
   * keeps a legitimate leg from being reported as half a movement.
   */
  existing: WalletRecord[];
  /** Defaults to {@link STATEMENT_SLACK_MS}. */
  slackMs?: number;
  /** Above this, a non-transfer record is worth a human glance. Defaults to integrity.ts's $50,000. */
  largeAmountCents?: number;
}

/** What `commitGuardedWrite` additionally needs to post the records. */
export interface GuardContext extends GuardInput {
  couch: AxiosInstance;
  userId: string;
}

/** Wallet stores category ids; every message a human reads wants the name. */
function categoryNamesById(lookup: LookupMaps): Record<string, string> {
  const byId: Record<string, string> = {};
  for (const [name, id] of Object.entries(lookup.categories)) byId[id] = name;
  return byId;
}

/**
 * Every date under which this movement could already be recorded.
 *
 * A statement that publishes both columns dates a purchase by when it was made
 * and charges it days later; for an instalment the gap is a month or more. The
 * existing record may carry either, so both are tried.
 */
function candidateDates(record: NewRecord, row: CsvRow): string[] {
  const dates = [record.recordDate];
  const opdate = row.opdate?.trim();
  if (opdate) dates.push(`${opdate}T12:00:00`);
  return dates;
}

function findDuplicate(
  existing: WalletRecord[],
  record: NewRecord,
  row: CsvRow,
  slackMs: number
): WalletRecord | undefined {
  for (const recordDate of candidateDates(record, row)) {
    const hit = existing.find((e) =>
      matchesExisting(
        e,
        {
          accountId: record.accountId,
          amount: record.amount,
          type: record.type,
          recordDate,
          payee: record.payee,
        },
        slackMs
      )
    );
    if (hit) return hit;
  }
  return undefined;
}

function describeExisting(hit: WalletRecord): string {
  return `duplicado en Wallet: ${hit._id} (${hit.recordDate}${hit.payee ? `, ${hit.payee}` : ""})`;
}

function inspectCandidate(entry: GuardedRecord, names: Record<string, string>): InspectedRecord {
  const { id, record } = entry;
  return {
    id,
    amountCents: record.amount,
    type: record.type,
    // Either field means "transfer". `convertRows` sets the boolean, but a
    // record read back from Wallet may carry only `transferId` — the iOS app
    // never sets the flag.
    transfer: Boolean(record.transfer || record.transferId),
    accountId: record.accountId,
    categoryName: names[record.categoryId],
    payee: record.payee,
    note: record.note,
    recordDate: record.recordDate,
  };
}

function inspectExisting(r: WalletRecord, names: Record<string, string>): InspectedRecord {
  return {
    id: r._id,
    amountCents: Number(r.amount),
    type: Number(r.type),
    transfer: Boolean(r.transfer || r.transferId),
    accountId: String(r.accountId),
    categoryName: names[String(r.categoryId)],
    payee: r.payee,
    note: r.note,
    recordDate: String(r.recordDate),
  };
}

/**
 * Decides what may be written, and says so without writing anything.
 *
 * Order matters and is the whole point:
 *   1. later instalments are dropped and first ones restated to the full
 *      purchase price (idempotent — a caller that already ran `planWrites`
 *      loses nothing by passing its rows through again);
 *   2. rows are converted, so amounts, types and transfer links are exactly
 *      what would be posted;
 *   3. the duplicate gate runs on THAT, never on the row that was matched;
 *   4. the integrity check runs on what survives, against a pool that includes
 *      Wallet's own records, so a leg whose counterpart is already recorded is
 *      not reported as an orphan.
 */
export async function guardWrite(rows: CsvRow[], ctx: GuardInput): Promise<GuardedWriteResult> {
  const slackMs = ctx.slackMs ?? STATEMENT_SLACK_MS;
  const names = categoryNamesById(ctx.lookup);

  // Defensive, not redundant. `reconcile-statement.ts` reaches here through
  // `planWrites`, which has already done this; a future caller may not, and a
  // later instalment written at face value is a charge the user never agreed
  // to record. Re-restating a first instalment yields the same figure.
  const { writable: staged, ignored } = splitForWriting(rows);

  // A cash withdrawal is a transfer to the cash account, and both legs have to
  // exist before `convertRows` runs — that is what links them into a pair. The
  // month path reaches here without passing through `planWrites`, so this is
  // the one place both paths share. Expansion clears its own marker, so a set
  // that was already expanded comes through untouched.
  const withCash = expandCashWithdrawals(staged);

  const { records, originalRows, skipped } = convertRows(withCash, ctx.lookup);

  const cleared: GuardedRecord[] = [];
  const duplicates: RejectedRecord[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const row = originalRows[i];
    const hit = findDuplicate(ctx.existing, record, row, slackMs);
    if (hit) {
      duplicates.push({ row, record, kind: "wallet-duplicate", existing: hit, reason: describeExisting(hit) });
    } else {
      cleared.push({ id: `pending-${i + 1}`, row, record });
    }
  }

  // A transfer pair is linked by a shared `transferId` before any of this runs.
  // If one leg turns out to be a duplicate and the other is written anyway, the
  // survivor points at a record that will never exist: half a movement, exactly
  // the orphan legs `Stocks` already carries. Both legs go, and the pair is
  // reported so a human can pair it by hand.
  const rejectedTransferIds = new Map<string, WalletRecord>();
  for (const d of duplicates) {
    if (d.record.transferId) rejectedTransferIds.set(d.record.transferId, d.existing);
  }
  const survivors: GuardedRecord[] = [];
  for (const entry of cleared) {
    const partner = entry.record.transferId ? rejectedTransferIds.get(entry.record.transferId) : undefined;
    if (partner) {
      duplicates.push({
        row: entry.row,
        record: entry.record,
        kind: "orphan-transfer-half",
        existing: partner,
        reason:
          `la otra pierna del traspaso ya está en Wallet (${partner._id}): ` +
          `escribir solo esta dejaría media transferencia`,
      });
    } else {
      survivors.push(entry);
    }
  }

  const candidates = survivors.map((entry) => inspectCandidate(entry, names));
  const findings = checkRunIntegrity({
    written: candidates,
    // The counterpart of a legitimate transfer leg may predate this statement.
    windowRecords: [...candidates, ...ctx.existing.map((r) => inspectExisting(r, names))],
    largeAmountCents: ctx.largeAmountCents,
  });
  const alerts = findings.filter((f) => f.severity === "alert");

  return {
    writable: survivors,
    records: survivors.map((entry) => entry.record),
    duplicates,
    skipped,
    ignored,
    findings,
    alerts,
    blocked: alerts.length > 0,
  };
}

/**
 * Posts a verdict that cleared. Refuses one that did not.
 *
 * The refusal is a throw and not a silent no-op on purpose: a caller that asked
 * for a write and got nothing must find out why here, not from the fact that
 * `/statements` stayed red. Whoever wants to override an alert fixes the
 * extraction or the record, not this call.
 */
export async function commitGuardedWrite(
  result: GuardedWriteResult,
  ctx: GuardContext
): Promise<BulkResult[]> {
  if (result.blocked) {
    throw new Error(
      `No se escribe nada: la revisión de integridad levantó ${result.alerts.length} alerta(s).\n` +
        result.alerts.map((a) => `  • ${a.message}`).join("\n")
    );
  }
  if (result.records.length === 0) return [];
  return writeRecords(ctx.couch, ctx.userId, result.records);
}

/** Renders a verdict for the console or the Telegram summary. */
export function formatGuardReport(result: GuardedWriteResult): string {
  const lines: string[] = [];
  lines.push(`✍️ Por escribir: ${result.records.length}`);
  if (result.duplicates.length) {
    lines.push(`🔁 Rechazados por duplicado: ${result.duplicates.length}`);
    for (const d of result.duplicates) {
      lines.push(`   ${d.row.date.slice(0, 10)} $${d.row.amount} ${d.row.payee || d.row.note || ""} — ${d.reason}`);
    }
  }
  if (result.skipped.length) {
    lines.push(`⚠️ No convirtieron: ${result.skipped.length}`);
    for (const s of result.skipped) lines.push(`   ${s.row.date.slice(0, 10)} $${s.row.amount} — ${s.reason}`);
  }
  if (result.ignored.length) {
    lines.push(`🔁 Parcialidades ignoradas a propósito: ${result.ignored.length}`);
  }
  if (result.alerts.length) {
    lines.push(`🚨 ${result.alerts.length} alerta(s) de integridad — NO se escribe nada:`);
    for (const a of result.alerts) lines.push(`   • ${a.message}`);
  }
  const reviews = result.findings.filter((f) => f.severity === "review");
  if (reviews.length) {
    lines.push(`🔎 Para revisar (${reviews.length}):`);
    for (const r of reviews) lines.push(`   • ${r.message}`);
  }
  return lines.join("\n");
}
