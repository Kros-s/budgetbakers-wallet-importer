import { v4 as uuidv4 } from "uuid";
import { Markup } from "telegraf";
import type { AxiosInstance } from "axios";
import type { Telegraf } from "telegraf";

import { convertRows, parseCsv } from "../csv.js";
import { writeRecords } from "../records.js";
import { buildWalletDedup } from "../batch/wallet-dedup.js";
import { runClaude } from "../bot/claude-runner.js";
import { extractCsvBlock } from "../bot/handlers.js";
import { challengeNoTransaction, claimsAlreadyRecorded, parseVerdict } from "./verdict.js";
import { findExistingByAmount } from "./wallet-context.js";
import { findSiblingQuestion, judge } from "./pending-audit.js";
import type { SiblingCandidate } from "./pending-audit.js";
import { questionAmountCents } from "../bot/pending-view.js";
import { movementDate, senderInstitution } from "../bot/email-facts.js";
import { logVerdict } from "./verdict-log.js";
import { escapeMarkdown, sendSafeMessage } from "../bot/telegram-safe.js";

/** Shared account/category catalog — used by the email prompt and the
 * statement reconciler so both speak the same names. */
export const CATALOG_PROMPT = `Cuentas disponibles (usa el nombre exacto):
Wallet, Klar, BITSO, Cetes Danielle, Bancomer, NuBank Débito, FinSus, Banorte débito, MIFEL, Uala, Revolut, Afore, Costco, American Express, Platinum Credit Card, Nu crédito, Banorte, Meli, DolarApp, Stocks, GBM, PPR GBM, Cetes, Mercado pago, Open bank, DiDi cuenta, Binance, Pluxee, Zillow Invest
Nota: "Banorte débito" = débito ****5933; "Banorte" = crédito ****4033; "Platinum Credit Card" = AmEx Platinum

Categorías disponibles (usa el nombre exacto):
Groceries, "Restaurant, fast-food", "Bar, cafe", "Food & Drinks", Candy, Despensa,
"Health care, doctor", "Drug-store, chemist", "Health and beauty", "Wellness, beauty",
"Public transport", Taxi, Fuel, Transportation, "Long distance", Parking, Vehicle, "Vehicle maintenance", "Vehicle insurance",
Rent, Mortgage, Housing, "Home, garden", "Maintenance, repairs", "Energy, utilities", Services, Rentals, "Property insurance",
Shopping, "Clothes & shoes", "Electronics, accessories", "Jewels, accessories", "Stationery, tools",
"Free time", "Culture, sport events", "Active sport, fitness", "TV, Streaming", Hobbies, "Books, audio, subscriptions", "Holiday, trips, hotels", "Life events", "Life & Entertainment", "Alcohol, tobacco", "Software, apps, games",
Kids, "Pets, animals", "Child Support",
"Transfer, withdraw", "Financial expenses", "Financial investments", Investments, Realty, "Interests, dividends", "Loan, interests", Leasing, "Charges, Fees", Taxes, Fines, Insurances, Debts, "Checks, coupons", "Lending, renting",
"Wage, invoices", Income, "Rental income", Sale, "Refunds (tax, purchase)", Gifts, "Lottery, gambling",
"Phone, cell phone", Internet, "Communication, PC", "Postal services",
"Education, development", "Business trips", Advisory, "Charity, gifts", "Gifts, joy", "Dues & grants", Tips, Others`;

