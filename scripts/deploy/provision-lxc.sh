#!/bin/bash
# Provisions a Debian/Ubuntu Proxmox LXC to run the importer NATIVELY
# (no Docker): Node 22 + pnpm + Claude Code CLI + systemd timers/services.
#
# Run ON the LXC as root, with the repo already at /opt/bbw (rsync or clone):
#   bash /opt/bbw/scripts/deploy/provision-lxc.sh
#
# Expects afterwards (copied separately, never in git):
#   /opt/bbw/.env.local   — IMAP/Telegram/Couch credentials (chmod 600)
#   /etc/bbw.env          — CLAUDE_CODE_OAUTH_TOKEN=... (chmod 600)

set -euo pipefail

APP_DIR=/opt/bbw
UNIT_SRC="$APP_DIR/scripts/deploy/systemd"

echo "── Timezone (las ventanas 20:00→20:00 dependen de esto)"
timedatectl set-timezone America/Mexico_City

echo "── Node 22 + pnpm"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
corepack enable

echo "── Claude Code CLI"
npm install -g @anthropic-ai/claude-code
claude --version

echo "── Dependencias y build"
cd "$APP_DIR"
pnpm install --frozen-lockfile
pnpm build

echo "── Usuario de servicio"
id -u bbw >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin bbw
mkdir -p "$APP_DIR/data/bot" "$APP_DIR/data/imap" "$APP_DIR/data/statements/inbox"
chown -R bbw:bbw "$APP_DIR/data"
[ -f "$APP_DIR/.env.local" ] && chown bbw:bbw "$APP_DIR/.env.local" && chmod 600 "$APP_DIR/.env.local"
[ -f /etc/bbw.env ] && chmod 600 /etc/bbw.env

echo "── Unidades systemd"
cp "$UNIT_SRC"/bbw-*.service "$UNIT_SRC"/bbw-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bbw-daily.timer bbw-remind.timer
systemctl enable bbw-bot.service   # started manually the first time: systemctl start bbw-bot

echo
echo "Listo. Verifica:"
echo "  systemctl list-timers 'bbw-*'"
echo "  sudo -u bbw node $APP_DIR/dist/cli/process-window.js --dry-run   # prueba de paridad"
echo "  systemctl start bbw-bot && journalctl -u bbw-bot -f              # bot interactivo"
