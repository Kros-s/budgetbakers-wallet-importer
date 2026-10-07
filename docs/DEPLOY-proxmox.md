# Proxmox migration — native deployment (chosen 2026-08-05)

The user's decision was **no Docker**. Production runs Node 22, Claude Code
and Codex CLI directly in LXC 200, managed by systemd. This includes the
20:00 daily batch, the 10:30 reminder, and the interactive Telegram bot.
The Dockerfile and Compose configuration remain alternatives, not the active
deployment path. Times are America/Mexico_City.

## Components in `scripts/deploy/`

- `push.sh`: runs locally, synchronizes source, builds remotely, and restarts
  the bot. This is the supported deployment path; exclusions live here.
  Use `scripts/deploy/push.sh --proxmox` for SSH through the Proxmox host and
  `pct exec 200`, or supply a directly accessible LXC SSH host.
- `provision-lxc.sh`: runs inside a new LXC; installs timezone configuration,
  Node 22, pnpm, both CLIs, poppler-utils, the `bbw` service user, and units.
  Do not rerun it on production for ordinary code updates.
- `systemd/bbw-daily.{service,timer}`: one-shot daily batch at 20:00 with
  `Persistent=true`. A missed timer runs after boot; the watermark covers
  the processing gap.
- `systemd/bbw-remind.{service,timer}`: 10:30 reminder, not persistent.
- `systemd/bbw-bot.service`: interactive bot with `Restart=on-failure`;
  interactive proposals require confirmation before writes.

## LXC requirements

- Debian 12 / Ubuntu 22.04 or newer, internet access, approximately 2 GB RAM.
- No nesting required: this deployment does not use Docker.

## Initial deployment

1. Establish SSH access through Proxmox, or add the local public SSH key to
   the LXC root user's `authorized_keys` for direct access.
2. Configure the selected provider privately. Claude uses
   `CLAUDE_CODE_OAUTH_TOKEN` in `/etc/bbw.env` (0600), obtained through
   `claude setup-token`. Codex authenticates as `bbw` with HOME
   `/var/lib/bbw`; see [AI providers](AI-PROVIDERS.md).
3. Copy code using `scripts/deploy/push.sh`; do not maintain a separate manual
   exclusion list. Earlier manual deployments accidentally copied 12 MB of
   bank PDFs. `data/` and `.env.local` are transferred separately only for
   initial setup; credentials have permissions 0600.
4. Provision the new LXC with `/opt/bbw/scripts/deploy/provision-lxc.sh`.
5. Check parity with `process-window.js --dry-run` under user `bbw`, HOME
   `/var/lib/bbw`, working directory `/opt/bbw`, and the production timezone.
6. Verify `systemctl list-timers 'bbw-*'` and start `bbw-bot`. Do not reload
   obsolete local LaunchAgents; stop any temporary local interactive bot to
   prevent competing Telegram polling processes.
7. Observe the first 20:00 run and its Telegram summary.
8. After two or three stable nights, remove obsolete disabled local plists.

## Updating production

Implement and test in the local repository, commit/push, then deploy with
`scripts/deploy/push.sh --proxmox`. Live credentials and runtime data remain
in the LXC. Provider selection through `/ai` persists and is shared by the
bot and daily batch. Keep deployment evidence and rollback instructions in
[AI providers](AI-PROVIDERS.md).

## Notes

- Voice transcription is not installed by default. If required, install
  `openai-whisper` with pipx and set `WHISPER_BIN` in `.env.local`.
- Runtime state lives under `/opt/bbw/data`. Recovering it to the Mac requires
  a deliberate reverse synchronization, separate from code deployment.
- The old local LaunchAgent watcher has not been located. Before enabling a
  new deployment, check that no local process restarts the old bot.

The existing daily command now discovers INBOX and IMAP Archive automatically.
See [mailbox coverage and deduplication](AI-PROVIDERS.md#automatic-mailbox-coverage-2026-10-07)
for the shared checkpoint, seven-day overlap, and historical recovery command.