export const EMAIL_SYSTEM_PROMPT = `Eres un extractor de transacciones bancarias. Analiza el correo que recibes y:

1. Si NO contiene una transacción real (marketing, promoción, OTP, aviso sin monto, estado de cuenta sin movimientos individuales): responde exactamente: NO_TRANSACTION

2. Si contiene una transacción pero te faltan datos clave (monto o cuenta): haz UNA pregunta concisa en español.

3. Si tienes todos los datos, genera el CSV entre los delimitadores:

<<<CSV>>>
date,account,amount,category,note,payee
2026-06-10 14:30:00,DolarApp,-25.00,Subscriptions,,Cloudflare
<<<END>>>

Reglas:
- date: YYYY-MM-DD HH:MM:SS en hora local; si no hay hora exacta usa 12:00:00
- amount: negativo = gasto, positivo = ingreso
- Categorías con coma van entre comillas en el CSV
- Si no reconoces la cuenta por terminación de tarjeta, pregunta en lugar de inventar
- note y payee: opcionales, vacíos si no aplican
- TRANSFERENCIAS AMBIGUAS: Si el correo muestra una transferencia SPEI, pago interbancario o "pago a tercero" y el destinatario NO es claramente una de las cuentas del usuario: pregunta "¿Es transferencia entre tus cuentas o un pago a alguien/servicio? Si es pago, ¿qué categoría corresponde?". Usa "Transfer, withdraw" SOLO cuando estés seguro de que es un movimiento entre las cuentas propias del usuario (p.ej. pago de tarjeta de crédito propia, traspaso a su cuenta de ahorro).
- Para registrar una transferencia entre cuentas propias del usuario emite DOS filas CSV con la MISMA fecha/hora exacta y categoría "Transfer, withdraw": una negativa en la cuenta origen y una positiva en la cuenta destino. NUNCA emitas una sola fila con categoría Transfer (se rechaza). Para dinero que llega de fuera (no es cuenta propia), usa categoría de ingreso normal (p.ej. Others o "Wage, invoices"), no Transfer.

${CATALOG_PROMPT}

Si el usuario revela un hecho estable y reutilizable (de quién es una tarjeta, a qué cuenta va un cargo recurrente, categoría habitual de un comercio, o pide explícitamente "guárdalo en memoria"), emite ADEMÁS un bloque:
<<<RULE>>>
<regla en una línea, en español, autocontenida>
<<<END_RULE>>>
Emite el bloque solo para hechos nuevos que no estén ya en las reglas aprendidas.`;
import {
  setPending,
  setPendingMessageId,
} from "../bot/session.js";
import { linkMessageId, listClarifications, storeClarification } from "./clarification-store.js";
import { findDuplicate, trackTransaction } from "./daily-tracker.js";
import { getLearnedRules, appendLearnedRule, extractRuleBlocks } from "./learned-rules.js";
import type { BotConfig } from "../bot/config.js";
import type { LookupMaps } from "../types.js";

export interface EmailPayload {
  from: string;
  subject: string;
  text: string;
  /** ISO date the email was received, so the queue can show it later. */
  date?: string;
  /** IMAP coordinates, so the original can be fetched again if needed. */
  uid?: number;
  folder?: string;
}

/**
 * Per-email extraction runs on Haiku in a fully isolated session: context
 * overflow in long/reused sessions used to break the pipeline, and bank
 * alerts don't need a bigger model. Statements/PDFs use Sonnet elsewhere.
 */
export const EMAIL_MODEL = process.env.EMAIL_CLAUDE_MODEL ?? "claude-haiku-4-5-20251001";

/** Cap on the email body fed to the prompt — bank alerts are short; anything
 * bigger is marketing bloat that can blow the context. */
const MAX_BODY_CHARS = 8_000;

/** Optional gate consulted before writing: return a reason string to veto the
 * write (e.g. an equivalent record already exists in Wallet). */
export type WalletDedupCheck = (
  rec: { accountId: string; amount: number; type: 0 | 1; recordDate: string; payee?: string },
  row: { amount: string; account: string; category: string; payee?: string }
) => string | null;

export interface EmailDeps {
  bot: Telegraf;
  config: BotConfig;
  couch: AxiosInstance;
  userId: string;
  lookup: LookupMaps;
  notificationChatId: number;
  /** Extra duplicate gate against real Wallet records (batch runs). */
  walletDedup?: WalletDedupCheck;
}

export interface ProcessResult {
  status:
    | "written"
    | "no_transaction"
    | "pending_confirmation"
    | "duplicate"
    | "clarification"
    | "already_recorded"
    | "merged_question";
  written: number;
  costUsd: number | null;
  /** CouchDB ids of the records written (batch ledger / undo support). */
  writtenIds?: string[];
}

