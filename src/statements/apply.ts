/**
 * @file statements/apply.ts
 * @description What a month's statements mean for Wallet, decided once.
 *
 * The pipeline could extract and it could report, but nothing closed the loop:
 * held transfer legs were never settled by any command, so the only way to write
 * a statement was the CLI by hand. This is the missing step, and it is written
 * as a pure plan on purpose — Telegram and a terminal session must not be able
 * to disagree about what a month means, so both ask this and neither decides.
 *
 * Nothing here touches the network or the disk. `planMonth` takes the rows and
 * returns what it would do; a caller writes, or shows, or refuses.
 */

import type { CsvRow } from "../csv.js";
import { crossTransfers, type LedgerRow, toLedgerRows } from "./crossing.js";
import { splitForWriting } from "./installments.js";
import { isTransferRow } from "./write-policy.js";

/** How far apart a statement row and a Wallet record may be and still be the same movement. */
export const MATCH_SLACK_DAYS = 5;

export type Disposition =
  /** Already in Wallet: writing it would duplicate. */
  | "recorded"
  /** No counterpart anywhere; safe to write on its own. */
  | "write"
  /** A transfer whose other leg is in this month too: write both, linked. */
  | "pair"
  /** A transfer whose counterpart is already in Wallet: write this leg, linked to it. */
  | "complete"
  /** Something is unresolved; a human decides. */
  | "hold";

export interface PlannedRow {
  account: string;
  row: CsvRow;
  disposition: Disposition;
  /** Why, in the user's language. */
  reason: string;
  /** For "pair": the account holding the other leg. */
  withAccount?: string;
}

export interface MonthPlan {
  month: string;
  planned: PlannedRow[];
  /** Later instalments, never written. */
  ignored: { account: string; row: CsvRow }[];
  /** Accounts whose statements took part. */
  accounts: string[];
}

const DAY = 86_400_000;

