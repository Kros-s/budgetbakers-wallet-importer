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

## Archived email recovery

The daily timer reads INBOX only. Moving an unprocessed email to Archive
removes it from that path, but the message remains available in Archive.
No messages need to be moved back for a read-only test. Use `--folder Archive`
with explicit dates and `--dry-run` to inspect a missing window.

IMAP UIDs are local to a folder. Ledgers, retries, and watermarks now keep
folders separate; legacy ledgers belong to INBOX. Archive ledgers use a
folder-derived filename suffix, and changes in UIDVALIDITY cannot be merged
into an incompatible existing ledger. Wallet record deduplication remains
necessary because moving a message can change its UID. Dry-run summaries
include proposed rows, duplicates already in Wallet, invalid rows,
clarifications, errors, and provider pauses. A failed or paused dry-run exits
with a failure status and never advances a watermark.

Only the test is being run against Archive; this update does not change the
daily timer to scan it automatically or perform a live Archive backfill.

### First missing window: Archive test results — 2026-10-07

The first window had no emails in INBOX because the messages had been
archived. Archive contained 33 messages for the same exact window. A complete
Archive dry-run passed: 5 messages were filtered before AI, and Codex Luna
processed the remaining 28. Results: 27 non-transaction verdicts and one
clarification asking which account paid for the Sam's Club purchase.
No CSV rows were proposed, no validation errors occurred, and no provider
pause occurred. Wallet's read-only dedup snapshot contained 3 existing
records around the window. No duplicate candidates could be evaluated
because the model produced no complete transaction rows.

Financial-state hashes under `data/bot` and `data/imap` matched before and
after the run. No movements were written, Telegram questions sent, or
watermarks advanced. The private raw log is
`/opt/bbw/change-backups/ai-20261007/archive-2026-10-01-dry-run.log`.

Usage: 28 calls, 290,466 input tokens, including 160,000 cached input tokens,
and 180 output tokens. Most responses concerned newsletters, Apple account
security/data-export notices, and promotions. This exposes a useful future
optimization: filter verified non-transaction notices before invoking the
CLI. No new sender blocklist entries were silently applied by this test.
This window validates retrieval, provider execution, and clarification
behavior; it does not validate extraction of a complete real transaction.
The updated code passes 595 tests, including exact time boundaries and
folder-isolated UID/watermark regressions.

The deterministic verdict review initially challenged one correctly discarded
Amex travel-points promotion. Its subject did not match the existing marketing
patterns, and hypothetical points redemption amounts resembled a movement.
A targeted promotion-pattern fix now recognizes that subject while retaining
the exception for a completed credit with an actual amount. Two regression
tests cover both cases. Dry-run also reports `challengedVerdicts`, so model
verdicts and the production safeguard can be assessed separately. The saved
model responses were rechecked without additional AI calls.

## Automatic mailbox coverage (2026-10-07)

`process-window.js` without `--folder` discovers INBOX and every mailbox
marked `\\Archive` by IMAP special-use. It fails instead of silently
skipping a missing Archive. Sent, Junk, and Trash are excluded. Explicit
`--folder` remains available for diagnostics, but does not advance shared
coverage. The existing daily systemd command uses this automatic mode.

The shared checkpoint is `data/imap/mailbox-coverage.json`, advanced only
after every selected mailbox finishes successfully. Its initial starting
point is saved before processing either mailbox, so an Archive failure
cannot inherit an advanced INBOX watermark. Empty windows are recorded as
complete. Quota pauses return a failure exit code and preserve coverage.
Daily runs revisit seven days, bounded by the initial recovery date. A move
of an older, never-processed email needs an explicit historical recovery;
the automatic overlap is not an unlimited historical scan.

Successful messages have an account-scoped SHA-256 fingerprint of the full
RFC822 source, with transport line endings normalized. Folder and IMAP UID
are excluded, so moving the same message preserves its identity. Different
content with a reused Message-ID remains distinct. Identity files live in
`data/imap/message-identities-*.json`; corrupt files fail closed. Fingerprints
start accumulating with this deployment: old UID history cannot identify
a previously moved message retrospectively. Wallet transaction comparison
remains the financial duplicate guard, including after a crash between a
Wallet write and saving the fingerprint. A Wallet record UUID alone does
not recognize a newly imported duplicate. A server rewriting message
content can change the fingerprint; Wallet comparison remains necessary.

Automatic and explicit-folder batches share an exclusive PID lock. A
mailbox move between header discovery and body retrieval fails that email
and leaves coverage unchanged so the next run retries.

Official first missing scheduled window:

```sh
cd /opt/bbw
sudo -u bbw env HOME=/var/lib/bbw TZ=America/Mexico_City \
  node dist/cli/process-window.js --day 2026-10-01
```

This means September 30 20:00 through October 1 20:00 CDMX, not the calendar
day at midnight. It permits normal Wallet writes and Telegram questions.

Official run completed successfully with Codex Luna: INBOX 0 emails, Archive
33 emails, 5 classified out, 27 no-transaction results, one clarification,
zero written Wallet records, and zero failures. Telegram clarification
#1845 asks which account paid the Sam's Club purchase of MXN 1,630.
Existing backlog warnings concern earlier runs. Shared coverage now ends
at `2026-10-02T02:00:00Z` (October 1 20:00 CDMX). Repeating the same official
window skipped all 33 messages with zero AI calls and no additional question.
28 message fingerprints are persisted; both October 1 ledgers are complete.

Official inference usage: 28 calls, 290,802 input tokens (211,200 cached),
181 output tokens. The repeat used no inference tokens. The first recovery
still evaluates unfiltered notices/newsletters; subsequent overlap scans
skip known UIDs and message fingerprints before model invocation.

Private run evidence:
`/opt/bbw/change-backups/ai-20261007/official-2026-10-01.log` and
`official-2026-10-01-repeat.log`. Pre-run backup:
`/opt/bbw/data/backups-full/bbw-state-2026-10-07-1314.tar.gz`.
The normal end-of-run retention sweep removed 7 expired ledgers and 6 old
cached attachments. No timer schedule or stack placement was changed.
