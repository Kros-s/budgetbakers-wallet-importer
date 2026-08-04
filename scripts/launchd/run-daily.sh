#!/bin/bash
# Wrapper for com.bbw-daily.plist. launchd fires this at BOTH scheduled times
# with the same arguments, so the mode is picked by clock: before noon it's
# the 10:30 pending-approvals reminder, otherwise the 20:00 batch run.
#
# The batch run uses the watermark window (end of last complete run → now),
# so days the Mac was off are covered automatically on the next firing.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" --no-use
  nvm use --silent default >/dev/null 2>&1 || true
fi

# Make sure `claude` resolves (installed in ~/.local/bin).
export PATH="$HOME/.local/bin:$PATH"

mkdir -p "$REPO_ROOT/data/bot"

HOUR=$(date +%H)
if [ "$HOUR" -lt 12 ]; then
  exec node dist/cli/process-window.js --remind
else
  exec node dist/cli/process-window.js
fi
