import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatReconcileSummary, needsAttention, parseReconcileOutput, reconcileCommand,
} from "../../bot/statement-flow.js";
import {
  LABEL_AMBIGUOUS, LABEL_MATCHED, LABEL_MISSING, LABEL_PERIOD, LABEL_WALLET_ONLY,
} from "../../statements/reconcile-labels.js";

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

test("statement jobs run one at a time, in order", async () => {
  // Ten PDFs at once would start ten Claude extractions on a two-core box, and
  // topping the usage limit mid-run burns the retries the pipeline needs.
  const { SerialQueue } = await import("../../bot/statement-flow.js");
  const q = new SerialQueue();
  const order: string[] = [];
  let running = 0;
  let peak = 0;

  const job = (name: string, ms: number) => async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, ms));
    order.push(name);
    running -= 1;
  };

  await Promise.all([q.run(job("a", 20)), q.run(job("b", 1)), q.run(job("c", 1))]);
  assert.equal(peak, 1, "nunca dos a la vez");
  assert.deepEqual(order, ["a", "b", "c"], "en el orden en que llegaron");
});

test("one failing job does not strand the batch behind it", async () => {
  // A single unreadable PDF must not take the other nine with it.
  const { SerialQueue } = await import("../../bot/statement-flow.js");
  const q = new SerialQueue();
  const boom = q.run(async () => { throw new Error("PDF ilegible"); });
  const after = q.run(async () => "listo");
  await assert.rejects(boom, /ilegible/);
  assert.equal(await after, "listo");
});

test("the queue reports how many are waiting", async () => {
  const { SerialQueue } = await import("../../bot/statement-flow.js");
  const q = new SerialQueue();
  assert.equal(q.pending, 0);
  const a = q.run(() => new Promise((r) => setTimeout(r, 10)));
  const b = q.run(async () => {});
  assert.equal(q.pending, 2);
  await Promise.all([a, b]);
  assert.equal(q.pending, 0);
});


// Verbatim from the real dry run of Banorte débito, agosto 2026 (2026-09-17),
// after the reconciler's heading became "➕ Faltan en Wallet". The fixture above
// predates that rename, which is how the parser kept passing while every
// Telegram summary reported zero missing movements.
const CURRENT_OUTPUT = `
── reconcile-statement ── Banorte débito · 2026-08 · dry · model=claude-sonnet-5

Extraídos 26 movimiento(s) (Claude declara 26).
Ledger del estado: /Users/mmayen/Repos/budgetbakers-wallet-importer/data/statements/ledger-banorte-debito-2026-08.json
ℹ️ sobran $17001.27: se extrajeron $717044.26 en cargos y el estado declara $700042.99 — puede haber filas duplicadas o informativas. El saldo declarado sí cuadra al centavo, así que es diferencia de definición: el estado suma sus cargos aparte de comisiones e intereses.
Periodo del estado: 2026-08-01 → 2026-08-31
⚠️ el estado cierra el día 31 y el registro dice corte 2 — ¿es el PDF de esta cuenta?

✅ Ya en Wallet: 21
➕ Faltan en Wallet: 5
   2026-08-01 $-5300.00 Marlene Miriam Vazquez Pen (Child Support)
   2026-08-03 $62891.91 MARCO ANTONIO MAYEN HERNANDEZ (Transfer, withdraw)
   2026-08-14 $50187.53 MARCO ANTONIO MAYEN HERNANDEZ (Transfer, withdraw)
   2026-08-15 $-10000.00 CetesDirecto (Financial investments)
   2026-08-29 $50255.18 MARCO ANTONIO MAYEN HERNANDEZ (Transfer, withdraw)
⚠️ Ambiguos (revisar a mano): 0
📅 3 de los faltantes caen al filo del periodo — puede que el banco los refleje en el estado del mes vecino. No son anomalía; se resuelven al cruzar el mes.
🧮 1 movimiento(s) que el estado desglosa y Wallet tiene netos — ya registrados:
   2026-08-03 $-300000.00 en Wallet = $-299.00 Banorte + $-281109.99 Banorte + $-16702.27 Banorte + $-1888.74 Banorte
👀 Solo en Wallet (no aparecen en el estado): 5
   2026-09-02 $545997.83 Cetes
   2026-09-03 $-80000 Banorte
   2026-09-03 $500000 [Claude 2026-09-03]
   2026-09-03 $-952200 Tesla
   2026-09-04 $-58753.01 [Claude 2026-09-04]
⏸️ 3 en espera del cruce del mes:
   2026-08-03 $62891.91 MARCO ANTONIO MAYEN HERNANDEZ — categoría de traspaso
   2026-08-14 $50187.53 MARCO ANTONIO MAYEN HERNANDEZ — categoría de traspaso
   2026-08-29 $50255.18 MARCO ANTONIO MAYEN HERNANDEZ — categoría de traspaso

✍️ Por escribir: 2

Dry — nada escrito en Wallet. Con --write se agregarían 2; 3 espera(n) al cruce.
`;

test("the current reconciler output is read — the zero-missing bug", () => {
  const s = parseReconcileOutput(CURRENT_OUTPUT);
  assert.equal(s.period, "2026-08-01 → 2026-08-31");
  assert.equal(s.matched, 21);
  assert.equal(s.missing, 5);
  assert.equal(s.missingLines.length, 5);
  assert.match(s.missingLines[0], /^2026-08-01 \$-5300\.00 Marlene/);
  assert.equal(s.walletOnly, 5);
});

test("the wrong-cut warning reaches the user", () => {
  const s = parseReconcileOutput(CURRENT_OUTPUT);
  assert.ok(s.warnings.some((w) => /registro dice corte 2/.test(w)));
  assert.equal(needsAttention(s), true);
});

test("output written with the shared labels is always readable", () => {
  // The structural guarantee: whatever the labels say, both ends use them.
  const out = [
    `${LABEL_PERIOD} 2026-01-01 → 2026-01-31`,
    `${LABEL_MATCHED} 3`,
    `${LABEL_MISSING} 2`,
    "   2026-01-05 $-10.00 A (Others)",
    "   2026-01-06 $-20.00 B (Others)",
    `${LABEL_AMBIGUOUS} 1`,
    `${LABEL_WALLET_ONLY} 4`,
  ].join("\n");
  const s = parseReconcileOutput(out);
  assert.deepEqual([s.matched, s.missing, s.missingLines.length, s.ambiguous, s.walletOnly], [3, 2, 2, 1, 4]);
});
