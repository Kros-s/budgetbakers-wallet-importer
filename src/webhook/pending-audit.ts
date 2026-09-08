/**
 * @file webhook/pending-audit.ts
 * @description Finds pending questions whose movement is already in Wallet.
 *
 * A question can be answered without the queue ever learning: the batch records
 * the movement from one email while the question came from another (banks send
 * two notifications per SPEI), or the user replies out of band. The queue then
 * keeps asking about money that is already booked. This reconciles the two.
 */

import type { ExistingRecord } from "./wallet-context.js";

/** How far the recorded date may sit from the date the email states. */
const DATE_SLACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuditCandidate {
  shortId: number;
  amountCents: number;
  /** The movement date as the email states it, when it states one. */
  movementDate: string | null;
  matches: ExistingRecord[];
}

export interface AuditVerdict {
  shortId: number;
  /** Safe to close: the movement is recorded and the dates agree. */
  resolved: boolean;
  reason: string;
  matches: ExistingRecord[];
}

/** Parses the loose date formats banks write, returning null when unsure. */
export function parseLooseDate(text: string | null): Date | null {
  if (!text) return null;
  const months: Record<string, number> = {
    ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5,
    jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11,
  };
  const named = /(\d{1,2})[/-]([A-Za-zÁ-úá-ú]{3})[A-Za-zÁ-úá-ú]*[/-](\d{4})/.exec(text);
  if (named) {
    const m = months[named[2].toLowerCase().slice(0, 3)];
    if (m !== undefined) return new Date(Number(named[3]), m, Number(named[1]));
  }
  const ymd = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(text);
  if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  const dmy = /(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(text);
  if (dmy) {
    const year = Number(dmy[3]) < 100 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    return new Date(year, Number(dmy[2]) - 1, Number(dmy[1]));
  }
  return null;
}

/**
 * Decides whether a candidate is safely resolved.
 *
 * Amount alone is not enough: two $50 purchases in a month are not the same
 * purchase. When the email states a date, the recorded movement has to sit near
 * it. When it does not, the amount has to be distinctive — a figure ending in
 * .00 is exactly the kind that repeats.
 */
export function judge(candidate: AuditCandidate): AuditVerdict {
  const { shortId, matches, amountCents, movementDate } = candidate;
  if (matches.length === 0) {
    return { shortId, resolved: false, reason: "no hay ningún registro con ese monto", matches };
  }

  const stated = parseLooseDate(movementDate);
  if (stated) {
    const near = matches.filter(
      (m) => Math.abs(Date.parse(m.recordDate) - stated.getTime()) <= DATE_SLACK_MS
    );
    if (near.length === 0) {
      return {
        shortId, resolved: false, matches,
        reason: "hay un registro con ese monto pero en otra fecha",
      };
    }
    return { shortId, resolved: true, matches: near, reason: "mismo monto y misma fecha" };
  }

  const isRound = amountCents % 100 === 0;
  if (isRound && matches.length > 1) {
    return {
      shortId, resolved: false, matches,
      reason: "monto redondo y varios registros iguales: no puedo distinguirlos",
    };
  }
  return {
    shortId, resolved: true, matches,
    reason: isRound ? "monto ya registrado (el correo no da fecha)" : "monto exacto ya registrado",
  };
}

/** One line per verdict, for the Telegram report. */
export function formatVerdict(v: AuditVerdict): string {
  const money = (c: number) => `$${(c / 100).toLocaleString("es-MX", { minimumFractionDigits: 2 })}`;
  const first = v.matches[0];
  const where = first
    ? ` → ${first.recordDate.slice(0, 10)} · ${first.accountName}${first.payee ? ` · ${first.payee.slice(0, 22)}` : ""}`
    : "";
  return `${v.resolved ? "✅" : "❔"} #${v.shortId} ${first ? money(first.amountCents) : ""}${where}\n     _${v.reason}_`;
}

/** How far apart two notifications of one movement may arrive. */
const SIBLING_SLACK_MS = 48 * 60 * 60 * 1000;

export interface SiblingCandidate {
  shortId: number;
  /** Sending institution, as `senderInstitution` names it. */
  institution: string;
  amountCents: number;
  /** The movement date as the email states it, when it states one. */
  movementDate: string | null;
  createdAt: number;
}

/**
 * The question already in the queue that asks about this same movement.
 *
 * A SPEI produces two notifications — one from the bank that sent it and one
 * from the bank that received it — and each became its own question. $26,151
 * and $15,000 were each asked twice in the same week; the daily summary even
 * said so ("se pregunta en 2 mensajes … probablemente el mismo movimiento"),
 * and then asked both anyway.
 *
 * Merging is only safe when a coincidence is implausible, because answering the
 * survivor closes both: if they were two real movements, the second is lost for
 * good. So the two must come from *different* institutions — the same bank
 * writing twice is far more likely to be two genuine charges — and land within
 * two days of each other.
 *
 * Round amounts get the stricter rule, the same one `judge` applies: $5,000
 * leaves one account and arrives at another all the time, so a figure ending in
 * .00 must also have both emails stating the same movement date. An unusual
 * amount like $58,753.01 is its own evidence.
 */
export function findSiblingQuestion(
  incoming: SiblingCandidate,
  pending: SiblingCandidate[]
): SiblingCandidate | null {
  if (!incoming.amountCents) return null;
  const isRound = incoming.amountCents % 100 === 0;

  const siblings = pending.filter((q) => {
    if (q.shortId === incoming.shortId) return false;
    if (q.amountCents !== incoming.amountCents) return false;
    if (q.institution === incoming.institution) return false;
    if (Math.abs(q.createdAt - incoming.createdAt) > SIBLING_SLACK_MS) return false;
    if (!isRound) return true;
    const a = parseLooseDate(q.movementDate);
    const b = parseLooseDate(incoming.movementDate);
    return a !== null && b !== null && a.getTime() === b.getTime();
  });

  // Two candidates means the merge itself is a guess; leave it to the user.
  return siblings.length === 1 ? siblings[0] : null;
}
