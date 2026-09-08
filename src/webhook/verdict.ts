/**
 * @file webhook/verdict.ts
 * @description Reading — and second-guessing — the model's "there is nothing to
 * record here" verdict.
 *
 * Discarding an email is the one decision in the pipeline with no downstream
 * check: a wrong CSV shows up in Wallet and a wrong question reaches the user,
 * but a wrong NO_TRANSACTION leaves no trace at all. On 2026-08-19 two of four
 * such verdicts were wrong, one of them hiding a $5,000 deposit whose body
 * literally read "Recibiste $5,000.00 MN" — the model had latched onto the word
 * "cancelada" in the sender's template name.
 */

import { classifyEmail } from "../classifier/email-rules.js";

export interface Verdict {
  isNoTransaction: boolean;
  /** The model's justification, when it gave one. */
  reason: string;
}

/**
 * The prompt asks for exactly "NO_TRANSACTION", and the model reliably adds its
 * reasoning anyway. Matching on equality filed every one of those as if it were
 * a question to the user — so accept the token wherever it leads, and keep the
 * explanation instead of throwing it away.
 */
export function parseVerdict(responseText: string): Verdict {
  const trimmed = responseText.trim();

  // Leading: "NO_TRANSACTION El correo es un aviso…"
  const leading = /^NO[_ ]TRANSACTION\b[:.\-–—]?\s*/i.exec(trimmed);
  if (leading) return { isNoTransaction: true, reason: trimmed.slice(leading[0].length).trim() };

  // Trailing: "Confirmado, se descarta por reembolso. NO_TRANSACTION".
  // The model reaches for this shape when it agrees with the user, and reading
  // only the leading form filed those agreements back as fresh questions.
  const trailing = /[\s.:\-–—]NO[_ ]TRANSACTION\.?$/i.exec(trimmed);
  if (trailing) {
    return { isNoTransaction: true, reason: trimmed.slice(0, trailing.index).trim() };
  }
  return { isNoTransaction: false, reason: "" };
}

/** Money written the way Mexican banks write it. */
const MONEY = /(?:\$|MXN|MN)\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*\.\d{2}\s?(?:MXN|MN)/gi;

/** Verbs that mean money actually moved, not that it might. */
const MOVEMENT = /\b(recibiste|recibió|recibio|enviaste|envió|envio|cargo|cargaron|abono|abonaron|retiro|retiraste|dep[oó]sito|depositaron|transferencia|traspaso|pagaste|compra(?:ste)?|se aplic[oó])\b/i;

/** How close a verb has to sit to the amount to be talking about it. */
const ADJACENCY = 60;

/** True when the body shows an amount next to a verb of movement. */
export function bodyShowsMovement(body: string): boolean {
  const text = body.replace(/\s+/g, " ");
  for (const match of text.matchAll(MONEY)) {
    const at = match.index ?? 0;
    const window = text.slice(Math.max(0, at - ADJACENCY), at + match[0].length + ADJACENCY);
    if (MOVEMENT.test(window)) return true;
  }
  return false;
}

export interface Challenge {
  /** Why the verdict is not being taken at face value. */
  reason: string;
  /** The question to put to the user instead of discarding the email. */
  question: string;
}

/**
 * Returns null when the verdict stands, or a Challenge when it should become a
 * question instead. Deterministic on purpose: a second model call would be
 * another opinion of the same kind, and this needs to be a different kind.
 */
export function challengeNoTransaction(input: {
  from: string;
  subject: string;
  body: string;
  reason: string;
}): Challenge | null {
  const { from, subject, body, reason } = input;

  // The model says no money moved, while the bank that sent it says otherwise.
  if (classifyEmail(from, subject) === "bank" && bodyShowsMovement(body)) {
    return {
      reason: "remitente bancario y el cuerpo muestra un monto junto a un verbo de movimiento",
      question:
        "El clasificador descartó este correo, pero viene de un banco y el texto menciona un movimiento con monto. " +
        `Su razón fue: "${reason}". ¿Es una transacción real? Si sí, dime cuenta y categoría.`,
    };
  }

  // "Not a bank transaction" is true and beside the point: cash is tracked too.
  if (/\befectivo\b/i.test(reason) || /no (?:es|constituye) una transacci[oó]n bancaria/i.test(reason)) {
    return {
      reason: "el veredicto reconoce un pago en efectivo, que sí se registra en la cuenta Wallet",
      question:
        "El clasificador lo descartó por no ser bancario, pero parece un pago en efectivo. " +
        `Su razón fue: "${reason}". ¿Lo registro en tu cuenta Wallet? Dime monto y categoría si falta algo.`,
    };
  }

  return null;
}

/**
 * True when the reply is not a question but a finding: the movement the email
 * announces is already in Wallet.
 *
 * The prompt gives the model the matching records, so it can reach the right
 * conclusion — "Sí, ya está registrado: … No propongo CSV." — and the pipeline
 * then filed that conclusion as a *question* and asked the user to answer it.
 * Three of those sat in the queue for two weeks; nothing could ever resolve
 * them, because there was nothing left to resolve.
 *
 * A question mark disqualifies the text outright. "¿Ya está registrado?" is the
 * model asking, not concluding, and the two must never collapse into one: the
 * cost of reading a question as a finding is a movement dropped in silence.
 */
export function claimsAlreadyRecorded(responseText: string): boolean {
  if (responseText.includes("?") || responseText.includes("¿")) return false;
  const flat = responseText
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  return /\bya\s+(?:esta|estaba|fue|quedo|lo\s+tengo|los\s+tengo)\s*(?:registrad[oa]s?|en\s+wallet)/.test(flat)
    || /\bya\s+(?:esta|estaba)\s+en\s+wallet\b/.test(flat);
}
