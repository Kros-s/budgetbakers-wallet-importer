/**
 * @file webhook/wallet-context.ts
 * @description Puts the movements Wallet already holds in front of the model.
 *
 * Asked "¿este ya está registrado?", the bot could only answer "no tengo acceso
 * a los registros previos" — true, and useless: the answer was one CouchDB
 * query away. Rather than hand the subprocess a tool to go looking (the bot
 * blocks Bash(node*) and the Wallet MCP tools on purpose, and a tool call is a
 * decision the model can get wrong), the candidates are fetched here and
 * pasted into the prompt.
 */

import type { AxiosInstance } from "axios";

import { listRecordsByDateRange } from "../records.js";

export interface ExistingRecord {
  amountCents: number;
  type: number;
  transfer: boolean;
  accountName: string;
  payee: string;
  note: string;
  recordDate: string;
}

/** Amounts a clarification could plausibly be about, in cents. */
export function candidateAmounts(...texts: string[]): number[] {
  const found = new Set<number>();
  for (const text of texts) {
    for (const m of text.matchAll(/(?:\$|MXN|MN)\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*\.\d{2})\s?(?:MXN|MN)/gi)) {
      const raw = (m[1] ?? m[2] ?? "").replace(/,/g, "");
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) found.add(Math.round(n * 100));
    }
  }
  return [...found];
}

/** Wallet records whose amount matches one the text mentions. */
export async function findExistingByAmount(
  couch: AxiosInstance,
  amountsCents: number[],
  accountNamesById: Record<string, string>,
  windowDays = 60,
  now = new Date()
): Promise<ExistingRecord[]> {
  if (amountsCents.length === 0) return [];
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const until = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const wanted = new Set(amountsCents);
  const all = await listRecordsByDateRange(couch, since, until);
  return all
    .filter((r) => wanted.has(Math.abs(Number(r.amount))))
    .map((r) => ({
      amountCents: Math.abs(Number(r.amount)),
      type: Number(r.type),
      transfer: Boolean(r.transfer),
      accountName: accountNamesById[String(r.accountId)] ?? String(r.accountId).slice(9, 17),
      payee: String(r.payee ?? ""),
      note: String(r.note ?? ""),
      recordDate: String(r.recordDate),
    }))
    .sort((a, b) => a.recordDate.localeCompare(b.recordDate));
}

/**
 * The prompt section. Says explicitly when nothing matched — silence would let
 * the model assume the check never ran and hedge exactly as before.
 */
export function formatWalletContext(records: ExistingRecord[], amountsCents: number[]): string {
  if (amountsCents.length === 0) return "";
  const money = (c: number) => `$${(c / 100).toLocaleString("es-MX", { minimumFractionDigits: 2 })}`;
  const looked = amountsCents.map(money).join(", ");
  if (records.length === 0) {
    return `Registros ya existentes en Wallet con esos montos (${looked}), últimos 60 días: NINGUNO.\n` +
      `Es decir: este movimiento NO está registrado todavía.\n\n`;
  }
  const lines = records.map((r) => {
    const kind = r.transfer ? "traspaso" : r.type === 1 ? "gasto" : "ingreso";
    const bits = [r.payee, r.note].filter(Boolean).join(" · ");
    return `- ${r.recordDate.slice(0, 16)} · ${money(r.amountCents)} · ${r.accountName} · ${kind}${bits ? ` · ${bits}` : ""}`;
  });
  return `Registros YA existentes en Wallet con esos montos (${looked}), últimos 60 días:\n${lines.join("\n")}\n` +
    `Si el movimiento del correo es uno de estos, dilo y NO propongas CSV.\n\n`;
}
