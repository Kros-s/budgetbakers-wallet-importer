/**
 * @file statements/detect.ts
 * @description Which Wallet account a statement PDF belongs to, and for which
 * month.
 *
 * The bot's help has been promising "mándame el PDF y lo proceso" while a
 * statement actually fell through to the generic document handler — read it,
 * extract movements, propose a CSV — which knows nothing about statement
 * periods, per-bank profiles, or the totals a statement declares about itself.
 * Routing it properly starts with recognising it, and the hard part of that is
 * that no PDF calls the account what Wallet calls it: Banamex is Costco, BBVA
 * is Bancomer, ARQ is DolarApp.
 */

export interface Detection {
  issuer: string;
  kind: string;
  /** Card product or account name as printed — "Gold", "Platinum", "Oro". */
  product: string;
  period: { from: string; to: string };
}

/**
 * Issuer text → Wallet account. Ordered: the first match wins, so the
 * discriminating entries come before the general ones. "Banorte" alone is the
 * debit account only because the credit card was already claimed above it, and
 * the same holds for Mercado Pago against Meli.
 */
const ALIASES: { match: RegExp; account: string }[] = [
  { match: /banamex|costco/i, account: "Costco" },
  { match: /banorte.*(cr[ée]dito|tarjeta)|tarjeta.*banorte/i, account: "Banorte" },
  { match: /banorte/i, account: "Banorte débito" },
  { match: /(american express|\bamex\b).*(platinum)/i, account: "Platinum Credit Card" },
  { match: /(american express|\bamex\b)/i, account: "American Express" },
  { match: /bbva|bancomer/i, account: "Bancomer" },
  { match: /(mercado ?pago|mp).*(cr[ée]dito|tarjeta)|meli/i, account: "Meli" },
  { match: /mercado ?pago/i, account: "Mercado pago" },
  { match: /nu.*(cr[ée]dito|tarjeta)/i, account: "Nu crédito" },
  { match: /nu ?bank|nu.*(d[ée]bito|cuenta)/i, account: "NuBank Débito" },
  { match: /arq|d[óo]lar ?app|d[óo]lares digitales/i, account: "DolarApp" },
  { match: /mifel/i, account: "MIFEL" },
  { match: /klar/i, account: "Klar" },
  { match: /finsus/i, account: "FinSus" },
];

/** Reads the identification block the detection pass is asked to emit. */
export function parseDetection(text: string): Detection | null {
  const issuer = /EMISOR:\s*(.+)/.exec(text)?.[1]?.trim();
  const kind = /TIPO:\s*(.+)/.exec(text)?.[1]?.trim() ?? "";
  const product = /PRODUCTO:\s*(.+)/.exec(text)?.[1]?.trim() ?? "";
  const period = /PERIODO:\s*(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})/.exec(text);
  if (!issuer || !period) return null;
  const [, from, to] = period;
  if (from > to) return null;
  return { issuer, kind, product, period: { from, to } };
}

/**
 * Issuers that hold two Wallet accounts, and the pattern that tells them apart.
 *
 * Without this, an Amex statement whose text never repeats the word "Platinum"
 * falls through to the Gold alias and a month of Platinum charges is filed
 * against the wrong card. Refusing to guess between two known accounts is the
 * same rule as refusing to guess an unknown issuer — the harm is identical, and
 * only the unknown case was guarded.
 */
const AMBIGUOUS: { issuer: RegExp; discriminators: RegExp[] }[] = [
  // \bamex\b, not /amex/: "Banamex" contains it, and Banamex is Costco.
  { issuer: /american express|\bamex\b/i, discriminators: [/platinum/i, /gold|oro/i] },
  { issuer: /banorte/i, discriminators: [/cr[ée]dito|tarjeta/i, /d[ée]bito|cheques|enlace/i] },
  { issuer: /^(?!.*meli).*mercado ?pago/i, discriminators: [/cr[ée]dito|tarjeta/i, /inversi[óo]n|cuenta|rendimiento/i] },
  { issuer: /\bnu\b|nu ?bank|nu m[ée]xico/i, discriminators: [/cr[ée]dito|tarjeta/i, /d[ée]bito|cuenta/i] },
];

/**
 * The Wallet account name, or null when nothing matches confidently.
 *
 * Null means "ask" — filing a statement under a guessed account writes a month
 * of movements into an account that never saw them.
 */
export function resolveAccount(detection: Detection): string | null {
  const haystack = `${detection.issuer} ${detection.kind} ${detection.product}`;
  const ambiguous = AMBIGUOUS.find((a) => a.issuer.test(haystack));
  if (ambiguous && !ambiguous.discriminators.some((d) => d.test(haystack))) return null;
  for (const { match, account } of ALIASES) {
    if (match.test(haystack)) return account;
  }
  return null;
}

/**
 * The month the statement belongs to: the one its cut falls in.
 *
 * Checked against fourteen real statements from seven banks — all of them name
 * the month containing the close, never the month the period opened in. Meli's
 * "julio" runs 22-jun to 21-jul.
 */
export function monthOf(detection: Detection): string {
  return detection.period.to.slice(0, 7);
}

export const DETECTION_PROMPT =
  `Identifica este PDF. NO extraigas movimientos todavía. Responde SOLO con estas cuatro líneas:\n` +
  `ES_ESTADO_DE_CUENTA: si|no\n` +
  `EMISOR: <la institución tal como aparece en el documento>\n` +
  `TIPO: <tarjeta de crédito | cuenta de débito | cuenta de inversión | otro>\n` +
  `PRODUCTO: <el nombre del producto tal como aparece — "Gold", "Platinum", "Oro", "Enlace", ` +
  `"Cuenta con Rendimiento" — o "no dice" si el documento no lo nombra>\n` +
  `PERIODO: <inicio>..<fin> en YYYY-MM-DD, copiado del periodo que declara el propio estado\n` +
  `Si no es un estado de cuenta bancario, responde solo "ES_ESTADO_DE_CUENTA: no".`;

export function looksLikeStatement(text: string): boolean {
  return /ES_ESTADO_DE_CUENTA:\s*s[ií]/i.test(text);
}
