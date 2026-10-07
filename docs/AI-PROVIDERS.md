# Proveedores de IA y flujo de despliegue

El repositorio local es la fuente del código. Implementar y probar aquí,
commit/push al repositorio, y desplegar con `scripts/deploy/push.sh --proxmox`.
Ese modo usa SSH al host y `pct exec 200`; no requiere SSH directo al LXC.
No editar código en producción y luego recuperarlo al repo.

El LXC conserva `/opt/bbw/data`, `.env.local`, `/etc/bbw.env` y el HOME de
`bbw` (`/var/lib/bbw`). Son estado y secretos de producción, no código.
El script no los reemplaza, tampoco envía PDFs locales ni `.claude`.

## Telegram

- `/ai`: estado global, ruta efectiva, pausa y modelos.
- `/ai auto`: Claude primero; Codex solo ante cuota, autenticación,
  indisponibilidad o CLI ausente. Nunca se ejecutan en paralelo.
- `/ai codex` o `/ai claude`: exclusivamente ese proveedor.
- `/ai retry`: quita la pausa del primario; no cambia el modo ni consume una llamada.
  En modo auto, la siguiente tarea vuelve a intentar Claude.

Solo chats autorizados. La elección se guarda atómicamente en
`data/bot/ai-policy.json`, compartida por bot y batch; aplica a la siguiente
extracción, no interrumpe la actual. La pausa de Claude dura una hora y vive
separada en `ai-claude-health.json`; evita intentarlo por cada correo.
Una aclaración válida no dispara fallback. Errores de CSV, validación y
escritura tampoco. Cuando no hay proveedor disponible, el batch pausa sin
consumir los reintentos de todos los correos pendientes.

## Modelos y consumo

Claude conserva Haiku para correos y ahora fija Haiku para chat si no hay
`CLAUDE_MODEL`. Estados conservan `STATEMENT_CLAUDE_MODEL` (Sonnet).
Codex: Luna/low para correos y chat; 6.1 Sol/medium para estados. Variables:
`CODEX_EMAIL_MODEL`, `CODEX_CHAT_MODEL`, `CODEX_STATEMENT_MODEL`.
No hay escalamiento de modelo automático por respuestas ambiguas.

El filtro determinista corre antes de la IA; los correos siguen limitados a
8,000 caracteres, conservando principio y final. Codex usa instrucciones
mínimas versionadas en `config/codex-extractor.md`, sin instrucciones de
agente de desarrollo, shell, web, apps o configuración personal. Su proceso
no recibe credenciales de Wallet, IMAP o Telegram. La aplicación entrega
imágenes y texto completo extraído con `pdftotext`; rechaza PDFs sin texto o
texto superior a 200,000 caracteres, sin truncar movimientos silenciosamente.
Los PDF escaneados requieren OCR previo; eso es una limitación de esta versión.

Las conversaciones nuevas guardan hasta cuatro turnos completos de contexto
compartido bajo `data/bot/ai-conversations/`, con permisos 0600. Claude conserva
su propia identidad; Codex recibe contexto acotado y usa sesiones efímeras.
Un cambio de proveedor entrega ese contexto al otro sin compartir IDs.
Conversaciones antiguas de Claude no pueden recuperar su historial a través
de este puente; usar `/reset` al adoptar la nueva versión. Las propuestas
pendientes se conservan independientemente. El modelo debe preguntar si falta
contexto anterior. No se modifica la confirmación ni el escritor de Wallet.

## Preparación del LXC

Instalar Codex CLI (versión validada: 0.161.0) y `poppler-utils`.
Autenticar como `bbw`, HOME `/var/lib/bbw`, con `codex login --device-auth`,
o transferir la caché propia autenticada por SSH privado. `auth.json` es 0600,
`.codex` es 0700; nunca se suben al repo. La autenticación es ChatGPT, no API.
Codex refresca la caché local. Los límites de cuenta siguen aplicando.

Referencias oficiales:
- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/auth
- https://learn.chatgpt.com/docs/models
- https://learn.chatgpt.com/docs/config-file/config-reference

## Reversión

Antes de desplegar, respaldar `src`, `dist`, `config`, `scripts` y docs.
Para regresar de proveedor, `/ai claude` basta si su suscripción funciona.
Para volver al código anterior: detener `bbw-bot`, restaurar el archivo privado
`/opt/bbw/change-backups/ai-20261007/code-before.tar.gz` en `/opt/bbw`, y arrancar
`bbw-bot`. El respaldo no reemplaza `data` ni secretos. Los archivos nuevos de
IA quedan inactivos con el código anterior. No ejecutar provision-lxc.sh sobre
producción para esta actualización.

## Registro de despliegue — 2026-10-07

Rama `codex/ai-provider-fallback`. Implementación inicial `a766da7`, seguida
por registro de uso de tokens y cierre del despliegue. Se desplegó con el
script soportado por Proxmox, compilando en LXC 200. Bot activo y `/ai`
confirmado en el menú real de Telegram mediante `getMyCommands`.
Modo persistente inicial: **codex**, por la suscripción de Claude desactivada.

Validación: 591 pruebas locales pasan, compilación local y remota exitosas.
En el LXC, login ChatGPT confirmado como `bbw`; Luna devolvió MODEL_OK y
extrajo correctamente dos ejemplos sintéticos (marketing y compra de
$150.50). Sol respondió y pasó una extracción de texto de PDF sintético
mediante `pdftotext`. No se escribió ningún movimiento ni se enviaron
mensajes de prueba a usuarios. Los tokens de Codex ahora quedan en el log
`[ai]`, sin prompts ni credenciales. La prueba mínima de PDF reportó 5,817
tokens de entrada y 7 de salida: el CLI tiene overhead incluso con
instrucciones reducidas; no se promete consumo equivalente a una API directa.

**Bloqueo independiente:** iCloud devuelve `AUTHENTICATIONFAILED` al
conectar por IMAP. La corrida del 6 de octubre falló antes de invocar IA.
El usuario confirmó un cambio de cuenta y actualizará `ICLOUD_EMAIL` y
`ICLOUD_APP_PASSWORD` en `/opt/bbw/.env.local`. No se modificaron esos
secretos. Falta validar IMAP y una corrida de extracción real después de
esa actualización; no se afirma que el procesamiento diario ya esté sano.
Los timers siguen habilitados con sus horarios existentes.

La revisión exacta del código desplegado se registra en
`/opt/bbw/data/deployments/ai-20261007.json`; no contiene secretos.
