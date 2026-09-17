/**
 * @file statements/continuity.ts
 * @description Whether an account's statements form an unbroken chain.
 *
 * Every check in this pipeline reads one statement against Wallet. None of them
 * can see the statement that never arrived, and a missing month is invisible in
 * exactly the way that matters: the movements it holds are not wrong, they are
 * absent, and every balance after it is quietly off by their sum.
 *
 * Banorte débito shows how it happens without anyone doing anything wrong. It
 * cut on the 1st through July and at month end from August, so its statements
 * run 2-jun→1-jul and then 1-ago→31-ago: the 2–31 July window has no statement
 * at all, and the bank never issued one. Wallet was $7,200 short and the only
 * symptom was a balance nobody could explain.
 *
 * Two consecutive statements agree on two things when nothing is missing: the
 * second starts the day after the first ends, and it opens on the balance the
 * first closed with. Either disagreement is worth a human's attention, so both
 * are reported — and the second one also catches a bank that renumbers its
 * periods while skipping money.
 */

export interface StatementSpan {
  month: string;
  period: { from: string; to: string };
  /** Declared balance at the open, in cents. Null when the statement omits it. */
  opening?: number | null;
  /** Declared balance at the close, in cents. */
  closing?: number | null;
}

export interface ContinuityFinding {
  kind: "gap" | "overlap" | "balance";
  /** Ready to show: this reaches the user through the run's warnings. */
  message: string;
}

/** The day after an ISO date, as an ISO date. */
export function dayAfter(iso: string): string {
  return shiftDay(iso, 1);
}

/** The day before an ISO date, as an ISO date. */
export function dayBefore(iso: string): string {
  return shiftDay(iso, -1);
}

function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const peso = (cents: number): string =>
  `$${(cents / 100).toLocaleString("es-MX", { minimumFractionDigits: 2 })}`;

/**
 * Reads an account's statements in order and reports where the chain breaks.
 *
 * Statements with no declared period are skipped rather than guessed at: a
 * false gap would send someone hunting for a statement that does not exist.
 */
export function checkContinuity(account: string, spans: StatementSpan[]): ContinuityFinding[] {
  const ordered = spans
    .filter((s) => s.period && s.period.from && s.period.to)
    .sort((a, b) => a.period.from.localeCompare(b.period.from));

  const findings: ContinuityFinding[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const next = ordered[i];
    const expected = dayAfter(prev.period.to);

    if (next.period.from > expected) {
      findings.push({
        kind: "gap",
        message:
          `${account}: falta el estado del ${expected} al ${dayBefore(next.period.from)} — ` +
          `el de ${prev.month} cierra el ${prev.period.to} y el de ${next.month} abre el ${next.period.from}. ` +
          `Ese tramo no lo ha revisado nadie.`,
      });
    } else if (next.period.from < expected) {
      findings.push({
        kind: "overlap",
        message:
          `${account}: los estados de ${prev.month} y ${next.month} se traslapan ` +
          `(${next.period.from} cae dentro de ${prev.period.from}–${prev.period.to}). ` +
          `Los movimientos del traslape se pueden registrar dos veces.`,
      });
    }

    // Independent of the dates: a bank can renumber its periods and still skip
    // money, and then only the balances disagree.
    if (
      prev.closing !== null && prev.closing !== undefined &&
      next.opening !== null && next.opening !== undefined &&
      prev.closing !== next.opening
    ) {
      findings.push({
        kind: "balance",
        message:
          `${account}: el estado de ${prev.month} cierra en ${peso(prev.closing)} y el de ${next.month} ` +
          `abre en ${peso(next.opening)} — faltan ${peso(next.opening - prev.closing)} por explicar entre los dos.`,
      });
    }
  }
  return findings;
}
