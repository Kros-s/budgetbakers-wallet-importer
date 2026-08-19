import fs from "fs";
import path from "path";

/**
 * Cheap rule-based email classifier that runs BEFORE any Claude invocation.
 *
 *  - "block"   → never processed (family Walmart/Cashi, known marketing).
 *  - "bank"    → sender is a known bank notification address; processed and
 *                prioritized for retries.
 *  - "unknown" → still processed (Haiku is cheap), but logged so recurring
 *                noise can be promoted to the blocklist.
 *
 * Rules live in data/bot/email-rules.json so they can be edited without a
 * deploy; the file is created from the defaults below on first use. Patterns
 * are case-insensitive regexes. `block` matches from+subject, `allow`
 * matches the sender only.
 */

export type EmailClass = "block" | "bank" | "unknown";

export interface EmailRules {
  block: string[];
  allow: string[];
}

const RULES_PATH = path.resolve("data/bot/email-rules.json");

// Seeded from the 2026-07/08 audit: senders that were always NO_TRANSACTION,
// plus Walmart/Cashi (family purchases — user submits their own via Telegram).
export const DEFAULT_RULES: EmailRules = {
  block: [
    "walmart\\.com",
    "cashi",
    "starbucks",
    "shop\\.app",
    "email\\.shop\\.app",
    "marketingdir@",
    "@email\\.banamex\\.com",
    "rappi",
    "uber\\s*(one|eats)",
    "netflix\\.com",
    "spotify\\.com",
    // Added from the 2026-08-19 catch-up dry-run: 100% NO_TRANSACTION over 285
    // emails. Anchored to the sender domain — `block` matches from+subject, so
    // a bare brand name would also block legitimate mail that merely mentions
    // it (e.g. a transfer notice naming the destination bank).
    // Private relay rewrites dots as underscores, hence [._].
    "e[._]costco[._]mx",          // Costco marketing; charges arrive via banamex
    "@github\\.com",
    "@promocinepolis\\.com",       // promos only — NOT confirmacion-compra@
    "@pluto\\.tv",
    "dslaboratories\\.com\\.mx",
    "global[._]metamail[._]com",  // Meta ad-product marketing
    "santander\\.com\\.mx",       // account unused; unblock notificaciones@ first if that changes
  ],
  allow: [
    "notificaciones@banamex\\.com",
    "notificaciones@banorte\\.com",
    "clientes(_at_|@)(email\\.)?bbva",
    "contacto@klar\\.mx",
    "mercadopago",
    "no-reply@gbm\\.com\\.mx",
    "openbank",
    "@nu\\.com",
    "americanexpress\\.com",
    "no-reply@revolut\\.com",
    "dolarapp",
    "bitso",
    "banregio|mifel|finsus|uala",
  ],
};

let cached: { rules: EmailRules; compiled: { block: RegExp[]; allow: RegExp[] } } | null = null;

function compile(rules: EmailRules) {
  return {
    block: rules.block.map((p) => new RegExp(p, "i")),
    allow: rules.allow.map((p) => new RegExp(p, "i")),
  };
}

export function loadRules(): EmailRules {
  if (cached) return cached.rules;
  let rules: EmailRules;
  try {
    rules = JSON.parse(fs.readFileSync(RULES_PATH, "utf8")) as EmailRules;
  } catch {
    rules = DEFAULT_RULES;
    fs.mkdirSync(path.dirname(RULES_PATH), { recursive: true });
    fs.writeFileSync(RULES_PATH, JSON.stringify(DEFAULT_RULES, null, 2));
  }
  cached = { rules, compiled: compile(rules) };
  return rules;
}

/** Test-only: inject rules without touching disk. */
export function setRulesForTest(rules: EmailRules | null): void {
  cached = rules ? { rules, compiled: compile(rules) } : null;
}

export function classifyEmail(from: string, subject: string): EmailClass {
  if (!cached) loadRules();
  const { block, allow } = cached!.compiled;
  const haystack = `${from} ${subject}`;
  if (block.some((r) => r.test(haystack))) return "block";
  if (allow.some((r) => r.test(from))) return "bank";
  return "unknown";
}
