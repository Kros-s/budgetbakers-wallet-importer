#!/bin/bash
# Packs everything the LXC needs that does NOT travel via git into one
# AES-256-encrypted archive, ready to AirDrop:
#   - .env.local        (IMAP/Telegram/Couch credentials)
#   - data/             (ledgers, trackers, learned rules, statements, pendings)
#
# Usage (passphrase as argument — works without a TTY):
#   bash scripts/deploy/pack-secrets.sh 'mi-frase-secreta'
#
# On the LXC (same passphrase, sent via a DIFFERENT channel than the file):
#   openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:'mi-frase-secreta' \
#     -in bbw-secrets-<date>.tar.gz.enc | tar xzf - -C /opt/bbw
#   chmod 600 /opt/bbw/.env.local
#
# NOT included (create on the LXC): /etc/bbw.env with CLAUDE_CODE_OAUTH_TOKEN
# from `claude setup-token` — tokens shouldn't ride along with the rest.

set -euo pipefail

PASS="${1:-}"
[ -n "$PASS" ] || { echo "Uso: pack-secrets.sh '<passphrase>'"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

[ -f .env.local ] || { echo "ERROR: no existe .env.local"; exit 1; }

OUT="$HOME/Desktop/bbw-secrets-$(date +%Y-%m-%d).tar.gz.enc"

tar czf - \
  --exclude "data/bot/archive" \
  --exclude "data/bot/*.log" \
  --exclude "data/bot/audit-report-*" \
  --exclude ".DS_Store" \
  .env.local data \
| openssl enc -aes-256-cbc -pbkdf2 -salt -pass pass:"$PASS" -out "$OUT"

echo "Listo: $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
echo "AirDrop ese archivo; manda la passphrase por OTRO canal."
