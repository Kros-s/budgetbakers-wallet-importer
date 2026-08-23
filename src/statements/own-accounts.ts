/**
 * @file statements/own-accounts.ts
 * @description Recognising your own accounts on the other side of a movement.
 *
 * A statement never calls a counterparty what Wallet calls it. Bancomer prints
 * an incoming transfer from DolarApp as `SPEI RECIBIDO ARCUS FI / Sent from ARQ
 * / PIER 5, S.A de C.V.`, and nothing in that says "this is your own money
 * coming back". So the extractor read it the only way it could — income — and
 * July 2026 alone would have booked $296,031.22 of invented earnings while
 * DolarApp and FinSus kept a balance they no longer had.
 *
 * The asymmetry is what made it dangerous. Money LEAVING names where it goes
 * (`SPEI ENVIADO BANORTE`, `SPEI ENVIADO MIFEL`), was categorised as a transfer
 * and was already held for the month's crossing. Money ARRIVING names who sent
 * it, in the sender's legal name, and sailed through as income.
 *
 * This is the directory that closes the gap. It resolves as far as the evidence
 * supports and no further: a pattern that could denote more than one of your
 * accounts returns `UNRESOLVED`, which still holds the row for the crossing.
 * Holding costs a delay and a line in the report; guessing costs a movement
 * booked against the wrong account, which nothing downstream would question.
 */

/** A counterparty that is one of your accounts, but which one is not decidable. */
export const UNRESOLVED = "__own__";

export interface OwnCounterparty {
  /** Matched against the whole movement text — description, reference block, payee. */
  match: RegExp;
  /** The Wallet account it resolves to, or UNRESOLVED when the text cannot say. */
  account: string;
  /**
   * Every Wallet account this pattern could denote — used to disqualify the
   * entry when it is the statement's own account. A Banorte statement is full
   * of the word "Banorte", and without this every row on it would read as a
   * transfer to itself.
   */
  covers: string[];
  /** Why this pattern means what it means, for whoever edits this table next. */
  because: string;
}

/**
 * Ordered: the first match wins, so the discriminating entries come first.
 *
 * Every pattern here was read off one of the user's own statements. Adding one
 * from memory is how an unrelated payee starts being treated as an internal
 * transfer, so each carries the line that justifies it.
 */
export const OWN_COUNTERPARTIES: OwnCounterparty[] = [
  {
    match: /arcus\s*fi|sent from arq|pier\s*5|d[óo]lar\s?app|\barq\b/i,
    account: "DolarApp",
    covers: ["DolarApp"],
    because:
      "BBVA prints DolarApp's sponsor bank and legal name: 'SPEI RECIBIDO ARCUS FI / Sent from ARQ / PIER 5, S.A de C.V.'",
  },
  { match: /\bmifel\b/i, account: "MIFEL", covers: ["MIFEL"], because: "BBVA prints 'SPEI ENVIADO MIFEL'" },
  {
    match: /\bfinsus\b/i,
    account: "FinSus",
    covers: ["FinSus"],
    because: "FinSus names itself on the leg that leaves it: '22-jun SPEI ENVIADO Transferencia de Marco'",
  },
  { match: /\bklar\b/i, account: "Klar", covers: ["Klar"], because: "Klar's statement names itself" },
  { match: /bbva|bancomer/i, account: "Bancomer", covers: ["Bancomer"], because: "BBVA México is the Wallet account 'Bancomer'" },
  { match: /\buala\b|\bualá\b/i, account: "Uala", covers: ["Uala"], because: "Ualá prints its own name" },
  {
    match: /mercado\s?pago|\bmercadopago\b|merpago/i,
    account: UNRESOLVED,
    covers: ["Mercado pago", "Meli"],
    because:
      "Mercado Pago holds two Wallet accounts — 'Mercado pago' (balance) and 'Meli' (card). The description does not say which",
  },
  {
    match: /\bbanorte\b/i,
    account: UNRESOLVED,
    covers: ["Banorte", "Banorte débito"],
    because:
      "Banorte holds two Wallet accounts — 'Banorte débito' and 'Banorte' (credit). A SPEI could be a transfer or a card payment",
  },
  {
    match: /\bnu\s?bank\b|\bnu\b(?!\w)/i,
    account: UNRESOLVED,
    covers: ["NuBank Débito", "Nu crédito"],
    because: "Nu holds two Wallet accounts — 'NuBank Débito' and 'Nu crédito'",
  },
];

/**
 * Which of your accounts is on the other side of this movement, if any.
 *
 * `self` is the account whose statement this is. Any entry that could denote it
 * is skipped rather than matched: a statement names its own issuer on every
 * page, and a movement resolving to the account it was read from is not a
 * transfer, it is the statement's letterhead.
 */
export function ownAccountFor(text: string, self: string): string | null {
  if (!text) return null;
  for (const entry of OWN_COUNTERPARTIES) {
    if (entry.covers.includes(self)) continue;
    if (entry.match.test(text)) return entry.account;
  }
  return null;
}

/** True when the counterparty is yours, whether or not it could be named. */
export function isOwnCounterparty(text: string, self: string): boolean {
  return ownAccountFor(text, self) !== null;
}

/** How the hold reads in the report. */
export function describeOwnCounterparty(account: string): string {
  return account === UNRESOLVED
    ? "contraparte es una cuenta propia (sin identificar cuál)"
    : `contraparte es tu cuenta ${account}`;
}
