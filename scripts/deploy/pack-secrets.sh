#!/bin/bash
# Packs everything the LXC needs that does NOT travel via git into one
# AES-256-encrypted archive, ready to AirDrop:
#   - .env.local        (IMAP/Telegram/Couch credentials)
#   - data/             (ledgers, trackers, learned rules, statements, pendings)
#
# Usage (args work without a TTY; token from `claude setup-token`):
#   bash scripts/deploy/pack-secrets.sh 'mi-frase-secreta' 'sk-ant-oat01-...'
#
# On the LXC (same passphrase, sent via a DIFFERENT channel than the file):
#   openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:'mi-frase-secreta' \
#     -in bbw-secrets-<date>.tar.gz.enc | tar xzf - -C /opt/bbw
#   mv /opt/bbw/bbw.env /etc/bbw.env && chmod 600 /etc/bbw.env /opt/bbw/.env.local

set -euo pipefail

PASS="${1:-}"
TOKEN="${2:-${CLAUDE_CODE_OAUTH_TOKEN:-}}"
[ -n "$PASS" ] || { echo "Uso: pack-secrets.sh '<passphrase>' ['<claude-oauth-token>']"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

[ -f .env.local ] || { echo "ERROR: no existe .env.local"; exit 1; }

EXTRA=()
if [ -n "$TOKEN" ]; then
  printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$TOKEN" > bbw.env
  chmod 600 bbw.env
  EXTRA=(bbw.env)
else
  echo "AVISO: sin token del CLI — /etc/bbw.env tendrá que crearse a mano en el LXC."
fi

OUT="$HOME/Desktop/bbw-secrets-$(date +%Y-%m-%d).tar.gz.enc"

tar czf - \
  --exclude "data/bot/archive" \
  --exclude "data/bot/*.log" \
  --exclude "data/bot/audit-report-*" \
  --exclude ".DS_Store" \
  .env.local data "${EXTRA[@]}" \
| openssl enc -aes-256-cbc -pbkdf2 -salt -pass pass:"$PASS" -out "$OUT"

rm -f bbw.env

echo "Listo: $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
echo "AirDrop ese archivo; manda la passphrase por OTRO canal."
