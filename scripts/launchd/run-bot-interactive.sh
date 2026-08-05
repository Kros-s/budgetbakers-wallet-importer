#!/bin/bash
# Wrapper for com.bbw-bot-interactive.plist — Telegram-only bot, INTERIM until
# the Proxmox migration.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" --no-use
  nvm use --silent default >/dev/null 2>&1 || true
fi

export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$REPO_ROOT/data/bot"

exec npx tsx src/bot/index.ts
