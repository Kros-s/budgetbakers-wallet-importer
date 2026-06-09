/**
 * @file bot/handlers.ts
 * @description Telegram event handlers wired in from index.ts.
 *
 * Flow per incoming user turn:
 *  1. Allowlist guard (chat id must be in TELEGRAM_ALLOWED_CHAT_IDS).
 *  2. If the user was awaiting a confirmation and replies "si"/"confirmar",
 *     we hand the pending CsvRow[] to writeRecords and bypass Claude.
 *  3. Otherwise we build a prompt (text + optional file path), call
 *     runClaude, and inspect the reply for a fenced CSV block. If found,
 *     we stash it as pending and ask the user to confirm. If not, we
 *     just relay Claude's text to Telegram.
 *
 * Claude is told (via append-system-prompt) to never call the writer
 * itself — it only proposes the CSV. The bot is the sole writer.
 */

import type { Context, Telegraf } from "telegraf";
import { Markup } from "telegraf";
import { message } from "telegraf/filters";

import type { AxiosInstance } from "axios";
import type { LookupMaps } from "../types.js";
import { convertRows, parseCsv } from "../csv.js";
import type { CsvRow } from "../csv.js";
import { writeRecords } from "../records.js";
import type { Logger } from "../logger.js";

import type { BotConfig } from "./config.js";
import { runClaude } from "./claude-runner.js";
import { downloadTelegramFile } from "./telegram-files.js";
import { transcribeAudio } from "./whisper.js";
import {
  getOrCreateSession,
  markTurnSent,
  resetSession,
  setPending,
  setPendingMessageId,
  takePending,
  clearAllPending,
  type BotSession,
} from "./session.js";

export interface HandlerDeps {
  bot: Telegraf;
  config: BotConfig;
  couch: AxiosInstance;
  userId: string;
  lookup: LookupMaps;
  log: Logger;
}

export const SYSTEM_PROMPT = `Eres un asistente de finanzas integrado en un bot de Telegram para BudgetBakers Wallet. El usuario te enviará fotos de tickets, PDFs de estados de cuenta o texto describiendo gastos.

Tu trabajo:
1. Analizar el contenido (lee imágenes/PDFs con Read si te dan un path).
2. Extraer movimientos (monto, fecha, comercio, cuenta, categoría sugerida).
3. Si te falta información, PREGUNTA al usuario en lenguaje natural y termina ahí. NO emitas CSV.
4. Cuando tengas todo claro, propón los registros como CSV en este formato exacto:

<<<CSV>>>
date,account,amount,category,note,payee,label
2026-05-09 12:00:00,Bancomer,-150.50,Restaurant fast-food,,Starbucks,Comida 🥘
2026-05-09 13:00:00,Bancomer,-500.00,Fuel,,PEMEX,Sentra
<<<END>>>

5. ANTES del bloque CSV, muestra siempre un resumen visual de los movimientos en este formato:

💳 *Cuenta* | 📅 fecha | 💰 monto | 🏷️ categoría | 🏪 comercio | 🔖 label (si aplica)

Ejemplo:
💳 Bancomer | 📅 09 May 12:00 | 💸 -$150.50 | 🍔 Restaurant fast-food | 🏪 Starbucks | 🔖 Comida 🥘
💳 Bancomer | 📅 09 May 13:00 | 💸 -$500.00 | ⛽ Fuel | 🏪 PEMEX | 🔖 Sentra

Usa emojis contextuales según la categoría (🍔 comida, ⛽ gasolina, 🛒 despensa, 💊 salud, 🎬 entretenimiento, 🏠 hogar, etc.). Para ingresos usa 💰 en lugar de 💸. Al final del listado agrega el total: **Total: -$X.XX**

REGLAS DURAS:
- NUNCA ejecutes Bash con node, npm, pnpm, ni invoques dist/cli/index.js. El bot escribe a CouchDB después de que el usuario confirme con "si"/"confirmar".
- NUNCA llames herramientas mcp__claude_ai_Wallet__ que escriban (esas son solo lectura, igual confirma).
- Categorías y nombres de cuenta deben coincidir exactamente con los del usuario (ver memoria del proyecto: accounts.md, categories.md, feedback*.md).
- Categorías con coma van entre comillas en el CSV (ej. "Restaurant, fast-food").
- La columna \`label\` es opcional — omítela o déjala vacía si no aplica ningún label.
- Los nombres de label deben coincidir exactamente con los de labels.md (ej. "Sentra", "Marlene", "Toll", "Comida 🥘"). Solo un label por fila.
- Si no estás seguro de algún campo, pregunta. No inventes.
- Mantén las respuestas concisas, este es un chat de Telegram.

El bot mostrará tu respuesta tal cual al usuario en Telegram. Si emites el bloque <<<CSV>>>, el bot lo extraerá, lo mostrará al usuario, y le pedirá confirmar antes de escribir.`;

