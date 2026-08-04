import type { AxiosInstance } from "axios";

import { listRecordsByDateRange } from "../records.js";
import type { WalletRecord } from "../types.js";
import type { WalletDedupCheck } from "../webhook/email-processor.js";

/**
 * Duplicate gate against REAL Wallet records — the source of truth — instead
 * of only the local 3 h tracker window. All records whose recordDate falls in
 * the run window (± slack) are fetched once up front; each proposal is then
 * checked in memory.
 *
 * A proposal is a duplicate when an existing record has:
 *   same accountId + same type + same amount (minor units) + recordDate
 *   within `slackMs` (default 48 h) + payee match when both are non-empty.
 */

const DEFAULT_SLACK_MS = 48 * 60 * 60 * 1000;

function normalizePayee(p: string): string {
  return p.trim().toLowerCase().replace(/\s+/g, " ");
}

export function matchesExisting(
  existing: Pick<WalletRecord, "accountId" | "amount" | "type" | "recordDate" | "payee">,
  candidate: { accountId: string; amount: number; type: 0 | 1; recordDate: string; payee?: string },
  slackMs = DEFAULT_SLACK_MS
): boolean {
  if (existing.accountId !== candidate.accountId) return false;
  if (existing.type !== candidate.type) return false;
  if (existing.amount !== candidate.amount) return false;
  const dt = Math.abs(Date.parse(existing.recordDate) - Date.parse(candidate.recordDate));
  if (Number.isNaN(dt) || dt > slackMs) return false;
  const ep = existing.payee ? normalizePayee(existing.payee) : "";
  const cp = candidate.payee ? normalizePayee(candidate.payee) : "";
  if (ep && cp && ep !== cp) return false;
  return true;
}

export async function buildWalletDedup(
  couch: AxiosInstance,
  windowFrom: Date,
  windowTo: Date,
  slackMs = DEFAULT_SLACK_MS
): Promise<{ check: WalletDedupCheck; existingCount: number }> {
  const from = new Date(windowFrom.getTime() - slackMs).toISOString();
  const to = new Date(windowTo.getTime() + slackMs).toISOString();
  const existing = await listRecordsByDateRange(couch, from, to);

  const check: WalletDedupCheck = (rec) => {
    const hit = existing.find((e) => matchesExisting(e, rec, slackMs));
    if (!hit) return null;
    return `duplicado en Wallet: ${hit._id} (${hit.recordDate}${hit.payee ? `, ${hit.payee}` : ""})`;
  };

  return { check, existingCount: existing.length };
}
