# Plan: refactor del bot de correos a procesamiento por día (batch)

**Estado: APROBADO EN CONCEPTO (2026-07-23), con los ajustes del usuario ya integrados.**
Cualquier agente puede ejecutar este plan de arriba a abajo. Cada fase termina con
criterios de aceptación verificables. Telegram es el canal de verdad con el usuario.

## Contexto y diagnóstico (2026-07-23)

El importador corría como daemon permanente (Telegram bot + IMAP poller cada 2 min)
bajo **dos** LaunchAgents distintos que apuntaban al mismo proceso:

- `com.bbw-bot.plist` → `scripts/launchd/run-bot.sh` → `node dist/main.js` (KeepAlive on crash)
- `com.iubix.webserver.plist` → `node --import tsx/esm src/main.ts` (KeepAlive **incondicional**)

Ambos fueron detenidos y renombrados a `*.plist.disabled` en `~/Library/LaunchAgents/`
el 2026-07-23. No recargar ninguno de los dos; esta arquitectura se retira.

> ⚠️ El usuario reporta un "watcher" que re-habilita el launch agent. No se encontró en
> este Mac (se revisaron LaunchAgents/Daemons, crontab, `~/Library/Scripts`, perfiles de
> shell y automatizaciones de Home Assistant). Renombrar los plists a `.disabled` debería
> neutralizarlo (un `launchctl load` contra la ruta original falla), pero **verificar
> durante 24 h que el bot no reviva** (`pgrep -fl "main.ts|dist/main.js"`) y preguntar al
> usuario dónde vive el watcher antes de la Fase 2.

### Causas raíz de los duplicados y huecos observados

1. **Dos supervisores compitiendo.** El instance-lock (`data/bot/bot.pid`) evitaba doble
   ejecución simultánea, pero producía crash-loops (≈5,180 archivos `bot-*.log` en
   `data/bot/`) y reinicios constantes. Un lock stale permite doble instancia.
2. **UIDs se persisten solo al final del poll** (`src/imap/poller.ts` fase 3). Si el
   proceso muere después de escribir registros pero antes de guardar
   `data/imap/processed-uids.json`, el siguiente arranque reprocesa los mismos correos.
3. **Ventana de dedup muy corta.** `findDuplicate()` en `src/webhook/daily-tracker.ts`
   solo mira 3 h hacia atrás y compara contra los tracker files locales, no contra los
   registros reales de Wallet. Un reproceso >3 h después crea duplicado.
4. **Reset de `uidValidity`** en el buzón invalida todo el store de UIDs → con
   `IMAP_LOOKBACK_DAYS=3` se reprocesan 3 días completos.
5. **Bug de pérdidas (gastos faltantes):** en `poller.ts` el `catch` por mensaje hace
   `processedUids.push(msg.uid)` **también cuando Claude falla** (se observaron rachas de
   `claude exited with code 1`). Esos correos se marcan procesados y sus transacciones
   nunca se escriben. Por eso hay días sin gastos registrados.
6. **Sesiones largas de Claude** en el bot interactivo se degradan (compresión de
   contexto / límite alcanzado) y "se pierden". Requisito del usuario: **cada run
   nocturno y cada correo/documento se procesa con contexto fresco** (invocación nueva
   de `claude`, `isFirstTurn`, sin resume de sesiones largas).

### Datos disponibles para la auditoría

- `data/bot/daily-tracker-YYYY-MM-DD.json` — solo existen desde 2026-07-10 (falta 07-11).
  Cada entrada: `ts, account, accountId, amount, category, payee, status`.
- `data/bot/bot-*.log` y `data/bot/launchd.{out,err}.log`, `data/bot/main.log` — historial
  desde 2026-05-11 (líneas `[email] wrote N record(s)`, `[imap] uid=... error`, etc.).
- `data/imap/processed-uids.json` — UIDs ya procesados de INBOX (cap 2000).
- **Fuente de verdad:** los registros en Wallet. Todo registro escrito por el bot lleva
  `note` con prefijo `[Claude` (p.ej. `[Claude 2026-07-23]`). Se consultan vía el MCP de
  Wallet (`get_records` con filtro `note` `contains.[Claude`) o vía CouchDB (`src/couch.ts`).

---

## Fase 1 — Auditoría y limpieza de duplicados (one-off, requiere aprobación por lote)

