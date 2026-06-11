import { ImapFlow } from "imapflow";
import type { MessageEnvelopeObject } from "imapflow";
import PostalMime from "postal-mime";

import { processEmail } from "../webhook/email-processor.js";
import type { EmailDeps } from "../webhook/email-processor.js";
import { getProcessed, saveProcessed } from "./processed-store.js";

function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/td>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#?\w+;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildClient() {
  return new ImapFlow({
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    auth: { user: process.env.ICLOUD_EMAIL!, pass: process.env.ICLOUD_APP_PASSWORD! },
    logger: false,
  });
}

interface FetchedMessage {
  uid: number;
  source: Buffer;
  envelope: MessageEnvelopeObject;
}

interface FetchResult {
  messages: FetchedMessage[];
  uidValidity: bigint;
}

// Phase 1: open connection, download everything, close immediately.
async function fetchMessages(folder: string, skipStore: boolean): Promise<FetchResult> {
  const client = buildClient();
  await client.connect();
  const messages: FetchedMessage[] = [];
  let uidValidity = 0n;
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      if (client.mailbox) uidValidity = (client.mailbox as { uidValidity: bigint }).uidValidity;

      const lookbackDays = Number(process.env.IMAP_LOOKBACK_DAYS ?? 3);
      const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
      const uids = await client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) return { messages, uidValidity };

      // Filter already-processed UIDs (unless this is the archive one-shot)
      const processed = skipStore ? new Set<number>() : getProcessed(folder, uidValidity);
      const toFetch = uids.filter((uid) => !processed.has(uid));
      if (toFetch.length === 0) return { messages, uidValidity };

      console.log(`[imap] ${toFetch.length} new message(s) to process`);

      for await (const msg of client.fetch(toFetch, { envelope: true, source: true }, { uid: true })) {
        if (msg.source && msg.envelope) {
          messages.push({ uid: msg.uid, source: msg.source, envelope: msg.envelope });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return { messages, uidValidity };
}

export async function pollOnce(deps: EmailDeps, folder = "INBOX", skipStore = false): Promise<void> {
  const userEmail = process.env.ICLOUD_EMAIL!;

  // Phase 1: fetch new messages quickly, then close connection
  const { messages, uidValidity } = await fetchMessages(folder, skipStore);
  if (messages.length === 0) return;

  // Phase 2: process through Claude (slow — no IMAP connection open)
  const processedUids: number[] = [];
  for (const msg of messages) {
    try {
      const parsed = await PostalMime.parse(msg.source);
      const text = parsed.text?.trim() || (parsed.html ? htmlToText(parsed.html) : "");

      if (!text) {
        console.log(`[imap] uid=${msg.uid} — empty body, skipping`);
        processedUids.push(msg.uid);
        continue;
      }

      const sender = msg.envelope.from?.[0];
      const from = sender?.address ?? userEmail;
      const subject = msg.envelope.subject ?? "";

      console.log(`[imap] uid=${msg.uid} from=${from} subject="${subject}"`);
      await processEmail(deps, { from, subject, text });
      processedUids.push(msg.uid);
    } catch (err) {
      console.error(`[imap] uid=${msg.uid} error:`, err instanceof Error ? err.message : err);
      processedUids.push(msg.uid);
    }
  }

  // Phase 3: save processed UIDs so next poll skips them (emails stay unread)
  if (!skipStore && processedUids.length > 0) {
    saveProcessed(folder, uidValidity, processedUids);
  }
}

export function startImapPoller(deps: EmailDeps): void {
  const email = process.env.ICLOUD_EMAIL?.trim();
  const pass = process.env.ICLOUD_APP_PASSWORD?.trim();

  if (!email || !pass) {
    console.warn("[imap] ICLOUD_EMAIL or ICLOUD_APP_PASSWORD not set — IMAP poller disabled.");
    return;
  }

  const intervalMs = Number(process.env.IMAP_POLL_INTERVAL_MS ?? 120_000);

  async function run(): Promise<void> {
    try {
      await pollOnce(deps);
    } catch (err) {
      console.error("[imap] Poll failed:", err instanceof Error ? err.message : err);
    }
    setTimeout(run, intervalMs);
  }

  setTimeout(run, 5_000);
  console.log(`[imap] Poller started — checking inbox every ${intervalMs / 1000}s`);
}
