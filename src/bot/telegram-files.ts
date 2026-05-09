/**
 * @file bot/telegram-files.ts
 * @description Downloads photos and documents from Telegram into a local
 * directory so Claude can read them by path.
 *
 * Telegram returns a file_id that we resolve via getFileLink (telegraf) and
 * then stream into a local file. Files are named with chat id + message id
 * for traceability and easier cleanup.
 */

import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import type { Telegraf, Context } from "telegraf";
import axios from "axios";

export interface DownloadedFile {
  localPath: string;
  /** Original Telegram MIME if known (for documents). Photos are typically jpeg. */
  mimeType: string | null;
  sizeBytes: number;
}

function inferExt(mimeType: string | null, fallback: string): string {
  if (!mimeType) return fallback;
  if (mimeType.includes("pdf")) return ".pdf";
  if (mimeType.includes("png")) return ".png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return ".jpg";
  if (mimeType.includes("webp")) return ".webp";
  return fallback;
}

export async function downloadTelegramFile(
  bot: Telegraf,
  ctx: Context,
  fileId: string,
  opts: { downloadDir: string; mimeType?: string | null; fallbackExt?: string }
): Promise<DownloadedFile> {
  const link = await bot.telegram.getFileLink(fileId);
  const url = link.toString();

  const chatId = ctx.chat?.id ?? "anon";
  const msgId = ctx.message && "message_id" in ctx.message ? ctx.message.message_id : Date.now();
  const ext = inferExt(opts.mimeType ?? null, opts.fallbackExt ?? ".bin");
  const localPath = path.join(opts.downloadDir, `bot_${chatId}_${msgId}${ext}`);

  const response = await axios.get(url, { responseType: "stream" });
  await pipeline(response.data, fs.createWriteStream(localPath));

  const { size } = fs.statSync(localPath);
  return { localPath, mimeType: opts.mimeType ?? null, sizeBytes: size };
}