Objetivo: dejar Wallet consistente antes de reactivar cualquier automatización.

1. Consultar en Wallet todos los registros con `note contains "[Claude"` desde 2026-05-11.
2. Agrupar candidatos a duplicado: mismo `accountId` + mismo monto (±0.01) + misma fecha
   de transacción (±48 h) + payee normalizado igual (o alguno vacío). Cruzar con los
   `daily-tracker-*.json` y con las líneas `wrote N record(s)` de los logs para
   confirmar qué escritura fue la original y cuál el reproceso.
3. Producir un reporte por día: registros legítimos, duplicados propuestos a borrar
   (con id de registro), y días sospechosos de huecos (rachas de `claude exited with
   code 1` en logs sin escritura posterior del mismo uid).
4. **Presentar el reporte al usuario (Telegram o sesión) y esperar aprobación explícita
   antes de borrar.** Borrado vía MCP `delete_documents` / `patch_records`, nunca masivo
   sin lista aprobada.
5. Los huecos NO se rellenan desde correos viejos: se rellenan en la Fase 3 con estados
   de cuenta PDF (más confiables).
6. **Minar los logs para el clasificador (Fase 2):** listar remitentes cuyo resultado fue
   siempre `NO_TRANSACTION` (Starbucks, shop.app, Afore, marketing de AmEx, etc.) y
   sembrar con ellos la blocklist inicial.

Aceptación: reporte generado; tras aprobación, cero clusters de duplicados restantes en
la consulta del paso 1; blocklist inicial generada desde datos reales.

## Fase 2 — Refactor a ejecución diaria (batch, 20:00, ventana de 24 h)

Objetivo: un solo proceso corto por día, idempotente, sin daemon, contexto fresco.

1. **Nuevo entrypoint CLI** `src/cli/process-day.ts` compilado a `dist/`:
   - Corre a las **20:00 hora local**. La ventana NO es el día calendario: es
     **watermark → ahora** (por defecto las últimas ~24 h: desde el fin de la última
     corrida exitosa hasta el momento del run). Así los gastos posteriores a las 8 pm
     caen en la corrida del día siguiente y nada se pierde.
   - `--from / --to` opcionales para reprocesar una ventana específica;
     `--day YYYY-MM-DD` como azúcar para la ventana 20:00 de ese día → 20:00 del
     siguiente.
   - Corre una vez y termina (exit 0). **Cada correo se procesa con una invocación
     fresca de Claude** (sessionId nuevo, sin sesión acumulada) — requisito explícito
     del usuario por la degradación por compresión/límites.
2. **Clasificador de correos (pre-filtro barato, antes de Claude):**
   - Config en `data/bot/email-rules.json`: `block` (remitente/asunto regex),
     `allow` (remitentes bancarios: banamex, banorte, amex, nu, klar, etc.),
     `unknown` → pasa a Claude pero se registra para revisar patrones.
   - **Walmart (`noreply@walmart.com` y variantes): SIEMPRE ignorar.** La familia usa la
     cuenta; el usuario mandará tickets/screenshots por Telegram manualmente. (Al
     recibir un ticket manual de Walmart, seguir preguntando con qué cuenta se pagó.)
   - Cashi: ya ignorado por learned rule; mover a blocklist explícita.
   - Los correos bloqueados se registran en el ledger como `classified_out` con el
     remitente/asunto (auditable), sin invocar Claude.
3. **Ledger por run** `data/bot/day-ledger-YYYY-MM-DD.json`:
   `{ day, window: {from, to}, status: "running"|"complete"|"failed", startedAt,
   finishedAt, uidsProcessed: [], uidsFailed: [], classifiedOut: [],
   records: [{couchId, accountId, amount, payee, txDate}] }`.
   - Si el ledger de la ventana pedida ya está `complete`, salir con "ya procesado"
     salvo `--force` (que reprocesa solo `uidsFailed`).
   - Se escribe **incrementalmente después de cada correo**, no al final.
   - Guardar `couchId` permite un `--undo-run` seguro si una corrida salió mal.
4. **Corregir el bug de pérdidas:** un uid solo entra a `uidsProcessed` si `processEmail`
   terminó sin excepción; si falla va a `uidsFailed` y se reintenta en el siguiente run
   (máx 3 intentos, luego notificación Telegram con el asunto del correo).
