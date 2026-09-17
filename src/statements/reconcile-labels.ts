/**
 * @file statements/reconcile-labels.ts
 * @description The headings the reconciler prints and the bot reads back.
 *
 * The bot learns what a statement run found by parsing the reconciler's output.
 * The reconciler renamed "➕ Faltantes (se agregarían)" to "➕ Faltan en Wallet"
 * — deliberately, with a comment saying why — and the parser went on looking for
 * the old words. From then on every statement sent over Telegram reported
 * "Faltantes: 0" and listed nothing: on 2026-09-17 an Amex statement missing 18
 * movements and a Mercado Pago one missing 46 both read as complete. The test
 * kept passing, because its "verbatim real output" was a copy from before the
 * rename.
 *
 * One definition, used by both ends, so the two cannot drift apart again.
 */

export const LABEL_PERIOD = "Periodo del estado:";
export const LABEL_MATCHED = "✅ Ya en Wallet:";
export const LABEL_MISSING = "➕ Faltan en Wallet:";
export const LABEL_AMBIGUOUS = "⚠️ Ambiguos (revisar a mano):";
export const LABEL_WALLET_ONLY = "👀 Solo en Wallet (no aparecen en el estado):";

/** The heading before the rename, still accepted when reading old output. */
export const LEGACY_LABEL_MISSING = "➕ Faltantes (se agregarían):";
