/**
 * @file bot/statement-flow.ts
 * @description Routing a statement PDF sent over Telegram to the reconciler.
 *
 * The help text has promised "mándame el PDF como archivo y lo proceso" while a
 * statement actually fell through to the generic document handler, which knows
 * nothing about statement periods, per-bank profiles, or the totals a statement
 * declares about itself. It would have re-introduced every bug fixed today,
 * silently, one confirmation at a time.
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";

export interface ReconcileInvocation {
  command: string;
  args: string[];
}

/**
 * How to invoke the reconciler from inside the bot process.
 *
 * On the container the bot runs the compiled tree, so the built CLI is there.
 * In development it is not, and falling back to tsx keeps the same flow
 * testable on a laptop instead of only after a deploy.
 */
export function reconcileCommand(
  opts: { pdf: string; account: string; month: string; write?: boolean; fromLedger?: boolean },
  distDir = path.resolve("dist"),
  exists: (p: string) => boolean = fs.existsSync
): ReconcileInvocation {
  const built = path.join(distDir, "cli", "reconcile-statement.js");
  const tail = [opts.pdf, "--account", opts.account, "--month", opts.month];
  if (opts.write) tail.push("--write");
  if (opts.fromLedger) tail.push("--from-ledger");
  return exists(built)
    ? { command: process.execPath, args: [built, ...tail] }
    : { command: "npx", args: ["tsx", path.resolve("src/cli/reconcile-statement.ts"), ...tail] };
}

export interface ReconcileSummary {
  period: string | null;
  matched: number;
  missing: number;
  ambiguous: number;
  walletOnly: number;
  missingLines: string[];
  warnings: string[];
}

const NUM = (s: string, re: RegExp): number => Number(re.exec(s)?.[1] ?? 0);

/** Turns the CLI's stdout into the few numbers worth putting in a message. */
export function parseReconcileOutput(out: string): ReconcileSummary {
  const missingLines: string[] = [];
  let collecting = false;
  for (const line of out.split("\n")) {
    if (/^➕ Faltantes/.test(line)) { collecting = true; continue; }
    if (collecting) {
      if (/^\s{3}\S/.test(line)) { missingLines.push(line.trim()); continue; }
      collecting = false;
    }
  }
  return {
    period: /Periodo del estado:\s*(\S+ → \S+)/.exec(out)?.[1] ?? null,
    matched: NUM(out, /✅ Ya en Wallet:\s*(\d+)/),
    missing: NUM(out, /➕ Faltantes \(se agregarían\):\s*(\d+)/),
    ambiguous: NUM(out, /⚠️ Ambiguos \(revisar a mano\):\s*(\d+)/),
    walletOnly: NUM(out, /👀 Solo en Wallet[^:]*:\s*(\d+)/),
    missingLines,
    // Every ⚠️ the CLI emitted that is not one of its own tally headings.
    warnings: out
      .split("\n")
      .filter((l) => l.includes("⚠️") && !/Ambiguos \(revisar a mano\)/.test(l))
      .map((l) => l.replace(/^\s*⚠️\s*/, "").trim())
      .filter(Boolean),
  };
}

/** How many rows to name before the message stops being readable. */
const MAX_LISTED = 12;

export function formatReconcileSummary(
  account: string,
  month: string,
  s: ReconcileSummary
): string {
  const lines = [`📄 *${account} · ${month}*`];
  if (s.period) lines.push(`_${s.period}_`);
  lines.push("");
  lines.push(`✅ Ya en Wallet: ${s.matched}`);
  lines.push(`➕ Faltantes: ${s.missing}`);
  if (s.ambiguous) lines.push(`⚠️ Ambiguos: ${s.ambiguous}`);
  if (s.walletOnly) lines.push(`👀 Solo en Wallet: ${s.walletOnly}`);

  if (s.missingLines.length) {
    const shown = s.missingLines.slice(0, MAX_LISTED);
    lines.push("", "```", ...shown, "```");
    // Never let a cap read as the whole list.
    if (s.missingLines.length > shown.length) {
      lines.push(`_…y ${s.missingLines.length - shown.length} más._`);
    }
  }
  if (s.warnings.length) lines.push("", ...s.warnings.map((w) => `⚠️ ${w}`));
  return lines.join("\n");
}

/** True when nothing should be written without a human looking first. */
export function needsAttention(s: ReconcileSummary): boolean {
  return s.warnings.length > 0 || s.ambiguous > 0;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function runReconcile(inv: ReconcileInvocation, timeoutMs = 900_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(inv.command, inv.args, { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: `${stderr}\n${err.message}` });
    });
  });
}
