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

  const walletOnly = inAccount.filter((r) => !usedRecordIds.has(r._id!));
  return { missing, matched, ambiguous, walletOnly };
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
