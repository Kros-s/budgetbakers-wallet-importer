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
  "*Estados de cuenta*",
  "Mándame el PDF como archivo y lo proceso. No hace falta comando.",
].join("\n");
