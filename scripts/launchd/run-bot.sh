#!/bin/bash
# Wrapper used by the LaunchAgent (com.bbw-bot.plist) to start the
# Telegram bot. Resolves node from nvm if available so the agent works
# regardless of which node version is active in the user's shell.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Load nvm if installed. This keeps the LaunchAgent working when node is
# managed by nvm (the default on most dev machines) without requiring a
# system-level node install.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" --no-use
  nvm use --silent default >/dev/null 2>&1 || true
fi

# Make sure `claude` resolves. The CLI is usually in ~/.local/bin (the
# install path recommended by the Claude Code installer).
export PATH="$HOME/.local/bin:$PATH"

mkdir -p "$REPO_ROOT/data/bot"

exec node "$REPO_ROOT/dist/bot/index.js"
