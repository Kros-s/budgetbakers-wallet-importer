/**
 * @file bot/statements-view.ts
 * @description The ✅/❌ grid behind /statements.
 *
 * The nightly batch already nags with a one-line list of overdue months, which
 * answers "what do I owe right now" but not "how far behind am I". This renders
 * the same registry as a month-by-month grid, so a gap two months deep is
 * visible as a gap instead of as one more name in a sentence.
 */

import type { AccountStatus } from "../statements/registry.js";

const MONTH_ABBR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/**
 * Two-letter column headers. An emoji occupies two monospace columns, so a cell
 * plus its separator is three; a three-letter month label would be four and the
 * header would drift one column further right on every month.
 */
const MONTH_CODE = ["en", "fe", "mz", "ab", "my", "jn", "jl", "ag", "se", "oc", "no", "di"];

/** Longest account name kept intact; the rest are cut so the grid stays aligned. */
const NAME_WIDTH = 14;

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  return monthKey(new Date(y, m - 1 + n, 1));
}

function label(month: string): string {
  return MONTH_ABBR[Number(month.split("-")[1]) - 1];
}

function code(month: string): string {
  return MONTH_CODE[Number(month.split("-")[1]) - 1];
}

/**
 * The months the grid shows: `count` of them, ending with the newest month
 * anything is actually owed for, or the month before today when nothing is.
 *
 * It used to end unconditionally at the previous month. An account whose cut
 * has already passed this month can owe the CURRENT month, and that column fell
 * off the right edge — the one gap most worth seeing, invisible.
 */
export function gridMonths(today: Date, count: number, missing: string[] = []): string[] {
  const newestOwed = missing.length ? missing.reduce((a, b) => (a > b ? a : b)) : "";
  const prev = addMonths(monthKey(today), -1);
  const last = newestOwed > prev ? newestOwed : prev;
  return Array.from({ length: count }, (_, i) => addMonths(last, i - count + 1));
}

/**
 * ✅ reconciled · ❌ missing · ⬜ not due yet (or before the account's startMonth).
 *
 * The blank cell is an emoji rather than a dot so every cell is the same width
 * and the columns stay square.
 *
 * Derived from `lastReceived` and `missing` alone: anything at or below the
 * last reconciled month is settled, anything the registry chases is missing,
 * and everything else is simply not owed — which is why a fresh account shows
 * dots rather than a wall of red.
 */
export function cellFor(status: AccountStatus, month: string): "✅" | "❌" | "⬜" {
  if (status.lastReceived && month <= status.lastReceived) return "✅";
  if (status.missing.includes(month)) return "❌";
  return "⬜";
}

function truncate(name: string): string {
  return name.length <= NAME_WIDTH ? name.padEnd(NAME_WIDTH) : `${name.slice(0, NAME_WIDTH - 1)}…`;
}

/** Most behind first, then alphabetically — the rows that need action lead. */
function ranked(rows: AccountStatus[]): AccountStatus[] {
  return [...rows].sort(
    (a, b) => b.missing.length - a.missing.length || a.account.localeCompare(b.account, "es")
  );
}

export function formatStatementsTable(
  statuses: AccountStatus[],
  today = new Date(),
  monthCount = 6
): string {
  if (statuses.length === 0) {
    return "📄 *Estados de cuenta*\n\nNo hay ninguna cuenta en el registro todavía.";
  }

  const months = gridMonths(today, monthCount, statuses.flatMap((s) => s.missing));
  const header = `${" ".repeat(NAME_WIDTH)} ${months.map(code).join(" ")}`;
  const rows = ranked(statuses).map((s) => {
    return `${truncate(s.account)} ${months.map((m) => cellFor(s, m)).join(" ")}`;
  });

  const totalMissing = statuses.reduce((n, s) => n + s.missing.length, 0);
  const behind = statuses.filter((s) => s.missing.length > 0);

  // Months older than the grid still count. Saying so beats a table that looks
  // complete because the oldest gaps scrolled off the left edge.
  const older = statuses.flatMap((s) => s.missing.filter((m) => m < months[0]));

  const span = months.length === 1
    ? `${label(months[0])} ${months[0].slice(0, 4)}`
    : `${label(months[0])}–${label(months[months.length - 1])} ${months[months.length - 1].slice(0, 4)}`;

  const lines = [
    "📄 *Estados de cuenta*",
    `_${span}_`,
    "",
    "```",
    header,
    ...rows,
    "```",
  ];

  if (totalMissing === 0) {
    lines.push("✅ Todo conciliado.");
  } else {
    lines.push(
      `❌ Faltan *${totalMissing}* ${totalMissing === 1 ? "mes" : "meses"} en ` +
        `*${behind.length}* ${behind.length === 1 ? "cuenta" : "cuentas"}.`
    );
    if (older.length > 0) {
      lines.push(
        `_${older.length} ${older.length === 1 ? "mes queda" : "meses quedan"} antes de ${label(months[0])} ` +
          `y no ${older.length === 1 ? "cabe" : "caben"} en la tabla: ${[...new Set(older)].sort().join(", ")}._`
      );
    }
    lines.push("", "_Mándame el PDF como archivo y lo concilio._");
  }

  return lines.join("\n");
}
