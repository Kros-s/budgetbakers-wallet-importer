import fs from "fs";
import path from "path";

/**
 * Statement registry: which accounts produce a monthly statement, when it
 * cuts, and which month was last reconciled. The nightly batch uses
 * `missingStatements()` to nag on Telegram when a month is overdue —
 * statements are the COMPLETE record; email alerts only cover some banks.
 */

export interface RegistryEntry {
  /** Day of month the statement cuts (1-28). */
  cutDay: number;
  /** How the PDF arrives: "email" (auto-captured) or "manual" (user downloads). */
  source: "email" | "manual";
  /**
   * Last reconciled month, "YYYY-MM", or null if never. Kept for display and
   * for migrating older registries; `received` is what decides what is owed.
   */
  lastReceived: string | null;
  /**
   * Every month actually reconciled, "YYYY-MM".
   *
   * A single high-water mark cannot describe a backlog with holes in it, and
   * statements do not arrive in order. Reconciling July while May and June were
   * still outstanding moved the mark to July, and everything at or below it read
   * as settled: two months that were never reconciled showed ✅ and were chased
   * by nothing. Which is the failure bc517c5 set out to fix, surviving in the
   * one place that scan never looked.
   */
  received?: string[];
  /** Days of grace after cutDay before nagging. Default 5. */
  graceDays?: number;
  /**
   * Oldest month worth chasing, "YYYY-MM". Without it an account that has never
   * been reconciled would be chased back to the beginning of time, so the
   * lookback is capped instead.
   */
  startMonth?: string;
}

export type Registry = Record<string, RegistryEntry>; // account name → entry

const REGISTRY_PATH = path.resolve("data/statements/registry.json");

const SEED_PATH = path.resolve("config/statements-registry.seed.json");

/**
 * Configuration comes from the committed seed; mutable state from the live file.
 *
 * `data/` is gitignored, so fourteen hand-verified cut days lived only on the
 * container's disk. A fresh provision got an empty registry and swallowed it:
 * the nightly nag never fired, /statements said the registry was empty, and
 * /cross refused every month — all silently. An account present only in the
 * live file is kept, never dropped, and `received` is left absent rather than
 * emptied so a pre-`received` registry keeps its lastReceived fallback.
 */
export function loadRegistry(): Registry {
  const read = (p: string): Registry => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as Registry;
    } catch {
      return {};
    }
  };
  const seed = read(SEED_PATH);
  const live = read(REGISTRY_PATH);
  if (Object.keys(seed).length === 0) return live;

  const merged: Registry = {};
  for (const [account, cfg] of Object.entries(seed)) {
    const state = live[account];
    merged[account] = {
      ...cfg,
      lastReceived: state?.lastReceived ?? cfg.lastReceived ?? null,
      ...(state?.received ? { received: state.received } : {}),
    };
  }
  for (const [account, entry] of Object.entries(live)) {
    if (!merged[account]) merged[account] = entry;
  }
  return merged;
}

export function saveRegistry(reg: Registry): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

/** Months known to be reconciled, migrating a pre-`received` registry. */
export function receivedMonths(entry: RegistryEntry): string[] {
  if (entry.received) return entry.received;
  // An older registry only recorded the newest one. That is all it actually
  // knew, so that is all we claim — the rest go back to being owed.
  return entry.lastReceived ? [entry.lastReceived] : [];
}

export function markReceived(account: string, month: string): void {
  const reg = loadRegistry();
  const entry = reg[account];
  if (!entry) return;
  const got = new Set(receivedMonths(entry));
  got.add(month);
  entry.received = [...got].sort();
  if (!entry.lastReceived || entry.lastReceived < month) entry.lastReceived = month;
  saveRegistry(reg);
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return monthKey(d);
}

/** How far back to look when an account has never been reconciled. */
const DEFAULT_LOOKBACK_MONTHS = 6;

export interface MissingStatement {
  account: string;
  /** "YYYY-MM" */
  month: string;
  source: string;
}

/**
 * The newest month whose statement is already due for this account: its cut day
 * plus the grace period has passed.
 *
 * A month's statement cuts within THAT SAME month, not the following one. The
 * code used to assume the opposite, which put every account a month behind
 * reality: Meli's "julio" statement closes 21-jul and the registry would not
 * chase it until 26-ago. Checked against fourteen real statements from seven
 * banks — Banamex, BBVA, Banorte débito and crédito, Mercado Pago, MIFEL,
 * Klar — and all seven name the month their cut falls in.
 */
function lastDueMonth(entry: RegistryEntry, today: Date): string | null {
  const grace = entry.graceDays ?? 5;
  const cut = Math.min(entry.cutDay, 28);
  const dueThisMonth = new Date(today.getFullYear(), today.getMonth(), cut + grace);
  const anchor = today >= dueThisMonth
    ? new Date(today.getFullYear(), today.getMonth(), 1)
    : new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return monthKey(anchor);
}

/**
 * Every month still missing, not just the most recent one.
 *
 * It used to report only the previous month, so three months behind on an
 * account produced one nag and the two older months were never mentioned again
 * — the reconciliation silently narrowed to whatever was most recent.
 */
export function missingStatements(today = new Date()): MissingStatement[] {
  const reg = loadRegistry();
  const out: MissingStatement[] = [];
  for (const [account, e] of Object.entries(reg)) {
    const last = lastDueMonth(e, today);
    if (!last) continue;
    // Anchored on the last DUE month, not on today: counting back from today
    // yielded one month more than the cap promised.
    const from = e.startMonth ?? addMonths(last, -(DEFAULT_LOOKBACK_MONTHS - 1));
    const got = new Set(receivedMonths(e));
    for (let m = from; m <= last; m = addMonths(m, 1)) {
      if (!got.has(m)) out.push({ account, month: m, source: e.source });
    }
  }
  return out;
}

export interface AccountStatus {
  account: string;
  source: string;
  cutDay: number;
  lastReceived: string | null;
  /** Months actually reconciled — not "everything up to lastReceived". */
  received: string[];
  missing: string[];
}

/** Per-account view for the /statements listing. */
export function statementStatus(today = new Date()): AccountStatus[] {
  const reg = loadRegistry();
  const missing = missingStatements(today);
  return Object.entries(reg).map(([account, e]) => ({
    account,
    source: e.source,
    cutDay: e.cutDay,
    lastReceived: e.lastReceived,
    received: receivedMonths(e),
    missing: missing.filter((m) => m.account === account).map((m) => m.month),
  }));
}
