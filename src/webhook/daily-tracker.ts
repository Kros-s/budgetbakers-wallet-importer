export interface DailyEntry {
  ts: string;          // ISO-8601
  account: string;     // nombre legible
  accountId: string;   // -Account_<uuid> para dedup exacto
  amount: number;      // float firmado (negativo = gasto)
  category: string;    // nombre legible
  payee: string;
  status: "written" | "pending";
}

let entries: DailyEntry[] = [];
let currentDay = todayStr();

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function checkReset(): void {
  const today = todayStr();
  if (today !== currentDay) {
    entries = [];
    currentDay = today;
  }
}

export function trackTransaction(entry: DailyEntry): void {
  checkReset();
  entries.push(entry);
}

/** Returns the matching entry if a likely duplicate exists, null otherwise. */
export function findDuplicate(accountId: string, amount: number): DailyEntry | null {
  checkReset();
  return (
    entries.find(
      (e) => e.accountId === accountId && Math.abs(e.amount - amount) < 0.01
    ) ?? null
  );
}

/** Returns all entries for today as JSONL — one compact JSON object per line. */
export function getDailyLog(): string {
  checkReset();
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

/** Builds a human-readable Telegram summary for the day. */
export function buildDailySummary(date: string): string {
  checkReset();
  if (entries.length === 0) return `📊 Sin transacciones registradas el ${date}.`;

  const lines = entries.map((e) => {
    const sign = e.amount < 0 ? "💸" : "💰";
    const amt = Math.abs(e.amount).toFixed(2);
    const time = e.ts.slice(11, 16);
    const tag = e.status === "pending" ? " ⏳" : "";
    return `${sign} ${time} | ${e.account} | $${amt} | ${e.category}${e.payee ? ` | ${e.payee}` : ""}${tag}`;
  });

  const expenses = entries.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
  const income = entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);

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
      arm(); // reschedule for next day
    }, msUntilNextFiring());
  }

  arm();
}
