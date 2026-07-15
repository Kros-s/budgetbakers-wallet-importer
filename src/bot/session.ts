import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { CsvRow } from "../csv.js";

export interface PendingProposal {
  rows: CsvRow[];
  summary: string;
  createdAt: number;
  /** Telegram message_id of the proposal message; set after the message is sent. */
  messageId?: number;
}

export interface BotSession {
  chatId: number;
  /** UUID we pass to claude --session-id / --resume. Generated on first turn. */
  claudeSessionId: string;
  /** Count of Claude invocations for this session. 0 = first turn (use --session-id). */
  turnsSent: number;
  lastSeenAt: number;
  /** FIFO queue of proposals awaiting confirmation. */
  pendingQueue: PendingProposal[];
}

// ── Disk persistence for pending proposals ──────────────────────────────────
// Proposals are written to disk so they survive service restarts.

const PENDING_PATH = join(process.cwd(), "data/bot/pending-proposals.json");

type PendingStore = Record<string, PendingProposal[]>; // chatId string → proposals

function loadPendingStore(): PendingStore {
  try {
    return JSON.parse(readFileSync(PENDING_PATH, "utf8")) as PendingStore;
  } catch {
    return {};
  }
}

function flushPending(chatId: number, queue: PendingProposal[]): void {
  mkdirSync(join(process.cwd(), "data/bot"), { recursive: true });
  const store = loadPendingStore();
  if (queue.length === 0) {
    delete store[String(chatId)];
  } else {
    store[String(chatId)] = queue;
  }
  writeFileSync(PENDING_PATH, JSON.stringify(store, null, 2));
}

// ── In-memory sessions ───────────────────────────────────────────────────────

const sessions = new Map<number, BotSession>();

export function getOrCreateSession(chatId: number): BotSession {
  let s = sessions.get(chatId);
  if (!s) {
    // Restore pending proposals from disk on first access after a restart.
    const stored = loadPendingStore();
    const pendingQueue: PendingProposal[] = stored[String(chatId)] ?? [];
    s = {
      chatId,
      claudeSessionId: randomUUID(),
      turnsSent: 0,
      lastSeenAt: Date.now(),
      pendingQueue,
    };
    sessions.set(chatId, s);
  } else {
    s.lastSeenAt = Date.now();
  }
  return s;
}

export function markTurnSent(chatId: number): void {
  const s = sessions.get(chatId);
  if (s) s.turnsSent += 1;
}

export function resetSession(chatId: number): BotSession {
  sessions.delete(chatId);
  return getOrCreateSession(chatId);
}

/** Enqueues a new pending proposal and flushes to disk. */
export function setPending(chatId: number, pending: PendingProposal): void {
  const s = getOrCreateSession(chatId);
  s.pendingQueue.push(pending);
  flushPending(chatId, s.pendingQueue);
}

/**
 * Attaches the Telegram message_id to the most-recently-enqueued proposal
 * and flushes to disk.
 */
export function setPendingMessageId(chatId: number, messageId: number): void {
  const s = sessions.get(chatId);
  if (!s || s.pendingQueue.length === 0) return;
  const last = s.pendingQueue[s.pendingQueue.length - 1];
  if (last.messageId === undefined) {
    last.messageId = messageId;
    flushPending(chatId, s.pendingQueue);
  }
}

/**
 * Removes and returns a pending proposal, flushing disk afterward.
 *
 * - If `messageId` is provided, finds the entry with that message_id.
 * - Otherwise takes the oldest entry (FIFO).
 *
 * Returns null if the queue is empty or the messageId is not found.
 */
export function takePending(chatId: number, messageId?: number): PendingProposal | null {
  const s = sessions.get(chatId);
  if (!s || s.pendingQueue.length === 0) return null;

  let entry: PendingProposal | undefined;
  if (messageId !== undefined) {
    const idx = s.pendingQueue.findIndex((p) => p.messageId === messageId);
    if (idx === -1) return null;
    [entry] = s.pendingQueue.splice(idx, 1);
  } else {
    entry = s.pendingQueue.shift();
  }

  if (entry) flushPending(chatId, s.pendingQueue);
  return entry ?? null;
}

/** Removes all pending proposals, flushes disk, and returns them. Used by /cancel. */
export function clearAllPending(chatId: number): PendingProposal[] {
  const s = sessions.get(chatId);
  if (!s) return [];
  const all = [...s.pendingQueue];
  s.pendingQueue = [];
  flushPending(chatId, []);
  return all;
}

export function getSessionStats(): { activeChats: number } {
  return { activeChats: sessions.size };
}
