#!/bin/bash
# Snapshots everything the importer cannot regenerate: the pending queue, the
# learned rules, the classifier rules, the ledgers (the watermark lives there)
# and the credentials. Logs and debug dumps are excluded — they are noise, and
# the whole point is a file small enough to keep many of.
#
# Run by bbw-backup.timer. Keeps 15 days, matching the rest of the retention.

set -euo pipefail

APP_DIR=/opt/bbw
DEST="$APP_DIR/data/backups-full"
KEEP_DAYS=15

mkdir -p "$DEST"
STAMP=$(date +%Y-%m-%d-%H%M)
OUT="$DEST/bbw-state-$STAMP.tar.gz"

cd "$APP_DIR"
# Statement PDFs are deliberately NOT in here: they are the most sensitive file
# the pipeline holds and the most replaceable — the bank reissues them on
# demand. Including them would also grow each snapshot ~35x (a month of the 13
# accounts is ~4.6 MB against the 270 KB this file weighs today), which defeats
# keeping many of them.
tar czf "$OUT" \
  --exclude="data/backups-full" \
  --exclude="data/statements/inbox" \
  --exclude="data/bot/*.log" \
  --exclude="data/*/debug" \
  data .env.local
chmod 600 "$OUT"

# Never leave zero backups: prune by age, but always keep the newest few.
mapfile -t OLD < <(ls -1t "$DEST"/bbw-state-*.tar.gz 2>/dev/null | tail -n +4)
for f in "${OLD[@]:-}"; do
  [ -n "$f" ] || continue
  if [ "$(find "$f" -mtime +$KEEP_DAYS -print -quit)" ]; then rm -f "$f"; fi
done

echo "respaldo: $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' ')) · $(ls -1 "$DEST" | wc -l) en total"
