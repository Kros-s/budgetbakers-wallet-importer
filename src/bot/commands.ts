/**
 * @file bot/commands.ts
 * @description The command list Telegram shows in the "/" menu, and the text
 * behind /help.
 *
 * Command names are English; everything the user reads is Spanish.
 */

export interface BotCommandSpec {
  command: string;
  description: string;
}

/** Registered with Telegram so they appear in the "/" menu. */
export const BOT_COMMANDS: BotCommandSpec[] = [
  { command: "pending", description: "Ver pendientes · /pending 35 para el detalle" },
  { command: "remind", description: "Reenviar las más importantes (/remind 5)" },
  { command: "next", description: "Modo guiado: una pregunta a la vez (beta)" },
  { command: "stop", description: "Salir del modo guiado" },
  { command: "cancel", description: "Descartar la propuesta pendiente" },
  { command: "reset", description: "Empezar una conversación nueva" },
  { command: "audit", description: "Cerrar pendientes que ya están en Wallet" },
  { command: "ignore", description: "Ignorar correos por asunto (/ignore texto)" },
  { command: "help", description: "Cómo usar el bot" },
];

export const HELP_TEXT = [
  "🤖 *Wallet Importer*",
  "",
  "*Registrar un gasto*",
  "Escríbelo y ya: `50 tacos efectivo`, `1200 gasolina con la Amex`.",
  "También puedes mandar una foto de un ticket, un PDF de estado de cuenta, o una nota de voz.",
  "",
  "*Aclaraciones pendientes*",
  "Cuando el batch nocturno no puede resolver un correo, te pregunta. Tres formas de contestar:",
  "",
  "• `/pending` — el índice completo, mayores primero.\n• `/pending 35` — el detalle de una: la pregunta entera y el fragmento del correo.",
  "• `#35 salió de Banorte débito` — por handle, sin buscar el mensaje.",
  "• Responder al mensaje de la pregunta, como siempre.",
  "",
  "Las tres aceptan foto, PDF o nota de voz: responde con la imagen del ticket, o mándala con `#35` al inicio del caption.",
  "",
  "Varias de un jalón:",
  "```",
  "#12 Groceries",
  "#19 es la Amex Gold",
  "#23 Fuel",
  "```",
  "",
  "*Otros*",
  "• `/remind 5` — reenvía las más importantes para tenerlas a mano.",
  "• `/next` — modo guiado (beta): una pregunta a la vez, contestas con texto normal. La ventana dura 2 minutos; después de eso lo que escribas cuenta como mensaje nuevo. `/stop` para salir.",
  "• `/cancel` — descarta la propuesta que esté esperando confirmación.",
  "• `/reset` — arranca conversación nueva si el bot se atoró.",
  "",
  "*Conciliar la cola*",
  "`/audit` revisa cada pendiente contra Wallet y cierra las que ya están registradas. Las dudosas te las lista sin tocarlas.",
  "",
  "*Ignorar avisos que no son movimientos*",
  "`/ignore cambio de politica de reinversion` — deja de preguntarte por esos correos y quita de la cola los que ya coincidan.",
  "`/ignore` sin texto lista las reglas activas.",
  "El filtro mira remitente y asunto, así que puedes ignorar un tipo de aviso sin ignorar al banco entero.",
  "",
  "*Estados de cuenta*",
  "Mándame el PDF como archivo y lo proceso. No hace falta comando.",
].join("\n");
