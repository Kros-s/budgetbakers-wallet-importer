/**
 * @file statements/reconcile-core.ts
 * @description The decisions `cli/reconcile-statement.ts` makes with no help
 * from CouchDB, the filesystem or Telegram: which statement rows Wallet is
 * already holding, which it is missing, which are too doubtful to write, and
 * whether the month may be closed and its PDF thrown away.
 *
 * These are the gate in front of every write on the statement path — a row
 * that reads as `missing` when Wallet already holds it is a duplicate the
 * moment `--write` runs — and they were living inline in a 420-line CLI with
 * no test able to reach them. Nothing here does I/O, so all of it is testable.
 *
 * This module is a behaviour-preserving extraction. Where the original does
 * something surprising, the surprise is reproduced and explained rather than
 * corrected: the CLI's behaviour is what the registry and the retention of
 * every statement PDF depend on today.
 */

import type { CsvRow } from "../csv.js";
import type { WalletRecord } from "../types.js";

/**
 * How far a statement row and a Wallet record may sit apart and still be the
 * same movement.
 *
 * Five, not three, and for the same reason as period.ts's BOUNDARY_DAYS: the
 * measured operation-to-posting lag reaches five days at Banamex. At three, a
 * purchase already recorded from its alert under the operation date failed to
 * match the statement's posting date, landed in `missing`, and --write booked
 * it again. The boundary heuristic was already flagging exactly those rows as
 * edge cases while the matcher refused to reach them.
 */
export const DATE_SLACK_DAYS = 5;

const DAY_MS = 86_400_000;

/** A statement row the matcher refuses to call matched or missing. */
export interface AmbiguousRow {
  row: CsvRow;
  reason: string;
}

export interface DiffResult {
  /** In the statement, not in Wallet → candidates to write. */
  missing: CsvRow[];
  /** How many statement rows found a record of their own. */
  matched: number;
  /** Too doubtful to write: for a human, never for --write. */
  ambiguous: AmbiguousRow[];
  /** In Wallet (this account, this window), never mentioned by the statement. */
  walletOnly: WalletRecord[];
  /**
   * Rows the statement publishes separately that Wallet holds as one record —
   * a deposit and the fee taken out of it, booked net.
   */
  grouped: { record: WalletRecord; rows: CsvRow[] }[];
}

