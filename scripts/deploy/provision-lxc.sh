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
# The service user's HOME. NOT $APP_DIR: the Claude CLI writes ~/.claude
# (config + --resume session state) and $APP_DIR is owned by root, so a HOME
# inside it makes every `claude` invocation fail with exit code 1.
SVC_HOME=/var/lib/bbw

echo "── Timezone (las ventanas 20:00→20:00 dependen de esto)"
# timedatectl talks to systemd-timedated, which is often denied in an
# unprivileged container. The symlink is the fallback that always works.
timedatectl set-timezone America/Mexico_City 2>/dev/null \
  || ln -sf /usr/share/zoneinfo/America/Mexico_City /etc/localtime

echo "── Paquetes base"
# gnupg + ca-certificates are required by the NodeSource setup script.
apt-get update
apt-get install -y ca-certificates curl gnupg unzip rsync git

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
id -u bbw >/dev/null 2>&1 || useradd --system --home "$SVC_HOME" --shell /usr/sbin/nologin bbw
mkdir -p "$SVC_HOME"
chown bbw:bbw "$SVC_HOME"
chmod 700 "$SVC_HOME"
mkdir -p "$APP_DIR/data/bot" "$APP_DIR/data/imap" "$APP_DIR/data/statements/inbox"
chown -R bbw:bbw "$APP_DIR/data"
# Guarded with if/then, not `[ -f ] && ...`: under `set -e` a false test at the
# head of an && list aborts the whole script before the units are installed.
if [ -f "$APP_DIR/.env.local" ]; then
  chown bbw:bbw "$APP_DIR/.env.local"
  chmod 600 "$APP_DIR/.env.local"
else
  echo "   AVISO: falta $APP_DIR/.env.local — el batch no podrá leer IMAP ni CouchDB."
fi
if [ -f /etc/bbw.env ]; then
  chmod 600 /etc/bbw.env
else
  echo "   AVISO: falta /etc/bbw.env — el CLI de Claude no tendrá token."
fi

echo "── Unidades systemd"
cp "$UNIT_SRC"/bbw-*.service "$UNIT_SRC"/bbw-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bbw-daily.timer bbw-remind.timer bbw-backup.timer
systemctl enable bbw-bot.service   # started manually the first time: systemctl start bbw-bot

echo
echo "Listo. Verifica:"
echo "  systemctl list-timers 'bbw-*'"
echo "  sudo -u bbw node $APP_DIR/dist/cli/process-window.js --dry-run   # prueba de paridad"
echo "  systemctl start bbw-bot && journalctl -u bbw-bot -f              # bot interactivo"