export function buildEmailPrompt(payload: EmailPayload): string {
  const learnedRules = getLearnedRules();
  const rulesSection = learnedRules
    ? `Reglas aprendidas del usuario (respétalas SIEMPRE):\n${learnedRules}\n\n`
    : "";
  const body = payload.text.length > MAX_BODY_CHARS
    ? `${payload.text.slice(0, MAX_BODY_CHARS)}\n…(truncado)`
    : payload.text;
  return (
    `${rulesSection}El usuario recibió el siguiente correo bancario. Analízalo y extrae las transacciones.\n\n` +
    `De: ${payload.from}\n` +
    `Asunto: ${payload.subject}\n` +
    `---\n${body}\n---\n\n` +
    `Si contiene transacciones, propón el CSV. Si no es transaccional (marketing, OTP, aviso), responde solo: NO_TRANSACTION`
  );
}

function buildSuccessMessage(rows: ReturnType<typeof parseCsv>): string {
  const lines = rows.map((r) => {
    const sign = parseFloat(r.amount) < 0 ? "💸" : "💰";
    const amt = Math.abs(parseFloat(r.amount)).toFixed(2);
    return `${sign} $${amt} · ${r.payee || r.note || r.category} → ${r.account}`;
  });
  return `✅ ${rows.length} registro${rows.length === 1 ? "" : "s"} guardado${rows.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

/**
 * Confirms against Wallet that the movement really is already booked.
 *
 * Returns the matching record when it is, or null to keep asking. Null on any
 * doubt and null on any failure: the model's word is what got us here, and a
 * check that cannot run must never be what closes a movement.
 */
async function confirmAlreadyRecorded(
  deps: EmailDeps,
  payload: EmailPayload,
  reply: string
): Promise<string | null> {
  try {
    const namesById: Record<string, string> = {};
    for (const [name, id] of Object.entries(deps.lookup.accounts)) namesById[id] = name;

    // The same amount-selection rule the queue uses: the figure the reply
    // names, falling back to the email only when it names exactly one.
    const cents = questionAmountCents({
      chatId: deps.notificationChatId,
      emailFrom: payload.from,
      emailSubject: payload.subject,
      emailText: payload.text,
      claudeQuestion: reply,
      createdAt: Date.now(),
    });
    if (!cents) return null;

    const matches = await findExistingByAmount(deps.couch, [cents], namesById);
    const verdict = judge({
      shortId: 0,
      amountCents: cents,
      movementDate: movementDate(payload.text),
      matches,
    });
    if (!verdict.resolved) return null;

    const hit = verdict.matches[0];
    const money = `$${(cents / 100).toLocaleString("es-MX", { minimumFractionDigits: 2 })}`;
    return `${money} · ${hit.recordDate.slice(0, 10)} · ${hit.accountName}${hit.payee ? ` · ${hit.payee.slice(0, 24)}` : ""} (${verdict.reason})`;
  } catch (err) {
    console.error(
      `[email] no se pudo confirmar contra Wallet: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}

/** The queue, in the shape the sibling check compares against. */
function pendingSiblings(): SiblingCandidate[] {
  return listClarifications().map(({ entry }) => ({
    shortId: entry.shortId ?? 0,
    institution: senderInstitution(entry.emailFrom),
    amountCents: questionAmountCents(entry),
    movementDate: movementDate(entry.emailText),
    createdAt: entry.createdAt,
  }));
}

