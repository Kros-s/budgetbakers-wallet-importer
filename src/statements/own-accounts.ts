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
  /**
   * Whether the pattern alone is enough, or the movement must also be the
   * holder's own.
   *
   * A bank name is not evidence of whose money it is: anyone can bank at BBVA,
   * and Banorte débito's July carried two SPEIs to a `Marlene Miriam Vazquez
   * Peña` at BBVA that the bank-name rule claimed as internal transfers. A
   * sponsor rail that serves exactly one product is different — money from
   * DolarApp's operating company can only be the user's own DolarApp balance.
   */
  requiresHolder: boolean;
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
    requiresHolder: false,
    because:
      "BBVA prints DolarApp's sponsor bank and legal name: 'SPEI RECIBIDO ARCUS FI / Sent from ARQ / PIER 5, S.A de C.V.'",
  },
  { match: /\bmifel\b/i, account: "MIFEL", covers: ["MIFEL"], requiresHolder: true, because: "BBVA prints 'SPEI ENVIADO MIFEL'" },
  {
    match: /\bfinsus\b/i,
    account: "FinSus",
    covers: ["FinSus"],
    requiresHolder: true,
    because: "FinSus names itself on the leg that leaves it: '22-jun SPEI ENVIADO Transferencia de Marco'",
  },
  { match: /\bklar\b/i, account: "Klar", covers: ["Klar"], requiresHolder: true, because: "Klar's statement names itself" },
  { match: /bbva|bancomer/i, account: "Bancomer", covers: ["Bancomer"], requiresHolder: true, because: "BBVA México is the Wallet account 'Bancomer'" },
  { match: /\buala\b|\bualá\b/i, account: "Uala", covers: ["Uala"], requiresHolder: true, because: "Ualá prints its own name" },
  {
    match: /mercado\s?pago|\bmercadopago\b|merpago/i,
    account: UNRESOLVED,
    covers: ["Mercado pago", "Meli"],
    requiresHolder: true,
    because:
      "Mercado Pago holds two Wallet accounts — 'Mercado pago' (balance) and 'Meli' (card). The description does not say which",
  },
  {
    match: /\bbanorte\b/i,
    account: UNRESOLVED,
    covers: ["Banorte", "Banorte débito"],
    requiresHolder: true,
    because:
      "Banorte holds two Wallet accounts — 'Banorte débito' and 'Banorte' (credit). A SPEI could be a transfer or a card payment",
  },
  {
    match: /\bnu\s?bank\b|\bnu\b(?!\w)/i,
    account: UNRESOLVED,
    covers: ["NuBank Débito", "Nu crédito"],
    requiresHolder: true,
    because: "Nu holds two Wallet accounts — 'NuBank Débito' and 'Nu crédito'",
  },
];

/**
 * The account holder's name, for telling your own money from someone else's.
 *
 * Set `STATEMENT_HOLDER` to the name as the banks print it. Unset, the
 * unresolved patterns below hold every movement they touch, which is noisy but
 * never wrong in the dangerous direction.
 */
export function statementHolder(): string | undefined {
  return process.env.STATEMENT_HOLDER?.trim() || undefined;
}

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Whether this movement names the account holder rather than somebody else.
 *
 * Three of the holder's name parts have to appear, or all of them when the name
 * is shorter than that. Statements truncate — "MARCO ANTONIO MAYEN" for
 * "MARCO ANTONIO MAYEN HERNANDEZ" — so demanding the whole name fails on the
 * user's own transfers, while one part in common would make any stranger who
 * shares a first name look like him.
 */
export function namesHolder(text: string, holder: string | undefined): boolean {
  if (!holder) return false;
  const wanted = tokens(holder);
  if (wanted.length === 0) return false;
  const present = new Set(tokens(text));
  const hits = wanted.filter((t) => present.has(t)).length;
  return hits >= Math.min(3, wanted.length);
}

/**
 * Which of your accounts is on the other side of this movement, if any.
 *
 * `self` is the account whose statement this is. Any entry that could denote it
 * is skipped rather than matched: a statement names its own issuer on every
 * page, and a movement resolving to the account it was read from is not a
 * transfer, it is the statement's letterhead.
 *
 * An entry that resolves to a single account is evidence on its own — nobody
 * else sends the user money through DolarApp's sponsor bank. An UNRESOLVED one
 * is not: it matched a payment rail, and anybody can pay you from Banorte or
 * through Mercado Pago. So those additionally require the movement to name the
 * holder, which is exactly what separates his $5,000 from Mercado Pago
 * ("MARCO ANTONIO MAYEN HERNANDEZ") from the $2,784 a debtor repaid him
 * through the same rail ("OCTAVIO ROA SAAVEDRA"). With no holder configured
 * the requirement cannot be tested and the row is held anyway.
 */
export interface OwnLookup {
  /** The name the banks print for the account holder. Defaults to `STATEMENT_HOLDER`. */
  holder?: string;
  /**
   * The counterparty the extractor distilled from the movement, when there was
   * one. Empty, or naming a rail rather than a person, means the statement
   * named nobody — which is not the same as naming somebody else.
   */
  payee?: string;
}

/** Names that identify a wire or a bank, never the party at the other end. */
const RAIL_NAMES = /^(stp|spei|clabe|banco|banorte|bbva|bancomer|banamex|klar|mifel|finsus|nu|nubank|mercado ?pago|arq|dolarapp|transferencia|abono|dep[óo]sito)s?$/i;

export function ownAccountFor(text: string, self: string, opts: OwnLookup | string = {}): string | null {
  const { holder = statementHolder(), payee } = typeof opts === "string" ? { holder: opts, payee: undefined } : opts;
  if (!text) return null;
  for (const entry of OWN_COUNTERPARTIES) {
    if (entry.covers.includes(self)) continue;
    if (!entry.match.test(text)) continue;
    if (entry.requiresHolder && !isHolders(text, payee, holder)) continue;
    return entry.account;
  }
  return null;
}

/**
 * Whether a movement matched by a bank name is the holder's own money.
 *
 * Three answers, and the middle one is the whole point. Banorte débito's July
 * carries `SPEI RECIBIDO, BCO:0012 BBVA MEXICO ... DEL CLIENTE MARCO ANTONIO
 * MAYEN HERNANDEZ` — his. It also carries `COMPRA ORDEN DE PAGO SPEI ...
 * BCO:012 BENEF:Marlene Miriam Vazquez Peña` — not his, however much the word
 * BBVA appears. And BBVA's own `SPEI RECIBIDO STP` names nobody at all, which
 * is not evidence of a third party and so is held rather than written.
 */
function isHolders(text: string, payee: string | undefined, holder: string | undefined): boolean {
  if (namesHolder(`${text} ${payee ?? ""}`, holder)) return true;
  const named = payee?.trim();
  // Nobody named: unknown, and unknown waits.
  if (!named || RAIL_NAMES.test(named)) return true;
  return false;
}

/** True when the counterparty is yours, whether or not it could be named. */
export function isOwnCounterparty(text: string, self: string, opts: OwnLookup | string = {}): boolean {
  return ownAccountFor(text, self, opts) !== null;
}

/** How the hold reads in the report. */
export function describeOwnCounterparty(account: string): string {
  return account === UNRESOLVED
    ? "contraparte es una cuenta propia (sin identificar cuál)"
    : `contraparte es tu cuenta ${account}`;
}
