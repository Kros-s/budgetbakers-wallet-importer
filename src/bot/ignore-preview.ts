/**
 * @file bot/ignore-preview.ts
 * @description Weighing an /ignore rule before it is applied.
 *
 * A block rule is the one setting that fails silently: too broad, and real
 * movements stop reaching the queue with nothing to notice. So the rule is
 * proposed, its blast radius shown, and applied only on confirmation — the same
 * shape as a CSV proposal, for the same reason.
 */

import { matchesPattern } from "../webhook/ignore-rules.js";
import type { ClarificationEntry } from "../webhook/clarification-store.js";
import { questionAmountCents } from "./pending-view.js";
import { senderInstitution } from "./email-facts.js";

export interface IgnoreMatch {
  shortId: number;
  subject: string;
  institution: string;
  amountCents: number;
}

export interface IgnorePreview {
  pattern: string;
  typed: string;
  matches: IgnoreMatch[];
  /** Reasons to think twice, in the order worth reading them. */
  warnings: string[];
  /** Distinct subjects hit — several means the text may be too generic. */
  distinctSubjects: string[];
}

/** Below this, a pattern is short enough to catch far more than intended. */
const SHORT_PATTERN = 8;

export function buildIgnorePreview(
  typed: string,
  pattern: string,
  pending: Array<{ entry: ClarificationEntry }>
): IgnorePreview {
  const matches: IgnoreMatch[] = pending
    .filter((p) => matchesPattern(pattern, p.entry.emailFrom, p.entry.emailSubject))
    .map((p) => ({
      shortId: p.entry.shortId!,
      subject: p.entry.emailSubject,
      institution: senderInstitution(p.entry.emailFrom),
      amountCents: questionAmountCents(p.entry),
    }));

  const withMoney = matches.filter((m) => m.amountCents > 0);
  const distinctSubjects = [...new Set(matches.map((m) => m.subject.trim().toLowerCase()))];
  const warnings: string[] = [];

  if (withMoney.length > 0) {
    // The loudest case: this rule would silence questions about actual money.
    warnings.push(
      `${withMoney.length} de estas preguntan por un movimiento con monto ` +
        `(${withMoney.map((m) => `#${m.shortId}`).join(", ")}). Si las ignoras, ese dinero no se registra.`
    );
  }
  if (typed.trim().length < SHORT_PATTERN) {
    warnings.push(`El texto es muy corto (${typed.trim().length} caracteres); podría casar con mucho más de lo que esperas.`);
  }
  if (distinctSubjects.length > 1) {
    warnings.push(`Casa con ${distinctSubjects.length} asuntos distintos, así que no apunta a un solo tipo de aviso.`);
  }
  if (matches.length === 0) {
    warnings.push("No casa con ninguna pendiente actual. Revisa que el texto esté como aparece en el correo.");
  }
  return { pattern, typed, matches, warnings, distinctSubjects };
}

/** The confirmation message. */
export function formatIgnorePreview(p: IgnorePreview): string {
  const money = (c: number) => `$${(c / 100).toLocaleString("es-MX", { minimumFractionDigits: 2 })}`;
  const lines = [`🚫 *Ignorar correos que digan:*\n\`${p.typed}\``, ""];

  if (p.matches.length > 0) {
    lines.push(`*Quitaría ${p.matches.length} de la cola:*`);
    for (const m of p.matches.slice(0, 10)) {
      const amt = m.amountCents > 0 ? ` · *${money(m.amountCents)}*` : "";
      lines.push(`• #${m.shortId} · ${m.institution}${amt}\n   _${m.subject.slice(0, 52)}_`);
    }
    if (p.matches.length > 10) lines.push(`…y ${p.matches.length - 10} más`);
    lines.push("");
  }

  if (p.warnings.length > 0) {
    lines.push("⚠️ *Antes de confirmar:*");
    for (const w of p.warnings) lines.push(`• ${w}`);
    lines.push("");
  }

  lines.push("Los correos futuros que coincidan tampoco se procesarán.");
  return lines.join("\n");
}
