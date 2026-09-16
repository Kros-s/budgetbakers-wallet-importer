/**
 * @file webhook/merchant-history.ts
 * @description The category a merchant has always had, from Wallet itself.
 *
 * The extractor sees one email and nothing else, so it categorises each charge
 * from scratch. On 13-sep it filed TOKS as Groceries although fourteen earlier
 * TOKS charges were Restaurant, and on 12-sep it asked what "EST DE SERV TELLEZ"
 * was although nine earlier charges there were Fuel. The answer to both was
 * already in Wallet — corrected by hand, charge after charge.
 *
 * So after extraction, a merchant with a clear history gets that category, at
 * two levels of confidence measured against Wallet (backtest over 616 expenses,
 * mar–sep 2026, history built only from what came before each one):
 *
 *  - Filling a provisional `Others` needs three charges and a 70% majority. Any
 *    category with a history beats "unknown", and it spares a question.
 *  - Overriding a category the model did choose needs five and 80%. At that
 *    bar history disagreed with the recorded category 9% of the time — and most
 *    of those were history being right: Capricornio filed as "Bar, cafe" when
 *    the user's own rule says Restaurant, Portal de Fuego the other way round.
 *
 * Stores where the category depends on what was bought are never overridden:
 * an Amazon order is a gift one week and shopping the next. OXXO, filed as
 * groceries or shopping by what was bought, has no clear history anyway.
 */

import type { CsvRow } from "../csv.js";
import type { WalletRecord } from "../types.js";

/** Enough history to replace a provisional category. */
export const FILL_MIN_CHARGES = 3;
export const FILL_MIN_SHARE = 0.7;

/** Enough history to contradict a category the model chose. */
export const OVERRIDE_MIN_CHARGES = 5;
export const OVERRIDE_MIN_SHARE = 0.8;

/** Placeholders a history may always replace. */
const PROVISIONAL = new Set(["Others", "Uncategorized", "Unknown expense"]);

/** Stores whose category is decided by the purchase, not the store. */
const PURPOSE_DECIDES = new Set(["AMAZON", "MERCADOLIBRE", "MELI", "LIVERPOOL", "PALACIO", "SEARS", "COPPEL"]);

/**
 * Categories that are not a vote for what a merchant is. "Others" is the
 * provisional placeholder — counting it would let a merchant's unknowns
 * outvote what it actually is.
 */
const NOT_A_VOTE = new Set(["Others", "Uncategorized", "Unknown expense", "Unknown income", "Transfer, withdraw"]);

/** Tokens that carry no identity: articles, company suffixes, card-terminal noise. */
const STOP = new Set(["DE", "DEL", "LA", "EL", "LOS", "LAS", "Y", "SA", "CV", "SAB", "RL", "PAC", "PA", "MX", "MEX", "SUC", "EXP"]);

/**
 * First tokens shared by unrelated businesses. "EST" is every service station
 * and "MERPAGO" is every merchant paid through Mercado Pago, so for these the
 * next token is what identifies the business.
 */
const GENERIC_FIRST = new Set([
  "EST", "REST", "SUPER", "SUPR", "SUPERCENTER", "FARMACIA", "FARM", "TIENDA", "GAS", "SERV", "SERVICIO",
  "SERVICIOS", "COMERCIAL", "GPO", "GRUPO", "CIA", "THE", "MERPAGO", "MERCADOPAGO", "PAYPAL", "CLIP", "SR",
  "SRA", "OPENPAY", "STRIPE", "BAE", "PRIV", "CAFE", "BAR", "TACOS", "TAQUERIA", "PANADERIA", "HOTEL",
  "ESTACIONAMIENTO", "LAVADO", "AUTOLAVADO", "ABARROTES", "MINI", "MINISUPER", "OPERADORA", "DISTRIBUIDORA",
  "NETPAY", "ZETTLE", "SUMUP", "POS",
]);

/**
 * A payee reduced to what identifies the business.
 *
 * "TOKS PACHUCA COLOSIO PAC" and "Toks" are the same restaurant; "EST DE SERV
 * TELLEZ ZEM" and "EST SERV TELLEZ" the same station. Returns null for a payee
 * with nothing distinctive left.
 */
export function merchantKey(payee: string): string | null {
  const tokens = payee
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !STOP.has(t));
  if (tokens.length === 0) return null;
  if (!GENERIC_FIRST.has(tokens[0])) return tokens[0];
  return tokens.length > 1 ? `${tokens[0]} ${tokens[1]}` : null;
}

export interface MerchantVerdict {
  /** The merchant as `merchantKey` reduced it. */
  key: string;
  category: string;
  count: number;
  share: number;
}

export type MerchantLookup = (payee: string) => MerchantVerdict | null;

/** Builds the lookup from past records. Transfers and placeholders do not vote. */
export function buildMerchantLookup(
  records: Array<Pick<WalletRecord, "payee" | "categoryId" | "transfer" | "type">>,
  categoryNames: Record<string, string>
): MerchantLookup {
  const tally = new Map<string, Map<string, number>>();
  for (const r of records) {
    // Only what was spent there says what a merchant is. Counting income made
    // Chedraui a "Refunds" merchant, on the strength of returned purchases.
    if (r.transfer || Number(r.type) !== 1) continue;
    const category = categoryNames[String(r.categoryId)];
    if (!category || NOT_A_VOTE.has(category)) continue;
    const key = merchantKey(String(r.payee ?? ""));
    if (!key) continue;
    const counts = tally.get(key) ?? new Map<string, number>();
    counts.set(category, (counts.get(category) ?? 0) + 1);
    tally.set(key, counts);
  }

  return (payee) => {
    const key = merchantKey(payee);
    const counts = key ? tally.get(key) : undefined;
    if (!counts) return null;
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total < FILL_MIN_CHARGES) return null;
    const [category, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const share = count / total;
    return share >= FILL_MIN_SHARE ? { key: key!, category, count, share } : null;
  };
}

export interface HistoryChange {
  payee: string;
  from: string;
  to: string;
  count: number;
  share: number;
}

/**
 * Gives each charge the category its merchant has always had.
 *
 * Only expenses, and never transfers: a refund from a restaurant is not a
 * restaurant bill, and a transfer's category is structural, not a guess.
 */
export function applyMerchantHistory(
  rows: CsvRow[],
  lookup: MerchantLookup
): { rows: CsvRow[]; changes: HistoryChange[] } {
  const changes: HistoryChange[] = [];
  const out = rows.map((row) => {
    const isTransfer = row.category === "Transfer, withdraw";
    if (!row.payee || isTransfer) return row;
    if (parseFloat(row.amount) >= 0) return row;
    const verdict = lookup(row.payee);
    if (!verdict || verdict.category === row.category) return row;
    if (!PROVISIONAL.has(row.category)) {
      const strongEnough = verdict.count >= OVERRIDE_MIN_CHARGES && verdict.share >= OVERRIDE_MIN_SHARE;
      if (!strongEnough || PURPOSE_DECIDES.has(verdict.key.split(" ")[0])) return row;
    }
    changes.push({ payee: row.payee, from: row.category, to: verdict.category, count: verdict.count, share: verdict.share });
    return { ...row, category: verdict.category };
  });
  return { rows: out, changes };
}
