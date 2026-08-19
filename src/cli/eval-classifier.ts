/**
 * @file cli/eval-classifier.ts
 * @description Replays saved emails through the current prompt and reports what
 * the classifier decides, so a prompt change can be measured instead of guessed.
 *
 *   node dist/cli/eval-classifier.js            # run every case
 *   node dist/cli/eval-classifier.js --only=id  # run one
 *
 * Cases live in data/bot/eval-emails.json — real bodies, so they stay out of
 * git. Build the file with `--seed-from-clarifications`, which pulls the emails
 * the pipeline has already stumbled on: the ones worth not regressing.
 *
 * Writes nothing anywhere: no Wallet, no ledger, no Telegram, no clarifications.
 */

import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import { loadEnvLocal } from "../env.js";
import { loadBotConfig } from "../bot/config.js";
import { runClaude } from "../bot/claude-runner.js";
import { buildEmailPrompt, EMAIL_MODEL, EMAIL_SYSTEM_PROMPT } from "../webhook/email-processor.js";
import { extractCsvBlock } from "../bot/handlers.js";
import { challengeNoTransaction, parseVerdict } from "../webhook/verdict.js";

type Expected = "transaction" | "no_transaction" | "question";

interface EvalCase {
  id: string;
  from: string;
  subject: string;
  text: string;
  expect: Expected;
  /** Why this case is in the set — shown on failure. */
  note?: string;
}

const CASES_PATH = path.resolve("data", "bot", "eval-emails.json");

function loadCases(): EvalCase[] {
  if (!fs.existsSync(CASES_PATH)) {
    console.error(`No hay casos en ${CASES_PATH}. Créalos con --seed-from-clarifications.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CASES_PATH, "utf8")) as EvalCase[];
}

/** Seeds cases from pending clarifications; every `expect` needs a human. */
function seedFromClarifications(): void {
  const storePath = path.resolve("data", "bot", "pending-clarifications.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<
    string,
    { emailFrom: string; emailSubject: string; emailText: string; claudeQuestion: string }
  >;
  const existing = fs.existsSync(CASES_PATH) ? (loadCases() as EvalCase[]) : [];
  const known = new Set(existing.map((c) => c.id));
  const seeded: EvalCase[] = [...existing];
  for (const [messageId, entry] of Object.entries(store)) {
    const id = `msg-${messageId}`;
    if (known.has(id)) continue;
    seeded.push({
      id,
      from: entry.emailFrom,
      subject: entry.emailSubject,
      text: entry.emailText,
      // A verdict filed as a question is the interesting case: mark it for review.
      expect: parseVerdict(entry.claudeQuestion).isNoTransaction ? "no_transaction" : "question",
      note: "REVISAR: expect asignado automáticamente, confírmalo a mano",
    });
  }
  fs.writeFileSync(CASES_PATH, JSON.stringify(seeded, null, 2));
  console.log(`${seeded.length} caso(s) en ${CASES_PATH} (${seeded.length - existing.length} nuevos).`);
  console.log("Revisa el campo `expect` de los nuevos antes de confiar en el resultado.");
}

async function classify(c: EvalCase): Promise<{ outcome: Expected; detail: string }> {
  const config = loadBotConfig();
  const result = await runClaude({
    config,
    sessionId: uuidv4(),
    isFirstTurn: true,
    prompt: buildEmailPrompt({ from: c.from, subject: c.subject, text: c.text }),
    appendSystemPrompt: EMAIL_SYSTEM_PROMPT,
    timeoutMs: 90_000,
    model: EMAIL_MODEL,
  });

  const raw = result.text.trim();
  const verdict = parseVerdict(raw);
  if (verdict.isNoTransaction) {
    const challenge = challengeNoTransaction({
      from: c.from, subject: c.subject, body: c.text, reason: verdict.reason,
    });
    if (challenge) return { outcome: "question", detail: `cuestionado: ${challenge.reason}` };
    return { outcome: "no_transaction", detail: verdict.reason.slice(0, 70) };
  }
  const { csv } = extractCsvBlock(raw);
  if (csv) return { outcome: "transaction", detail: csv.split("\n").slice(1).join(" | ").slice(0, 70) };
  return { outcome: "question", detail: raw.slice(0, 70) };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const argv = process.argv.slice(2);
  if (argv.includes("--seed-from-clarifications")) return seedFromClarifications();

  const only = argv.find((a) => a.startsWith("--only="))?.split("=")[1];
  const cases = loadCases().filter((c) => !only || c.id === only);
  if (cases.length === 0) {
    console.error("Ningún caso coincide.");
    process.exit(1);
  }

  let pass = 0;
  const failures: string[] = [];
  for (const [i, c] of cases.entries()) {
    process.stdout.write(`[${i + 1}/${cases.length}] ${c.id} … `);
    try {
      const { outcome, detail } = await classify(c);
      const ok = outcome === c.expect;
      if (ok) pass++;
      else failures.push(`${c.id}: esperado ${c.expect}, obtuvo ${outcome} — ${detail}${c.note ? ` (${c.note})` : ""}`);
      console.log(`${ok ? "✅" : "❌"} ${outcome}${ok ? "" : ` (esperado ${c.expect})`}`);
    } catch (err) {
      failures.push(`${c.id}: error — ${err instanceof Error ? err.message.slice(0, 90) : err}`);
      console.log("✖ error");
    }
  }

  console.log(`\n${pass}/${cases.length} casos correctos.`);
  if (failures.length) {
    console.log("\nFallos:");
    for (const f of failures) console.log(`  • ${f}`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
