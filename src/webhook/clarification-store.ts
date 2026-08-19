import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";

export interface ClarificationEntry {
  chatId: number;
  emailFrom: string;
  emailSubject: string;
  emailText: string;
  claudeQuestion: string;
  createdAt: number;
}

const STORE_PATH = join(process.cwd(), "data/bot/pending-clarifications.json");
const LOCK_PATH = `${STORE_PATH}.lock`;

/**
 * A pending clarification is user-actionable state, not a cache: it lives until
 * the user answers it. 90 days only exists so a question the user will clearly
 * never answer cannot pile up forever.
 *
 * It was 7 days, which silently destroyed 16 real questions on 2026-08-19: the
 * batch caught up on a two-week backlog, and the first new question it stored
 * pruned every question raised before the outage — the ones most in need of an
 * answer. Pruning is a side effect of an unrelated write, so it must be both
 * generous and loud.
 */
const TTL_MS = 90 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

type Store = Record<string, ClarificationEntry>;

function load(): Store {
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf8")) as Store;
  } catch {
    return {};
  }
}

function save(store: Store): void {
  mkdirSync(join(process.cwd(), "data/bot"), { recursive: true });
  // Write-then-rename: rename is atomic on POSIX, so a concurrent reader sees
  // either the old file or the new one, never a half-written one.
  const tmp = `${STORE_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, STORE_PATH);
}

/**
 * Serialises the read-modify-write cycle across processes. The nightly batch
 * appends questions while the bot removes the ones the user answers; without
 * this, whoever saved last silently reinstated the other's stale snapshot —
 * resurrecting an answered question or dropping a new one.
 */
function withLock<T>(fn: () => T): T {
  mkdirSync(join(process.cwd(), "data/bot"), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(LOCK_PATH, "wx");
      break;
    } catch {
      // Reclaim a lock left behind by a process that died mid-write.
      try {
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) {
          rmSync(LOCK_PATH, { force: true });
          continue;
        }
      } catch { /* the holder released it between our open and stat */ }
      if (Date.now() > deadline) break; // proceed unlocked rather than lose the write
      const until = Date.now() + 25;
      while (Date.now() < until) { /* brief spin: these writes are sub-millisecond */ }
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      closeSync(fd);
      if (existsSync(LOCK_PATH)) rmSync(LOCK_PATH, { force: true });
    }
  }
}

export function storeClarification(messageId: number, entry: ClarificationEntry): void {
  withLock(() => {
    const store = load();
    const cutoff = Date.now() - TTL_MS;
    for (const key of Object.keys(store)) {
      const age = store[key].createdAt;
      // Guard the comparison: a non-numeric createdAt would make `age < cutoff`
      // NaN-false and hide the entry from pruning forever.
      if (typeof age === "number" && age < cutoff) {
        console.warn(
          `[clarifications] purgada por antigüedad (>${TTL_MS / 86_400_000}d): "${store[key].emailSubject}"`
        );
        delete store[key];
      }
    }
    store[String(messageId)] = entry;
    save(store);
  });
}

/** Removes and returns the clarification tied to a Telegram message_id. */
export function takeClarification(messageId: number): ClarificationEntry | null {
  return withLock(() => {
    const store = load();
    const key = String(messageId);
    const entry = store[key] ?? null;
    if (entry) {
      delete store[key];
      save(store);
    }
    return entry;
  });
}

/** Every pending clarification, for the post-run integrity check and reminders. */
export function listClarifications(): Array<{ messageId: number; entry: ClarificationEntry }> {
  return Object.entries(load()).map(([key, entry]) => ({ messageId: Number(key), entry }));
}

/** Returns (without removing) the most recent clarification for a chat, if any. */
export function peekLatestClarification(
  chatId: number
): { messageId: number; entry: ClarificationEntry } | null {
  const store = load();
  let latest: { messageId: number; entry: ClarificationEntry } | null = null;
  for (const [key, entry] of Object.entries(store)) {
    if (entry.chatId === chatId) {
      if (!latest || entry.createdAt > latest.entry.createdAt) {
        latest = { messageId: Number(key), entry };
      }
    }
  }
  return latest;
}