const CONFIRM_WORDS = new Set([
  "si", "sí", "yes", "y", "ok", "okay", "confirmar", "confirma", "dale", "go",
]);
const CANCEL_WORDS = new Set([
  "no", "n", "cancelar", "cancela", "cancel", "abort", "stop",
]);

function isAllowed(ctx: Context, allowed: Set<number>): boolean {
  const id = ctx.chat?.id;
  return typeof id === "number" && allowed.has(id);
}

const CSV_BLOCK_RE = /<<<CSV>>>\s*([\s\S]*?)\s*<<<END>>>/;

export function extractCsvBlock(text: string): { csv: string | null; cleanedText: string } {
  const m = text.match(CSV_BLOCK_RE);
  if (!m) return { csv: null, cleanedText: text };
  const csv = m[1].trim();
  const cleanedText = text.replace(CSV_BLOCK_RE, "").trim();
  return { csv, cleanedText };
}

async function sendLong(ctx: Context, text: string): Promise<void> {
  if (!text) return;
  const MAX = 4000;
  for (let i = 0; i < text.length; i += MAX) {
    await ctx.reply(text.slice(i, i + MAX));
  }
}

async function processUserTurn(
  deps: HandlerDeps,
  ctx: Context,
  session: BotSession,
  prompt: string
): Promise<void> {
  const { config, log } = deps;
  const isFirstTurn = session.turnsSent === 0;

  await ctx.sendChatAction("typing").catch(() => {});

  const result = await runClaude({
    config,
    sessionId: session.claudeSessionId,
    isFirstTurn,
    prompt,
    appendSystemPrompt: SYSTEM_PROMPT,
    disallowedTools: [
      "Bash(node*)",
      "Bash(npm*)",
      "Bash(pnpm*)",
      "Bash(npx*)",
      "Bash(tsx*)",
      "Bash(./dist/*)",
      "Bash(dist/*)",
      // Wallet MCP tools can hang indefinitely in the subprocess; all needed
      // label/account/category data is already in the project memory files.
      "mcp__claude_ai_Wallet__*",
    ],
    timeoutMs: 240_000,
  });

  markTurnSent(session.chatId);

  log("Claude turn", {
    chatId: session.chatId,
    sessionId: session.claudeSessionId,
    isFirstTurn,
    ok: result.ok,
    durationMs: result.durationMs,
    costUsd: result.costUsd,
    textLen: result.text.length,
  });

  if (!result.ok) {
    await ctx.reply(
      `⚠️ Claude reportó un error: ${result.text.slice(0, 500)}\n\n` +
        `Reintenta, o usa /reset para empezar la conversación de cero.`
    );
    return;
  }

  const { csv, cleanedText } = extractCsvBlock(result.text);

  if (csv) {
    let rows: CsvRow[];
    try {
      rows = parseCsv(csv);
    } catch (err) {
      await ctx.reply(
        `⚠️ Claude propuso un CSV pero no pude parsearlo: ${
          err instanceof Error ? err.message : String(err)
        }\nTexto crudo:\n\n${csv.slice(0, 1000)}`
      );
      return;
    }

    if (rows.length === 0) {
      await ctx.reply(
        "⚠️ Claude emitió un bloque CSV vacío. Intenta describir el gasto otra vez."
      );
      return;
    }

    setPending(session.chatId, {
      rows,
      summary: cleanedText,
      createdAt: Date.now(),
    });

    const queueLen = session.pendingQueue.length;
    const queueBadge = queueLen > 1 ? ` (${queueLen} pendientes)` : "";
    const preview = cleanedText ? `${cleanedText}\n\n` : "";
    const csvPreview = csv.length > 1500 ? csv.slice(0, 1500) + "\n…(truncado)" : csv;
    const body = `${preview}📋 Propuesta${queueBadge} — ${rows.length} registro${rows.length === 1 ? "" : "s"}:\n\`\`\`\n${csvPreview}\n\`\`\``;

    const sent = await ctx.reply(
      body,
      Markup.inlineKeyboard([
        Markup.button.callback("✅ Confirmar", "confirm_pending"),
        Markup.button.callback("❌ Cancelar", "cancel_pending"),
      ])
    );
    setPendingMessageId(session.chatId, sent.message_id);
    return;
  }

  await sendLong(ctx, cleanedText || "(sin respuesta)");
}

