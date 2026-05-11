# Running the bot 24/7 on macOS with launchd

This folder has a `LaunchAgent` template (`com.bbw-bot.plist`) and a
wrapper script (`run-bot.sh`) that together keep the Telegram bot
running across logins and crashes.

## One-time setup

```bash
# 1. Clone the repo (typically once, on the Mac mini)
git clone git@github.com:Kros-s/budgetbakers-wallet-importer.git
cd budgetbakers-wallet-importer
npm install
npm run build      # produces dist/bot/index.js used by run-bot.sh

# 2. Create .env.local with these vars (gitignored)
cat > .env.local <<EOF
COUCH_URL=https://couch-prod-us-1.budgetbakers.com
COUCH_DB=bb-<your-user-id>
COUCH_LOGIN=<your-user-id>
COUCH_TOKEN=<replication-token>
COUCH_USER_ID=<your-user-id>
TELEGRAM_BOT_TOKEN=<botfather-token>
TELEGRAM_ALLOWED_CHAT_IDS=<your-chat-id>
EOF

# 3. Verify `claude` CLI is installed and logged in
which claude && claude --version
# If `claude --print "ping"` fails with auth errors, run `claude login` first.

# 4. Smoke test the bot in the foreground
npm run bot
# Send /start from Telegram, confirm allowlist accepts you. Ctrl+C to stop.

# 5. Stamp the LaunchAgent plist with the absolute repo path
REPO_PATH="$(pwd)"
mkdir -p ~/Library/LaunchAgents
sed "s|__REPO_PATH__|$REPO_PATH|g" scripts/launchd/com.bbw-bot.plist \
  > ~/Library/LaunchAgents/com.bbw-bot.plist

# 6. Load and start the agent
launchctl unload -w ~/Library/LaunchAgents/com.bbw-bot.plist 2>/dev/null || true
launchctl load -w ~/Library/LaunchAgents/com.bbw-bot.plist

# 7. Verify it's running
launchctl list | grep com.bbw-bot
tail -f data/bot/launchd.out.log     # should show "Starting bot (long-polling)..."
```

## After code changes

```bash
git pull
npm install          # only if package.json changed
npm run build
launchctl kickstart -k gui/$(id -u)/com.bbw-bot   # restart with the new build
```

## Stopping the bot

```bash
launchctl unload -w ~/Library/LaunchAgents/com.bbw-bot.plist
```

## Caveats

- **LaunchAgent runs as your user**, so the bot has access to your
  Claude Max keychain credentials and the MCP servers you've configured
  for `claude`. A LaunchDaemon (system-wide) would run as root and would
  NOT see your keychain — keep this as a LaunchAgent.

- **macOS sleep**: if the Mac mini sleeps, the bot pauses. Configure
  power settings so it never sleeps:
  ```bash
  sudo pmset -a sleep 0 displaysleep 5 disksleep 0
  ```

- **Auto-login**: for the LaunchAgent to survive reboots without manual
  login, enable automatic login for your user in System Settings →
  Users & Groups → Automatic login.

- **Log rotation**: launchd doesn't rotate the log files. They grow
  unbounded. Truncate periodically or wire up newsyslog if needed.

- **Claude Max session**: `claude` reads auth from the user's keychain;
  there's nothing extra to do as long as you ran `claude login` once on
  this machine. If you ever sign out of macOS or the keychain locks,
  the bot may start failing — re-login fixes it.
