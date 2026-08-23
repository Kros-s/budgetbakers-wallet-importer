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

import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import type { Context, Telegraf } from "telegraf";
import { Markup } from "telegraf";
import { message } from "telegraf/filters";

import type { AxiosInstance } from "axios";
import type { LookupMaps } from "../types.js";
import { convertRows, parseCsv, rowsToCsv } from "../csv.js";
import type { CsvRow } from "../csv.js";
import { writeRecords } from "../records.js";
import { buildWalletDedup } from "../batch/wallet-dedup.js";
import type { Logger } from "../logger.js";

import type { BotConfig } from "./config.js";
import { runClaude, StaleSessionError } from "./claude-runner.js";
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
import { trackTransaction } from "../webhook/daily-tracker.js";
import {
  takeClarification,
  storeClarification,
  type ClarificationEntry,
} from "../webhook/clarification-store.js";
import { EMAIL_SYSTEM_PROMPT } from "../webhook/email-processor.js";
import { getLearnedRules, appendLearnedRule, extractRuleBlocks } from "../webhook/learned-rules.js";
import {
  ensureShortIds, findByMessageId, findByShortId, findClosed, linkMessageId,
  takeByShortId, updateClarificationQuestion,
} from "../webhook/clarification-store.js";
import { formatPendingDetail, formatPendingIndex, looksLikeHandleAnswer, parseAnswers, questionAmountCents, sortByImportance } from "./pending-view.js";
import { HELP_TEXT } from "./commands.js";
import { movementDate, senderInstitution } from "./email-facts.js";
import { addIgnorePattern, listIgnorePatterns, matchesPattern, relaxAccents, toLiteralPattern } from "../webhook/ignore-rules.js";
import { formatVerdict, judge } from "../webhook/pending-audit.js";
import { parseVerdict } from "../webhook/verdict.js";
import { buildIgnorePreview, formatIgnorePreview } from "./ignore-preview.js";
import { formatStatementsTable } from "./statements-view.js";
import { DETECTION_PROMPT, looksLikeStatement, monthOf, parseDetection, resolveAccount } from "../statements/detect.js";
import { fileStatement, formatArrivals, unidentifiedArrivals } from "../statements/filing.js";
import { formatCoverage, loadLedger, monthCoverage } from "../statements/ledgers.js";
import { countBy, formatPlan, writableRows } from "../statements/apply.js";
import { commitGuardedWrite, formatGuardReport, guardWrite } from "../statements/guarded-write.js";
import { MONTH_SPEC, loadMonth } from "../statements/month-runner.js";
import { listRecordsByDateRange } from "../records.js";
import {
  alreadyInWallet, crossTransfers, formatCrossing, orphanTransferLegs,
  toLedgerRows, toWalletRows,
} from "../statements/crossing.js";
import { formatAccountPeriods, splitAtAccountBoundary } from "../statements/month-window.js";
import {
  formatReconcileSummary, needsAttention, parseReconcileOutput, reconcileCommand, runReconcile,
  SerialQueue,
} from "./statement-flow.js";
import { statementStatus } from "../statements/registry.js";
import { candidateAmounts, findExistingByAmount, formatWalletContext } from "../webhook/wallet-context.js";
import { activeQuestion, justExpired, startGuided, stopGuided, secondsLeft } from "./guided-mode.js";
import { escapeMarkdown, replySafe, sendSafeMessage } from "./telegram-safe.js";

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

REGLAS DURAS:
- NUNCA ejecutes Bash con node, npm, pnpm, ni invoques dist/cli/index.js. El bot escribe a CouchDB después de que el usuario confirme con "si"/"confirmar".
- NUNCA llames herramientas mcp__claude_ai_Wallet__ que escriban (esas son solo lectura, igual confirma).
- Categorías y nombres de cuenta deben coincidir exactamente con los del usuario (ver memoria del proyecto: accounts.md, categories.md, feedback*.md).
- Categorías con coma van entre comillas en el CSV (ej. "Restaurant, fast-food").
- La columna \`label\` es opcional — omítela o déjala vacía si no aplica ningún label.
- Los nombres de label deben coincidir exactamente con los de labels.md (ej. "Sentra", "Marlene", "Toll", "Comida 🥘"). Solo un label por fila.
- Si no estás seguro de algún campo, pregunta. No inventes.
- Mantén las respuestas concisas, este es un chat de Telegram.
- Para registrar una transferencia entre cuentas propias del usuario emite DOS filas CSV con la MISMA fecha/hora exacta y categoría "Transfer, withdraw": una negativa en la cuenta origen y una positiva en la cuenta destino. NUNCA emitas una sola fila con categoría Transfer (se rechaza). Para dinero que llega de fuera (no es cuenta propia), usa categoría de ingreso normal (p.ej. Others o "Wage, invoices"), no Transfer.

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

/**
 * Which pending question, if any, this message is answering.
 *
 * Attachments were text-only until now: a photo replying to a question landed
 * in the photo handler, which knew nothing about the queue, so it was read as a
 * brand new expense. Both routes are accepted — a reply to any message showing
 * the question, or a `#35` at the start of the caption.
 */
function clarificationTarget(
  replyToId: number | undefined,
  caption: string
): { found: { messageId: number; entry: ClarificationEntry }; text: string } | null {
  const byHandle = /^#(\d+)\s*([\s\S]*)$/.exec(caption.trim());
  if (byHandle) {
    const found = findByShortId(Number(byHandle[1]));
    if (found) return { found, text: byHandle[2].trim() };
  }
  if (replyToId !== undefined) {
    const found = findByMessageId(replyToId);
    if (found) return { found, text: caption };
  }
  return null;
}

