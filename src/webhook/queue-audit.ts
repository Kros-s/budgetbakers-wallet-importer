/**
 * @file webhook/queue-audit.ts
 * @description Closes the pending questions whose movement is already in Wallet.
 *
 * Banks notify a movement more than once, and the batch processes those
 * notifications in whatever order the inbox holds them. So one email of a
 * night's run books the movement while another, minutes later in the same run,
 * files a question about it: #69 asked on 15-sep where $46,732.53 had come from,
 * about a payment written from a different email that same night.
 *
 * `/audit` already knew how to catch that — but only when someone typed it.
 * Running it at the end of every batch makes it the default instead of a chore.
 *
 * This was three copies of one loop: the Telegram command, the terminal command,
 * and now the batch. A question must not be resolved in one surface and still
 * open in another, so there is one implementation and three callers.
 *
 * The judgement is `judge`'s, unchanged, and it never closes on a guess: a round
 * amount with several matches, or a match on another date, stays in the queue.
 */

import type { AxiosInstance } from "axios";

import type { LookupMaps } from "../types.js";
import { ensureShortIds, takeByShortId } from "./clarification-store.js";
import { findExistingByAmount } from "./wallet-context.js";
import { judge, type AuditVerdict } from "./pending-audit.js";
import { questionAmountCents } from "../bot/pending-view.js";
import { movementDate } from "../bot/email-facts.js";

export interface QueueAudit {
  /** Matched a recorded movement closely enough to close. */
  resolved: AuditVerdict[];
  /** Resembled a recorded movement, but not enough to close on. */
  doubtful: AuditVerdict[];
}

export interface QueueAuditOptions {
  /** Close the resolved questions. False reports without touching the queue. */
  close: boolean;
  /** Restrict to one chat's questions, as the Telegram command does. */
  chatId?: number;
  /** Recorded on each closed question, so a later reply knows why it went. */
  reason?: string;
}

/**
 * The date a question's movement is judged against.
 *
 * The body's own date when it states one; otherwise when the email arrived,
 * which every entry carries. Without this fallback, a body with no date sent
 * `judge` down its dateless branch, where one match of the same amount is
 * enough — and on 16-sep it matched a $150 payment to the Mercado Pago card
 * from 24-ago against a $150 OXXO charge on the Costco card three weeks later.
 * Harmless while /audit needed a human to read the result; not once the batch
 * closes what it finds every night.
 */
export function referenceDate(entry: {
  emailText: string;
  emailDate?: string;
  createdAt: number;
}): string {
  return movementDate(entry.emailText) ?? entry.emailDate ?? new Date(entry.createdAt).toISOString();
}

export async function auditQueue(
  couch: AxiosInstance,
  lookup: LookupMaps,
  opts: QueueAuditOptions
): Promise<QueueAudit> {
  const items = ensureShortIds()
    .filter((i) => opts.chatId === undefined || i.entry.chatId === opts.chatId)
    .map(({ entry }) => ({ entry, cents: questionAmountCents(entry) }))
    .filter((i) => i.cents > 0);

  const audit: QueueAudit = { resolved: [], doubtful: [] };
  if (items.length === 0) return audit;

  const namesById: Record<string, string> = {};
  for (const [name, id] of Object.entries(lookup.accounts)) namesById[id] = name;

  // One read of Wallet for the whole queue, split per question afterwards. The
  // loop this replaces listed every record in the window once per question.
  const existing = await findExistingByAmount(couch, [...new Set(items.map((i) => i.cents))], namesById);

  for (const { entry, cents } of items) {
    const matches = existing.filter((m) => m.amountCents === cents);
    if (matches.length === 0) continue;
    const verdict = judge({
      shortId: entry.shortId!,
      amountCents: cents,
      movementDate: referenceDate(entry),
      matches,
    });
    if (verdict.resolved) {
      if (opts.close) takeByShortId(entry.shortId!, opts.reason ?? "ya estaba en Wallet");
      audit.resolved.push(verdict);
    } else {
      audit.doubtful.push(verdict);
    }
  }
  return audit;
}
