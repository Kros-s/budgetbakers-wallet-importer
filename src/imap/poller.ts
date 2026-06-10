import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";

import { processEmail } from "../webhook/email-processor.js";
import type { EmailDeps } from "../webhook/email-processor.js";

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

async function pollOnce(deps: EmailDeps): Promise<void> {
  const userEmail = process.env.ICLOUD_EMAIL!;
  const pass = process.env.ICLOUD_APP_PASSWORD!;

  const client = new ImapFlow({
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    auth: { user: userEmail, pass },
    logger: false,
  });

  await client.connect();

  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const lookbackDays = Number(process.env.IMAP_LOOKBACK_DAYS ?? 3);
      const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
      const uids = await client.search({ seen: false, since }, { uid: true });
      if (!uids || uids.length === 0) return;

      console.log(`[imap] ${uids.length} unseen message(s)`);

      for await (const msg of client.fetch(uids, { envelope: true, source: true }, { uid: true })) {
        const uid = msg.uid;
        const markSeen = () => client.messageFlagsAdd([uid], ["\\Seen"], { uid: true });

        try {
          if (!msg.source) {
            await markSeen();
            continue;
          }

          const parsed = await PostalMime.parse(msg.source);
          const text = parsed.text?.trim() || (parsed.html ? htmlToText(parsed.html) : "");

          if (!text) {
            console.log(`[imap] uid=${uid} — empty body, skipping`);
            await markSeen();
            continue;
          }

          const sender = msg.envelope?.from?.[0];
          const from = sender?.address ?? userEmail;
          const subject = msg.envelope?.subject ?? "";

          console.log(`[imap] uid=${uid} from=${from} subject="${subject}"`);

          await processEmail(deps, { from, subject, text });
          await markSeen();
        } catch (err) {
          console.error(`[imap] uid=${uid} error:`, err instanceof Error ? err.message : err);
          await markSeen();
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
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
