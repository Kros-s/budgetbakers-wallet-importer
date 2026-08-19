/**
 * @file bot/guided-mode.ts
 * @description The short-lived "answer the next question with plain text" state
 * behind /next.
 *
 * The text handler deliberately never treats free text as an answer to a
 * pending question — "50 tacos efectivo" is a new expense, not a reply. Guided
 * mode is the narrow, explicit exception, and it closes on its own after two
 * minutes of silence so that ambiguity cannot outlive the user's attention.
 *
 * State is in memory on purpose: a restart ends the window, which is the same
 * thing two minutes of silence does.
 */

export const GUIDED_WINDOW_MS = 2 * 60 * 1000;

interface GuidedState {
  shortId: number;
  expiresAt: number;
}

const active = new Map<number, GuidedState>();

/** Opens the window on a question. Replaces any question already active. */
export function startGuided(chatId: number, shortId: number, now = Date.now()): void {
  active.set(chatId, { shortId, expiresAt: now + GUIDED_WINDOW_MS });
}

/**
 * The question this chat is answering, or null when the window is closed.
 * Expiry is evaluated on read rather than by a timer, so it survives restarts
 * and needs nothing running in the background.
 */
export function activeQuestion(chatId: number, now = Date.now()): number | null {
  const state = active.get(chatId);
  if (!state) return null;
  if (now >= state.expiresAt) {
    active.delete(chatId);
    return null;
  }
  return state.shortId;
}

/** True when a window was open and has just lapsed — the caller can say so. */
export function justExpired(chatId: number, now = Date.now()): boolean {
  const state = active.get(chatId);
  return state !== undefined && now >= state.expiresAt;
}

export function stopGuided(chatId: number): boolean {
  return active.delete(chatId);
}

/** Seconds left on the window, for the message shown to the user. */
export function secondsLeft(chatId: number, now = Date.now()): number {
  const state = active.get(chatId);
  if (!state) return 0;
  return Math.max(0, Math.ceil((state.expiresAt - now) / 1000));
}

/** Test-only: drops every open window. */
export function resetGuidedForTest(): void {
  active.clear();
}
