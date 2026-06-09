# BudgetBakers Wallet Importer

Automated transaction pipeline for BudgetBakers / Wallet. Combines three things in a single always-on process:

1. **Telegram bot** — chat with Claude to record transactions, confirm proposals, rollback mistakes.
2. **Email webhook** — bank notification emails are parsed by Claude and written automatically, or routed to Telegram for confirmation.
3. **CSV importer CLI** — batch-import from a CSV file (the original tool, still works).

All three share the same CouchDB connection, lookup maps, and Claude session infrastructure.

---

## How it works

```
Bank email → Cloudflare Email Worker
               → POST /webhook/email (Cloudflare Tunnel → Mac Mini :8765)
               → Claude extracts transaction (CSV)
               → All fields resolved? → silent write to CouchDB + Telegram notification
               → Missing fields?     → Telegram proposal with ✅ ❌ buttons
               → Claude asks a question? → message forwarded to Telegram (multi-turn session)
               → Duplicate detected?  → Telegram warning, no write

Telegram message → Claude multi-turn conversation
                 → Proposes CSV → user confirms → writes to CouchDB

Every day at 21:00 → Telegram daily summary of all recorded transactions
```

---

## Requirements

- Node.js 18+
- [Claude Code CLI](https://claude.ai/code) authenticated with a Claude Max account (`claude` binary in PATH)
- A BudgetBakers / Wallet account with CouchDB credentials
- A Telegram bot token (from BotFather)
- Cloudflare account (for the email worker + tunnel)

---

## Setup

### 1. Install dependencies

```bash
git clone <repo>
cd budgetbakers-wallet-importer
npm install
```

### 2. Configure environment

Copy `.env.local.example` to `.env.local` and fill in all values:

```bash
cp .env.local.example .env.local
```

Required variables:

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token from BotFather |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Comma-separated list of allowed Telegram chat IDs |
| `COUCH_URL` | BudgetBakers CouchDB endpoint |
| `COUCH_DB` | Database name (`bb-<userId>`) |
| `COUCH_LOGIN` | Replication login (userId UUID) |
| `COUCH_TOKEN` | Replication token |
| `COUCH_USER_ID` | Same as `COUCH_LOGIN` |
| `WEBHOOK_SECRET` | Shared secret between Cloudflare Worker and this server |
| `WEBHOOK_PORT` | Port for the webhook HTTP server (default: `8765`) |

### 3. Run

```bash
npm run main        # bot + webhook server (always-on)
npm start           # CLI importer (interactive, one-shot)
```

### 4. Run as a macOS service (LaunchAgent)

A plist template is included. Copy it to `~/Library/LaunchAgents/` and load it:

```bash
cp scripts/launchd/com.iubix.webserver.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.iubix.webserver.plist
```

Logs go to `data/bot/main.log`.

---

## Cloudflare setup

### Email Worker

Create a Cloudflare Email Worker that receives emails at your domain and POSTs to the webhook:

```js
import PostalMime from "postal-mime";

export default {
  async email(message, env) {
    const parsed = await PostalMime.parse(message.raw);
    await fetch(env.WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": env.WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        from: message.from,
        subject: message.headers.get("subject") ?? "",
        text: parsed.text ?? "",
      }),
    });
  },
};
```

Worker secrets: `WEBHOOK_URL` (e.g. `https://wallet.yourdomain.com/webhook/email`), `WEBHOOK_SECRET`.

### Tunnel

```bash
cloudflared tunnel create webhook
cloudflared tunnel route dns webhook wallet.yourdomain.com
```

Config at `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: wallet.yourdomain.com
    service: http://127.0.0.1:8765
  - service: http_status:404
```

---

## Telegram bot commands

| Command / action | What it does |
|---|---|
| Send any message | Claude processes it as a transaction description |
| Confirm (`✅` or "si") | Writes the last proposed CSV to CouchDB |
| Cancel (`❌` or `/cancel`) | Discards the pending proposal |
| `/reset` | Starts a new Claude conversation session |
| Voice message | Transcribed via Whisper, then processed as text |

---

## Email pipeline — transaction flows

| Scenario | Result |
|---|---|
| All fields resolved | Silent write + Telegram success notification |
| Unknown account or category | Proposal sent to Telegram with ✅ ❌ buttons |
| Claude asks a clarifying question | Message forwarded to Telegram; reply continues the conversation |
| Same account + amount already recorded today | Telegram duplicate warning; nothing written |
| Not a transaction (marketing, OTP) | Silently ignored (`NO_TRANSACTION`) |

---

## CSV importer CLI

The original batch import tool. Writes transactions from a CSV file directly to CouchDB.

```bash
npm start
```

Non-interactive mode:

```bash
npm start -- --email you@example.com --csv ./transactions.csv --yes
```

Rollback helpers:

```bash
npm start -- --list-last 20
npm start -- --rollback-last 20
npm start -- --rollback-last 20 --start-ts "2026-03-23T08:00:00Z" --end-ts "2026-03-23T09:00:00Z"
```

### CSV format

```csv
date,account,amount,category,note,payee
2026-01-27 02:31:00,First Bank,-53.75,Charges & Fees,Stamp Duty,
2026-01-29 13:33:00,First Bank,-300000,Transfer,,
2026-01-29 13:33:00,Palmpay,300000,Transfer,,
2026-02-10 11:25:00,First Bank,300000,Wage & invoices,,Company XYZ
```

| Column | Required | Notes |
|---|---|---|
| `date` | yes | `YYYY-MM-DD HH:MM:SS` — interpreted as local time |
| `account` | yes | Exact account name as it appears in the app |
| `amount` | yes | Signed float. Negative = expense, positive = income |
| `category` | yes | Exact category name, or `Transfer` / `Transfer withdraw` |
| `note` | no | Free text |
| `payee` | no | Stored as a separate field |

Transfer pairs are detected automatically when two rows share the same `date` and transfer category.

---

## Project structure

```
src/
├── main.ts                  Entry point: bot + webhook server + daily summary
├── bot/
│   ├── claude-runner.ts     Spawns `claude -p` and parses output
│   ├── config.ts            Bot config from env vars
│   ├── handlers.ts          Telegraf message/callback handlers, SYSTEM_PROMPT
│   ├── index.ts             Bot-only entry point (legacy)
│   └── session.ts           In-memory session state per chat (pending queue, Claude session ID)
├── webhook/
│   ├── server.ts            HTTP server (POST /webhook/email)
│   ├── email-processor.ts   Email → Claude → write or Telegram fallback
│   └── daily-tracker.ts     In-memory daily log (JSONL), dedup, end-of-day summary
├── cli/                     Interactive CLI importer
├── auth.ts                  BudgetBakers SSO login flow
├── couch.ts                 CouchDB client and lookup map builder
├── csv.ts                   CSV parser and row → CouchDB record converter
├── date-time.ts             Local date parsing and ISO normalization
├── direct-auth.ts           Direct credential loader from env vars (no SSO needed)
├── logger.ts                File/console logger with secret redaction
├── records.ts               _bulk_docs writer and recent-record listing/deletes
└── types.ts                 Shared TypeScript interfaces
```

---

## Security notes

- All secrets are loaded from `.env.local` (git-ignored).
- The webhook server validates `X-Webhook-Secret` on every request and binds to `127.0.0.1` only — never exposed directly to the internet; traffic reaches it through the Cloudflare Tunnel.
- Claude runs with `--permission-mode bypassPermissions` scoped to the project directory.
- The logger redacts known sensitive field names (`token`, `password`, `secret`, etc.) from all structured log output.
