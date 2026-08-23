/**
 * @file batch/integrity.ts
 * @description Post-run sanity checks over what a batch actually wrote and
 * asked, so a run cannot report "complete, 0 failed" while holding a serious
 * error — which is exactly what happened on 2026-08-19: a $323,000 CETES
 * withdrawal was booked as a plain expense, making the money vanish from net
 * worth, and the run reported success.
 *
 * Deliberately deterministic: no model call. These are cheap structural
 * questions ("a transfer category that is not flagged as a transfer") that a
 * model would only make slower and less predictable.
 */

export interface InspectedRecord {
  id: string;
  /** Absolute value in cents, as Wallet stores it. The sign lives in `type`. */
  amountCents: number;
  /** 0 = income, 1 = expense. */
  type: number;
  /**
   * Whether Wallet considers this a leg of a transfer.
   *
   * Two fields carry that, and which one is set depends on where the record was
   * created: the iOS app links legs with `transferId` and leaves the boolean
   * unset, while the web app and this importer set the boolean. Of 5,593
   * records under a transfer category, 5,590 carry a transferId and only 591
   * carry the flag — so reading the flag alone calls 5,002 perfectly ordinary
   * transfers unflagged. Harmless while this only inspects what a run just
   * wrote; ruinous the first time it is pointed at the whole history.
   */
  transfer: boolean;
  accountId: string;
  categoryName?: string;
  payee?: string;
  note?: string;
  /** ISO timestamp. */
  recordDate: string;
  /**
   * The movement as its statement printed it, reference block and all.
   *
   * `payee` is a cleaned-up name and often loses the very words that give a
   * movement away. BBVA's `SPEI RECIBIDO STP` arrived from an account of the
   * user's whose name the statement never printed, and reached Wallet as
   * income from a payee called "STP" — nothing in which reads as a transfer.
   * Empty for records that came from anywhere but a statement.
   */
  description?: string;
}

export interface PendingQuestion {
  messageId: number;
  claudeQuestion: string;
  emailSubject?: string;
}

export type FindingKind =
  | "transfer-not-flagged"
  | "transfer-wording-not-flagged"
  | "orphan-transfer-leg"
  | "verdict-filed-as-question"
  | "duplicate-question"
  | "question-may-be-recorded"
  | "large-non-transfer"
  | "inflow-without-counterparty";

export interface IntegrityFinding {
  /** "alert" = almost certainly wrong. "review" = worth a human glance. */
  severity: "alert" | "review";
  kind: FindingKind;
  message: string;
  recordId?: string;
  messageId?: number;
}

/** Category names in the user's catalog that mean "money moved between accounts". */
const TRANSFER_CATEGORIES = ["transfer, withdraw", "transfer", "traspaso"];

/**
 * Wording that means a movement between the user's own accounts. Only ever
 * raises "review": a payee really can read "TRANSFERENCIA A JUAN" for a genuine
 * payment to a third party, which is not a transfer.
 */
const TRANSFER_WORDS = /\b(retiro|traspaso|transferencia|spei|entre cuentas|cuenta propia)\b/i;

/**
 * Names that identify a payment rail or a clearing house, never a counterparty.
 *
 * A statement that prints one of these as the sender printed nothing at all:
 * BBVA's `SPEI RECIBIDO STP` was $10,155.21 arriving from the user's own FinSus
 * account, and reached Wallet as income from a payee called "STP". SPEI itself
 * is not on this list and must not be — every wire in Mexico travels on it,
 * including every genuine payment from a client, so treating the word as a
 * signal flags six ordinary rows to catch one.
 */
const PAYMENT_RAILS = /^(stp|spei|clabe|banco|banxico|transferencia|abono|dep[óo]sito|interbancari[oa])s?$/i;

/** How far apart the two legs of one transfer may be recorded. */
const COUNTERPART_SLACK_MS = 48 * 60 * 60 * 1000;

const isTransferCategory = (name?: string) =>
  !!name && TRANSFER_CATEGORIES.includes(name.trim().toLowerCase());

/**
 * Categories that describe where money came from well enough that no
 * counterparty is needed.
 *
 * Mercado Pago pays interest 46 times a month, every one of them naming no
 * sender because the sender is the bank. Flagging all 46 to catch one $6,250
 * arrival buries the finding under its own noise.
 */
const EARNED_INCOME = /interes|interest|dividend|wage|salar|n[óo]mina|rendimiento|ganancia|cashback/i;

const isEarnedIncome = (name?: string): boolean => !!name && EARNED_INCOME.test(name);

/** Whether the statement named a sender at all, as opposed to naming the wire. */
const namesSomebody = (r: InspectedRecord): boolean => {
  const payee = r.payee?.trim();
  return !!payee && !PAYMENT_RAILS.test(payee);
};

/** Every peso amount mentioned in a question, in cents. */
export function amountsInText(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) out.push(Math.round(n * 100));
  }
  return out;
}

function hasCounterpart(leg: InspectedRecord, pool: InspectedRecord[]): boolean {
  const legTime = Date.parse(leg.recordDate);
  return pool.some(
    (other) =>
      other.id !== leg.id &&
      other.transfer &&
      other.amountCents === leg.amountCents &&
      other.type !== leg.type &&
      other.accountId !== leg.accountId &&
      Math.abs(Date.parse(other.recordDate) - legTime) <= COUNTERPART_SLACK_MS
  );
}

