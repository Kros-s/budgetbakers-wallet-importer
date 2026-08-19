import fs from "fs";
import path from "path";

/**
 * @file batch/retention.ts
 * @description Age-based pruning for the files the bot and the batch leave
 * behind: one log per bot start (seven of them accumulated on 2026-08-19 alone)
 * and one ledger per day.
 */

export interface PruneOptions {
  dir: string;
  /** Only files whose basename matches are considered. */
  pattern: RegExp;
  maxAgeDays: number;
  /**
   * Newest files to keep no matter how old they are.
   *
   * Not a nicety: `latestWatermark()` reads the newest complete ledger to decide
   * where the next run starts, and during the Aug 5–19 outage that ledger was
   * already 14 days old. A plain age cutoff would have deleted the very file
   * that knew how far the pipeline had got, and the next run would have
   * re-scanned from its default lookback — re-proposing two weeks of movements
   * that were already recorded.
   */
  keepNewest: number;
  /** Injectable for tests. */
  now?: number;
}

export interface PruneResult {
  deleted: string[];
  kept: number;
}

/** Deletes matching files older than maxAgeDays, always sparing the newest N. */
export function pruneOldFiles(opts: PruneOptions): PruneResult {
  const { dir, pattern, maxAgeDays, keepNewest, now = Date.now() } = opts;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { deleted: [], kept: 0 };
  }

  const candidates = names
    .filter((n) => pattern.test(n))
    .map((n) => {
      const full = path.join(dir, n);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        return null;
      }
      return { name: n, full, mtimeMs };
    })
    .filter((f): f is { name: string; full: string; mtimeMs: number } => f !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];

  for (const [index, file] of candidates.entries()) {
    if (index < keepNewest) continue;
    if (file.mtimeMs >= cutoff) continue;
    try {
      fs.rmSync(file.full, { force: true });
      deleted.push(file.name);
    } catch { /* a file we cannot remove is not worth failing a run over */ }
  }

  return { deleted, kept: candidates.length - deleted.length };
}

export const LOG_RETENTION_DAYS = 15;
export const LEDGER_RETENTION_DAYS = 15;

/** Prunes the bot's per-start logs. Safe to call on every start. */
export function pruneBotLogs(dataBotDir: string, now?: number): PruneResult {
  return pruneOldFiles({
    dir: dataBotDir,
    pattern: /^bot-.*\.log$/,
    maxAgeDays: LOG_RETENTION_DAYS,
    keepNewest: 3,
    now,
  });
}

/** Prunes the discarded-email log, which grows one file per day. */
export function pruneVerdictLogs(dataBotDir: string, now?: number): PruneResult {
  return pruneOldFiles({
    dir: dataBotDir,
    pattern: /^verdicts-\d{4}-\d{2}-\d{2}\.jsonl$/,
    maxAgeDays: LOG_RETENTION_DAYS,
    keepNewest: 3,
    now,
  });
}

/** Prunes day ledgers, never touching the newest — the watermark lives there. */
export function pruneLedgers(dataBotDir: string, now?: number): PruneResult {
  return pruneOldFiles({
    dir: dataBotDir,
    pattern: /^day-ledger-\d{4}-\d{2}-\d{2}\.json$/,
    maxAgeDays: LEDGER_RETENTION_DAYS,
    keepNewest: 2,
    now,
  });
}
