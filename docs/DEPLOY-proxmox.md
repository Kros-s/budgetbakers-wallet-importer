# Migración a Proxmox — despliegue NATIVO (elegido 2026-08-05)

Decisión del usuario: **sin Docker**. Node 22 + Claude Code CLI directo en un
LXC, con systemd timers. Se porta TODO: batch nocturno (20:00), recordatorio
(10:30) y bot interactivo de Telegram. (El Dockerfile/compose del repo queda
como alternativa, no es la ruta activa.)

## Piezas (en `scripts/deploy/`)

- `push.sh` — corre en el Mac: sincroniza el árbol, compila y reinicia el bot.
  Es la única forma soportada de desplegar; los `--exclude` viven ahí.
- `provision-lxc.sh` — corre EN el LXC: timezone, Node 22, pnpm, Claude CLI,
  build, usuario de servicio `bbw`, instala y habilita las unidades.
- `systemd/bbw-daily.{service,timer}` — batch one-shot a las 20:00,
  `Persistent=true` (si el LXC estuvo apagado, dispara al arrancar y la
  ventana watermark cubre el hueco).
- `systemd/bbw-remind.{service,timer}` — recordatorio 10:30, no persistente.
- `systemd/bbw-bot.service` — bot interactivo, `Restart=on-failure` (es el
  único proceso de larga vida; nunca escribe sin confirmación).

## Requisitos del LXC

- Debian 12 / Ubuntu 22.04+, acceso a internet, ~2 GB RAM.
- NO necesita nesting (sin Docker).

## Pasos

1. **Acceso**: agregar la llave pública del Mac (`~/.ssh/id_ed25519.pub`) a
   `root@<lxc>:/root/.ssh/authorized_keys` (las llaves actuales del usuario
   viven en otra máquina).
2. **Token del CLI** (una vez, en el Mac): `claude setup-token` →
   en el LXC crear `/etc/bbw.env` con `CLAUDE_CODE_OAUTH_TOKEN=...` (600).
3. **Copiar**: `scripts/deploy/push.sh` — NO a mano. La lista de `--exclude`
   se desincronizó estando en prosa y cada despliegue mandaba `Statements/`
   (12 MB de PDFs bancarios) al contenedor. `data/` y `.env.local` se copian
   aparte, una sola vez (600).
4. **Provisionar**: `ssh root@lxc bash /opt/bbw/scripts/deploy/provision-lxc.sh`
5. **Paridad**: `sudo -u bbw node /opt/bbw/dist/cli/process-window.js --dry-run`
   debe proponer lo mismo que el Mac.
6. **Cutover**: verificar `systemctl list-timers 'bbw-*'`; arrancar el bot
   (`systemctl start bbw-bot`); en el Mac NO recargar ningún LaunchAgent
   (los viejos ya están `.disabled`; `com.bbw-daily` nunca se activó).
   Detener también el bot interactivo temporal del Mac.
7. Supervisar la primera corrida de las 20:00 (resumen en Telegram).
8. Después de 2–3 noches estables: borrar los plists `.disabled` del Mac.

## Notas

- Voz (whisper) en el bot: no se instala por defecto; si se usa audio en
  Telegram, instalar whisper en el LXC (`pipx install openai-whisper`) y
  definir `WHISPER_BIN` en `.env.local`, o ignorar audios.
- Estado completo en `/opt/bbw/data` — rollback = rsync inverso al Mac.
- El "watcher" que revivía el LaunchAgent viejo en el Mac sigue sin
  localizarse: al migrar, verificar que nada en el Mac levante el bot de
  nuevo (`pgrep -fl main.ts`).