async function buildClarificationPrompt(
  deps: HandlerDeps,
  c: ClarificationEntry,
  userReply: string
): Promise<string> {
  const body = c.emailText.length > 3000 ? c.emailText.slice(0, 3000) + "\n…(truncado)" : c.emailText;
  const learnedRules = getLearnedRules();
  const rulesSection = learnedRules
    ? `Reglas aprendidas del usuario (respétalas SIEMPRE):\n${learnedRules}\n\n`
    : "";
  // "¿Ya está registrado?" is a question the model cannot answer on its own and
  // should never have to guess at, so the matching records travel with the ask.
  let walletSection = "";
  try {
    const amounts = candidateAmounts(c.emailText, c.claudeQuestion, userReply);
    const namesById: Record<string, string> = {};
    for (const [name, id] of Object.entries(deps.lookup.accounts)) namesById[id] = name;
    walletSection = formatWalletContext(
      await findExistingByAmount(deps.couch, amounts, namesById),
      amounts
    );
  } catch (err) {
    deps.log.error("No se pudo consultar Wallet para el contexto", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return (
    walletSection +
    `${rulesSection}Contexto: Se analizó el siguiente correo bancario:\n\n` +
    `De: ${c.emailFrom}\nAsunto: ${c.emailSubject}\n---\n${body}\n---\n\n` +
    `Tu pregunta anterior fue: "${c.claudeQuestion}"\n\n` +
    `El usuario respondió: "${userReply}"\n\n` +
    `Con esta información, propón el CSV. Si aún falta algo, haz una pregunta concisa.\n\n` +
    `Si el usuario reveló un hecho estable y reutilizable (de quién es una tarjeta, a qué cuenta va un cargo recurrente, categoría habitual de un comercio, o pide explícitamente "guárdalo en memoria"), emite ADEMÁS un bloque:\n` +
    `<<<RULE>>>\n<regla en una línea, en español, autocontenida>\n<<<END_RULE>>>\n` +
    `Emite el bloque solo para hechos nuevos que no estén ya en las reglas aprendidas.`
  );
}

async function processUserTurn(
  deps: HandlerDeps,
  ctx: Context,
  session: BotSession,
  prompt: string,
  systemPrompt: string = SYSTEM_PROMPT,
  /** Set when this turn is answering a clarification, so it can be kept or
   *  dropped according to how the turn ends. */
  clarificationShortId?: number,
  /** True when the user was correcting a proposal that is still on screen. */
  amending = false
): Promise<void> {
  const { config, log } = deps;
  let activeSession = session;
  let isFirstTurn = activeSession.turnsSent === 0;

  await ctx.sendChatAction("typing").catch(() => {});

  // A resume can fail because the conversation lives in another machine's
  // ~/.claude — the state after a host migration. Losing the context is
  // unavoidable there; losing the user's message is not, so start a fresh
  // session and replay this turn into it.
  const invoke = () => runClaude({
    config,
    sessionId: activeSession.claudeSessionId,
    isFirstTurn,
    prompt,
    appendSystemPrompt: systemPrompt,
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

  let result;
  try {
    result = await invoke();
  } catch (err) {
    if (!(err instanceof StaleSessionError) || isFirstTurn) throw err;
    log("Sesión de Claude no encontrada — reiniciándola y reintentando el turno", {
      chatId: activeSession.chatId,
      staleSessionId: activeSession.claudeSessionId,
    });
    activeSession = resetSession(activeSession.chatId);
    isFirstTurn = true;
    result = await invoke();
  }

  markTurnSent(activeSession.chatId);

  log("Claude turn", {
    chatId: activeSession.chatId,
    sessionId: activeSession.claudeSessionId,
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

  // Extract and persist any learned-rule blocks before further parsing —
  // they must never reach the user or the CSV extractor/parser.
  const { rules, cleanedText: dedupedText } = extractRuleBlocks(result.text);
  for (const rule of rules) appendLearnedRule(rule);
  const ruleNote = rules.map((r) => `\n\n🧠 Regla guardada: ${r}`).join("");

  const { csv, cleanedText } = extractCsvBlock(dedupedText);

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

    // The old proposal is still on screen with live buttons, and its data is
    // now wrong. Pressing it would write the version the user just corrected —
    // silently, since nothing distinguishes a stale message from a fresh one.
    if (amending) {
      for (const stale of clearAllPending(session.chatId)) {
        if (stale.messageId === undefined) continue;
        await ctx.telegram
          .editMessageReplyMarkup(session.chatId, stale.messageId, undefined, { inline_keyboard: [] })
          .catch(() => {});
        await ctx.telegram
          .editMessageText(
            session.chatId, stale.messageId, undefined,
            `~Propuesta reemplazada~\n\n_Corregida abajo._`,
            { parse_mode: "Markdown" }
          )
          .catch(() => {});
      }
    }

    setPending(session.chatId, {
      rows,
      summary: cleanedText,
      createdAt: Date.now(),
      clarificationShortId,
    });

    // Warn before the button, not after. The confirm path blocks duplicates
    // either way, but finding out at proposal time is the difference between
    // "why did nothing happen?" and an informed decision.
    let dupWarning = "";
    try {
      const times = rows.map((r) => Date.parse(r.date.replace(" ", "T"))).filter((t) => Number.isFinite(t));
      if (times.length > 0) {
        const { records: candidates, originalRows: candidateRows } = convertRows(rows, deps.lookup);
        const { check } = await buildWalletDedup(
          deps.couch, new Date(Math.min(...times)), new Date(Math.max(...times))
        );
        const hits = candidates
          .map((rec, i) => ({ hit: check(rec, candidateRows[i]), row: candidateRows[i] }))
          .filter((x) => x.hit);
        if (hits.length > 0) {
          dupWarning =
            `\n\n🔁 *Ojo:* ${hits.length} de estas filas ya parecen estar en Wallet:\n` +
            hits.map((h) => `• $${Math.abs(parseFloat(h.row.amount)).toFixed(2)} en ${h.row.account}`).join("\n") +
            `\nSi confirmas, esas se omiten.`;
        }
      }
    } catch { /* the warning is a courtesy; the gate at confirm is the guarantee */ }

    const queueLen = session.pendingQueue.length;
    const queueBadge = queueLen > 1 ? ` (${queueLen} pendientes)` : "";
    const preview = cleanedText ? `${cleanedText}\n\n` : "";
    const csvPreview = csv.length > 1500 ? csv.slice(0, 1500) + "\n…(truncado)" : csv;
    const body = `${preview}📋 Propuesta${queueBadge} — ${rows.length} registro${rows.length === 1 ? "" : "s"}:\n\`\`\`\n${csvPreview}\n\`\`\`${dupWarning}${ruleNote}`;

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

  // The user judged this one not to be a movement and the model agreed. Their
  // call closes it: a dismissal is a decision, and re-filing the agreement as a
  // fresh question left #23, #26 and #27 asking about things already settled.
  if (clarificationShortId !== undefined) {
    const verdict = parseVerdict(cleanedText.trim());
    if (verdict.isNoTransaction) {
      takeByShortId(clarificationShortId, "la descartaste: no era una transacción");
      await sendLong(
        ctx,
        `🚫 #${clarificationShortId} descartada — no es un movimiento.` +
          (verdict.reason ? `\n_${verdict.reason.slice(0, 200)}_` : "") +
          ruleNote
      );
      return;
    }
  }

  // No CSV: the movement is still unresolved, so the question stays in the
  // queue — updated to whatever is being asked now.
  if (clarificationShortId !== undefined && cleanedText.trim()) {
    updateClarificationQuestion(clarificationShortId, cleanedText.trim());
    await sendLong(ctx, `${cleanedText}${ruleNote}\n\n_Sigue pendiente como #${clarificationShortId}._`);
    return;
  }

  await sendLong(ctx, (cleanedText || "(sin respuesta)") + ruleNote);
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
    const originalCsv = rowsToCsv(pending.rows);
    await processUserTurn(
      deps, ctx, session,
      `El CSV que propuse falló validación al intentar importarlo. ` +
      `${skipped.length} registro(s) descartados:\n${skippedReasons}\n\n` +
      `Estas eran las filas originales:\n${originalCsv}\n` +
      `Corrige SOLO los campos rechazados y re-emite el bloque <<<CSV>>> completo con los mismos datos.`
    );
    return;
  }

  // Last gate before anything reaches Wallet. This path — propose, confirm,
  // write — had no duplicate check of any kind, which is how the $33,750
  // transfer was recorded twice on 2026-08-19: the batch had already written it
  // that morning and answering the clarification wrote it again.
  let toWrite = records;
  let toWriteRows = originalRows;
  const dupes: string[] = [];
  try {
    const times = originalRows
      .map((r) => Date.parse(r.date.replace(" ", "T")))
      .filter((t) => Number.isFinite(t));
    if (times.length > 0) {
      const { check } = await buildWalletDedup(
        deps.couch, new Date(Math.min(...times)), new Date(Math.max(...times))
      );
      const keep: typeof records = [];
      const keepRows: typeof originalRows = [];
      records.forEach((rec, i) => {
        const hit = check(rec, originalRows[i]);
        if (hit) {
          const amt = Math.abs(parseFloat(originalRows[i].amount)).toFixed(2);
          dupes.push(`$${amt} en ${originalRows[i].account} — ${hit}`);
        } else {
          keep.push(rec);
          keepRows.push(originalRows[i]);
        }
      });
      toWrite = keep;
      toWriteRows = keepRows;
    }
  } catch (err) {
    // Fail closed. The catch used to leave `toWrite` as the full list and write
    // everything unchecked while still reporting "N registros escritos" — a
    // CouchDB timeout or a view rebuild silently disarmed the guard that exists
    // because a $33,750 transfer was once written twice.
    deps.log.error("No se pudo verificar duplicados en Wallet", {
      error: err instanceof Error ? err.message : String(err),
    });
    await ctx.reply(
      `⛔ No pude comprobar duplicados contra Wallet, así que no escribí nada.\n` +
        `Vuelve a confirmar en un momento.`
    );
    return;
  }

  if (toWrite.length === 0) {
    await ctx.reply(
      `🔁 *No se escribió nada: ya está en Wallet.*\n${dupes.map((d) => `• ${d}`).join("\n")}`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  let results;
  try {
    results = await writeRecords(deps.couch, deps.userId, toWrite);
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

  const now = new Date().toISOString();
  // Iterate the rows actually sent: `records` still holds the ones filtered out
  // as duplicates, and indexing it against `results` would misattribute them.
  toWrite.forEach((rec, i) => {
    if (results[i]?.ok) {
      const row = toWriteRows[i];
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
  });

  deps.log("Bot import committed", {
    chatId: session.chatId,
    sessionId: session.claudeSessionId,
    ok,
    fail,
    skipped: skipped.length,
    proposedAt: pending.createdAt,
  });

  let msg = `✅ ${ok} registro${ok === 1 ? "" : "s"} escrito${ok === 1 ? "" : "s"}.`;
  if (dupes.length > 0) {
    msg += `\n🔁 ${dupes.length} omitido${dupes.length === 1 ? "" : "s"} por ya estar en Wallet:\n${dupes.map((d) => `• ${d}`).join("\n")}`;
  }
  if (fail > 0) msg += `\n❌ ${fail} fallaron en CouchDB.`;
  if (skipped.length > 0) msg += `\n⏭️ ${skipped.length} omitidos:\n${skippedReasons}`;

  // The movement is finally recorded, so the question can leave the queue.
  // Only on a clean write: if anything was skipped it is still unresolved.
  const closed: number[] = [];
  if (pending.clarificationShortId !== undefined && ok > 0 && skipped.length === 0) {
    if (takeByShortId(pending.clarificationShortId, "se registró el movimiento")) closed.push(pending.clarificationShortId);
  }

  // The link above only exists when the answer arrived as a reply or with a
  // handle. Send the receipt photo as a plain message and the write succeeds
  // while the question stays queued forever — which is what happened to #13 and
  // #14 on 2026-08-20. So also close by what was actually written: a pending
  // question asking about exactly this amount is answered by this record.
  if (ok > 0 && skipped.length === 0) {
    for (const row of toWriteRows) {
      const cents = Math.round(Math.abs(parseFloat(row.amount)) * 100);
      if (!Number.isFinite(cents) || cents === 0) continue;
      const matches = ensureShortIds()
        .filter((i) => i.entry.chatId === session.chatId)
        .filter((i) => !closed.includes(i.entry.shortId!))
        .filter((i) => questionAmountCents(i.entry) === cents);
      // Only when it is unambiguous. Two questions about the same amount is
      // exactly the case where guessing writes the wrong outcome.
      if (matches.length === 1 && takeByShortId(matches[0].entry.shortId!, "se registró un movimiento por ese monto")) {
        closed.push(matches[0].entry.shortId!);
      }
    }
  }
  if (closed.length) {
    msg += `\n📋 ${closed.map((c) => `#${c}`).join(", ")} resuelta${closed.length === 1 ? "" : "s"} y fuera de la cola.`;
  }
  await ctx.reply(msg);

  if (skipped.length > 0) {
    const originalCsv = rowsToCsv(skipped.map((s) => s.row));
    await processUserTurn(
      deps, ctx, session,
      `${skipped.length} registro(s) no pudieron importarse por errores de validación:\n${skippedReasons}\n\n` +
      `Estas eran las filas originales:\n${originalCsv}\n` +
      `Corrige SOLO los campos rechazados y re-emite el bloque <<<CSV>>> completo con los mismos datos.`
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

  // ── Cola de aclaraciones ──────────────────────────────────────────────────
  // Responder al mensaje original funciona mientras la pregunta es reciente y
  // deja de servir con 42 acumuladas. Estos comandos permiten atenderlas por
  // handle, sin buscar nada en el historial.

  bot.command("pending", async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1]?.replace(/^#/, "");
    const items = ensureShortIds().filter((i) => i.entry.chatId === ctx.chat.id);

    // `/pending 35` asks for one question in full; `/pending` is the index.
    if (arg && /^\d+$/.test(arg)) {
      const one = items.find((i) => i.entry.shortId === Number(arg));
      const sent = await sendSafeMessage(
        deps.bot.telegram,
        ctx.chat.id,
        one ? formatPendingDetail(one) : `No hay pendiente #${arg}. Usa /pending para ver la lista.`
      );
      // Replying to this detail must resolve the question, not open a new expense.
      if (one) linkMessageId(one.entry.shortId!, sent.message_id);
      return;
    }

    for (const chunk of formatPendingIndex(items)) {
      await sendSafeMessage(deps.bot.telegram, ctx.chat.id, chunk);
    }
  });

  bot.command("remind", async (ctx) => {
    const count = Math.min(Math.max(Number(ctx.message.text.split(/\s+/)[1]) || 5, 1), 10);
    const items = sortByImportance(ensureShortIds().filter((i) => i.entry.chatId === ctx.chat.id));
    if (items.length === 0) {
      await ctx.reply("✅ No hay aclaraciones pendientes.");
      return;
    }
    const batch = items.slice(0, count);
    await ctx.reply(`🔔 Reenviando ${batch.length} de ${items.length}, mayores primero.`);
    for (const item of batch) {
      // Same template as /pending <handle>, minus the raw excerpt: five full
      // excerpts in a row would bury the questions they are meant to surface.
      const sent = await sendSafeMessage(
        deps.bot.telegram,
        ctx.chat.id,
        formatPendingDetail(item, { excerpt: false })
      );
      // Link rather than move: the original message keeps working too.
      linkMessageId(item.entry.shortId!, sent.message_id);
    }
  });

  bot.command("next", async (ctx) => {
    const items = sortByImportance(ensureShortIds().filter((i) => i.entry.chatId === ctx.chat.id));
    if (items.length === 0) {
      stopGuided(ctx.chat.id);
      await ctx.reply("✅ No queda ninguna aclaración pendiente.");
      return;
    }
    const { entry } = items[0];
    startGuided(ctx.chat.id, entry.shortId!);
    const prompt = await sendSafeMessage(
      deps.bot.telegram,
      ctx.chat.id,
      `🧭 *Modo guiado \\(beta\\)* · quedan ${items.length}\n\n` +
        `📧 *#${entry.shortId} · ${escapeMarkdown(senderInstitution(entry.emailFrom))}*\n${entry.claudeQuestion}\n\n` +
        `_Responde con texto normal en los próximos 2 minutos, o responde a este mensaje cuando quieras. Luego /next para la siguiente, o /stop para salir._`
    );
    linkMessageId(entry.shortId!, prompt.message_id);
  });

  bot.command("audit", async (ctx) => {
    const items = ensureShortIds().filter((i) => i.entry.chatId === ctx.chat.id);
    if (items.length === 0) {
      await ctx.reply("✅ No hay aclaraciones pendientes.");
      return;
    }
    await ctx.reply(`🔍 Revisando ${items.length} pendientes contra Wallet…`);

    const namesById: Record<string, string> = {};
    for (const [name, id] of Object.entries(deps.lookup.accounts)) namesById[id] = name;

    const resolved: string[] = [];
    const doubtful: string[] = [];
    for (const { entry } of items) {
      const cents = questionAmountCents(entry);
      if (!cents) continue;
      const matches = await findExistingByAmount(deps.couch, [cents], namesById);
      if (matches.length === 0) continue;
      const verdict = judge({
        shortId: entry.shortId!, amountCents: cents,
        movementDate: movementDate(entry.emailText), matches,
      });
      if (verdict.resolved) {
        takeByShortId(entry.shortId!, "ya estaba en Wallet");
        resolved.push(formatVerdict(verdict));
      } else {
        doubtful.push(formatVerdict(verdict));
      }
    }

    if (resolved.length === 0 && doubtful.length === 0) {
      await ctx.reply("Nada que conciliar: ninguna pendiente coincide con un registro existente.");
      return;
    }
    let msg = "";
    if (resolved.length) {
      msg += `*Ya registradas — las cerré (${resolved.length})*\n${resolved.join("\n")}\n\n`;
    }
    if (doubtful.length) {
      // Never closed on a guess: a wrong close hides a real movement for good.
      msg += `*Parecidas, pero no las cierro (${doubtful.length})*\n${doubtful.join("\n")}\n\n_Revísalas con \`/pending N\`._`;
    }
    await sendSafeMessage(deps.bot.telegram, ctx.chat.id, msg);
  });

  // A block rule is the one setting that fails silently — too broad and real
  // movements stop arriving with nothing to notice — so it is proposed, its
  // blast radius shown, and applied only on confirmation.
  const proposedIgnores = new Map<number, { typed: string; pattern: string }>();

  bot.command("ignore", async (ctx) => {
    const typed = ctx.message.text.replace(/^\/ignore(?:@\S+)?\s*/i, "").trim();

    if (!typed) {
      const patterns = listIgnorePatterns();
      await ctx.reply(
        `🚫 *${patterns.length} reglas de ignorado*\n\n` +
          patterns.map((p) => `• \`${p}\``).join("\n") +
          `\n\nAgrega una con \`/ignore texto del asunto\`.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const pattern = relaxAccents(toLiteralPattern(typed));
    if (listIgnorePatterns().includes(pattern)) {
      await ctx.reply("Ya existe esa regla. Con `/ignore` sin texto las ves todas.", { parse_mode: "Markdown" });
      return;
    }

    const pending = ensureShortIds().filter((i) => i.entry.chatId === ctx.chat.id);
    const preview = buildIgnorePreview(typed, pattern, pending);
    proposedIgnores.set(ctx.chat.id, { typed, pattern });

    await sendSafeMessage(deps.bot.telegram, ctx.chat.id, formatIgnorePreview(preview), {
      reply_markup: Markup.inlineKeyboard([
        Markup.button.callback("✅ Ignorar", "confirm_ignore"),
        Markup.button.callback("❌ Cancelar", "cancel_ignore"),
      ]).reply_markup,
    });
  });

  bot.action("confirm_ignore", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    const proposed = proposedIgnores.get(ctx.chat!.id);
    if (!proposed) {
      await ctx.reply("Esa propuesta ya no está vigente. Vuelve a escribir /ignore.");
      return;
    }
    proposedIgnores.delete(ctx.chat!.id);

    const { pattern, added, total } = addIgnorePattern(proposed.typed);
    const hit = ensureShortIds()
      .filter((i) => i.entry.chatId === ctx.chat!.id)
      .filter((i) => matchesPattern(pattern, i.entry.emailFrom, i.entry.emailSubject));
    for (const h of hit) takeByShortId(h.entry.shortId!, "la ignoraste con /ignore");

    let msg = added
      ? `🚫 Regla activa. Van ${total}.`
      : `Esa regla ya existía. Van ${total}.`;
    if (hit.length > 0) {
      msg += `\n📋 Quité ${hit.length} de la cola: ${hit.map((h) => `#${h.entry.shortId}`).join(", ")}`;
    }
    await ctx.reply(msg);
  });

  // ── Statement routing ───────────────────────────────────────────────────
  const statementQueue = new SerialQueue();
  // A dry run is proposed, never applied. The write pass replays the stored
  // extraction rather than reading the PDF again, so what gets committed is
  // exactly the diff that was shown.
  async function tryStatementRoute(
    d: HandlerDeps,
    chatId: number,
    localPath: string
  ): Promise<boolean> {
    const detection = await runClaude({
      config: d.config,
      sessionId: uuidv4(),
      isFirstTurn: true,
      prompt: `Lee el PDF en ${localPath} con Read (solo las primeras páginas bastan).\n\n${DETECTION_PROMPT}`,
      allowedTools: ["Read"],
      timeoutMs: 180_000,
      model: process.env.STATEMENT_CLAUDE_MODEL ?? "claude-sonnet-5",
    });
    if (!detection.ok || !looksLikeStatement(detection.text)) return false;

    const parsed = parseDetection(detection.text);
    if (!parsed) return false;
    const account = resolveAccount(parsed);
    const month = monthOf(parsed);

    if (!account) {
      // Filing a statement against a guessed account writes a month of
      // movements into an account that never saw them.
      await sendSafeMessage(
        d.bot.telegram, chatId,
        `📄 Esto parece un estado de cuenta de *${parsed.issuer}* (${parsed.period.from} → ${parsed.period.to}), ` +
          `pero no sé a qué cuenta de Wallet corresponde. Dime cuál y lo proceso.`
      );
      return true;
    }

    const landed = fileStatement({
      bytes: fs.readFileSync(localPath),
      original: path.basename(localPath),
      source: "telegram",
      account, month,
      via: `chat:${chatId}`,
    });
    const filed = landed.path;

    const ahead = statementQueue.pending;
    await sendSafeMessage(
      d.bot.telegram, chatId,
      `📄 *${account} · ${month}* — conciliando contra Wallet, tarda un poco…` +
        (ahead > 0 ? `\n_${ahead} en la fila antes de este._` : "")
    );

    const run = await statementQueue.run(() =>
      runReconcile(reconcileCommand({ pdf: filed, account, month }))
    );
    if (!run.ok) {
      await sendSafeMessage(
        d.bot.telegram, chatId,
        `❌ No pude conciliar *${account} · ${month}*:\n\`\`\`\n${(run.stderr || run.stdout).slice(-600)}\n\`\`\``
      );
      return true;
    }

    // Both streams: every ⚠️ the CLI emits goes to stderr via console.warn, so
    // reading stdout alone left the summary with no warnings at all — the
    // charge-mismatch and wrong-account checks were invisible to the user while
    // the help promised they would be reported.
    const summary = parseReconcileOutput(`${run.stdout}\n${run.stderr}`);
    const msg = formatReconcileSummary(account, month, summary);

    // Nothing is offered for writing account by account. A transfer whose other
    // leg is in a statement that has not arrived yet would be booked alone and
    // duplicated when the counterpart shows up; only the complete month can
    // answer "does this movement already exist somewhere". So the extraction is
    // banked and the month's coverage reported.
    const coverage = monthCoverage(month);
    const tail = coverage.complete
      ? `\n\n${formatCoverage(coverage)}\n_Ya se puede cruzar el mes: \`/cross ${month}\`._`
      : `\n\n${formatCoverage(coverage)}\n_Guardado. No escribo nada hasta tener el mes completo._`;

    await sendSafeMessage(
      d.bot.telegram, chatId,
      needsAttention(summary) ? `${msg}\n\n_Esto hay que resolverlo antes de cruzar._${tail}` : `${msg}${tail}`
    );
    return true;
  }

  bot.action("cancel_ignore", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    const had = proposedIgnores.delete(ctx.chat!.id);
    await ctx.reply(had ? "🗑️ Regla descartada, nada cambió." : "No había ninguna propuesta.");
  });

  // The loop the pipeline was missing. Everything before this could extract and
  // report; nothing settled a held transfer leg, so the only way to write a
  // statement was the CLI by hand. Proposed, never applied: the plan is shown,
  // and only a tap writes it.
  const proposedApplies = new Map<number, { month: string }>();

  bot.command("apply", async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1]?.trim() ?? "";
    if (!MONTH_SPEC.test(arg)) {
      await ctx.reply("Uso: `/apply 2026-07` o un rango, `/apply 2026-06..2026-07`", { parse_mode: "Markdown" });
      return;
    }
    await ctx.reply(`🗂️ Revisando ${arg}…`);
    const view = await loadMonth(arg, deps.couch, deps.lookup);
    const rows = writableRows(view.plan).map((p) => ({ ...p.row, account: p.account }));
    if (rows.length === 0) {
      await sendSafeMessage(deps.bot.telegram, ctx.chat.id, `${formatPlan(view.plan)}\n\n_Nada por escribir._`);
      return;
    }
    const guard = await guardWrite(rows, { lookup: deps.lookup, existing: view.records });
    const report = formatGuardReport(guard);
    if (guard.blocked) {
      await sendSafeMessage(
        deps.bot.telegram, ctx.chat.id,
        `⛔ *${arg}* — la verificación de integridad levantó alerta(s), no propongo escribir.\n\n${report}`
      );
      return;
    }
    if (guard.records.length === 0) {
      await sendSafeMessage(deps.bot.telegram, ctx.chat.id, `${arg}: nada quedó después del dedup.\n\n${report}`);
      return;
    }
    proposedApplies.set(ctx.chat.id, { month: arg });
    await deps.bot.telegram.sendMessage(
      ctx.chat.id,
      `${formatPlan(view.plan)}\n\n*${guard.records.length} registro(s) listos para escribir.*` +
        (report.trim() ? `\n${report}` : ""),
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: `✍️ Escribir ${guard.records.length}`, callback_data: "confirm_apply" },
            { text: "🗑️ Descartar", callback_data: "cancel_apply" },
          ]],
        },
      }
    );
  });

  bot.action("confirm_apply", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    const proposed = proposedApplies.get(ctx.chat!.id);
    if (!proposed) {
      await ctx.reply("Ese plan ya no está vigente. Vuelve a correr /apply.");
      return;
    }
    proposedApplies.delete(ctx.chat!.id);
    await ctx.reply(`✍️ Escribiendo ${proposed.month}…`);

    // Rebuilt, not remembered. Between the proposal and the tap the month may
    // have changed — another statement arrived, or the batch wrote something —
    // and writing a stale plan is how the same movement gets booked twice.
    const view = await loadMonth(proposed.month, deps.couch, deps.lookup);
    const rows = writableRows(view.plan).map((p) => ({ ...p.row, account: p.account }));
    const guard = await guardWrite(rows, { lookup: deps.lookup, existing: view.records });
    if (guard.blocked || guard.records.length === 0) {
      await sendSafeMessage(
        deps.bot.telegram, ctx.chat!.id,
        `↩️ No escribí nada: ${guard.blocked ? "integridad levantó alerta(s)" : "ya no queda nada por escribir"}.\n\n${formatGuardReport(guard)}`
      );
      return;
    }
    await commitGuardedWrite(guard, {
      lookup: deps.lookup, existing: view.records,
      couch: deps.couch, userId: deps.userId,
    });
    await sendSafeMessage(
      deps.bot.telegram, ctx.chat!.id,
      `✅ *${proposed.month}* — ${guard.records.length} registro(s) escritos.\n\n` +
        `_Para revertir: \`npm run snapshot -- undo ${proposed.month}\`_`
    );
  });

  bot.action("cancel_apply", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    const had = proposedApplies.delete(ctx.chat!.id);
    await ctx.reply(had ? "🗑️ Descartado, nada se escribió." : "No había ningún plan pendiente.");
  });

  bot.command("plan", async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1]?.trim() ?? "";
    if (!MONTH_SPEC.test(arg)) {
      await ctx.reply("Uso: `/plan 2026-07` o un rango, `/plan 2026-06..2026-07`", { parse_mode: "Markdown" });
      return;
    }
    await ctx.reply(`🗂️ Armando el plan de ${arg}…`);
    // Same call the terminal makes. A month must not mean one thing in chat and
    // another in a session, so both ask loadMonth and neither decides.
    const view = await loadMonth(arg, deps.couch, deps.lookup);
    const n = countBy(view.plan);
    const detail = writableRows(view.plan)
      .slice(0, 12)
      .map((p) => `${p.row.date.slice(0, 10)} ${p.account} $${p.row.amount} — ${p.disposition}`)
      .join("\n");
    const more = writableRows(view.plan).length > 12 ? `\n_…y ${writableRows(view.plan).length - 12} más._` : "";
    await sendSafeMessage(
      deps.bot.telegram, ctx.chat.id,
      `${formatPlan(view.plan)}\n\n_${formatCoverage(view.coverage)}_` +
        (detail ? `\n\n*Se escribiría:*\n\`\`\`\n${detail}\n\`\`\`${more}` : "") +
        `\n\n_Nada escrito. ${n.hold ? `${n.hold} en espera.` : ""}_`
    );
  });

  bot.command("cross", async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1]?.trim() ?? "";
    if (!MONTH_SPEC.test(arg)) {
      await ctx.reply("Uso: `/cross 2026-07` o un rango, `/cross 2026-06..2026-07`", { parse_mode: "Markdown" });
      return;
    }
    const coverage = monthCoverage(arg);
    if (coverage.have.length === 0) {
      await ctx.reply(`No hay ninguna extracción de ${arg} todavía. Mándame los PDFs.`);
      return;
    }
    await ctx.reply(`🔀 Cruzando ${arg}…`);

    // Wallet goes into the crossing alongside the statements. Without it the
    // month can only see the PDFs that arrived, so a payment already recorded
    // reads as a missing movement — which is the duplicate we are here to
    // avoid. It also makes a partial month useful: a leg can settle against
    // what is already booked even if its statement never comes.
    // The window comes from each account's real statement period. The calendar
    // month left Costco's first nineteen days crossed against records that were
    // never fetched, and every one of them surfaced as an orphan.
    const view = await loadMonth(arg, deps.couch, deps.lookup);
    const existing = await listRecordsByDateRange(deps.couch, view.window.from, view.window.to);
    const namesById: Record<string, string> = {};
    for (const [name, id] of Object.entries(deps.lookup.accounts)) namesById[id] = name;

    const fromStatements = coverage.have.flatMap((account) => {
      const led = loadLedger(account, arg);
      return led ? toLedgerRows(account, led.rows) : [];
    });
    const fromWallet = toWalletRows(existing, namesById, deps.lookup.transferCategoryId ?? undefined);
    const result = crossTransfers([...fromStatements, ...fromWallet]);
    const already = alreadyInWallet(result);
    const orphans = orphanTransferLegs(result);

    const totals = coverage.have
      .map((a) => {
        const led = loadLedger(a, arg);
        const n = led?.rows.length ?? 0;
        const sum = (led?.rows ?? []).reduce((t, r) => t + (parseFloat(r.amount) || 0), 0);
        return `${a.padEnd(20).slice(0, 20)} ${String(n).padStart(4)} ${sum.toFixed(2).padStart(12)}`;
      })
      .join("\n");

    const parts = [
      `🔀 *Cruce de ${arg}*`,
      `${coverage.have.length}/${coverage.have.length + coverage.missing.length} estados · ` +
        `${fromStatements.length} mov. de estados · ${fromWallet.length} ya en Wallet`,
      "```",
      formatAccountPeriods(view.periods),
      "```",
      "",
      "```",
      totals,
      "```",
      `*Traspasos pareados: ${result.pairs.length}*`,
      "```",
      formatCrossing(result.pairs),
      "```",
    ];

    if (already.length) {
      parts.push(`✅ *${already.length}* de esos cruzan contra algo ya registrado — no hay que escribirlos.`, "");
    }
    if (result.possible.length) {
      parts.push(
        `🤔 *${result.possible.length} coincidencia(s) de monto* sin categoría de traspaso — puede ser casualidad:`,
        "```", formatCrossing(result.possible), "```"
      );
    }
    // Rows at the edge of the month are held back on purpose. A movement made
    // at month end posts days later — 92% of Banamex's do, up to five — so it
    // lands on the next statement, whose account may not be extracted yet.
    // Judged against each account's own period, not against 1-jul/31-jul: the
    // calendar edge deferred the wrong rows and let the risky ones through.
    const { deferred } = splitAtAccountBoundary(
      result.unpaired.filter((r) => r.source === "statement"),
      view.periods
    );
    if (deferred.length) {
      parts.push(
        `📅 *${deferred.length} al filo del mes* — en espera, no se deciden hasta tener todas las cuentas:`,
        "```",
        deferred.slice(0, 10).map((o) => `${o.date} ${(o.cents / 100).toFixed(2)} ${o.account}`).join("\n"),
        "```"
      );
    }
    if (orphans.length) {
      parts.push(
        `⚠️ *${orphans.length} pata(s) sin contraparte*`,
        "```",
        orphans.map((o) => `${o.date} ${(o.cents / 100).toFixed(2)} ${o.account}`).join("\n"),
        "```"
      );
    }
    if (!coverage.complete) {
      // The panorama is worth seeing while it fills in; committing to it is
      // not, because a counterpart may still be in a statement that has not
      // arrived. Saying which accounts are missing is what keeps the two apart.
      parts.push(
        "",
        `_${formatCoverage(coverage)}_`,
        `_Vista parcial: una pata suelta aquí puede tener su contraparte en un estado que falta._`
      );
    } else {
      parts.push("", `_${formatCoverage(coverage)}_`);
    }

    await sendSafeMessage(deps.bot.telegram, ctx.chat.id, parts.join("\n"));
  });

  bot.command("statements", async (ctx) => {
    const pendientes = unidentifiedArrivals();
    const extra = pendientes.length
      ? `\n\n📥 *${pendientes.length} archivo(s) sin identificar* — llegaron pero no sé de qué cuenta son:\n` +
        `\`\`\`\n${formatArrivals(pendientes)}\n\`\`\`\n_Dime a qué cuenta corresponden y los proceso._`
      : "";
    await sendSafeMessage(deps.bot.telegram, ctx.chat.id, formatStatementsTable(statementStatus()) + extra);
  });

  bot.command("help", async (ctx) => {
    await sendSafeMessage(deps.bot.telegram, ctx.chat.id, HELP_TEXT);
  });

  bot.command("stop", async (ctx) => {
    await ctx.reply(stopGuided(ctx.chat.id) ? "🧭 Modo guiado cerrado." : "No había modo guiado abierto.");
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

      // A photo can be the answer to a pending question — a receipt, a
      // screenshot of the statement — not only a new expense.
      const target = clarificationTarget(ctx.message.reply_to_message?.message_id, caption);
      if (target) {
        const reply =
          `${target.text || "(el usuario respondió con una imagen)"}\n\n` +
          `Imagen adjunta guardada en: ${downloaded.localPath}\n` +
          `Léela con Read para obtener los datos que faltaban.`;
        await replySafe(ctx, `📧 #${target.found.entry.shortId} · procesando tu imagen…`);
        await processUserTurn(
          deps, ctx, session,
          await buildClarificationPrompt(deps, target.found.entry, reply),
          EMAIL_SYSTEM_PROMPT, target.found.entry.shortId
        );
        return;
      }

      const prompt =
        `El usuario envió una foto en Telegram. Está guardada localmente en:\n${downloaded.localPath}\n\n` +
        (caption ? `Caption del usuario: "${caption}"\n\n` : "") +
        `Analízala (lee el archivo con Read), extrae los movimientos y propón el CSV cuando estés listo, o pregunta lo que falte.`;

      // A photo sent while a proposal is on screen is a correction of it far
      // more often than a second, unrelated expense.
      await processUserTurn(deps, ctx, session, prompt, SYSTEM_PROMPT, undefined, session.pendingQueue.length > 0);
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

      const target = clarificationTarget(ctx.message.reply_to_message?.message_id, caption);
      if (target) {
        const reply =
          `${target.text || "(el usuario respondió con un documento)"}\n\n` +
          `Documento adjunto guardado en: ${downloaded.localPath}\n` +
          `Léelo con Read (pasa pages si es un PDF grande) para obtener los datos que faltaban.`;
        await replySafe(ctx, `📧 #${target.found.entry.shortId} · procesando tu documento…`);
        await processUserTurn(
          deps, ctx, session,
          await buildClarificationPrompt(deps, target.found.entry, reply),
          EMAIL_SYSTEM_PROMPT, target.found.entry.shortId
        );
        return;
      }

      // A statement goes to the reconciler, not to the generic "read it and
      // propose a CSV" path: only the reconciler knows the statement's period,
      // the per-bank profile, and how to check the extraction against the
      // totals the statement declares about itself.
      const isPdf = (doc.mime_type ?? "").includes("pdf") || /\.pdf$/i.test(doc.file_name ?? "");
      if (isPdf && !target) {
        const routed = await tryStatementRoute(deps, ctx.chat.id, downloaded.localPath);
        if (routed) return;
        // Detection failing is not permission to use the generic path. That path
        // knows nothing about statement periods, instalments or transfer legs,
        // so a statement that merely timed out would be proposed as a plain CSV
        // and one tap would write the whole month through the weakest gate.
        await sendSafeMessage(
          deps.bot.telegram, ctx.chat.id,
          `📄 No pude identificar este PDF como estado de cuenta — puede que la lectura fallara o que el ` +
            `documento no declare su periodo.\n\nSi ES un estado de cuenta, dime de qué cuenta y qué mes y ` +
            `lo proceso por el camino correcto. Si NO lo es, mándalo otra vez con un caption diciendo qué es.`
        );
        return;
      }

      const prompt =
        `El usuario envió un documento en Telegram (${doc.mime_type ?? "tipo desconocido"}, ${
          downloaded.sizeBytes
        } bytes). Guardado en:\n${downloaded.localPath}\n\n` +
        (caption ? `Caption: "${caption}"\n\n` : "") +
        `Léelo (con Read; si es PDF puedes pasar pages para PDFs grandes), extrae movimientos y propón el CSV cuando estés listo. Si necesitas info, pregunta.`;

      await processUserTurn(deps, ctx, session, prompt, SYSTEM_PROMPT, undefined, session.pendingQueue.length > 0);
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

      const target = clarificationTarget(ctx.message.reply_to_message?.message_id, transcript);
      if (target) {
        await replySafe(ctx, `📧 #${target.found.entry.shortId} · procesando tu nota de voz…`);
        await processUserTurn(
          deps, ctx, session,
          await buildClarificationPrompt(deps, target.found.entry, target.text || transcript),
          EMAIL_SYSTEM_PROMPT, target.found.entry.shortId
        );
        return;
      }

      const prompt =
        `El usuario envió un mensaje de voz (${voice.duration}s). Transcripción automática:\n\n"${transcript}"\n\n` +
        `Extrae los movimientos mencionados y propón el CSV cuando estés listo, o pregunta lo que falte.`;

      await processUserTurn(deps, ctx, session, prompt, SYSTEM_PROMPT, undefined, session.pendingQueue.length > 0);
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
    if (!taken) {
      await ctx.reply("Nada pendiente que cancelar.");
      return;
    }
    // Cancelling is a decision too: the user has judged this movement, so the
    // question goes as well rather than coming back tomorrow.
    let note = "";
    if (taken.clarificationShortId !== undefined && takeByShortId(taken.clarificationShortId)) {
      note = `\n📋 #${taken.clarificationShortId} también sale de la cola.`;
    }
    await ctx.reply(`🗑️ Propuesta descartada.${note}`);
  });

  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text.trim();
    const session = getOrCreateSession(ctx.chat.id);
    const replyToId = ctx.message.reply_to_message?.message_id;
    let amendingProposal = false;

    if (session.pendingQueue.length > 0) {
      const word = text.toLowerCase();
      if (CONFIRM_WORDS.has(word)) {
        await commitPending(deps, ctx, session, replyToId);
        return;
      }
      if (CANCEL_WORDS.has(word)) {
        const taken = takePending(ctx.chat.id, replyToId);
        await ctx.reply(taken ? "🗑️ Propuesta descartada." : "Nada pendiente que cancelar.");
        return;
      }
      // Falls through: user is amending — let Claude refine it, and the new
      // proposal will supersede the one still on screen.
      amendingProposal = true;
    }

    // ── Respuestas por handle: `#12 Groceries`, una o varias por mensaje ──
    if (looksLikeHandleAnswer(text)) {
      const answers = parseAnswers(text);
      const missing: number[] = [];
      let handled = 0;
      for (const { shortId, answer } of answers) {
        // Capture the Telegram id first: on failure the question goes back
        // under its own key, so reply-to keeps working on the original message.
        // Peek, never take: the question leaves the queue only once a record is
        // written or the user cancels. Answering is not by itself a resolution.
        const found = findByShortId(shortId);
        if (!found) {
          missing.push(shortId);
          continue;
        }
        try {
          await replySafe(ctx, `📧 #${shortId} · procesando tu respuesta…`);
          await processUserTurn(
            deps, ctx, session,
            await buildClarificationPrompt(deps, found.entry, answer),
            EMAIL_SYSTEM_PROMPT, shortId
          );
          handled++;
        } catch (err) {
          log.error("Handle answer failed", { shortId, error: err instanceof Error ? err.message : String(err) });
          await ctx.reply(`❌ #${shortId} falló: ${err instanceof Error ? err.message : String(err)}. Sigue pendiente.`);
        }
      }
      if (missing.length) {
        await ctx.reply(
          `⚠️ Sin pendiente para ${missing.map((m) => `#${m}`).join(", ")} — puede que ya se resolviera. /pending para ver la lista.`
        );
      }
      if (handled === 0 && missing.length === 0) {
        await ctx.reply("No entendí ninguna respuesta. Formato: `#12 tu respuesta`");
      }
      return;
    }

    // ── Modo guiado: texto normal contesta la pregunta activa, 2 min ──
    const guided = activeQuestion(ctx.chat.id);
    if (guided !== null) {
      const found = findByShortId(guided);
      if (found) {
        stopGuided(ctx.chat.id);
        try {
          await replySafe(ctx, `📧 #${guided} · procesando tu respuesta…`);
          await processUserTurn(
            deps, ctx, session,
            await buildClarificationPrompt(deps, found.entry, text),
            EMAIL_SYSTEM_PROMPT, guided
          );
          await ctx.reply("Siguiente con /next, o /stop para salir.");
        } catch (err) {
          await ctx.reply(`❌ Falló: ${err instanceof Error ? err.message : String(err)}. Sigue pendiente.`);
        }
        return;
      }
    } else if (justExpired(ctx.chat.id)) {
      stopGuided(ctx.chat.id);
      await ctx.reply(
        "⏱️ La ventana de 2 minutos del modo guiado se cerró, así que tomo esto como mensaje nuevo. Usa /next para reabrirla."
      );
    }

    // Only resolve a clarification via explicit reply-to — never auto-consume free text.
    const found = replyToId ? findByMessageId(replyToId) : null;

    // The message is still on screen after the question closes, and a reply to
    // it used to fall through to the generic handler — which answered "¿a qué
    // correo te refieres?" to someone replying to a specific email.
    if (!found && replyToId !== undefined) {
      const closed = findClosed(replyToId);
      if (closed) {
        await ctx.reply(
          `✅ Esa pregunta (#${closed.shortId}) ya se cerró: ${closed.reason}.\n\n` +
            `Si el movimiento quedó mal registrado, dímelo con el monto y la fecha. ` +
            `Con /pending ves lo que sigue abierto.`
        );
        return;
      }
    }

    if (found) {
      try {
        await replySafe(ctx, `📧 Procesando tu respuesta sobre el correo de _${escapeMarkdown(senderInstitution(found.entry.emailFrom))}_…`);
        await processUserTurn(
          deps, ctx, session,
          await buildClarificationPrompt(deps, found.entry, text),
          EMAIL_SYSTEM_PROMPT, found.entry.shortId
        );
      } catch (err) {
        log.error("Clarification handling failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        await ctx.reply(
          `❌ Error procesando tu respuesta: ${err instanceof Error ? err.message : String(err)}\n\n` +
            `Sigue pendiente; puedes responder de nuevo al mismo mensaje.`
        );
      }
      return;
    }

    try {
      await processUserTurn(deps, ctx, session, text, SYSTEM_PROMPT, undefined, amendingProposal);
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
