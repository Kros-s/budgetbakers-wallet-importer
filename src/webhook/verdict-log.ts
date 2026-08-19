import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

/**
 * @file webhook/verdict-log.ts
 * @description Append-only record of every email the classifier discarded.
 *
 * A discarded email leaves no other trace: no Wallet record, no question, no
 * ledger entry. When two of four verdicts turned out to be wrong on 2026-08-19,
 * the only reason anyone could tell was an unrelated parsing bug that had been
 * filing them as questions. This is that visibility, on purpose.
 */

export interface VerdictLogEntry {
  from: string;
  subject: string;
  /** The model's justification for discarding it. */
  reason: string;
  /** Why the verdict was overridden, or null when it stood. */
  challenged: string | null;
}

export function verdictLogPath(now = new Date()): string {
  return join(process.cwd(), "data", "bot", `verdicts-${now.toISOString().slice(0, 10)}.jsonl`);
}

export function logVerdict(entry: VerdictLogEntry, now = new Date()): void {
  try {
    mkdirSync(join(process.cwd(), "data", "bot"), { recursive: true });
    appendFileSync(
      verdictLogPath(now),
      `${JSON.stringify({ at: now.toISOString(), ...entry })}\n`,
      "utf8"
    );
  } catch {
    // Observability must never be able to fail a run.
  }
}
