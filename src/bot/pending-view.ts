/**
 * @file bot/pending-view.ts
 * @description Pure helpers behind /pending, /remind and answering by handle.
 *
 * Replying to the original Telegram message works while a question is fresh and
 * becomes unusable once a backlog builds up — 42 questions deep, finding the
 * right message means scrolling days of chat. These let the user address a
 * question by a short handle instead, and answer several at once.
 */

import { amountsInText } from "../batch/integrity.js";
import type { ClarificationEntry } from "../webhook/clarification-store.js";

export interface PendingItem {
  messageId: number;
  entry: ClarificationEntry;
}

/** Largest amount the question mentions, in cents. 0 when it names none. */
export function questionAmountCents(entry: ClarificationEntry): number {
  return Math.max(0, ...amountsInText(entry.claudeQuestion));
}

/**
 * Biggest amounts first, then oldest.
 *
 * Money order, not arrival order: a $33,750 transfer matters more than a $55
 * grocery category, and a queue sorted by date buries it under trivia.
 */
export function sortByImportance(items: PendingItem[]): PendingItem[] {
  return [...items].sort((a, b) => {
    const diff = questionAmountCents(b.entry) - questionAmountCents(a.entry);
    if (diff !== 0) return diff;
    return (a.entry.createdAt ?? 0) - (b.entry.createdAt ?? 0);
  });
}

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("es-MX", { minimumFractionDigits: 2 })}`;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Renders the list the user reads. Plain text: handles must survive escaping. */
export function formatPendingList(items: PendingItem[], limit = 10): string {
  if (items.length === 0) return "✅ No hay aclaraciones pendientes.";
  const sorted = sortByImportance(items);
  const shown = sorted.slice(0, limit);
  const lines = shown.map(({ entry }) => {
    const cents = questionAmountCents(entry);
    const amount = cents > 0 ? money(cents).padStart(13) : "".padStart(13);
    return `#${entry.shortId ?? "?"} ${amount}  ${oneLine(entry.claudeQuestion, 68)}`;
  });
  const header = `📋 ${items.length} pendiente${items.length === 1 ? "" : "s"}` +
    (items.length > shown.length ? ` · mostrando ${shown.length}, mayores primero` : "");
  const footer = items.length > shown.length
    ? `\n\n…y ${items.length - shown.length} más · /pending ${Math.min(items.length, limit + 20)} para ver más`
    : "";
  return `${header}\n\n${lines.join("\n\n")}${footer}\n\nResponde así: #${shown[0].entry.shortId ?? 1} tu respuesta`;
}

export interface ParsedAnswer {
  shortId: number;
  answer: string;
}

/**
 * Reads `#12 Groceries` lines, one or many in a message.
 *
 * Batch answering is where the queue actually drains: most questions are a
 * single word ("Groceries", "la Amex"), and 28 of them one at a time is a chore
 * nobody finishes.
 */
export function parseAnswers(text: string): ParsedAnswer[] {
  const out: ParsedAnswer[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const m = /^#(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const answer = m[2].trim();
    if (answer) out.push({ shortId: Number(m[1]), answer });
  }
  return out;
}

/** True when the message is addressed to handles rather than free text. */
export function looksLikeHandleAnswer(text: string): boolean {
  return /^\s*#\d+\s+\S/.test(text);
}
