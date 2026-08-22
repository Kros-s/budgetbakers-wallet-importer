import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatReconcileSummary, needsAttention, parseReconcileOutput, reconcileCommand,
} from "../../bot/statement-flow.js";

// Verbatim from the real dry run against the Meli July statement.
const REAL_OUTPUT = `
── reconcile-statement ── Meli · 2026-07 · dry · model=claude-sonnet-5

Extraídos 7 movimiento(s) (Claude declara 7).
Ledger del estado: /opt/bbw/data/statements/ledger-meli-2026-07.json
Periodo del estado: 2026-06-22 → 2026-07-21

✅ Ya en Wallet: 0
➕ Faltantes (se agregarían): 7
   2026-06-22 $-10.00 No identificado (Others)
   2026-06-25 $-10.00 No identificado (Others)
   2026-07-01 $-197.08 MERCADO PAGO (Others)
   2026-07-01 $3268.48 Mercado Pago (Transfer, withdraw)
   2026-07-09 $-10.00 No identificado (Others)
   2026-07-11 $-50.00 No identificado (Others)
   2026-07-18 $-50.00 No identificado (Others)
⚠️ Ambiguos (revisar a mano): 0
👀 Solo en Wallet (no aparecen en el estado): 0

Dry — nada escrito en Wallet. Repite con --write para agregar los 7 faltantes.
`;

test("the real dry run is read correctly", () => {
  const s = parseReconcileOutput(REAL_OUTPUT);
  assert.equal(s.period, "2026-06-22 → 2026-07-21");
  assert.equal(s.matched, 0);
  assert.equal(s.missing, 7);
  assert.equal(s.ambiguous, 0);
  assert.equal(s.walletOnly, 0);
  assert.equal(s.missingLines.length, 7);
  assert.equal(s.missingLines[0], "2026-06-22 $-10.00 No identificado (Others)");
});

test("the ambiguous tally is not mistaken for a warning", () => {
  // Its heading carries ⚠️ even when the count is zero.
  assert.deepEqual(parseReconcileOutput(REAL_OUTPUT).warnings, []);
  assert.equal(needsAttention(parseReconcileOutput(REAL_OUTPUT)), false);
});

test("a charge mismatch is surfaced and blocks the quiet path", () => {
  const out = REAL_OUTPUT.replace(
    "✅ Ya en Wallet: 0",
    "⚠️ Cuadre contra el estado: faltan $20.00: el estado declara $327.08 en cargos y se extrajeron $307.08 — hay movimientos sin capturar.\n✅ Ya en Wallet: 0"
  );
  const s = parseReconcileOutput(out);
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /faltan \$20\.00/);
  assert.equal(needsAttention(s), true);
});

test("ambiguous rows demand a human even with no warning", () => {
  const out = REAL_OUTPUT.replace("⚠️ Ambiguos (revisar a mano): 0", "⚠️ Ambiguos (revisar a mano): 2");
  assert.equal(needsAttention(parseReconcileOutput(out)), true);
});

test("the summary names the account, the period and the figures", () => {
  const msg = formatReconcileSummary("Meli", "2026-07", parseReconcileOutput(REAL_OUTPUT));
  assert.match(msg, /\*Meli · 2026-07\*/);
  assert.match(msg, /2026-06-22 → 2026-07-21/);
  assert.match(msg, /➕ Faltantes: 7/);
  assert.match(msg, /MERCADO PAGO/);
});

test("a long statement says how many rows it did not list", () => {
  // A cap that reads as the whole list is how a month goes missing unnoticed.
  const many = Array.from({ length: 40 }, (_, i) => `   2026-07-01 $-${i}.00 COMERCIO ${i} (Others)`);
  const out = REAL_OUTPUT.replace(/(➕ Faltantes \(se agregarían\): 7)[\s\S]*?(⚠️ Ambiguos)/, `$1\n${many.join("\n")}\n$2`);
  const msg = formatReconcileSummary("Costco", "2026-07", parseReconcileOutput(out));
  assert.match(msg, /…y 28 más\./);
});

test("the built CLI is preferred and tsx is the fallback", () => {
  const built = reconcileCommand({ pdf: "/x.pdf", account: "Meli", month: "2026-07" }, "/dist", () => true);
  assert.equal(built.command, process.execPath);
  assert.ok(built.args[0].endsWith("/dist/cli/reconcile-statement.js"));

  const dev = reconcileCommand({ pdf: "/x.pdf", account: "Meli", month: "2026-07" }, "/dist", () => false);
  assert.equal(dev.command, "npx");
  assert.equal(dev.args[0], "tsx");
});

test("the write pass replays the ledger instead of extracting again", () => {
  const inv = reconcileCommand(
    { pdf: "/x.pdf", account: "Meli", month: "2026-07", write: true, fromLedger: true }, "/dist", () => true
  );
  assert.ok(inv.args.includes("--write"));
  assert.ok(inv.args.includes("--from-ledger"));
});
