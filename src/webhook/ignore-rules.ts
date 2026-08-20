/**
 * @file webhook/ignore-rules.ts
 * @description Adding "never ask me about this again" rules from Telegram.
 *
 * The classifier's block list matches sender *and* subject, which is what makes
 * this safe: CetesDirecto sends real movements, so blocking the institution
 * would lose money, while "Cambio de politica de reinversion automatica" is
 * never a movement whoever sends it. The unit of ignoring is the notice, not
 * the bank.
 */

import fs from "fs";
import path from "path";

import { loadRules } from "../classifier/email-rules.js";

const RULES_PATH = path.resolve("data/bot/email-rules.json");

/**
 * Escapes user input into a literal pattern.
 *
 * Typed text is taken literally on purpose: a stray `.` or `*` from someone
 * describing an email in words would silently widen the rule, and a rule that
 * matches more than intended drops real movements without a trace.
 */
export function toLiteralPattern(text: string): string {
  return text.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Accent-insensitive so "política" and "politica" are the same rule. */
export function relaxAccents(pattern: string): string {
  const groups: Record<string, string> = {
    a: "[aáà]", e: "[eéè]", i: "[iíì]", o: "[oóò]", u: "[uúùü]", n: "[nñ]",
    á: "[aáà]", é: "[eéè]", í: "[iíì]", ó: "[oóò]", ú: "[uúùü]", ñ: "[nñ]",
  };
  return pattern.replace(/[a-záéíóúüñ]/gi, (ch) => {
    const lower = ch.toLowerCase();
    return groups[lower] ?? ch;
  });
}

export interface AddResult {
  pattern: string;
  added: boolean;
  total: number;
}

/** Appends a block pattern. Returns added=false when it was already there. */
export function addIgnorePattern(text: string): AddResult {
  const pattern = relaxAccents(toLiteralPattern(text));
  const rules = JSON.parse(JSON.stringify(loadRules())) as { block: string[]; allow: string[] };
  if (rules.block.includes(pattern)) {
    return { pattern, added: false, total: rules.block.length };
  }
  rules.block.push(pattern);
  fs.mkdirSync(path.dirname(RULES_PATH), { recursive: true });
  fs.writeFileSync(RULES_PATH, JSON.stringify(rules, null, 2));
  return { pattern, added: true, total: rules.block.length };
}

/** The block patterns currently in force. */
export function listIgnorePatterns(): string[] {
  return loadRules().block;
}

/** Does this pattern match? Used to preview the blast radius before saving. */
export function matchesPattern(pattern: string, from: string, subject: string): boolean {
  try {
    return new RegExp(pattern, "i").test(`${from} ${subject}`);
  } catch {
    return false;
  }
}
