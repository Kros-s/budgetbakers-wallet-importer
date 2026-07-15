import fs from "fs";
import path from "path";

export interface DailyEntry {
  ts: string;          // ISO-8601
  account: string;     // nombre legible
  accountId: string;   // -Account_<uuid> para dedup exacto
  amount: number;      // float firmado (negativo = gasto)
  category: string;    // nombre legible
  payee: string;
  status: "written" | "pending";
}

interface Store {
  day: string;
  entries: DailyEntry[];
}

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function storePath(day: string): string {
  return path.resolve(`data/bot/daily-tracker-${day}.json`);
}

function loadStore(): Store {
  const day = todayStr();
  try {
    return JSON.parse(fs.readFileSync(storePath(day), "utf8")) as Store;
  } catch {
    // file missing or corrupt — start fresh
  }
  return { day, entries: [] };
}

function saveStore(store: Store): void {
  const p = storePath(store.day);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store));
}

let store = loadStore();

function checkReset(): void {
  const today = todayStr();
  if (store.day !== today) {
    store = { day: today, entries: [] };
    saveStore(store);
  }
}

export function trackTransaction(entry: DailyEntry): void {
  checkReset();
  store.entries.push(entry);
  saveStore(store);
}

interface PastDaysCache {
  builtForDay: string; // "today" at the time this cache was built
  entries: DailyEntry[]; // entries from the 2 days before builtForDay
}

let pastDaysCache: PastDaysCache | null = null;

function shiftedDayStr(day: string, offsetDays: number): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() - offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// Read-only lookback into the previous 2 days' files — needed to catch a
// duplicate whose original entry was written just before midnight. Never
// mutates those files or the in-memory `store`. Cached per current day so
// repeated calls don't re-read from disk; the cache is rebuilt whenever the
// current day changes.
function loadPastDaysEntries(): DailyEntry[] {
  const today = todayStr();
  if (pastDaysCache && pastDaysCache.builtForDay === today) return pastDaysCache.entries;

  const entries: DailyEntry[] = [];
  for (const offset of [1, 2]) {
    const day = shiftedDayStr(today, offset);
    try {
      const past = JSON.parse(fs.readFileSync(storePath(day), "utf8")) as Store;
      entries.push(...past.entries);
    } catch {
      // file missing or corrupt — nothing to add for that day
    }
  }
  pastDaysCache = { builtForDay: today, entries };
  return entries;
}

function normalizePayee(payee: string): string {
  return payee.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Returns the matching entry if a likely duplicate exists, null otherwise.
 * Looks at today's in-memory store plus the on-disk files for the previous
 * 2 days (read-only). An entry counts as a duplicate when:
 *   - same accountId, AND
 *   - |amount difference| < 0.01, AND
 *   - written within `windowMs` of now (default 3h) — uses the entry's ts, AND
 *   - if BOTH payees are non-empty (after trim/lowercase/space-collapse),
 *     they must match; if either is empty, account+amount+window is enough.
 */
export function findDuplicate(
  accountId: string,
  amount: number,
  payee?: string,
  windowMs = 3 * 60 * 60 * 1000
): DailyEntry | null {
  checkReset();
  const now = Date.now();
  const normPayee = payee ? normalizePayee(payee) : "";
  const candidates = [...store.entries, ...loadPastDaysEntries()];

  return (
    candidates.find((e) => {
      if (e.accountId !== accountId) return false;
      if (Math.abs(e.amount - amount) >= 0.01) return false;
      if (now - new Date(e.ts).getTime() > windowMs) return false;
      const entryPayee = e.payee ? normalizePayee(e.payee) : "";
      if (normPayee && entryPayee && normPayee !== entryPayee) return false;
      return true;
    }) ?? null
  );
}

/** True if any transaction has been tracked so far today. */
export function hasEntriesToday(): boolean {
  checkReset();
  return store.entries.length > 0;
}

/** Returns all entries for today as JSONL — one compact JSON object per line. */
export function getDailyLog(): string {
  checkReset();
  return store.entries.map((e) => JSON.stringify(e)).join("\n");
}

/** Builds a human-readable Telegram summary for the day. */
export function buildDailySummary(date: string): string {
  checkReset();
  if (store.entries.length === 0) return `📊 Sin transacciones registradas el ${date}.`;

  const lines = store.entries.map((e) => {
    const sign = e.amount < 0 ? "💸" : "💰";
    const amt = Math.abs(e.amount).toFixed(2);
    const time = e.ts.slice(11, 16);
    const tag = e.status === "pending" ? " ⏳" : "";
    return `${sign} ${time} | ${e.account} | $${amt} | ${e.category}${e.payee ? ` | ${e.payee}` : ""}${tag}`;
  });

  const expenses = store.entries.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
  const income = store.entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);

  const totals: string[] = [];
  if (expenses < 0) totals.push(`💸 Gastos: -$${Math.abs(expenses).toFixed(2)}`);
  if (income > 0) totals.push(`💰 Ingresos: +$${income.toFixed(2)}`);

  return [`📊 *Resumen ${date}*\n`, ...lines, "─────────────", ...totals].join("\n");
}

/** Schedules a callback at the given hour (local time) every day. */
export function scheduleDailyAt(hour: number, callback: () => void): void {
  function msUntilNextFiring(): number {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  function arm(): void {
    setTimeout(() => {
      callback();
      arm();
    }, msUntilNextFiring());
  }

  arm();
}
