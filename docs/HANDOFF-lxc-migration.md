# Handoff: migración a LXC de Proxmox (estado al 2026-08-18)

Para el agente que retoma el trabajo en la máquina con acceso a Proxmox.
Branch: `refactor/daily-batch` (todo el refactor vive ahí; NO mergeado a main).

## Qué es esto

Importador de gastos → BudgetBakers Wallet. Pipeline batch (no daemon):
- `src/cli/process-window.ts` — corrida nocturna 20:00: lee IMAP (iCloud) en
  ventana watermark, clasificador de correos (Walmart/marketing fuera), cada
  correo → Claude CLI **Haiku 4.5 en sesión aislada nueva** (`EMAIL_MODEL`),
  dedup contra Wallet real (±48 h), ledger idempotente por día en
  `data/bot/day-ledger-*.json`. `--remind` = recordatorio 10:30 de pendientes.
  `--undo-run <día>` = rollback. `--dry-run` = propone sin escribir.
- `src/bot/index.ts` — bot interactivo de Telegram (fotos, tickets, respuestas
  a aclaraciones). Único proceso de larga vida. Nunca escribe sin confirmación.
- `src/cli/reconcile-statement.ts` — estados de cuenta PDF (Sonnet 5): extrae,
  guarda ledger normalizado, diff vs Wallet, `--write` agrega faltantes.
  Registro de estados esperados en `data/statements/registry.json`.
- Reglas del usuario acumuladas en `data/bot/learned-rules.md` (NO perder).

## Estado actual

- Mac mini: bot interactivo corriendo bajo launchd `com.bbw-bot-interactive`
  (interim). Ningún batch programado: **el correo no se procesa desde 2026-08-05**
  — primer pendiente tras el deploy: correr el catch-up (paso 6).
- Ledger completo hasta 2026-08-05 (watermark). Duplicados históricos limpiados.
- 3 propuestas + 17 aclaraciones esperando respuesta del usuario en Telegram.
- LaunchAgents viejos del Mac: renombrados `*.plist.disabled` — NO recargar.
  (Ojo: el usuario reporta un "watcher" no localizado que revivía el agente
  viejo en el Mac; irrelevante en el LXC, pero no reactivar nada en el Mac.)

## Plan de despliegue (nativo, sin Docker — decisión del usuario)

### 1. Crear el contenedor (en el host Proxmox)

```bash
# Ajusta storage/bridge/ID a tu entorno:
pveam update && pveam available | grep debian-12-standard
pveam download local debian-12-standard_12.7-1_amd64.tar.zst   # o la versión listada
pct create 200 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname bbw --unprivileged 1 --cores 2 --memory 2048 --swap 512 \
  --rootfs local-lvm:16 --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --onboot 1 --start 1
pct exec 200 -- bash -c "apt update && apt install -y git rsync curl unzip openssh-server"
```

### 2. Código

```bash
pct exec 200 -- git clone -b refactor/daily-batch \
  https://github.com/Kros-s/budgetbakers-wallet-importer.git /opt/bbw
# (repo privado: usa deploy key o https con token)
```

### 3. Secretos (llegan por AirDrop como bbw-secrets-<fecha>.tar.gz.enc,
   AES-256; la passphrase la da el usuario por otro canal)

```bash
pct push 200 bbw-secrets-*.tar.gz.enc /root/bbw-secrets.tar.gz.enc
pct exec 200 -- bash -c "openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:'<PASSPHRASE>' \
  -in /root/bbw-secrets.tar.gz.enc | tar xzf - -C /opt/bbw && \
  chmod 600 /opt/bbw/.env.local && rm /root/bbw-secrets.tar.gz.enc"
```

### 4. Token del Claude CLI

El bundle ya trae `bbw.env` con `CLAUDE_CODE_OAUTH_TOKEN` (generado por el
usuario con `claude setup-token`). Muévelo a su lugar:

```bash
pct exec 200 -- bash -c "mv /opt/bbw/bbw.env /etc/bbw.env && chmod 600 /etc/bbw.env"
```

(Si el bundle no lo trajera, pide al usuario correr `claude setup-token` y
crea /etc/bbw.env a mano con ese valor.)

### 5. Provisionar (instala Node 22, pnpm, Claude CLI, build, usuario bbw,
   timers systemd 20:00/10:30 y servicio del bot)

```bash
pct exec 200 -- bash /opt/bbw/scripts/deploy/provision-lxc.sh
```

El daemon queda así: `bbw-daily.timer` (20:00, Persistent=true — si el LXC
estuvo apagado dispara al arrancar y la ventana watermark absorbe el hueco),
`bbw-remind.timer` (10:30), `bbw-bot.service` (bot, Restart=on-failure).

### 6. Validar + catch-up + cutover

```bash
pct exec 200 -- sudo -u bbw node /opt/bbw/dist/cli/process-window.js --dry-run
# Revisar la salida (backlog desde 2026-08-05). Si se ve bien:
pct exec 200 -- sudo -u bbw node /opt/bbw/dist/cli/process-window.js
pct exec 200 -- systemctl start bbw-bot
pct exec 200 -- systemctl list-timers 'bbw-*'
```

En el Mac (SOLO tras confirmar que el bot del LXC responde en Telegram —
dos bots long-polling a la vez pelean por los updates):

```bash
launchctl bootout gui/$(id -u)/com.bbw-bot-interactive
rm ~/Library/LaunchAgents/com.bbw-bot-interactive.plist
```

### 7. Verificación final

- Resumen del batch llega a Telegram; `data/bot/day-ledger-<hoy>.json` con
  `status: complete`.
- Mandar un mensaje de texto al bot ("50 tacos efectivo") → propone CSV.
- `pnpm test` en /opt/bbw (61 tests) si se quiere paranoia extra.

## Después del cutover (backlog conocido, en orden)

1. Recordar al usuario sus 20 pendientes de Telegram (los re-lista `--remind`).
2. Reconciliar estados May–Jul: Costco → AmEx → Banorte (el usuario junta los
   PDF; perfiles por banco en `data/statements/profiles/`, ver README ahí).
   Verificar los cut-days adivinados de `data/statements/registry.json`.
3. Mejoras anotadas: log de veredictos NO_TRANSACTION de remitentes bancarios,
   limpieza de aclaraciones stale, backup semanal de `data/`, prompts de
   efectivo (conteo semanal de cartera + follow-up de retiros ATM).
4. Merge de `refactor/daily-batch` → main cuando el LXC lleve unas noches
   estable.

## Convenciones que el usuario espera (memoria del proyecto)

- Correos: Haiku aislado por correo; PDFs: Sonnet high. No subir modelos sin preguntar.
- Notas de registros: prefijo `[Claude ...]`. CSV: categorías con coma entre
  comillas. Walmart por correo se ignora SIEMPRE (familia). Cashi se ignora.
- Telegram es el canal de verdad; al pedir datos faltantes, mostrar lo ya
  identificado. Todo borrado en Wallet requiere lista aprobada + respaldo.
