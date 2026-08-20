/**
 * @file bot/email-facts.ts
 * @description Pulls the identifying details out of a bank email so a listing
 * can show them.
 *
 * The detail view used to print the local part of the sender — "notificaciones"
 * — which is the half that says nothing. The institution lives in the domain,
 * and Apple's private relay mangles that domain into the local part, so both
 * need undoing before anything useful can be shown.
 */

/** Domains whose name in the email is not the name the user thinks in. */
const KNOWN: Array<[RegExp, string]> = [
  [/banamex/i, "Banamex"],
  [/banorte/i, "Banorte"],
  [/bbva|bancomer/i, "BBVA / Bancomer"],
  [/santander/i, "Santander"],
  [/mercadopago|mercado_pago/i, "Mercado Pago"],
  [/americanexpress|amex/i, "American Express"],
  [/costco/i, "Costco"],
  [/cetesdirecto/i, "CetesDirecto"],
  [/dolarapp/i, "DolarApp"],
  [/\bnu\.com|nubank/i, "Nu"],
  [/mifel/i, "MIFEL"],
  [/klar/i, "Klar"],
  [/openbank/i, "Openbank"],
  [/revolut/i, "Revolut"],
  [/gbm/i, "GBM"],
  [/paypal/i, "PayPal"],
  [/stripe/i, "Stripe"],
  [/uala|ualá/i, "Ualá"],
  [/finsus/i, "FinSus"],
  [/bitso/i, "Bitso"],
];

/**
 * The sending domain, with Apple's private relay undone.
 *
 * Relay rewrites `costcomx@e.costco.mx` as
 * `costcomx_at_e_costco_mx_<hash>@icloud.com`, so the real domain is buried in
 * the local part with dots turned into underscores.
 */
export function senderDomain(from: string): string {
  const relay = /_at_([a-z0-9_]+)@/i.exec(from);
  if (relay) {
    // Relay appends one or two hash segments: e_costco_mx_hqb5pwb4zdfbtt_92524291.
    // Domain labels in these senders never contain digits, so drop from the
    // right while they do.
    const parts = relay[1].split("_");
    while (parts.length > 1 && /\d/.test(parts[parts.length - 1])) parts.pop();
    return parts.join(".");
  }
  const at = from.lastIndexOf("@");
  return at === -1 ? from : from.slice(at + 1);
}

/** A name the user recognises, falling back to the domain itself. */
export function senderInstitution(from: string): string {
  const domain = senderDomain(from);
  for (const [pattern, name] of KNOWN) {
    if (pattern.test(domain) || pattern.test(from)) return name;
  }
  return domain;
}

export interface EmailFacts {
  /** Card or account endings: ****1977, *******5933. */
  accounts: string[];
  /** Reference / operation numbers. */
  references: string[];
  /** Dates as written in the email. */
  dates: string[];
  /** Amounts as written, largest first. */
  amounts: string[];
}

const clean = (text: string) => text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

export function extractFacts(text: string): EmailFacts {
  const flat = clean(text);
  const uniq = (xs: string[]) => [...new Set(xs)];

  const accounts = uniq(
    [...flat.matchAll(/(?:\*{2,}\s?\d{3,4})|(?:terminaci[oó]n:?\s*\d{3,4})|(?:termina(?:da)?\s+en\s+\d{3,4})/gi)]
      .map((m) => m[0].replace(/\s+/g, " ").trim())
  ).slice(0, 6);

  const references = uniq(
    [...flat.matchAll(/(?:referencia|folio|orden|operaci[oó]n)\s*:?\s*([A-Z0-9-]{4,20})/gi)].map((m) => m[1])
  ).slice(0, 4);

  const dates = uniq(
    [...flat.matchAll(
      // dd/Mmm/yyyy · dd/mm/yyyy · yyyy/mm/dd · "8 de julio de 2026" · "08 julio 2026"
      /\b\d{1,2}[/-][A-Za-z]{3,}[/-]\d{4}\b|\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{1,2} (?:de )?[a-záéíóú]{4,10} (?:de )?\d{4}\b/gi
    )].map((m) => m[0])
  ).slice(0, 4);

  const amounts = uniq(
    [...flat.matchAll(/(?:\$|MXN|MN|USD)\s?\d[\d,]*(?:\.\d{2})?/gi)].map((m) => m[0].trim())
  )
    .sort((a, b) => {
      const n = (x: string) => Number(x.replace(/[^\d.]/g, "")) || 0;
      return n(b) - n(a);
    })
    .slice(0, 5);

  return { accounts, references, dates, amounts };
}

/**
 * The date the movement happened, as the bank states it.
 *
 * Not the same as when the email arrived, and it is the one that finds the
 * transaction in a bank statement. Banks label it, so the label is the signal:
 * a body can carry a cut-off date and a payment-due date too, and picking the
 * first date found would often pick one of those instead.
 */
export function movementDate(text: string): string | null {
  const flat = clean(text);
  const labelled =
    /fecha(?:\s+y\s+hora)?(?:\s+de\s+(?:la\s+)?(?:operaci[oó]n|movimiento|transacci[oó]n|compra))?\s*:?\s*([0-9]{1,4}[/-][0-9A-Za-zÁ-úá-ú]{1,9}[/-][0-9]{2,4}(?:[^0-9]{1,12}[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?(?:\s*[AaPp]\.?[Mm]\.?)?)?)/i;
  const m = labelled.exec(flat);
  if (m) return m[1].replace(/\s+/g, " ").trim();
  const any = extractFacts(text).dates;
  return any.length ? any[0] : null;
}

/** The facts as lines for the detail view. Empty when nothing was found. */
export function formatFacts(facts: EmailFacts): string[] {
  const lines: string[] = [];
  if (facts.amounts.length) lines.push(`💵 ${facts.amounts.join("  ·  ")}`);
  if (facts.accounts.length) lines.push(`💳 ${facts.accounts.join("  ·  ")}`);
  if (facts.dates.length) lines.push(`📅 ${facts.dates.join("  ·  ")}`);
  if (facts.references.length) lines.push(`🔖 ${facts.references.join("  ·  ")}`);
  return lines;
}

/**
 * A dot sized by the amount, so a queue is scanned rather than read.
 * Thresholds are about attention, not accounting: red is "look at this now".
 */
export function amountDot(cents: number): string {
  if (cents === 0) return "⚪";
  if (cents >= 1_000_000) return "🔴";
  if (cents >= 100_000) return "🟠";
  return "🟡";
}
