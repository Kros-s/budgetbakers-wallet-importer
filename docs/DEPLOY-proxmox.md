# Migración a Proxmox (contenedor Docker)

Objetivo: sacar el importador del Mac mini. El batch corre como contenedor
one-shot disparado por cron del host; el bot interactivo de Telegram es un
contenedor opcional de larga vida.

## Requisitos en el host (LXC o VM con Docker)

- Docker + docker compose.
- Zona horaria del host: `America/Mexico_City` (las ventanas 20:00→20:00
  dependen de ella).
- El contenedor LXC debe permitir nesting si se usa LXC (`features: nesting=1`).

## Preparación (una vez, en el Mac)

1. Crear el token de auth del CLI de Claude (larga vida, revocable):
   `claude setup-token` → guarda el valor como `CLAUDE_CODE_OAUTH_TOKEN`.
2. Verificar paridad en el Mac antes del cutover:
   `docker compose run --rm importer --dry-run` debe proponer lo mismo que
   la corrida nativa.

## Cutover

1. En el Mac: descargar el LaunchAgent nuevo si ya estaba activo
   (`launchctl bootout gui/$(id -u)/com.bbw-daily`). Los dos viejos ya están
   `.disabled` — no tocarlos.
2. Copiar al host: repo → `/opt/bbw`, y rsync de `data/` y `.env.local`
   (contiene credenciales IMAP/Telegram/Couch; `chmod 600`).
   `CLAUDE_CODE_OAUTH_TOKEN` va en `/opt/bbw/.env` (lo lee compose), no en git.
3. `cd /opt/bbw && docker compose build importer`
4. Validar: `docker compose run --rm importer --dry-run`
   (la ventana watermark cubre sola los días del traslado).
5. Cron del host:
   ```
   0 20 * * *  cd /opt/bbw && docker compose run --rm importer >> data/bot/daily.out.log 2>&1
   30 10 * * * cd /opt/bbw && docker compose run --rm importer --remind >> data/bot/daily.out.log 2>&1
   ```
6. Bot interactivo (opcional): `docker compose --profile bot up -d bot`.
   Nota: la transcripción de voz (whisper) no está instalada en la imagen;
   si se usa, añadir el binario al Dockerfile o desactivar audio.
7. Supervisar la primera corrida de las 20:00 (resumen en Telegram) y después
   borrar los plists `.disabled` del Mac.

## Rollback

El estado completo vive en `data/` — para volver al Mac basta rsync inverso y
recargar el LaunchAgent `com.bbw-daily`. Ninguna pieza guarda estado fuera de
`data/` y Wallet/CouchDB.
