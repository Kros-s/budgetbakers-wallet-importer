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
import { amountDot, extractFacts, formatFacts, senderInstitution } from "./email-facts.js";

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

/** Telegram rejects anything over 4096; leave room for Markdown wrappers. */
const CHUNK_LIMIT = 3500;

/** Splits a body of lines into messages that Telegram will accept. */
export function chunkLines(lines: string[], limit = CHUNK_LIMIT): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > limit) {
      out.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) out.push(current);
  return out;
}

/** Strips markup and collapses whitespace — stored bodies can still be HTML. */
export function plainExcerpt(text: string, max: number): string {
  const flat = text
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}



/**
 * One line per question, all of them.
 *
 * The previous listing truncated each question to a fragment and still only
 * showed ten, so it managed to be both unreadable and incomplete. This one is
 * an index: enough to choose, never enough to answer. `/pending <handle>` is
 * where the detail lives.
 */
export function formatPendingIndex(items: PendingItem[]): string[] {
  if (items.length === 0) return ["✅ No hay aclaraciones pendientes."];
  const sorted = sortByImportance(items);
  const withAmount = sorted.filter((i) => questionAmountCents(i.entry) > 0);
  const without = sorted.filter((i) => questionAmountCents(i.entry) === 0);

  const lines: string[] = [`📋 *${items.length} pendientes*`, ""];

  if (withAmount.length) {
    lines.push(`*💰 Mueven dinero — ${withAmount.length}*`, "");
    for (const { entry } of withAmount) {
      const cents = questionAmountCents(entry);
      // Amount first and on its own line: it is what decides where to start.
      lines.push(`${amountDot(cents)} \`#${entry.shortId}\`  *${money(cents)}*`);
      lines.push(`      🏦 ${oneLine(senderInstitution(entry.emailFrom), 18)} · ${oneLine(entry.emailSubject, 32)}`);
      lines.push("");
    }
  }

  if (without.length) {
    lines.push(`*🏷️ Solo falta categoría — ${without.length}*`, "");
    for (const { entry } of without) {
      lines.push(`⚪ \`#${entry.shortId}\`  ${oneLine(entry.claudeQuestion, 56)}`);
    }
    lines.push("");
  }

  lines.push("👉 `/pending 35` detalle  ·  `#35 tu respuesta` para contestar");
  return chunkLines(lines);
}

/** Everything needed to answer one question without leaving the chat. */
export function formatPendingDetail(item: PendingItem): string {
  const { entry } = item;
  const cents = questionAmountCents(entry);
  const when = entry.createdAt ? new Date(entry.createdAt).toISOString().slice(0, 10) : "?";
  // The sender address is deliberately absent: with Apple private relay most of
  // them read like costcomx_at_e_costco_mx_hqb5pwb4zdfbtt@icloud.com, which
  // fills the screen and identifies nothing. The institution is the useful half.
  const facts = formatFacts(extractFacts(entry.emailText));
  const out: string[] = [
    `${amountDot(cents)} *#${entry.shortId}*  ·  🏦 *${senderInstitution(entry.emailFrom)}*`,
  ];
  if (cents > 0) out.push(`💵 *${money(cents)}*`);
  out.push(
    "",
    `📌 ${oneLine(entry.emailSubject, 80)}`,
    `🕐 En cola desde ${when}`
  );
  if (facts.length) out.push("", "*Datos del correo*", ...facts);
  out.push(
    "",
    "❓ *Lo que falta*",
    entry.claudeQuestion.trim(),
    "",
    "📄 *Texto del correo*",
    plainExcerpt(entry.emailText, 700),
    "",
    `↩️ Contesta \`#${entry.shortId} tu respuesta\`, o responde a este mensaje — también con foto o PDF.`
  );
  return out.join("\n");
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
