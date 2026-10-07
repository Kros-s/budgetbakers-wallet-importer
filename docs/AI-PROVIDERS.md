# AI providers and deployment workflow

The local repository is the source of truth for code. Implement and test
changes locally, commit/push them, then deploy with
`scripts/deploy/push.sh --proxmox`. This uses SSH to the host and `pct exec 200`;
direct SSH access to the LXC is not required. Do not develop in production
and later copy the code back into the repository.

The LXC retains `/opt/bbw/data`, `.env.local`, `/etc/bbw.env`, and the `bbw`
service user's HOME (`/var/lib/bbw`). These are runtime state and secrets,
not source code. Deployment does not overwrite them or send local bank PDFs
or `.claude` settings.

## Telegram

- `/ai`: global mode, effective provider order, cooldown, and models.
- `/ai auto`: Claude first; Codex only after quota, authentication,
  availability, or missing CLI failures. Providers never run in parallel
  for the same extraction.
- `/ai codex` or `/ai claude`: use that provider exclusively.
- `/ai retry`: clear the primary provider's cooldown. This does not change
  the mode or make a model call. In auto mode, the next task retries Claude.

Only authorized chats can change the mode. The selection is written
atomically to `data/bot/ai-policy.json`, shared by the bot and daily batch.
It applies to the next extraction and does not interrupt the current one.
Claude's one-hour cooldown is stored separately in `ai-claude-health.json`
to avoid retrying an unavailable provider for every email.

A valid clarification does not trigger fallback. CSV, validation, and write
errors do not trigger fallback either. When no provider is available, the
batch pauses without exhausting the retry budget of pending emails.

## Models and usage

Claude retains Haiku for email and now defaults to Haiku for chat when
`CLAUDE_MODEL` is unset. Statements retain `STATEMENT_CLAUDE_MODEL` (Sonnet).
Codex uses Luna/low for email and chat, and 6.1 Sol/medium for statements.
Overrides: `CODEX_EMAIL_MODEL`, `CODEX_CHAT_MODEL`, `CODEX_STATEMENT_MODEL`.
Ambiguous responses do not automatically escalate to larger models.

The deterministic email filter runs before AI. Email bodies remain capped
at 8,000 characters, preserving the beginning and end. Codex uses minimal,
versioned extraction instructions from `config/codex-extractor.md`; it does
not load development-agent instructions, shell, web, apps, or personal
configuration. Its process does not receive Wallet, IMAP, or Telegram
credentials. The application supplies images and complete text extracted
using `pdftotext`. PDFs without text, or text exceeding 200,000 characters,
are rejected rather than silently dropping transactions. Scanned PDFs
require OCR first; this is a limitation of this version.

New conversations retain up to four complete turns of shared context under
`data/bot/ai-conversations/`, with permissions 0600. Claude keeps its own
session identity; Codex receives bounded context in ephemeral sessions.
Switching providers transfers this context without sharing session IDs.
Historical Claude conversations cannot recover their history through this
bridge; use `/reset` when adopting the new version. Pending proposals are
persisted separately. The model must ask if earlier context is missing.
Confirmation and Wallet write behavior remain unchanged.

## LXC preparation

Install Codex CLI (validated version: 0.161.0) and `poppler-utils`.
Authenticate as `bbw`, HOME `/var/lib/bbw`, using `codex login --device-auth`,
or transfer your own authenticated cache over private SSH. `auth.json` has
permissions 0600 and `.codex` has permissions 0700; neither belongs in Git.
Authentication uses ChatGPT, not an API key. Codex refreshes the local cache;
account usage limits still apply.

Official references:

- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/auth
- https://learn.chatgpt.com/docs/models
- https://learn.chatgpt.com/docs/config-file/config-reference

## Rollback

Before deployment, back up the existing source, build, scripts, and docs.
To switch providers, `/ai claude` is sufficient if the subscription works.
To restore the previous code, stop `bbw-bot`, extract the private archive
`/opt/bbw/change-backups/ai-20261007/code-before.tar.gz` into `/opt/bbw`, and
start `bbw-bot`. This backup does not replace runtime data or credentials.
New AI files remain unused by the previous code. Do not rerun
`provision-lxc.sh` on production for this update.

## Deployment record — 2026-10-07

Branch: `codex/ai-provider-fallback`. Initial implementation: `a766da7`,
followed by token usage logging and deployment verification. Deployment used
the supported Proxmox script and compiled inside LXC 200. The bot was active;
`/ai` was verified in the real Telegram menu through `getMyCommands`.
Initial persistent mode: **codex**, while the Claude subscription is inactive.

Validation: 591 local tests passed; local and remote builds succeeded.
ChatGPT login was verified as `bbw` in the LXC. Luna returned MODEL_OK and
passed two synthetic examples: marketing and a $150.50 purchase. Sol passed
a model check and synthetic PDF text extraction through `pdftotext`.
No transactions were written or test messages sent to users. Codex usage
is logged under `[ai]` without prompts or credentials. The minimal PDF test
reported 5,817 input tokens and 7 output tokens: CLI overhead remains even
with reduced instructions. Consumption equivalent to a direct API call is
not promised.

The October 6 daily failure was independently identified as iCloud
`AUTHENTICATIONFAILED`, before AI invocation. The user subsequently renewed
the app password and restarted the bot. IMAP reads passed, finding 87 emails
since October 1. The configured account identifier matched the previous
private backup. Two real email inference checks returned NO_TRANSACTION and
a clarification, without writes, ledger changes, or processed markers.
The authentication block was resolved. The full live batch was not manually
run; its existing 20:00 CDMX timer remained enabled.

The exact deployed revision is recorded in
`/opt/bbw/data/deployments/ai-20261007.json`, without secrets.

## Testing the first missing day

The last completed watermark was `2026-10-01T02:00:07.325Z`
(September 30, 20:00:07 CDMX). The first missing scheduled window ends on
October 1 at 20:00 CDMX (`2026-10-02T02:00:00Z`). Test that window with:

```bash
cd /opt/bbw
runuser -u bbw -- env HOME=/var/lib/bbw TZ=America/Mexico_City \
  node dist/cli/process-window.js \
  --from 2026-10-01T02:00:07.325Z --to 2026-10-02T02:00:00Z --dry-run
```

Dry-run proposes extraction results without writing to Wallet, Telegram,
ledgers, or the processed store. It still consumes model usage. Its private
output is stored in
`/opt/bbw/change-backups/ai-20261007/first-missing-day-dry-run.log`.