function signedCents(row: CsvRow): number {
  const n = Number(String(row.amount).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/**
 * Distance in whole calendar days, comparing dates and not instants.
 *
 * A statement row's date carries no timezone and parses as local, while a Wallet
 * record is stored with an offset — so a five-day gap measured in milliseconds
 * came out as five days and six hours and fell outside a five-day slack. Banks
 * post by day, not by second, so days are the honest unit and the offset stops
 * mattering at all.
 */
function dayGap(a: string, b: string): number {
  const day = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  const [x, y] = [day(a), day(b)];
  return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) / DAY : Infinity;
}

/**
 * Is this row already recorded?
 *
 * Same account, same signed amount, within the slack. The slack is five days
 * because that is the measured gap between when a purchase happens and when the
 * bank posts it — a movement recorded from its alert carries the operation date
 * while the statement publishes the posting date.
 */
function alreadyRecorded(
  account: string,
  row: CsvRow,
  wallet: LedgerRow[],
  used: Set<LedgerRow>
): LedgerRow | undefined {
  const cents = signedCents(row);
  if (!Number.isFinite(cents)) return undefined;
  const dates = [String(row.date), ...(row.opdate ? [row.opdate] : [])];
  // Consumed once, as diff() already does: without it two identical statement
  // rows both matched one Wallet record and both reported "already recorded",
  // so the second real movement disappeared from the plan.
  return wallet.find(
    (w) => !used.has(w) && w.account === account && w.cents === cents &&
      dates.some((d) => dayGap(d, w.date) <= MATCH_SLACK_DAYS)
  );
}

export interface LedgerInput {
  account: string;
  rows: CsvRow[];
}

/**
 * Income categories that really do come from outside the accounts.
 *
 * Everything else that arrives as money IN is, until proven otherwise, money
 * that left another of your own accounts. Klar's July shows why: +$210,000
 * categorised "Financial investments", no counterpart yet, and the plan was
 * ready to write it as standalone income. Its other half is in Banorte débito's
 * July statement, which had not arrived — so with the month incomplete, an
 * inflow that is not recognisably external waits.
 */
const EXTERNAL_INCOME = /interes|interest|dividend|wage|salar|n[óo]mina|rendimiento|refund|reembolso|cashback|venta|sale/i;

function isUnexplainedInflow(row: CsvRow): boolean {
  const cents = signedCents(row);
  return Number.isFinite(cents) && cents > 0 && !EXTERNAL_INCOME.test(row.category ?? "");
}

/**
 * Decides a whole month at once.
 *
 * A month is the unit because a transfer has two legs in two different
 * statements: deciding one statement at a time cannot see the other half, so it
 * writes half a movement and writes it again when the counterpart arrives.
 */
export function planMonth(
  month: string,
  ledgers: LedgerInput[],
  wallet: LedgerRow[],
  opts: { coverageComplete?: boolean } = {}
): MonthPlan {
  const planned: PlannedRow[] = [];
  const ignored: { account: string; row: CsvRow }[] = [];

  // Later instalments never reach a decision; a first instalment is restated to
  // the purchase's full price before anything is matched against Wallet, so the
  // amount we look for is the amount we would write.
  const usable: { account: string; rows: CsvRow[] }[] = [];
  for (const led of ledgers) {
    const { writable, ignored: skip } = splitForWriting(led.rows);
    for (const row of skip) ignored.push({ account: led.account, row });
    usable.push({ account: led.account, rows: writable });
  }

  // Rows still owed after Wallet has been consulted — only these can pair, and
  // only these can be written.
  const outstanding: { account: string; row: CsvRow; led: LedgerRow }[] = [];
  const usedWallet = new Set<LedgerRow>();
  for (const { account, rows } of usable) {
    for (const row of rows) {
      const hit = alreadyRecorded(account, row, wallet, usedWallet);
      if (hit) {
        usedWallet.add(hit);
        planned.push({ account, row, disposition: "recorded", reason: "ya está en Wallet" });
        continue;
      }
      const [led] = toLedgerRows(account, [row]);
      if (!led) {
        planned.push({ account, row, disposition: "hold", reason: "no pude leer su monto o su fecha" });
        continue;
      }
      outstanding.push({ account, row, led });
    }
  }

  // Pair the outstanding legs among themselves first: two statements of the same
  // month are the only place a transfer's two halves can meet.
  const { pairs } = crossTransfers(outstanding.map((o) => o.led));
  const partner = new Map<LedgerRow, LedgerRow>();
  for (const p of pairs) {
    partner.set(p.out, p.in);
    partner.set(p.in, p.out);
  }
  const byLed = new Map(outstanding.map((o) => [o.led, o]));

  for (const { account, row, led } of outstanding) {
    const other = partner.get(led);
    if (other) {
      planned.push({
        account, row, disposition: "pair",
        reason: `traspaso con ${byLed.get(other)?.account ?? "otra cuenta"}`,
        withAccount: byLed.get(other)?.account,
      });
      continue;
    }
    // No partner in this month's statements. If Wallet already holds the
    // opposite movement in another account, this leg completes a transfer that
    // is half-recorded; if not, and it looks like a transfer, it waits.
    const opposite = wallet.find(
      (w) => w.account !== account && w.cents === -led.cents && dayGap(w.date, led.date) <= MATCH_SLACK_DAYS
    );
    if (opposite) {
      planned.push({
        account, row, disposition: "complete",
        reason: `su contraparte ya está en ${opposite.account}`,
        withAccount: opposite.account,
      });
      continue;
    }
    if (isTransferRow(row)) {
      planned.push({ account, row, disposition: "hold", reason: "traspaso sin contraparte todavía" });
      continue;
    }
    if (!opts.coverageComplete && isUnexplainedInflow(row)) {
      planned.push({
        account, row, disposition: "hold",
        reason: "entrada de dinero sin origen conocido y el mes está incompleto",
      });
      continue;
    }
    planned.push({ account, row, disposition: "write", reason: "movimiento propio de la cuenta" });
  }

  return { month, planned, ignored, accounts: ledgers.map((l) => l.account) };
}

export function countBy(plan: MonthPlan): Record<Disposition, number> {
  const out: Record<Disposition, number> = { recorded: 0, write: 0, pair: 0, complete: 0, hold: 0 };
  for (const p of plan.planned) out[p.disposition] += 1;
  return out;
}

/** The rows a caller would actually write, in the order they were planned. */
export function writableRows(plan: MonthPlan): PlannedRow[] {
  return plan.planned.filter((p) => p.disposition === "write" || p.disposition === "pair" || p.disposition === "complete");
}

export function formatPlan(plan: MonthPlan): string {
  const n = countBy(plan);
  const lines = [
    `🗂️ *Plan de ${plan.month}* · ${plan.accounts.length} cuenta(s)`,
    "",
    `✅ ya en Wallet: ${n.recorded}`,
    `✍️ por escribir: ${n.write}`,
    `🔗 traspasos completos: ${n.pair / 2 || 0} par(es)`,
    `🧩 completan uno ya registrado: ${n.complete}`,
    `⏸️ en espera: ${n.hold}`,
  ];
  if (plan.ignored.length) lines.push(`🔁 parcialidades ignoradas: ${plan.ignored.length}`);
  const holds = plan.planned.filter((p) => p.disposition === "hold");
  if (holds.length) {
    lines.push("", "```",
      ...holds.slice(0, 10).map((h) => `${h.row.date.slice(0, 10)} ${h.account} $${h.row.amount} — ${h.reason}`),
      "```");
    if (holds.length > 10) lines.push(`_…y ${holds.length - 10} más._`);
  }
  return lines.join("\n");
}
