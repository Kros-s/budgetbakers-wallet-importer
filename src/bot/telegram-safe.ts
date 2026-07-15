/**
 * @file bot/telegram-safe.ts
 * @description Guards against Telegram's legacy Markdown parser rejecting
 * dynamic, unescaped text (e.g. email addresses with underscores). Telegram
 * replies with a 400 "can't parse entities" error in that case, and the
 * caller loses whatever it was trying to send. `sendSafeMessage`/`replySafe`
 * retry the same text as plain text so the message always reaches the user.
 */

import type { Context, Telegram } from "telegraf";
import { TelegramError } from "telegraf";
import type { Message, Convenience } from "telegraf/types";

type ExtraReplyMessage = Convenience.ExtraReplyMessage;

/** Escapes characters that are special in Telegram's legacy Markdown parse_mode. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([_*`[])/g, "\\$1");
}

function isParseEntitiesError(err: unknown): boolean {
  return (
    err instanceof TelegramError &&
    err.response.error_code === 400 &&
    /can't parse entities/i.test(err.response.description)
  );
}

/**
 * Sends a message with parse_mode "Markdown"; if Telegram rejects it because
 * of unescaped entities, retries the same text without parse_mode so the
 * message is never silently dropped.
 */
export async function sendSafeMessage(
  telegram: Telegram,
  chatId: number,
  text: string,
  extra?: ExtraReplyMessage
): Promise<Message.TextMessage> {
  try {
    return await telegram.sendMessage(chatId, text, { parse_mode: "Markdown", ...extra });
  } catch (err) {
    if (!isParseEntitiesError(err)) throw err;
    const { parse_mode: _ignored, ...rest } = extra ?? {};
    return telegram.sendMessage(chatId, text, rest);
  }
}

/** Same fallback logic as sendSafeMessage, for use inside a Context handler. */
export async function replySafe(
  ctx: Context,
  text: string,
  extra?: ExtraReplyMessage
): Promise<Message.TextMessage> {
  try {
    return await ctx.reply(text, { parse_mode: "Markdown", ...extra });
  } catch (err) {
    if (!isParseEntitiesError(err)) throw err;
    const { parse_mode: _ignored, ...rest } = extra ?? {};
    return ctx.reply(text, rest);
  }
}
