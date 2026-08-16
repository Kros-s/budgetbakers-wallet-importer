#!/bin/bash
# Packs everything the LXC needs that does NOT travel via git into one
# encrypted archive, ready to AirDrop:
#   - .env.local        (IMAP/Telegram/Couch credentials)
#   - data/             (ledgers, trackers, learned rules, statements, pendings)
#
# Usage (prompts twice for a passphrase):
#   bash scripts/deploy/pack-secrets.sh
#
# On the LXC:
#   unzip bbw-secrets-<date>.zip -d /opt/bbw/    # asks the passphrase
#   chmod 600 /opt/bbw/.env.local
#
# NOT included (create on the LXC): /etc/bbw.env with CLAUDE_CODE_OAUTH_TOKEN
# from `claude setup-token` — tokens shouldn't ride along with the rest.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

OUT="$HOME/Desktop/bbw-secrets-$(date +%Y-%m-%d).zip"

[ -f .env.local ] || { echo "ERROR: no existe .env.local"; exit 1; }

# -e: encrypted (AES with password prompt); excludes junk and huge logs.
zip -er "$OUT" .env.local data \
  -x "data/bot/archive/*" "data/bot/*.log" "data/bot/audit-report-*" "*.DS_Store"

echo
echo "Listo: $OUT"
echo "AirDrop ese archivo; la contraseña viaja por otro canal (no la mandes junto)."
