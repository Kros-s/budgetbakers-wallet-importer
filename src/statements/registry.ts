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
  /** Last reconciled month, "YYYY-MM", or null if never. */
  lastReceived: string | null;
  /** Days of grace after cutDay before nagging. Default 5. */
  graceDays?: number;
}

export type Registry = Record<string, RegistryEntry>; // account name → entry

const REGISTRY_PATH = path.resolve("data/statements/registry.json");

export function loadRegistry(): Registry {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")) as Registry;
  } catch {
    return {};
  }
}

export function saveRegistry(reg: Registry): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

export function markReceived(account: string, month: string): void {
  const reg = loadRegistry();
  const entry = reg[account];
  if (!entry) return;
  if (!entry.lastReceived || entry.lastReceived < month) entry.lastReceived = month;
  saveRegistry(reg);
}

function prevMonth(d: Date): string {
  const m = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Accounts whose previous-month statement is overdue: today is past
 * cutDay + graceDays and lastReceived < previous month.
 */
export function missingStatements(today = new Date()): { account: string; month: string; source: string }[] {
  const reg = loadRegistry();
  const expected = prevMonth(today);
  const out: { account: string; month: string; source: string }[] = [];
  for (const [account, e] of Object.entries(reg)) {
    const due = new Date(today.getFullYear(), today.getMonth(), Math.min(e.cutDay, 28) + (e.graceDays ?? 5));
    if (today < due) continue;
    if (e.lastReceived && e.lastReceived >= expected) continue;
    out.push({ account, month: expected, source: e.source });
  }
  return out;
}
