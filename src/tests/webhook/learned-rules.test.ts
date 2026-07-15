// extractRuleBlocks is pure (no cwd dependency) so it's tested directly.
// getLearnedRules/appendLearnedRule resolve data/bot/learned-rules.md from
// process.cwd() at import time, so we chdir into a scratch directory before
// the first import — same pattern as bot/session.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { extractRuleBlocks } from "../../webhook/learned-rules.js";

test("extractRuleBlocks extracts a single rule block and strips it from the text", () => {
  const text =
    "Aquí está tu CSV.\n\n<<<RULE>>>\nLa tarjeta X es del usuario.\n<<<END_RULE>>>\n\n<<<CSV>>>foo<<<END>>>";
  const { rules, cleanedText } = extractRuleBlocks(text);

  assert.deepEqual(rules, ["La tarjeta X es del usuario."]);
  assert.doesNotMatch(cleanedText, /<<<RULE>>>|<<<END_RULE>>>/);
  assert.match(cleanedText, /<<<CSV>>>foo<<<END>>>/);
});

test("extractRuleBlocks extracts multiple rule blocks", () => {
  const text =
    "<<<RULE>>>\nRegla uno.\n<<<END_RULE>>>\ntexto intermedio\n<<<RULE>>>\nRegla dos.\n<<<END_RULE>>>";
  const { rules, cleanedText } = extractRuleBlocks(text);

  assert.deepEqual(rules, ["Regla uno.", "Regla dos."]);
  assert.equal(cleanedText, "texto intermedio");
});

test("extractRuleBlocks returns no rules and untouched text when there are no blocks", () => {
  const text = "Solo texto normal, sin bloques.";
  const { rules, cleanedText } = extractRuleBlocks(text);

  assert.deepEqual(rules, []);
  assert.equal(cleanedText, text);
});

test("extractRuleBlocks ignores an empty rule block", () => {
  const text = "<<<RULE>>>\n\n<<<END_RULE>>>";
  const { rules, cleanedText } = extractRuleBlocks(text);

  assert.deepEqual(rules, []);
  assert.equal(cleanedText, "");
});

// ── getLearnedRules / appendLearnedRule (cwd-dependent) ─────────────────────

const scratchDir = mkdtempSync(join(tmpdir(), "learned-rules-test-"));
const originalCwd = process.cwd();
process.chdir(scratchDir);

const learnedRulesModule = await import(`../../webhook/learned-rules.js?t=${Date.now()}`);

test("getLearnedRules returns empty string when the file doesn't exist yet", () => {
  assert.equal(learnedRulesModule.getLearnedRules(), "");
});

test("appendLearnedRule creates the file with a dated line, and getLearnedRules reads it back", () => {
  learnedRulesModule.appendLearnedRule("Los cargos de Cashi son de un familiar.");

  const content = learnedRulesModule.getLearnedRules();
  assert.match(content, /- \[\d{4}-\d{2}-\d{2}\] Los cargos de Cashi son de un familiar\.$/m);

  const onDisk = readFileSync(join(scratchDir, "data/bot/learned-rules.md"), "utf8");
  assert.equal(onDisk, content);
});

test("appendLearnedRule appends subsequent rules without clobbering existing ones", () => {
  learnedRulesModule.appendLearnedRule("Segunda regla.");

  const content = learnedRulesModule.getLearnedRules();
  assert.match(content, /Los cargos de Cashi son de un familiar\./);
  assert.match(content, /Segunda regla\.$/m);
});

test.after(() => {
  process.chdir(originalCwd);
  rmSync(scratchDir, { recursive: true, force: true });
});
