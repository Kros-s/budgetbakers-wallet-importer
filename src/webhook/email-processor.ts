import { v4 as uuidv4 } from "uuid";
import { Markup } from "telegraf";
import type { AxiosInstance } from "axios";
import type { Telegraf } from "telegraf";

import { convertRows, parseCsv } from "../csv.js";
import { writeRecords } from "../records.js";
import { runClaude } from "../bot/claude-runner.js";
import { extractCsvBlock } from "../bot/handlers.js";

const EMAIL_SYSTEM_PROMPT = `Eres un extractor de transacciones bancarias. Analiza el correo que recibes y:

1. Si NO contiene una transacción real (marketing, promoción, OTP, aviso sin monto, estado de cuenta sin movimientos individuales): responde exactamente: NO_TRANSACTION

2. Si contiene una transacción pero te faltan datos clave (monto o cuenta): haz UNA pregunta concisa en español.

3. Si tienes todos los datos, genera el CSV entre los delimitadores:

<<<CSV>>>
date,account,amount,category,note,payee
2026-06-10 14:30:00,DolarApp,-25.00,Subscriptions,,Cloudflare
<<<END>>>

Reglas:
- date: YYYY-MM-DD HH:MM:SS en hora local; si no hay hora exacta usa 12:00:00
- account: nombre exacto según accounts.md del proyecto
- amount: negativo = gasto, positivo = ingreso
- category: nombre exacto según categories.md del proyecto
- Categorías con coma van entre comillas en el CSV
- Si no reconoces la cuenta, busca en accounts_card_endings.md por terminación de tarjeta
- Si aún no puedes resolver la cuenta, pregunta en lugar de inventar
- note y payee: opcionales, vacíos si no aplican`;
import {
  getOrCreateSession,
  setPending,
  setPendingMessageId,
} from "../bot/session.js";
import { findDuplicate, trackTransaction } from "./daily-tracker.js";
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
  return (
    `El usuario recibió el siguiente correo bancario. Analízalo y extrae las transacciones.\n\n` +
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

  const responseText = result.text.trim();
  console.log(`[email] claude → ${responseText.slice(0, 120)}`);

  if (responseText === "NO_TRANSACTION") {
    return { status: "no_transaction", written: 0, costUsd: result.costUsd };
  }

  const { csv, cleanedText } = extractCsvBlock(responseText);

  // Claude asked a clarifying question — hand off to bot's multi-turn session
  if (!csv) {
    const session = getOrCreateSession(notificationChatId);
    session.claudeSessionId = sessionId;
    session.turnsSent = 1;
    await bot.telegram.sendMessage(
      notificationChatId,
      `📧 *Correo de ${payload.from}*\n\n${responseText}\n\n_Responde con los datos o escribe *cancelar* para ignorar._`,
      { parse_mode: "Markdown" }
    );
    return { status: "clarification", written: 0, costUsd: result.costUsd };
  }

  const rows = parseCsv(csv);
  if (rows.length === 0) throw new Error("Claude returned empty CSV block");

  const { records, originalRows, skipped } = convertRows(rows, lookup);

  // Happy path: all rows resolved → dedup check → silent write + Telegram notification
  if (skipped.length === 0 && records.length > 0) {
    const duplicates = records
      .map((rec, i) => ({ rec, row: originalRows[i] }))
      .filter(({ rec, row }) => findDuplicate(rec.accountId, parseFloat(row.amount)) !== null);

    if (duplicates.length > 0) {
      const dupLines = duplicates.map(({ row }) => {
        const amt = Math.abs(parseFloat(row.amount)).toFixed(2);
        return `⚠️ $${amt} en ${row.account} (${row.category})`;
      });
      console.log(`[email] duplicate detected — skipping write`);
      await bot.telegram.sendMessage(
        notificationChatId,
        `🔁 *Posible duplicado* — no se guardó:\n${dupLines.join("\n")}`,
        { parse_mode: "Markdown" }
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

    await bot.telegram.sendMessage(notificationChatId, buildSuccessMessage(rows));
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

  const sent = await bot.telegram.sendMessage(
    notificationChatId,
    `📧 *Correo bancario*\n\n${preview}📋 ${rows.length} registro(s)${skippedNote}:\n\`\`\`\n${csvPreview}\n\`\`\``,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        Markup.button.callback("✅ Confirmar", "confirm_pending"),
        Markup.button.callback("❌ Cancelar", "cancel_pending"),
      ]),
    }
  );

  setPendingMessageId(notificationChatId, sent.message_id);

  return { status: "pending_confirmation", written: 0, costUsd: result.costUsd };
}
