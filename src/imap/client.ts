import { ImapFlow } from "imapflow";

/**
 * iCloud IMAP client shared by the poller, the audit CLI and the batch
 * processor. Requires ICLOUD_EMAIL / ICLOUD_APP_PASSWORD in the environment.
 */
export function buildImapClient(): ImapFlow {
  return new ImapFlow({
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    auth: { user: process.env.ICLOUD_EMAIL!, pass: process.env.ICLOUD_APP_PASSWORD! },
    logger: false,
  });
}