5. **Dedup contra la fuente de verdad:** antes de escribir, además del tracker local,
   consultar Wallet/Couch por registros existentes con mismo accountId + monto + fecha de
   transacción (±48 h) + payee. Si hay match → no escribir, loggear como duplicado evitado.
6. **Nuevo LaunchAgent** `scripts/launchd/com.bbw-daily.plist`:
   - `StartCalendarInterval` a las **20:00**, sin `KeepAlive`, sin `RunAtLoad`.
   - Ejecuta `run-daily.sh` → `process-day`; si el watermark tiene >24 h de atraso
     (Mac apagado), la ventana se extiende automáticamente hasta cubrir el hueco.
   - Al final del run: resumen a Telegram (escritos, duplicados evitados, bloqueados
     por clasificador, fallidos, aclaraciones pendientes) y **re-envío de propuestas
     pendientes** cuyos botones inline hayan expirado (se observaron errores Telegraf
     "query is too old").
7. **Modelo y esfuerzo (contexto fresco):** cada invocación pasa `--model` explícito
   vía `claude-runner.ts` (ya soporta override):
   - Correos nocturnos → **`claude-sonnet-5`, esfuerzo medio** (extracción estructurada
     con learned rules; high no mejora exactitud y sube costo/latencia).
   - Estados de cuenta PDF (Fase 3) → **`claude-sonnet-5`, esfuerzo high** (formatos
     variables). Si un banco falla repetidamente aun con perfil → escalar ese banco a
     Opus y anotarlo en su perfil.
8. **Run recordatorio 10:30 AM:** el mismo plist lleva DOS `StartCalendarInterval`
   (launchd acepta array): 20:00 = run completo; **10:30 = modo `--remind`**, que NO
   procesa correos: solo revisa `pending-proposals.json` / `pending-clarifications.json`
   y la cola de la Fase 3, y re-envía por Telegram cada pendiente con botones frescos
   ("Tienes N aprobaciones pendientes"). Si no hay pendientes, no manda nada.
9. **Telegram bot interactivo** (fotos, tickets Walmart, PDFs, aclaraciones): proceso
   aparte opcional (`pnpm bot`), fuera de launchd por ahora; sigue siendo el canal de
   verdad para confirmaciones.
10. **Housekeeping:** archivar los ~5,180 `bot-*.log` viejos (tar en `data/bot/archive/`)
    y eliminar los dos plists `.disabled` cuando el nuevo esté probado.
11. Actualizar `scripts/launchd/README.md` y `docs/` con la nueva operación.

Aceptación: correr `process-day` dos veces seguidas → la segunda no escribe nada; matar
el proceso a la mitad y relanzar → sin duplicados en Wallet; correo de Walmart en la
ventana → `classified_out`, cero invocaciones de Claude; LaunchAgent disparando 20:00.

## Fase 3 — Reconciliación con estados de cuenta PDF (catch-up, dos pasadas)

Objetivo: poner al día los gastos atrasados y verificar meses pasados contra el banco.
Los PDFs son difíciles (el formato cambia entre bancos) → el conocimiento de parsing se
**persiste por banco** para no re-aprenderlo cada vez.

1. **Perfiles por banco** en `data/statements/profiles/<banco>.md`: notas de formato
   (dónde están los cargos, formato de fechas, señales de abono vs cargo, páginas a
   ignorar, trucos aprendidos). Cada vez que un estado nuevo requiera ajustes, el agente
   actualiza el perfil. *(No existe memoria previa de esto — la sesión vieja no lo
   guardó; se reconstruye aquí y queda en el repo.)*
2. **CLI** `reconcile-statement <ruta.pdf> --account <nombre> [--month YYYY-MM]`, con
   invocación fresca de Claude por documento:
   - Extrae movimientos del PDF (usando el perfil del banco si existe).
   - Guarda el extracto normalizado en `data/statements/ledger-<cuenta>-<YYYY-MM>.json`
     (log permanente de lo que dice el banco — pedido explícito del usuario).
   - Descarga de Wallet los registros de esa cuenta en el periodo y hace el match.
3. **Pasada A (automática):** los movimientos del estado que NO están en Wallet y cuyo
   match es inequívoco (cuenta cierta + monto + fecha + comercio reconocible + categoría
   clara por learned rules) se escriben en lote con nota `[Claude reconcile YYYY-MM]`.
   Se reporta el lote completo a Telegram (formato "Lista con etiquetas" + CSV).
