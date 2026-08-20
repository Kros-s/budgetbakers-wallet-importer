import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";

export interface ClarificationEntry {
  /**
   * Short, permanent handle the user types to answer: `#118 salió de Banorte`.
   *
   * Deliberately NOT the position in a listing. A positional number answered a
   * few minutes later would land on whichever question had shifted into that
   * slot — a silent mistake that writes to real finances. It is also not the
   * Telegram message id, because /remind re-sends the question and that id
   * changes; this one survives.
   *
   * Optional only for entries created before the field existed; ensureShortIds
   * backfills them.
   */
  shortId?: number;
  /**
   * Other Telegram messages that present this same question — a /remind
   * resend, a /pending detail, a /next prompt. Replying to any of them
   * resolves it, because the user has no way to know which message the queue
   * happens to be keyed by, and a reply that falls through is read as a brand
   * new expense.
   */
  aliasMessageIds?: number[];
  chatId: number;
  emailFrom: string;
  emailSubject: string;
  emailText: string;
  /** ISO date the email was received, when the caller knew it. */
  emailDate?: string;
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
    const shortId =
      entry.shortId ?? Math.max(0, ...Object.values(store).map((e) => e.shortId ?? 0)) + 1;
    store[String(messageId)] = { ...entry, shortId };
    save(store);
  });
}

/** Removes and returns the clarification tied to a Telegram message_id. */
export function takeClarification(messageId: number): ClarificationEntry | null {
  return withLock(() => {
    const store = load();
    const key = String(messageId);
    if (store[key]) {
      const entry = store[key];
      const ids = messageIdsOf(key, entry);
      delete store[key];
      save(store);
      recordClosed(ids, entry.shortId ?? 0, "resuelta");
      return entry;
    }
    // Not the message the queue is keyed by — try the ones that present it too.
    for (const [k, entry] of Object.entries(store)) {
      if (entry.aliasMessageIds?.includes(messageId)) {
        const ids = messageIdsOf(k, entry);
        delete store[k];
        save(store);
        recordClosed(ids, entry.shortId ?? 0, "resuelta");
        return entry;
      }
    }
    return null;
  });
}

/**
 * Records that another message now shows this question, so replying to it
 * works. Unlike re-keying, the original message keeps working too.
 */
export function linkMessageId(shortId: number, messageId: number): void {
  withLock(() => {
    const store = load();
    for (const entry of Object.values(store)) {
      if (entry.shortId === shortId) {
        const aliases = new Set(entry.aliasMessageIds ?? []);
        aliases.add(messageId);
        entry.aliasMessageIds = [...aliases];
        save(store);
        return;
      }
    }
  });
}

/** Assigns a handle to any entry that predates the field. Returns them all. */
export function ensureShortIds(): Array<{ messageId: number; entry: ClarificationEntry }> {
  return withLock(() => {
    const store = load();
    let next = Math.max(0, ...Object.values(store).map((e) => e.shortId ?? 0)) + 1;
    let changed = false;
    // Oldest first, so the handles read in the order the questions arrived.
    for (const key of Object.keys(store).sort((a, b) => Number(a) - Number(b))) {
      if (store[key].shortId === undefined) {
        store[key].shortId = next++;
        changed = true;
      }
    }
    if (changed) save(store);
    return Object.entries(store).map(([k, entry]) => ({ messageId: Number(k), entry }));
  });
}

/** Looks up a pending clarification by its handle, without removing it. */
export function findByShortId(shortId: number): { messageId: number; entry: ClarificationEntry } | null {
  for (const [key, entry] of Object.entries(load())) {
    if (entry.shortId === shortId) return { messageId: Number(key), entry };
  }
  return null;
}

const CLOSED_PATH = join(process.cwd(), "data/bot/closed-clarifications.json");
const CLOSED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ClosedNote {
  shortId: number;
  reason: string;
  closedAt: number;
}

/**
 * Remembers which Telegram messages used to be questions.
 *
 * A closed question leaves its message on screen inviting a reply, and the reply
 * used to fall through to the generic handler — the bot answered "¿a qué correo
 * te refieres?" to someone replying to a specific email. Knowing the message was
 * a question is what lets it say so.
 */
export function recordClosed(messageIds: number[], shortId: number, reason: string): void {
  try {
    const log: Record<string, ClosedNote> = (() => {
      try {
        return JSON.parse(readFileSync(CLOSED_PATH, "utf8")) as Record<string, ClosedNote>;
      } catch {
        return {};
      }
    })();
    const cutoff = Date.now() - CLOSED_TTL_MS;
    for (const k of Object.keys(log)) if (log[k].closedAt < cutoff) delete log[k];
    for (const id of messageIds) log[String(id)] = { shortId, reason, closedAt: Date.now() };
    mkdirSync(join(process.cwd(), "data/bot"), { recursive: true });
    writeFileSync(CLOSED_PATH, JSON.stringify(log, null, 1));
  } catch {
    // Losing this costs a confusing reply, never data.
  }
}

export function findClosed(messageId: number): ClosedNote | null {
  try {
    const log = JSON.parse(readFileSync(CLOSED_PATH, "utf8")) as Record<string, ClosedNote>;
    return log[String(messageId)] ?? null;
  } catch {
    return null;
  }
}

/** Every message id that showed this question. */
function messageIdsOf(key: string, entry: ClarificationEntry): number[] {
  return [Number(key), ...(entry.aliasMessageIds ?? [])];
}

/** Peeks by Telegram message id, following the aliases. Does not remove. */
export function findByMessageId(messageId: number): { messageId: number; entry: ClarificationEntry } | null {
  const store = load();
  const direct = store[String(messageId)];
  if (direct) return { messageId, entry: direct };
  for (const [k, entry] of Object.entries(store)) {
    if (entry.aliasMessageIds?.includes(messageId)) return { messageId: Number(k), entry };
  }
  return null;
}

/**
 * Replaces the question text, keeping the entry in the queue.
 *
 * Used when answering produced another question rather than a record: the
 * movement is still unresolved, so it must stay in the queue — with the newest
 * question, not the one the user already answered.
 */
export function updateClarificationQuestion(shortId: number, question: string): void {
  withLock(() => {
    const store = load();
    for (const entry of Object.values(store)) {
      if (entry.shortId === shortId) {
        entry.claudeQuestion = question;
        save(store);
        return;
      }
    }
  });
}

/** Removes and returns the clarification with this handle. */
export function takeByShortId(shortId: number, reason = "resuelta"): ClarificationEntry | null {
  return withLock(() => {
    const store = load();
    for (const [key, entry] of Object.entries(store)) {
      if (entry.shortId === shortId) {
        const ids = messageIdsOf(key, entry);
        delete store[key];
        save(store);
        recordClosed(ids, shortId, reason);
        return entry;
      }
    }
    return null;
  });
}

/**
 * Moves a clarification to a new Telegram message id, keeping its handle.
 * Used by /remind, which re-sends the question so reply-to works on it again.
 */
export function rekeyClarification(oldMessageId: number, newMessageId: number): void {
  withLock(() => {
    const store = load();
    const entry = store[String(oldMessageId)];
    if (!entry) return;
    delete store[String(oldMessageId)];
    store[String(newMessageId)] = entry;
    save(store);
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
