/**
 * @file webhook/learned-rules.ts
 * @description Persistent store of facts Claude learns from user clarifications
 * (e.g. "this card is mine", "ignore charges from X"). These are injected into
 * every email/chat prompt so the bot never re-asks the same question.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { dirname, join } from "path";

const RULES_PATH = join(process.cwd(), "data/bot/learned-rules.md");

/** Returns the current learned-rules file content, or "" if it doesn't exist. */
export function getLearnedRules(): string {
  try {
    return readFileSync(RULES_PATH, "utf8");
  } catch {
    return "";
  }
}

/** Appends a new rule line as "- [YYYY-MM-DD] <rule>", creating the file/dir if needed. */
export function appendLearnedRule(rule: string): void {
  mkdirSync(dirname(RULES_PATH), { recursive: true });
  if (!existsSync(RULES_PATH)) {
    appendFileSync(RULES_PATH, "# Reglas aprendidas (inyectadas en cada análisis de correo)\n\n");
  }
  const today = new Date().toISOString().slice(0, 10);
  appendFileSync(RULES_PATH, `- [${today}] ${rule}\n`);
}

const RULE_BLOCK_RE = /<<<RULE>>>\s*([\s\S]*?)\s*<<<END_RULE>>>/g;

/**
 * Extracts all `<<<RULE>>>...<<<END_RULE>>>` blocks from Claude's response text.
 * Returns the trimmed rule strings plus the text with those blocks stripped out
 * (so they never reach the user or the CSV parser).
 */
export function extractRuleBlocks(text: string): { rules: string[]; cleanedText: string } {
  const rules: string[] = [];
  for (const match of text.matchAll(RULE_BLOCK_RE)) {
    const rule = match[1].trim();
    if (rule) rules.push(rule);
  }
  const cleanedText = text.replace(RULE_BLOCK_RE, "").trim();
  return { rules, cleanedText };
}