4. **Pasada B (problemáticos):** todo lo ambiguo (cuenta/categoría dudosa, posibles
   transferencias entre cuentas propias, cargos que podrían ser de la familia, montos que
   casi-matchean un registro existente) va a una **cola de aclaraciones** que se manda a
   Telegram una por una, mostrando siempre lo ya identificado (preferencia guardada del
   usuario). Nada de la pasada B se escribe sin respuesta.
   - Duplicados detectados en Wallet (dos registros vs un cargo en el estado) se
     proponen a borrar en esta misma cola.
5. **Ingesta de estados — tres vías (todas terminan en `data/statements/inbox/`):**
   a. **Telegram (principal):** el usuario adjunta el PDF. Si el caption trae
      `/statement <cuenta> [YYYY-MM]` se usa directo; si viene sin caption, el bot
      detecta que parece estado de cuenta (multipágina, emisor bancario) y pregunta
      "¿Estado de cuenta? ¿De qué cuenta y mes?" antes de arrancar la reconciliación.
      Un ticket/foto normal sigue el flujo actual sin cambios.
   b. **Carpeta:** dejar PDFs en `data/statements/inbox/` y correr `reconcile-statement`.
   c. **Correo (automática):** el clasificador nocturno marca correos de "estado de
      cuenta disponible"; si traen el PDF adjunto se guarda en el inbox; si solo traen
      liga, se notifica por Telegram para descarga manual. La reconciliación NO corre
      sola: el run nocturno avisa "llegó el estado de <banco>" y se dispara con
      aprobación (o `--auto` por cuenta cuando el perfil ya esté maduro).
6. **Contraseñas de PDFs:** muchos bancos protegen el PDF (fecha de nacimiento, dígitos
   de tarjeta, etc.). Se guardan en `data/statements/passwords.json` (`chmod 600`;
   `data/` ya está en `.gitignore`, nunca se commitea) con formato
   `{ "<banco>": { "password": "...", "hint": "cómo se construye" } }`. El `hint`
   también se anota en el perfil del banco (sin el valor). NO guardar contraseñas en la
   memoria del agente ni en archivos versionados.
7. Ejecutar cuenta por cuenta para mayo–julio 2026, empezando por las de más movimiento
   (Costco, American Express, Banorte).

Aceptación: por cada estado procesado, el diff cierra: Wallet = estado de cuenta ±
ajustes aprobados; el ledger del estado queda en `data/statements/`; el perfil del banco
queda actualizado.

## Orden de ejecución sugerido

Fase 1 (auditoría + blocklist minada) → aprobación → limpieza → Fase 2 (refactor) →
prueba manual 2–3 días → activar LaunchAgent 20:00 → Fase 3 (reconciliación por cuenta).

## Decisiones ya tomadas por el usuario (2026-07-23)

- Run diario ~**20:00**, ventana de 24 h (watermark), no día calendario.
- **Walmart por correo se ignora siempre**; tickets manuales por Telegram.
- Clasificador de correos previo a Claude (blocklist sembrada desde logs).
- Estados de cuenta: log permanente + solo agregar faltantes; dos pasadas
  (auto → problemáticos por Telegram).
- Contexto fresco de Claude en cada run/correo/documento.
- Modelos (actualizado 2026-08-04): **Haiku 4.5 (`claude-haiku-4-5-20251001`) por
  correo, en sesión totalmente aislada** (sessionId nuevo, nunca resume) y cuerpo del
  correo recortado a ~8 KB — el desborde de contexto rompía la app. Sonnet 5 high para
  PDFs (escalar a Opus por banco solo si falla con perfil).
- Milestone final: contenerizar todo (Docker, importer one-shot + bot opcional) para
  migrar del Mac mini a Proxmox; ver plan de ejecución.
- Recordatorio de aprobaciones pendientes a las 10:30 AM (modo `--remind`).
- Ingesta de estados: Telegram con caption `/statement` (o autodetección + pregunta),
  carpeta inbox, o captura automática desde correo con aviso.
- Contraseñas de PDFs en `data/statements/passwords.json` (gitignored, chmod 600),
  hints en los perfiles por banco; nunca en memoria del agente ni en git.

## Pendientes de confirmar

- Ubicación del "watcher" que re-habilita el launch agent (no encontrado en este Mac).
- Ventana de dedup contra Wallet (propuesta: ±48 h sobre fecha de transacción).
