import { v4 as uuidv4 } from "uuid";
import { Markup } from "telegraf";
import type { AxiosInstance } from "axios";
import type { Telegraf } from "telegraf";

import { convertRows, parseCsv } from "../csv.js";
import { writeRecords } from "../records.js";
import { runClaude } from "../bot/claude-runner.js";
import { extractCsvBlock } from "../bot/handlers.js";
import { escapeMarkdown, sendSafeMessage } from "../bot/telegram-safe.js";

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

Cuentas disponibles (usa el nombre exacto):
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
"Education, development", "Business trips", Advisory, "Charity, gifts", "Gifts, joy", "Dues & grants", Tips, Others

Si el usuario revela un hecho estable y reutilizable (de quién es una tarjeta, a qué cuenta va un cargo recurrente, categoría habitual de un comercio, o pide explícitamente "guárdalo en memoria"), emite ADEMÁS un bloque:
<<<RULE>>>
<regla en una línea, en español, autocontenida>
<<<END_RULE>>>
Emite el bloque solo para hechos nuevos que no estén ya en las reglas aprendidas.`;
import {
  setPending,
  setPendingMessageId,
} from "../bot/session.js";
import { storeClarification } from "./clarification-store.js";
import { findDuplicate, trackTransaction } from "./daily-tracker.js";
import { getLearnedRules, appendLearnedRule, extractRuleBlocks } from "./learned-rules.js";
import type { BotConfig } from "../bot/config.js";
import type { LookupMaps } from "../types.js";

export interface EmailPayload {
  from: string;
  subject: string;
  text: string;
}

export interface EmailDeps {
  bot: Telegraf;
  config: BotConfig;
  couch: AxiosInstance;
  userId: string;
  lookup: LookupMaps;
  notificationChatId: number;
}

export interface ProcessResult {
  status: "written" | "no_transaction" | "pending_confirmation" | "duplicate" | "clarification";
  written: number;
  costUsd: number | null;
}

function buildPrompt(payload: EmailPayload): string {
  const learnedRules = getLearnedRules();
  const rulesSection = learnedRules
    ? `Reglas aprendidas del usuario (respétalas SIEMPRE):\n${learnedRules}\n\n`
    : "";
  return (
    `${rulesSection}El usuario recibió el siguiente correo bancario. Analízalo y extrae las transacciones.\n\n` +
    `De: ${payload.from}\n` +
    `Asunto: ${payload.subject}\n` +
    `---\n${payload.text}\n---\n\n` +
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

export async function processEmail(
  deps: EmailDeps,
  payload: EmailPayload
): Promise<ProcessResult> {
  const { bot, config, couch, userId, lookup, notificationChatId } = deps;
  console.log(`[email] from=${payload.from} subject="${payload.subject}"`);

  const sessionId = uuidv4();
  const result = await runClaude({
    config,
    sessionId,
    isFirstTurn: true,
    prompt: buildPrompt(payload),
    appendSystemPrompt: EMAIL_SYSTEM_PROMPT,
    timeoutMs: 90_000,
  });

  if (!result.ok) throw new Error(`Claude error: ${result.text.slice(0, 300)}`);

  const rawText = result.text.trim();
  console.log(`[email] claude → ${rawText.slice(0, 120)}`);

  // Extract and persist any learned-rule blocks before further parsing —
  // they must never reach the user or the CSV extractor/parser.
  const { rules, cleanedText: responseText } = extractRuleBlocks(rawText);
  for (const rule of rules) appendLearnedRule(rule);
  const ruleNote = rules.map((r) => `\n\n🧠 Regla guardada: ${r}`).join("");

  if (responseText === "NO_TRANSACTION") {
    return { status: "no_transaction", written: 0, costUsd: result.costUsd };
  }

  const { csv, cleanedText } = extractCsvBlock(responseText);

  // Claude asked a clarifying question — persist context to disk and notify user
  if (!csv) {
    const sent = await sendSafeMessage(
      bot.telegram,
      notificationChatId,
      `📧 *Correo de ${escapeMarkdown(payload.from)}*\n\nAsunto: ${escapeMarkdown(payload.subject)}\n\n${responseText}\n\n_↩️ Responde **directamente a este mensaje** con los datos faltantes._${ruleNote}`
    );
    storeClarification(sent.message_id, {
      chatId: notificationChatId,
      emailFrom: payload.from,
      emailSubject: payload.subject,
      emailText: payload.text,
      claudeQuestion: responseText,
      createdAt: Date.now(),
    });
    return { status: "clarification", written: 0, costUsd: result.costUsd };
  }

  const rows = parseCsv(csv);
  if (rows.length === 0) throw new Error("Claude returned empty CSV block");

  const { records, originalRows, skipped } = convertRows(rows, lookup);

  // Happy path: all rows resolved → dedup check → silent write + Telegram notification
  if (skipped.length === 0 && records.length > 0) {
    const duplicates = records
      .map((rec, i) => ({ rec, row: originalRows[i] }))
      .filter(({ rec, row }) => findDuplicate(rec.accountId, parseFloat(row.amount), row.payee) !== null);

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

    await writeRecords(couch, userId, records);
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
    return { status: "written", written: records.length, costUsd: result.costUsd };
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
