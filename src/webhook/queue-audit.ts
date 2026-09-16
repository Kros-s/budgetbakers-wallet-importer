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
      movementDate: movementDate(entry.emailText),
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
