/**
 * @file bot/session.ts
 * @description In-memory session state per Telegram chat id.
 *
 * Each chat keeps a stable Claude `--session-id` (a UUID generated on first
 * message) that we reuse via `--resume` to maintain conversation context
 * across messages. We also maintain a FIFO queue of pending CSV proposals
 * produced by Claude, each tied to the Telegram message_id of its proposal
 * message. Confirmation is routed to the right entry via message_id (inline
 * button or reply-to), falling back to FIFO order for plain "si" messages.
 */

import { randomUUID } from "crypto";
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

const sessions = new Map<number, BotSession>();

export function getOrCreateSession(chatId: number): BotSession {
  let s = sessions.get(chatId);
  if (!s) {
    s = {
      chatId,
      claudeSessionId: randomUUID(),
      turnsSent: 0,
      lastSeenAt: Date.now(),
      pendingQueue: [],
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

/** Enqueues a new pending proposal. */
export function setPending(chatId: number, pending: PendingProposal): void {
  const s = getOrCreateSession(chatId);
  s.pendingQueue.push(pending);
}

/**
 * Attaches the Telegram message_id to the most-recently-enqueued proposal
 * (the one that was just sent and whose message_id wasn't known at enqueue time).
 */
export function setPendingMessageId(chatId: number, messageId: number): void {
  const s = sessions.get(chatId);
  if (!s || s.pendingQueue.length === 0) return;
  const last = s.pendingQueue[s.pendingQueue.length - 1];
  if (last.messageId === undefined) last.messageId = messageId;
}

/**
 * Removes and returns a pending proposal.
 *
 * - If `messageId` is provided, finds the entry with that message_id.
 * - Otherwise takes the oldest entry (FIFO).
 *
 * Returns null if the queue is empty or the messageId is not found.
 */
export function takePending(chatId: number, messageId?: number): PendingProposal | null {
  const s = sessions.get(chatId);
  if (!s || s.pendingQueue.length === 0) return null;

  if (messageId !== undefined) {
    const idx = s.pendingQueue.findIndex((p) => p.messageId === messageId);
    if (idx === -1) return null;
    const [entry] = s.pendingQueue.splice(idx, 1);
    return entry;
  }

  return s.pendingQueue.shift() ?? null;
}

/** Removes all pending proposals and returns them. Used by /cancel. */
export function clearAllPending(chatId: number): PendingProposal[] {
  const s = sessions.get(chatId);
  if (!s) return [];
  const all = [...s.pendingQueue];
  s.pendingQueue = [];
  return all;
}

export function getSessionStats(): { activeChats: number } {
  return { activeChats: sessions.size };
}
