/**
 * Statement pipeline, from a terminal session.
 *
 *   npx tsx src/cli/statements.ts status
 *   npx tsx src/cli/statements.ts cross 2026-07
 *   npx tsx src/cli/statements.ts plan 2026-07
 *
 * The same functions the Telegram commands call. Two surfaces, one answer —
 * a month must not mean one thing in chat and another in a terminal.
 */
import { loadEnvLocal } from "../env.js";
import { buildCouchClient, buildLookupMapsFromData, fetchLookupData } from "../couch.js";
import { loadDirectCredentials } from "../direct-auth.js";
import { markReceived, statementStatus } from "../statements/registry.js";
import { formatStatementsTable } from "../bot/statements-view.js";
import { formatCoverage } from "../statements/ledgers.js";
import { countBy, formatPlan, writableRows } from "../statements/apply.js";
import { commitGuardedWrite, formatGuardReport, guardWrite } from "../statements/guarded-write.js";
import { MONTH_SPEC, loadMonth, monthsInSpec } from "../statements/month-runner.js";
import { formatArrivals, unidentifiedArrivals } from "../statements/filing.js";

function stripMarkdown(text: string): string {
  return text.replace(/```/g, "").replace(/[*_]/g, "");
}

async function main(): Promise<void> {
  loadEnvLocal();
  const [cmd, arg] = process.argv.slice(2);

  if (!cmd || cmd === "status") {
    console.log(stripMarkdown(formatStatementsTable(statementStatus())));
    const pend = unidentifiedArrivals();
    if (pend.length) console.log(`\n${pend.length} sin identificar:\n${formatArrivals(pend)}`);
    return;
  }

  if (!MONTH_SPEC.test(arg ?? "")) {
    throw new Error(
      `Uso: statements.ts <status|cross|plan|apply> [YYYY-MM | YYYY-MM..YYYY-MM] [--write]`
    );
  }

  const credentials = loadDirectCredentials();
  const couch = buildCouchClient(credentials.replication);
  const lookup = buildLookupMapsFromData(await fetchLookupData(couch));
  const view = await loadMonth(arg, couch, lookup);

  console.log(stripMarkdown(formatCoverage(view.coverage)));
  console.log(`Ventana consultada en Wallet: ${view.window.from.slice(0, 10)} → ${view.window.to.slice(0, 10)}\n`);

  if (cmd === "apply") {
    const rows = writableRows(view.plan).map((p) => ({ ...p.row, account: p.account }));
    if (rows.length === 0) {
      console.log(stripMarkdown(formatPlan(view.plan)));
      console.log("\nNada por escribir.");
      return;
    }
    // Through the same guard the per-statement path uses: dedup against what
    // Wallet holds and an integrity pass over what is about to be posted.
    const guard = await guardWrite(rows, { lookup, existing: view.records });
    console.log(formatGuardReport(guard));
    if (guard.blocked) {
      console.error("\n⛔ Integridad levantó alerta(s): no se escribe nada.");
      process.exitCode = 1;
      return;
    }
    if (!process.argv.includes("--write")) {
      console.log(`\n${guard.records.length} registro(s) listos. Repite con --write para escribirlos.`);
      return;
    }
    await commitGuardedWrite(guard, { lookup, existing: view.records, couch, userId: credentials.userId });
    console.log(`\n✍️ Escritos ${guard.records.length} registro(s).`);

    // A month whose every row has been written is reconciled, and the registry
    // is where `/statements` reads that from. Until this ran, the table stayed
    // red on months that were finished — the same lie as staying green on one
    // that was not, pointing the other way.
    //
    // An account is only marked where nothing of its own is outstanding: a held
    // leg still needs the counterpart's statement, and a row the converter
    // refused was never written at all.
    const outstanding = new Set<string>();
    for (const p of view.plan.planned) if (p.disposition === "hold") outstanding.add(p.account);
    for (const s of guard.skipped) outstanding.add(s.row.account);
    const marked: string[] = [];
    for (const { account, month } of view.ledgers) {
      if (outstanding.has(account)) continue;
      markReceived(account, month);
      marked.push(`${account} ${month}`);
    }
    console.log(
      marked.length
        ? `✅ Conciliados en el registro: ${marked.length} (${[...outstanding].length} cuenta(s) siguen abiertas: ${[...outstanding].join(", ") || "ninguna"})`
        : `↩️ Ninguna cuenta se marcó conciliada: ${[...outstanding].join(", ")}`
    );
    // One undo per month in the range: every row carries the marker of the
    // month it was extracted under, and `undo` matches that marker exactly.
    for (const m of monthsInSpec(arg)) console.log(`Para revertir: npm run snapshot -- undo ${m}`);
    return;
  }

  if (cmd === "cross" || cmd === "plan") {
    console.log(stripMarkdown(formatPlan(view.plan)));
    if (cmd === "plan") {
      const n = countBy(view.plan);
      console.log(`\nDetalle de lo que se escribiría (${writableRows(view.plan).length}):`);
      for (const p of writableRows(view.plan)) {
        console.log(`   ${p.row.date.slice(0, 10)} ${p.account.padEnd(20)} $${String(p.row.amount).padStart(12)}  ${p.disposition} — ${p.reason}`);
      }
      if (n.hold) console.log(`\n${n.hold} en espera; no se escriben.`);
      console.log(`\nNada se ha escrito. La escritura sigue siendo una decisión aparte.`);
    }
    return;
  }
  throw new Error(`Comando desconocido: ${cmd}`);
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