export interface IntegrityInput {
  /** Records this run wrote. */
  written: InspectedRecord[];
  /** Every Wallet record in the window — a counterpart may predate this run. */
  windowRecords?: InspectedRecord[];
  /** Clarifications still awaiting the user. */
  pending?: PendingQuestion[];
  /** Above this, a non-transfer record is worth a human glance. Default $50,000. */
  largeAmountCents?: number;
}

export function checkRunIntegrity(input: IntegrityInput): IntegrityFinding[] {
  const { written, pending = [], largeAmountCents = 5_000_000 } = input;
  const pool = input.windowRecords?.length ? input.windowRecords : written;
  const findings: IntegrityFinding[] = [];
  const money = (cents: number) => `$${(cents / 100).toLocaleString("es-MX", { minimumFractionDigits: 2 })}`;
  const describe = (r: InspectedRecord) =>
    r.payee?.trim() || r.description?.trim().slice(0, 60) || r.note?.trim() || r.id;

  for (const r of written) {
    // The $323,000 case: filed under a transfer category, but not linked, so
    // one side of the movement simply disappears.
    if (isTransferCategory(r.categoryName) && !r.transfer) {
      findings.push({
        severity: "alert",
        kind: "transfer-not-flagged",
        recordId: r.id,
        message: `${money(r.amountCents)} en "${describe(r)}" tiene categoría de traspaso pero no está marcado como traspaso: el dinero desaparece en vez de moverse.`,
      });
    } else if (!r.transfer && TRANSFER_WORDS.test(`${r.note ?? ""} ${r.payee ?? ""}`)) {
      findings.push({
        severity: "review",
        kind: "transfer-wording-not-flagged",
        recordId: r.id,
        message: `${money(r.amountCents)} en "${describe(r)}" se describe como movimiento entre cuentas pero se registró como ${r.type === 1 ? "gasto" : "ingreso"} suelto.`,
      });
    }

    if (r.transfer && !hasCounterpart(r, pool)) {
      findings.push({
        severity: "alert",
        kind: "orphan-transfer-leg",
        recordId: r.id,
        message: `${money(r.amountCents)} en "${describe(r)}" es media transferencia: falta la contraparte.`,
      });
    }

    // Money arriving that the statement could not attribute to anybody. It may
    // be a client paying by wire, or it may be another of the user's own
    // accounts whose name the sending bank never printed — from this side there
    // is no telling, and the second reading is the expensive one. Only raised
    // where a description exists to have been silent, so this stays quiet on
    // every path that does not come from a statement.
    if (!r.transfer && r.type === 0 && r.description && !namesSomebody(r) && !isEarnedIncome(r.categoryName)) {
      findings.push({
        severity: "review",
        kind: "inflow-without-counterparty",
        recordId: r.id,
        message: `${money(r.amountCents)} entró sin que el estado nombrara quién lo envió ("${r.description.trim().slice(0, 60)}"): puede ser de otra cuenta tuya.`,
      });
    }

    if (!r.transfer && r.amountCents >= largeAmountCents) {
      findings.push({
        severity: "review",
        kind: "large-non-transfer",
        recordId: r.id,
        message: `${money(r.amountCents)} en "${describe(r)}" es inusualmente grande para un movimiento suelto.`,
      });
    }
  }

  // A verdict stored where a question belongs: the model decided there was
  // nothing to record, and the answer was filed as if it were asking.
  for (const q of pending) {
    if (q.claudeQuestion.trimStart().toUpperCase().startsWith("NO_TRANSACTION")) {
      findings.push({
        severity: "alert",
        kind: "verdict-filed-as-question",
        messageId: q.messageId,
        message: `El mensaje ${q.messageId} no es una pregunta, es un veredicto NO_TRANSACTION archivado como pendiente${q.emailSubject ? ` ("${q.emailSubject}")` : ""}.`,
      });
    }
  }

  // The same movement asked twice, seen from each bank.
  const byAmount = new Map<number, PendingQuestion[]>();
  for (const q of pending) {
    for (const cents of new Set(amountsInText(q.claudeQuestion))) {
      byAmount.set(cents, [...(byAmount.get(cents) ?? []), q]);
    }
  }
  for (const [cents, qs] of byAmount) {
    if (qs.length > 1) {
      findings.push({
        severity: "review",
        kind: "duplicate-question",
        messageId: qs[0].messageId,
        message: `${money(cents)} se pregunta en ${qs.length} mensajes (${qs.map((q) => q.messageId).join(", ")}): probablemente el mismo movimiento visto desde ambos bancos.`,
      });
    }
    const already = written.find((r) => r.amountCents === cents);
    if (already) {
      findings.push({
        severity: "review",
        kind: "question-may-be-recorded",
        messageId: qs[0].messageId,
        message: `${money(cents)} se pregunta en el mensaje ${qs[0].messageId} pero ya se escribió un registro por ese monto en esta corrida.`,
      });
    }
  }

  return findings;
}

/** Renders findings for the Telegram summary. Empty string when all is well. */
export function formatFindings(findings: IntegrityFinding[]): string {
  if (findings.length === 0) return "";
  const alerts = findings.filter((f) => f.severity === "alert");
  const reviews = findings.filter((f) => f.severity === "review");
  const lines: string[] = [];
  if (alerts.length) {
    lines.push(`\n🚨 *Revisión de integridad — ${alerts.length} alerta(s)*`);
    for (const f of alerts) lines.push(`• ${f.message}`);
  }
  if (reviews.length) {
    lines.push(`\n🔎 *Para revisar (${reviews.length})*`);
    for (const f of reviews) lines.push(`• ${f.message}`);
  }
  return lines.join("\n");
}