async function commitPending(
  deps: HandlerDeps,
  ctx: Context,
  session: BotSession,
  messageId?: number
): Promise<void> {
  const pending = takePending(session.chatId, messageId);
  if (!pending) {
    await ctx.reply("No hay nada pendiente de confirmar.");
    return;
  }

  await ctx.sendChatAction("typing").catch(() => {});

  const { records, originalRows, skipped } = convertRows(pending.rows, deps.lookup);

  const skippedReasons = skipped
    .slice(0, 5)
    .map((s, i) => `[${i + 1}] ${s.reason}`)
    .join("\n");

  if (records.length === 0) {
    await ctx.reply(
      `⚠️ No quedaron registros válidos. ${skipped.length} descartados:\n${skippedReasons}`
    );
    await processUserTurn(
      deps, ctx, session,
      `El CSV que propuse falló validación al intentar importarlo. ` +
      `${skipped.length} registro(s) descartados:\n${skippedReasons}\n\n` +
      `Por favor corrige y propón un nuevo CSV.`
    );
    return;
  }

  let results;
  try {
    results = await writeRecords(deps.couch, deps.userId, records);
  } catch (err) {
    deps.log.error("writeRecords threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    await ctx.reply(
      `❌ Falló la escritura a CouchDB: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return;
  }

  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;

  deps.log("Bot import committed", {
    chatId: session.chatId,
    sessionId: session.claudeSessionId,
    ok,
    fail,
    skipped: skipped.length,
    proposedAt: pending.createdAt,
  });

  let msg = `✅ ${ok} registro${ok === 1 ? "" : "s"} escrito${ok === 1 ? "" : "s"}.`;
  if (fail > 0) msg += `\n❌ ${fail} fallaron en CouchDB.`;
  if (skipped.length > 0) msg += `\n⏭️ ${skipped.length} omitidos:\n${skippedReasons}`;
  await ctx.reply(msg);

  if (skipped.length > 0) {
    await processUserTurn(
      deps, ctx, session,
      `${skipped.length} registro(s) no pudieron importarse por errores de validación:\n${skippedReasons}\n\n` +
      `Por favor corrígelos y propón un nuevo CSV solo para los registros fallidos.`
    );
  }
}

export function registerHandlers(deps: HandlerDeps): void {
  const { bot, config, log } = deps;

  bot.use(async (ctx, next) => {
    if (!isAllowed(ctx, config.allowedChatIds)) {
      log.warn("Unauthorized chat", { chatId: ctx.chat?.id, from: ctx.from?.username });
      await ctx.reply("⛔ No autorizado.");
      return;
    }
    return next();
  });

  bot.command("start", async (ctx) => {
    const s = getOrCreateSession(ctx.chat.id);
    await ctx.reply(
      `Hola. Mándame una foto, un PDF o describe un gasto en texto.\n` +
        `Sesión: \`${s.claudeSessionId.slice(0, 8)}…\`\n` +
        `Comandos: /reset (nueva conversación), /cancel (descartar propuesta).`
    );
  });

  bot.command("reset", async (ctx) => {
    const s = resetSession(ctx.chat.id);
    await ctx.reply(`🔄 Conversación reiniciada. Sesión: \`${s.claudeSessionId.slice(0, 8)}…\``);
  });

  bot.command("cancel", async (ctx) => {
    const cleared = clearAllPending(ctx.chat.id);
    await ctx.reply(
      cleared.length > 0
        ? `🗑️ ${cleared.length} propuesta${cleared.length === 1 ? "" : "s"} descartada${cleared.length === 1 ? "" : "s"}.`
        : "Nada pendiente que cancelar."
    );
  });

  bot.on(message("photo"), async (ctx) => {
    try {
      const session = getOrCreateSession(ctx.chat.id);

      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const downloaded = await downloadTelegramFile(bot, ctx, largest.file_id, {
        downloadDir: config.downloadDir,
        mimeType: "image/jpeg",
        fallbackExt: ".jpg",
      });

      log("Photo received", {
        chatId: ctx.chat.id,
        path: downloaded.localPath,
        size: downloaded.sizeBytes,
      });

      const caption = ctx.message.caption?.trim() ?? "";
      const prompt =
        `El usuario envió una foto en Telegram. Está guardada localmente en:\n${downloaded.localPath}\n\n` +
        (caption ? `Caption del usuario: "${caption}"\n\n` : "") +
        `Analízala (lee el archivo con Read), extrae los movimientos y propón el CSV cuando estés listo, o pregunta lo que falte.`;

      await processUserTurn(deps, ctx, session, prompt);
    } catch (err) {
      log.error("Photo handler failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.reply(
        `❌ Error procesando la foto: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  bot.on(message("document"), async (ctx) => {
    try {
      const session = getOrCreateSession(ctx.chat.id);

      const doc = ctx.message.document;
      const downloaded = await downloadTelegramFile(bot, ctx, doc.file_id, {
        downloadDir: config.downloadDir,
        mimeType: doc.mime_type ?? null,
        fallbackExt: doc.file_name ? `.${doc.file_name.split(".").pop()}` : ".bin",
      });

      log("Document received", {
        chatId: ctx.chat.id,
        path: downloaded.localPath,
        mime: doc.mime_type,
        size: downloaded.sizeBytes,
      });

      const caption = ctx.message.caption?.trim() ?? "";
      const prompt =
        `El usuario envió un documento en Telegram (${doc.mime_type ?? "tipo desconocido"}, ${
          downloaded.sizeBytes
        } bytes). Guardado en:\n${downloaded.localPath}\n\n` +
        (caption ? `Caption: "${caption}"\n\n` : "") +
        `Léelo (con Read; si es PDF puedes pasar pages para PDFs grandes), extrae movimientos y propón el CSV cuando estés listo. Si necesitas info, pregunta.`;

      await processUserTurn(deps, ctx, session, prompt);
    } catch (err) {
      log.error("Document handler failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.reply(
        `❌ Error procesando el documento: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  bot.on(message("voice"), async (ctx) => {
    try {
      const session = getOrCreateSession(ctx.chat.id);
      const voice = ctx.message.voice;

      await ctx.sendChatAction("typing").catch(() => {});
      await ctx.reply("🎙️ Transcribiendo…").catch(() => {});

      const downloaded = await downloadTelegramFile(bot, ctx, voice.file_id, {
        downloadDir: config.downloadDir,
        mimeType: voice.mime_type ?? "audio/ogg",
        fallbackExt: ".ogg",
      });

      log("Voice received", {
        chatId: ctx.chat.id,
        path: downloaded.localPath,
        duration: voice.duration,
        size: downloaded.sizeBytes,
      });

      let transcript: string;
      try {
        transcript = await transcribeAudio(downloaded.localPath, {
          whisperBin: config.whisperBin,
          model: config.whisperModel,
        });
      } catch (err) {
        await ctx.reply(
          `⚠️ No pude transcribir el audio: ${err instanceof Error ? err.message : String(err)}\n\n` +
            `Asegúrate de que whisper esté instalado:\n\`pip install openai-whisper\``
        );
        return;
      }

      if (!transcript) {
        await ctx.reply(
          "⚠️ No encontré texto en el audio. Intenta de nuevo o escribe el gasto."
        );
        return;
      }

      const prompt =
        `El usuario envió un mensaje de voz (${voice.duration}s). Transcripción automática:\n\n"${transcript}"\n\n` +
        `Extrae los movimientos mencionados y propón el CSV cuando estés listo, o pregunta lo que falte.`;

      await processUserTurn(deps, ctx, session, prompt);
    } catch (err) {
      log.error("Voice handler failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.reply(
        `❌ Error procesando el audio: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  bot.action("confirm_pending", async (ctx) => {
    await ctx.answerCbQuery();
    const session = getOrCreateSession(ctx.chat!.id);
    const messageId = ctx.callbackQuery.message?.message_id;
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await commitPending(deps, ctx as unknown as Context, session, messageId);
  });

  bot.action("cancel_pending", async (ctx) => {
    await ctx.answerCbQuery();
    const messageId = ctx.callbackQuery.message?.message_id;
    const taken = takePending(ctx.chat!.id, messageId);
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(taken ? "🗑️ Propuesta descartada." : "Nada pendiente que cancelar.");
  });

  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text.trim();
    const session = getOrCreateSession(ctx.chat.id);

    if (session.pendingQueue.length > 0) {
      const word = text.toLowerCase();
      // If the user replied to a specific proposal message, target that entry.
      const replyToId = ctx.message.reply_to_message?.message_id;

      if (CONFIRM_WORDS.has(word)) {
        await commitPending(deps, ctx, session, replyToId);
        return;
      }
      if (CANCEL_WORDS.has(word)) {
        const taken = takePending(ctx.chat.id, replyToId);
        await ctx.reply(taken ? "🗑️ Propuesta descartada." : "Nada pendiente que cancelar.");
        return;
      }
      // Falls through: user is amending — let Claude refine it.
    }

    try {
      await processUserTurn(deps, ctx, session, text);
    } catch (err) {
      log.error("Text handler failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.reply(
        `❌ Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });
}