export async function processEmail(
  deps: EmailDeps,
  payload: EmailPayload
): Promise<ProcessResult> {
  const { bot, config, couch, userId, lookup, notificationChatId } = deps;
  console.log(`[email] from=${payload.from} subject="${payload.subject}"`);

  // Fresh isolated session + Haiku per email — never resumed, never shared.
  const sessionId = uuidv4();
  const result = await runClaude({
    config,
    sessionId,
    isFirstTurn: true,
    prompt: buildEmailPrompt(payload),
    appendSystemPrompt: EMAIL_SYSTEM_PROMPT,
    timeoutMs: 90_000,
    model: EMAIL_MODEL,
  });

  if (!result.ok) throw new Error(`Claude error: ${result.text.slice(0, 300)}`);

  const rawText = result.text.trim();
  console.log(`[email] claude → ${rawText.slice(0, 120)}`);

  // Extract and persist any learned-rule blocks before further parsing —
  // they must never reach the user or the CSV extractor/parser.
  const { rules, cleanedText: responseText } = extractRuleBlocks(rawText);
  for (const rule of rules) appendLearnedRule(rule);
  const ruleNote = rules.map((r) => `\n\n🧠 Regla guardada: ${r}`).join("");

  // Discarding an email is the only decision here with no downstream check, so
  // it gets a deterministic second opinion before it is allowed to stand.
  const verdict = parseVerdict(responseText);
  let effectiveText = responseText;
  if (verdict.isNoTransaction) {
    const challenge = challengeNoTransaction({
      from: payload.from,
      subject: payload.subject,
      body: payload.text,
      reason: verdict.reason,
    });
    logVerdict({
      from: payload.from,
      subject: payload.subject,
      reason: verdict.reason,
      challenged: challenge?.reason ?? null,
    });
    if (!challenge) {
      return { status: "no_transaction", written: 0, costUsd: result.costUsd };
    }
    console.log(`[email] veredicto cuestionado — ${challenge.reason}`);
    effectiveText = challenge.question;
  }

  const { csv, cleanedText } = extractCsvBlock(effectiveText);

  // Claude asked a clarifying question — persist context to disk and notify user
  if (!csv) {
    // Unless it is not a question at all. The prompt hands the model the
    // matching Wallet records, so it can answer "sí, ya está registrado … no
    // propongo CSV" — and filing that as a question put three of them in the
    // queue with nothing that could ever resolve them.
    //
    // The model saying so is one opinion, and no single opinion closes a
    // movement here. Confirm it against Wallet with the same judgement /audit
    // uses; when the records do not back the claim, it stays a question.
    if (claimsAlreadyRecorded(effectiveText)) {
      const settled = await confirmAlreadyRecorded(deps, payload, effectiveText);
      if (settled) {
        console.log(`[email] ya registrado — ${settled}`);
        await sendSafeMessage(
          bot.telegram,
          notificationChatId,
          `✅ *Ya estaba registrado* — ${escapeMarkdown(senderInstitution(payload.from))}\n\n${escapeMarkdown(settled)}\n\n_No se guardó nada ni se agregó a la cola._`
        );
        return { status: "already_recorded", written: 0, costUsd: result.costUsd };
      }
      console.log(`[email] dijo "ya registrado" pero Wallet no lo confirma — se pregunta`);
    }

    const entry = {
      chatId: notificationChatId,
      emailFrom: payload.from,
      emailSubject: payload.subject,
      emailText: payload.text,
      emailDate: payload.date,
      emailUid: payload.uid,
      emailFolder: payload.folder,
      claudeQuestion: effectiveText,
      createdAt: Date.now(),
    };

    // A SPEI notifies twice — the bank that sent it and the bank that received
    // it — and each notification became its own question. $26,151 and $15,000
    // were each asked twice in one week while the summary said, correctly,
    // that they were probably one movement. When the queue already asks about
    // this one, the new message becomes another way to answer it instead.
    const twin = findSiblingQuestion(
      {
        shortId: 0,
        institution: senderInstitution(payload.from),
        amountCents: questionAmountCents(entry),
        movementDate: movementDate(payload.text),
        createdAt: entry.createdAt,
      },
      pendingSiblings()
    );

    const twinNote = twin
      ? `\n\n_Es el mismo movimiento que la pregunta #${twin.shortId} — contestar aquí o allá la cierra una sola vez._`
      : "";
    const sent = await sendSafeMessage(
      bot.telegram,
      notificationChatId,
      `📧 *Correo de ${escapeMarkdown(senderInstitution(payload.from))}*\n\nAsunto: ${escapeMarkdown(payload.subject)}\n\n${effectiveText}\n\n_↩️ Responde **directamente a este mensaje** con los datos faltantes._${twinNote}${ruleNote}`
    );

    if (twin) {
      // Reply-to on this message resolves the question it duplicates; the
      // original keeps working too.
      linkMessageId(twin.shortId, sent.message_id);
      console.log(`[email] misma pregunta que #${twin.shortId} — enlazada, no se encola otra`);
      return { status: "merged_question", written: 0, costUsd: result.costUsd };
    }

    storeClarification(sent.message_id, entry);
    return { status: "clarification", written: 0, costUsd: result.costUsd };
  }

  const rows = parseCsv(csv);
  if (rows.length === 0) throw new Error("Claude returned empty CSV block");

  const { records, originalRows, skipped } = convertRows(rows, lookup);

  // Happy path: all rows resolved → dedup check → silent write + Telegram notification
  if (skipped.length === 0 && records.length > 0) {
    // The batch passes a dedup built over its window; the interactive bot has
    // none, so answering a clarification could re-write what the batch already
    // recorded — which is how $33,750 was booked twice on 2026-08-19. Build one
    // on demand around the dates being proposed.
    let walletDedup = deps.walletDedup;
    if (!walletDedup) {
      try {
        const times = originalRows
          .map((r) => Date.parse(r.date.replace(" ", "T")))
          .filter((t) => Number.isFinite(t));
        if (times.length > 0) {
          const built = await buildWalletDedup(
            deps.couch,
            new Date(Math.min(...times)),
            new Date(Math.max(...times))
          );
          walletDedup = built.check;
        }
      } catch (err) {
        console.error(`[email] no se pudo construir el dedup de Wallet: ${err instanceof Error ? err.message : err}`);
      }
    }

    const duplicates = records
      .map((rec, i) => ({ rec, row: originalRows[i] }))
      .filter(({ rec, row }) =>
        findDuplicate(rec.accountId, parseFloat(row.amount), row.payee) !== null ||
        (walletDedup ? walletDedup(rec, row) !== null : false));

    if (duplicates.length > 0) {
      const dupLines = duplicates.map(({ row }) => {
        const amt = Math.abs(parseFloat(row.amount)).toFixed(2);
        return `⚠️ $${amt} en ${row.account} (${row.category})`;
      });
      console.log(`[email] duplicate detected — skipping write`);
      await sendSafeMessage(
        bot.telegram,
        notificationChatId,
        `🔁 *Posible duplicado* — no se guardó:\n${dupLines.join("\n")}`
      );
      return { status: "duplicate", written: 0, costUsd: result.costUsd };
    }

    const bulk = await writeRecords(couch, userId, records);
    console.log(`[email] wrote ${records.length} record(s) silently`);

    const now = new Date().toISOString();
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const row = originalRows[i];
      trackTransaction({
        ts: now,
        account: row.account,
        accountId: rec.accountId,
        amount: parseFloat(row.amount),
        category: row.category,
        payee: row.payee ?? "",
        status: "written",
      });
    }

    await bot.telegram.sendMessage(notificationChatId, `${buildSuccessMessage(rows)}${ruleNote}`);
    return {
      status: "written",
      written: records.length,
      costUsd: result.costUsd,
      writtenIds: bulk.map((b) => b.id),
    };
  }

  // Fallback: send proposal to Telegram for confirmation
  console.log(`[email] fallback → sending proposal to Telegram (skipped: ${skipped.length})`);

  const preview = cleanedText ? `${cleanedText}\n\n` : "";
  const csvPreview = csv.length > 1500 ? csv.slice(0, 1500) + "\n…(truncado)" : csv;
  const skippedNote = skipped.length > 0
    ? `\n⚠️ ${skipped.length} fila(s) no resolvieron: ${skipped.map((s) => s.reason).join("; ")}`
    : "";

  setPending(notificationChatId, { rows, summary: cleanedText ?? "", createdAt: Date.now() });

  const sent = await sendSafeMessage(
    bot.telegram,
    notificationChatId,
    `📧 *Correo bancario*\n\n${preview}📋 ${rows.length} registro(s)${skippedNote}:\n\`\`\`\n${csvPreview}\n\`\`\`${ruleNote}`,
    Markup.inlineKeyboard([
      Markup.button.callback("✅ Confirmar", "confirm_pending"),
      Markup.button.callback("❌ Cancelar", "cancel_pending"),
    ])
  );

  setPendingMessageId(notificationChatId, sent.message_id);

  return { status: "pending_confirmation", written: 0, costUsd: result.costUsd };
}
