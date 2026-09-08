/**
 * The pending-question queue, from a terminal.
 *
 *   npx tsx src/cli/clarifications.ts list
 *   npx tsx src/cli/clarifications.ts audit [--close]
 *   npx tsx src/cli/clarifications.ts close 24,44 --reason "ya estaba en Wallet"
 *
 * `/audit` already reconciles the queue against Wallet, but only from a chat.
 * A queue that has grown past what a phone screen can work through needs a
 * surface that is not a chat — and an operator looking at 36 questions should
 * not have to type them one at a time into Telegram to clear the ones that were
 * never questions.
 *
 * Same functions the Telegram command calls: a question must not be resolved in
 * chat and still open in a terminal.
 */
import { loadEnvLocal } from "../env.js";
import { buildCouchClient, buildLookupMapsFromData, fetchLookupData } from "../couch.js";
import { loadDirectCredentials } from "../direct-auth.js";
import { ensureShortIds, takeByShortId } from "../webhook/clarification-store.js";
import { findExistingByAmount } from "../webhook/wallet-context.js";
import { formatVerdict, judge } from "../webhook/pending-audit.js";
import { parseIdSpec, questionAmountCents, sortByImportance } from "../bot/pending-view.js";
import { movementDate } from "../bot/email-facts.js";

function stripMarkdown(text: string): string {
  return text.replace(/```/g, "").replace(/[*_]/g, "");
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("es-MX", { minimumFractionDigits: 2 })}`;
}

function list(): void {
  const items = sortByImportance(ensureShortIds());
  if (items.length === 0) {
    console.log("✅ No hay aclaraciones pendientes.");
    return;
  }
  console.log(`📮 ${items.length} aclaración(es) pendientes — por monto, luego por antigüedad\n`);
  for (const { entry } of items) {
    const cents = questionAmountCents(entry);
    const when = new Date(entry.createdAt).toISOString().slice(0, 10);
    console.log(
      `#${String(entry.shortId).padEnd(4)} ${when}  ${(cents ? money(cents) : "—").padStart(14)}  ${entry.emailSubject.slice(0, 44)}`
    );
    console.log(`      ${entry.claudeQuestion.replace(/\s+/g, " ").slice(0, 150)}`);
  }
}

/**
 * The same reconciliation `/audit` performs, headless.
 *
 * Dry by default. Closing a question is not reversible from here — the movement
 * it was guarding stops being asked about — so it stays a separate decision,
 * the way writing records does everywhere else in this codebase.
 */
async function audit(close: boolean): Promise<void> {
  loadEnvLocal();
  const credentials = loadDirectCredentials();
  const couch = buildCouchClient(credentials.replication);
  const lookup = buildLookupMapsFromData(await fetchLookupData(couch));

  const namesById: Record<string, string> = {};
  for (const [name, id] of Object.entries(lookup.accounts)) namesById[id] = name;

  const items = ensureShortIds();
  console.log(`🔍 Revisando ${items.length} pendientes contra Wallet…\n`);

  const resolved: string[] = [];
  const doubtful: string[] = [];
  for (const { entry } of items) {
    const cents = questionAmountCents(entry);
    if (!cents) continue;
    const matches = await findExistingByAmount(couch, [cents], namesById);
    if (matches.length === 0) continue;
    const verdict = judge({
      shortId: entry.shortId!,
      amountCents: cents,
      movementDate: movementDate(entry.emailText),
      matches,
    });
    if (verdict.resolved) {
      if (close) takeByShortId(entry.shortId!, "ya estaba en Wallet");
      resolved.push(stripMarkdown(formatVerdict(verdict)));
    } else {
      doubtful.push(stripMarkdown(formatVerdict(verdict)));
    }
  }

  if (resolved.length === 0 && doubtful.length === 0) {
    console.log("Nada que conciliar: ninguna pendiente coincide con un registro existente.");
    return;
  }
  if (resolved.length) {
    console.log(`Ya registradas (${resolved.length})${close ? " — cerradas" : ""}:\n${resolved.join("\n")}\n`);
  }
  if (doubtful.length) {
    // Never closed on a guess: a wrong close hides a real movement for good.
    console.log(`Parecidas, pero NO se cierran (${doubtful.length}):\n${doubtful.join("\n")}\n`);
  }
  if (!close && resolved.length) {
    console.log(`Repite con --close para sacar de la cola las ${resolved.length} ya registradas.`);
  }
}

/**
 * Closes questions by handle, with the reason on the record.
 *
 * For the ones the audit cannot reach: a question naming no amount ("¿a qué
 * cuenta corresponde la terminación ****9748?") has nothing to match on, and is
 * answered by knowledge that lives outside Wallet.
 */
function close(spec: string, reason: string): void {
  const ids = parseIdSpec(spec);
  if (ids.length === 0) throw new Error(`No entendí los identificadores: "${spec}"`);

  for (const id of ids) {
    const entry = takeByShortId(id, reason);
    console.log(
      entry
        ? `✅ #${id} cerrada — ${reason}\n     era: ${entry.claudeQuestion.replace(/\s+/g, " ").slice(0, 110)}`
        : `⚠️ #${id} no estaba en la cola`
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "list";

  if (cmd === "list") return list();
  if (cmd === "audit") return audit(argv.includes("--close"));
  if (cmd === "close") {
    const i = argv.indexOf("--reason");
    const reason = i !== -1 ? argv[i + 1] : undefined;
    if (!argv[1] || !reason) {
      throw new Error(`Uso: clarifications.ts close <id>[,<id>...] --reason "por qué"`);
    }
    return close(argv[1], reason);
  }
  throw new Error(`Comando desconocido: ${cmd}. Usa list | audit | close.`);
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