/** Signed cents, the way the rest of the pipeline reads a row. */
function signedCents(row: CsvRow): number {
  const n = parseFloat(row.amount);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/** Both dates a statement may publish for one movement, as epoch ms. */
function rowTimes(row: CsvRow): number[] {
  const times = [Date.parse(row.date.replace(" ", "T"))];
  if (row.opdate) times.push(Date.parse(`${row.opdate}T12:00:00`));
  return times.filter(Number.isFinite);
}

/** How many statement lines one Wallet record may stand for. */
const MAX_GROUP = 4;

/** Anything that carries a signed amount and the day the statement printed it. */
export interface Summable {
  cents: number;
  day: string;
}

/**
 * The one same-day group of two to four items that sums to `want`, or null.
 *
 * Shared by both matchers so the guards cannot drift apart between the
 * per-statement path and the month's. Null covers three different answers —
 * no group, several groups, or groups on more than one day — and they are all
 * the same instruction: leave it alone.
 *
 * Every subset is enumerated rather than solved greedily because the answer has
 * to be known to be the ONLY one. Two different combinations reaching the same
 * figure is what a coincidence looks like, and guessing between them writes
 * some real movements while hiding others.
 */
export function uniqueGroupSummingTo<T extends Summable>(items: T[], want: number): T[] | null {
  const byDay = new Map<string, T[]>();
  for (const it of items) byDay.set(it.day, [...(byDay.get(it.day) ?? []), it]);

  let answer: T[] | null = null;
  for (const sameDay of byDay.values()) {
    const hits: T[][] = [];
    const walk = (start: number, chosen: T[], total: number): void => {
      if (chosen.length >= 2 && total === want) { hits.push([...chosen]); return; }
      if (chosen.length >= MAX_GROUP || hits.length > 1) return;
      for (let i = start; i < sameDay.length; i++) {
        chosen.push(sameDay[i]);
        walk(i + 1, chosen, total + sameDay[i].cents);
        chosen.pop();
        if (hits.length > 1) return;
      }
    };
    walk(0, [], 0);
    if (hits.length === 0) continue;
    // A second answer, here or on another day, means nobody can say which.
    if (hits.length > 1 || answer) return null;
    answer = hits[0];
  }
  return answer;
}

/**
 * Movements a statement itemises that Wallet holds as one record.
 *
 * Two real shapes, both found by reading real statements:
 *
 *   - DolarApp publishes a deposit and the commission taken out of it as two
 *     lines — `Compra USDc +3,600` and `Comisión -3` — while Wallet holds the
 *     single $3,597 that arrived. $7,154 duplicated in June, $7,114 in July.
 *   - Banorte débito publishes an early mortgage payoff as four lines on one
 *     day (299.00 + 178,901.66 + 21,568.34 + 2,198.00) where Wallet holds one
 *     $202,967.00 record. That one is same-sign, which an opposite-sign rule
 *     could never reach.
 *
 * Row by row none of them matches anything, so all of them land in `missing`
 * and `--write` posts them on top of the record already there.
 *
 * Three constraints keep a coincidence from being read as a group, and they
 * matter more than the matching does:
 *
 *   1. every line in the group carries the SAME date, as the statement printed
 *      it. A bank splits one movement across lines on the day it happens, not
 *      across a week.
 *   2. at most four lines, so this cannot wander into subset-sum over a month.
 *   3. the subset must be the ONLY one that sums to the record. Two different
 *      combinations reaching the same figure is exactly what a coincidence
 *      looks like, and it is left for a human rather than guessed at.
 */
function matchNettedGroups(
  missing: CsvRow[],
  free: WalletRecord[]
): { record: WalletRecord; rows: CsvRow[] }[] {
  const found: { record: WalletRecord; rows: CsvRow[] }[] = [];
  const taken = new Set<CsvRow>();
  for (const record of free) {
    const want = record.type === 1 ? -record.amount : record.amount;
    const at = Date.parse(record.recordDate);
    if (!Number.isFinite(at)) continue;
    const near = missing.filter(
      (r) => !taken.has(r) &&
        Number.isFinite(signedCents(r)) &&
        rowTimes(r).some((t) => Math.abs(at - t) <= DATE_SLACK_DAYS * DAY_MS)
    );
    const group = uniqueGroupSummingTo(
      near.map((row) => ({ row, cents: signedCents(row), day: row.date.slice(0, 10) })),
      want
    );
    if (!group) continue;
    const rows = group.map((g) => g.row);
    rows.forEach((r) => taken.add(r));
    found.push({ record, rows });
  }
  return found;
}

/**
 * Match statement rows against the Wallet records already in the window.
 *
 * A record answers a row when it is in the same account, for the same absolute
 * amount in cents, with the same direction (`type`: 1 = money out, 0 = money
 * in), and sits within DATE_SLACK_DAYS of EITHER of the two dates a statement
 * publishes.
 *
 * Both dates, because either may be the one Wallet holds: an alert fires when
 * the purchase happens, the statement books it when it posts, and for an
 * instalment the two are a month apart. Matching on the closest of the two is
 * what keeps a movement from reading as missing and being written a second
 * time.
 *
 * Records are consumed as they are matched, so two identical statement lines
 * cannot both be answered by the single record Wallet holds — the second one
 * is reported as a possible repeated charge instead of quietly matching.
 */
export function diff(rows: CsvRow[], existing: WalletRecord[], accountId: string): DiffResult {
  const inAccount = existing.filter((r) => r.accountId === accountId);
  const usedRecordIds = new Set<string>();
  const missing: CsvRow[] = [];
  const ambiguous: AmbiguousRow[] = [];
  let matched = 0;

  for (const row of rows) {
    const amt = Math.round(Math.abs(parseFloat(row.amount)) * 100);
    const type = parseFloat(row.amount) < 0 ? 1 : 0;
    const times = [Date.parse(row.date.replace(" ", "T"))];
    if (row.opdate) times.push(Date.parse(`${row.opdate}T12:00:00`));
    const candidates = inAccount.filter((r) => {
      if (r.amount !== amt || r.type !== type) return false;
      const rec = Date.parse(r.recordDate);
      // Number.isFinite guards the row, not the record: an unparseable date on
      // the statement side must not turn into a NaN comparison that matches
      // everything. Such a row simply finds nothing and lands in `missing`.
      return times.some((t) => Number.isFinite(t) && Math.abs(rec - t) <= DATE_SLACK_DAYS * DAY_MS);
    });
    const free = candidates.filter((c) => !usedRecordIds.has(c._id!));
    if (free.length === 1) {
      usedRecordIds.add(free[0]._id!);
      matched++;
    } else if (free.length > 1) {
      // Counted as matched AND reported as ambiguous, consuming the first
      // candidate. The row is not written (it is not in `missing`), but Wallet
      // very likely holds a duplicate and only a human can say which one.
      usedRecordIds.add(free[0]._id!);
      matched++;
      ambiguous.push({
        row,
        reason: `${free.length} registros candidatos con mismo monto/fecha — revisar duplicados en Wallet`,
      });
    } else if (candidates.length > 0) {
      // Something matched but it is already spoken for. Writing this row would
      // be right if the bank really charged twice and wrong if the extraction
      // read the same line twice, so it goes to the human.
      ambiguous.push({
        row,
        reason: "el registro de Wallet que coincide ya casó con otra línea del estado — posible cargo repetido",
      });
    } else {
      missing.push(row);
    }
  }

  // Second pass, over what neither side could answer alone.
  const free = inAccount.filter((r) => !usedRecordIds.has(r._id!));
  const grouped = matchNettedGroups(missing, free);
  for (const g of grouped) {
    usedRecordIds.add(g.record._id!);
    matched += g.rows.length;
    for (const r of g.rows) missing.splice(missing.indexOf(r), 1);
  }

  const walletOnly = inAccount.filter((r) => !usedRecordIds.has(r._id!));
  return { missing, matched, ambiguous, walletOnly, grouped };
}

/** Everything left over from a reconcile run that a human still has to touch. */
export interface Outstanding {
  /** Rows waiting for the month's crossing to find their transfer counterpart. */
  held: number;
  /** Rows `diff` refused to resolve. */
  ambiguous: number;
  /** Rows `convertRows` refused: unknown account/category, bad amount or date. */
  skipped: number;
  /** The integrity check raised an alert and nothing was written. */
  blocked: boolean;
}

/**
 * How many things the run left open.
 *
 * `blocked` is deliberately not part of the count: it is a separate condition
 * on the month (see `mayMarkReconciled`) and it does NOT keep the PDF.
 */
export function unresolvedCount(o: Pick<Outstanding, "held" | "ambiguous" | "skipped">): number {
  return o.held + o.ambiguous + o.skipped;
}

/**
 * May the month be marked received in the registry?
 *
 * A month with rows still waiting for the crossing is not reconciled. Marking
 * it anyway turned /statements green while its transfer legs were unwritten.
 * Anything unresolved leaves the month open: marking it on `held` alone let
 * ambiguous rows and rows the converter refused vanish into a month the
 * registry then never chased again. A write the integrity check blocked closes
 * nothing either — nothing reached Wallet.
 */
export function mayMarkReconciled(o: Outstanding): boolean {
  return unresolvedCount(o) === 0 && !o.blocked;
}

/**
 * May the source PDF be deleted?
 *
 * The PDF has served its purpose unless something in it is still unresolved.
 * A skipped row counts: a lone transfer leg (a card payment whose other side
 * lives in another account) is refused by design, and it is the PDF you go
 * back to when you come to pair it. Held rows count for the same reason: the
 * PDF is what you come back to when the month is crossed.
 *
 * PRESERVED ODDITY: unlike `mayMarkReconciled`, this ignores `blocked`. A run
 * where integrity refused the write, with nothing held, ambiguous or skipped,
 * writes nothing, leaves the month open — and still retires the PDF. The CLI
 * behaves exactly this way today (`retireStatement` is called with a count
 * that never mentions `blocked`); it is reproduced here rather than fixed so
 * the switch-over changes no behaviour.
 */
export function mayRetireStatement(o: Pick<Outstanding, "held" | "ambiguous" | "skipped">): boolean {
  return unresolvedCount(o) === 0;
}
