#!/bin/bash
# Pushes the working tree to the LXC and restarts the bot.
#
# This exists because the deploy was a command copied by hand, and its
# --exclude list drifted: the copy in the docs excluded only node_modules and
# dist, so every deploy shipped 12 MB of bank statements from Statements/ to the
# container — as uid 501, outside data/, invisible to both the retention sweep
# and the backup. An exclude list that matters cannot live in prose.
#
#   scripts/deploy/push.sh [host]

set -euo pipefail

HOST="${1:-root@10.40.40.24}"
APP_DIR=/opt/bbw
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# data/ and .env.local are deliberately absent: the container's copies are the
# live ones, and overwriting them from the Mac loses whatever ran overnight.
# Statements/ holds bank PDFs and has no business leaving this machine.
# No --delete, and above all no --delete-excluded: it implies --delete and
# applies it to the excluded paths, so it would wipe data/ and .env.local on the
# container — the pending queue, the learned rules and the watermark with them.
rsync -az \
  --exclude node_modules \
  --exclude data \
  --exclude dist \
  --exclude Statements \
  --exclude .env.local \
  --exclude .git \
  --exclude .DS_Store \
  -e ssh "$REPO_DIR/" "$HOST:$APP_DIR/"

ssh "$HOST" "cd $APP_DIR && pnpm build && \
  chown bbw:bbw .env.local && chmod 600 .env.local && chown -R bbw:bbw data && \
  systemctl restart bbw-bot && systemctl is-active bbw-bot"
