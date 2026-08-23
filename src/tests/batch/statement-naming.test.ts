import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { fileURLToPath } from "url";

import {
  accountSlug,
  bankProfileFileName,
  canonicalFileName,
  ledgerFileName,
  mergeRegistry,
  migrationPlan,
  parseStatementFile,
  slugCollisions,
  statementPdfName,
  type RegistrySeed,
} from "../../statements/naming.js";
import type { Registry } from "../../statements/registry.js";

const SEED_PATH = fileURLToPath(new URL("../../../config/statements-registry.seed.json", import.meta.url));
const seed = JSON.parse(fs.readFileSync(SEED_PATH, "utf8")) as RegistrySeed;

/** What data/statements really holds on the container right now. */
const REAL_LEDGERS = ["ledger-mifel-2026-07.json", "ledger-meli-2026-07.json", "ledger-klar-2026-07.json"];

// ── The canonical slug ───────────────────────────────────────────────────────

test("an account name becomes one lowercase ASCII slug", () => {
  assert.equal(accountSlug("Platinum Credit Card"), "platinum-credit-card");
  assert.equal(accountSlug("MIFEL"), "mifel");
  assert.equal(accountSlug("Mercado pago"), "mercado-pago");
});

test("an accent never reaches the filesystem", () => {
  // macOS (APFS) hands back decomposed NFD names while the Linux container
  // stores whatever bytes it was given, usually NFC. A filename containing "é"
  // is two different byte strings across those two machines, so existsSync on
  // one silently misses a file the other wrote. ASCII has no such ambiguity.
  assert.equal(accountSlug("Banorte débito"), "banorte-debito");
  assert.equal(accountSlug("Nu crédito"), "nu-credito");
  assert.equal(accountSlug("NuBank Débito"), "nubank-debito");
  for (const account of Object.keys(seed)) {
    assert.match(accountSlug(account), /^[a-z0-9-]+$/, `"${account}" produced a non-ASCII slug`);
  }
});

test("the accented and unaccented spellings of one account are one slug", () => {
  assert.equal(accountSlug("Banorte débito"), accountSlug("Banorte debito"));
  assert.equal(accountSlug("Banorte  DÉBITO "), accountSlug("banorte-debito"));
});

test("slugging an already canonical slug changes nothing", () => {
  // migrationPlan re-slugs the slug that is already inside a filename, so a
  // second run of the migration must be a no-op rather than a second rename.
  for (const account of Object.keys(seed)) {
    const slug = accountSlug(account);
    assert.equal(accountSlug(slug), slug);
  }
});

// ── The derived names ────────────────────────────────────────────────────────

test("the PDF, the ledger and the profile of one account agree on one slug", () => {
  // The real bug: filing.ts stripped accents, ledgers.ts did not, and
  // reconcile-statement.ts copied the ledgers.ts version. "Banorte débito" got
  // a PDF at banorte-debito-*.pdf, a ledger at ledger-banorte-débito-*.json and
  // a profile looked for at banorte-débito.md — three shelves, one account, and
  // a coverage check that could not see the statement it had just filed.
  const slug = accountSlug("Banorte débito");
  assert.equal(statementPdfName("Banorte débito", "2026-07"), `${slug}-2026-07.pdf`);
  assert.equal(ledgerFileName("Banorte débito", "2026-07"), `ledger-${slug}-2026-07.json`);
  assert.equal(bankProfileFileName("Banorte débito"), `${slug}.md`);
});

test("the derived names carry the month and the right extension", () => {
  assert.equal(statementPdfName("Meli", "2026-07"), "meli-2026-07.pdf");
  assert.equal(statementPdfName("Meli", "2026-07", ".PDF"), "meli-2026-07.PDF");
  assert.equal(ledgerFileName("Nu crédito", "2026-06"), "ledger-nu-credito-2026-06.json");
  assert.equal(bankProfileFileName("Mercado pago"), "mercado-pago.md");
});

test("no two accounts in the registry fold onto the same slug", () => {
  // Stripping accents merges spellings on purpose; merging two genuinely
  // distinct accounts would show up only as one statement overwriting another.
  assert.deepEqual(slugCollisions(Object.keys(seed)), {});
  // And the check itself has to be able to see one when it happens.
  assert.deepEqual(
    slugCollisions(["Banorte débito", "Banorte debito"]),
    { "banorte-debito": ["Banorte débito", "Banorte debito"] },
  );
});

// ── Reading what is already on disk ──────────────────────────────────────────

test("each kind of statement file is recognised for what it is", () => {
  assert.equal(parseStatementFile("ledger-meli-2026-07.json").kind, "ledger");
  assert.equal(parseStatementFile("meli-2026-07.pdf").kind, "statement");
  assert.equal(parseStatementFile("meli.md").kind, "profile");
  assert.equal(parseStatementFile("_sin-identificar-20267-deadbeef.pdf").kind, "provisional");
  assert.equal(parseStatementFile("registry.json").kind, "unknown");
  assert.equal(parseStatementFile("arrivals.jsonl").kind, "unknown");
});

test("the account and month are read back out of a filename", () => {
  const parsed = parseStatementFile("ledger-banorte-débito-2026-07.json");
  assert.equal(parsed.slug, "banorte-débito");
  assert.equal(parsed.month, "2026-07");
});

// ── The migration ────────────────────────────────────────────────────────────

test("the ledgers actually on disk need no renaming", () => {
  // MIFEL, Meli and Klar have no accents, so the switchover to the canonical
  // convention moves nothing that exists today. That is the whole point of
  // running the plan before touching the container.
  const plan = migrationPlan(REAL_LEDGERS);
  assert.deepEqual(plan.renames, []);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.unchanged, REAL_LEDGERS);
  assert.deepEqual(plan.unrecognised, []);
});

test("an accented file is renamed to its ASCII name", () => {
  const plan = migrationPlan([
    "ledger-banorte-débito-2026-07.json",
    "banorte-débito-2026-07.pdf",
    "nu-crédito.md",
  ]);
  assert.deepEqual(plan.renames, [
    { from: "ledger-banorte-débito-2026-07.json", to: "ledger-banorte-debito-2026-07.json" },
    { from: "banorte-débito-2026-07.pdf", to: "banorte-debito-2026-07.pdf" },
    { from: "nu-crédito.md", to: "nu-credito.md" },
  ]);
  assert.deepEqual(plan.unchanged, []);
});

test("a second run of the migration moves nothing", () => {
  // Idempotence is what makes it safe to re-run after a partial failure.
  const once = migrationPlan(["ledger-banorte-débito-2026-07.json"]);
  const after = once.renames.map((r) => r.to);
  const twice = migrationPlan(after);
  assert.deepEqual(twice.renames, []);
  assert.deepEqual(twice.unchanged, after);
});

test("a rename onto an existing file is a conflict, never a rename", () => {
  // Both spellings of one account already have a ledger — one written on the
  // accent-stripping path, one on the other. Renaming would silently destroy
  // whichever extraction was there first, so this needs a human.
  const plan = migrationPlan([
    "ledger-banorte-débito-2026-07.json",
    "ledger-banorte-debito-2026-07.json",
  ]);
  assert.deepEqual(plan.renames, []);
  assert.deepEqual(plan.conflicts, [
    { from: "ledger-banorte-débito-2026-07.json", to: "ledger-banorte-debito-2026-07.json" },
  ]);
  assert.deepEqual(plan.unchanged, ["ledger-banorte-debito-2026-07.json"]);
});

test("two differently spelled files claiming one canonical name conflict", () => {
  // Neither target exists yet, so only tracking what is already present would
  // have happily planned both renames and lost one of the two files.
  const plan = migrationPlan(["Banorte Débito-2026-07.pdf", "banorte-débito-2026-07.pdf"]);
  assert.equal(plan.renames.length, 1);
  assert.deepEqual(plan.conflicts, [
    { from: "banorte-débito-2026-07.pdf", to: "banorte-debito-2026-07.pdf" },
  ]);
});

test("a corrected statement keeps its version suffix", () => {
  // resolveCollision() files a DIFFERENT document for the same month as "-v2"
  // beside the original. Dropping the suffix would rename the correction on
  // top of the statement that was already reconciled against.
  assert.equal(canonicalFileName("banorte-débito-2026-07-v2.pdf"), "banorte-debito-2026-07-v2.pdf");
  const plan = migrationPlan(["banorte-débito-2026-07.pdf", "banorte-débito-2026-07-v2.pdf"]);
  assert.deepEqual(plan.renames, [
    { from: "banorte-débito-2026-07.pdf", to: "banorte-debito-2026-07.pdf" },
    { from: "banorte-débito-2026-07-v2.pdf", to: "banorte-debito-2026-07-v2.pdf" },
  ]);
});

test("a provisional name keeps its leading underscore", () => {
  // The underscore is what sorts an unidentified arrival apart and keeps it out
  // of the coverage count; slugging the name would eat it.
  assert.equal(
    canonicalFileName("_sin-identificar-20267-deadbeef.pdf"),
    "_sin-identificar-20267-deadbeef.pdf",
  );
  const plan = migrationPlan(["_sin-identificar-20267-deadbeef.pdf"]);
  assert.deepEqual(plan.renames, []);
  assert.deepEqual(plan.unchanged, ["_sin-identificar-20267-deadbeef.pdf"]);
});

test("a file this module does not name is reported, not silently skipped", () => {
  // registry.json and arrivals.jsonl live in the same directory. A migration
  // that quietly ignored them would also quietly ignore anything it failed to
  // parse, which is exactly the file worth looking at by hand.
  const plan = migrationPlan(["registry.json", "arrivals.jsonl", "ledger-meli-2026-07.json"]);
  assert.deepEqual(plan.unrecognised, ["registry.json", "arrivals.jsonl"]);
  assert.deepEqual(plan.unchanged, ["ledger-meli-2026-07.json"]);
});

test("an empty directory produces an empty plan, not a crash", () => {
  assert.deepEqual(migrationPlan([]), { renames: [], conflicts: [], unchanged: [], unrecognised: [] });
});

// ── The versioned seed ───────────────────────────────────────────────────────

test("the seed carries all fourteen accounts and their hand-verified cut days", () => {
  // data/ is gitignored, so these fourteen cut days existed on exactly one
  // disk. A rebuilt container came up with an empty registry, chased nothing,
  // and said nothing about it.
  assert.deepEqual(
    Object.fromEntries(Object.entries(seed).map(([a, e]) => [a, e.cutDay])),
    {
      "Costco": 8,
      "American Express": 13,
      "Platinum Credit Card": 6,
      "Banorte": 10,
      "Banorte débito": 2,
      "Bancomer": 16,
      "Nu crédito": 24,
      "NuBank Débito": 28,
      "Mercado pago": 28,
      "MIFEL": 28,
      "DolarApp": 28,
      "Klar": 28,
      "Meli": 21,
      "FinSus": 28,
    },
  );
});

test("every seed entry is configuration only, with no reconciliation state", () => {
  // Checking `received` into git would re-assert months as reconciled on every
  // deploy and stop the batch from ever chasing them again.
  for (const [account, e] of Object.entries(seed)) {
    assert.ok(!("received" in e), `${account} carries a received list`);
    assert.equal(e.lastReceived, null, `${account} carries a lastReceived`);
    assert.equal(e.startMonth, "2026-05", `${account} is missing the lookback floor`);
    assert.ok(e.source === "manual" || e.source === "email", `${account} has an unknown source`);
    assert.ok(e.cutDay >= 1 && e.cutDay <= 28, `${account} has a cut day outside 1-28`);
  }
});

// ── Merging the seed with the live registry ──────────────────────────────────

const LIVE: Registry = {
  "MIFEL": { cutDay: 28, source: "manual", lastReceived: "2026-07", startMonth: "2026-05", received: ["2026-07"] },
  "Meli": { cutDay: 21, source: "manual", lastReceived: "2026-07", startMonth: "2026-05", received: ["2026-07"] },
};

test("the live file keeps what has actually been reconciled", () => {
  const merged = mergeRegistry(seed, LIVE);
  assert.deepEqual(merged["MIFEL"].received, ["2026-07"]);
  assert.equal(merged["MIFEL"].lastReceived, "2026-07");
  assert.deepEqual(merged["Meli"].received, ["2026-07"]);
});

test("an account never reconciled comes out owing everything, not nothing", () => {
  const merged = mergeRegistry(seed, LIVE);
  assert.equal(merged["Klar"].lastReceived, null);
  assert.equal(merged["Klar"].received, undefined);
  // `receivedMonths()` falls back to lastReceived for a pre-`received`
  // registry; writing an empty array here would erase that fallback.
  assert.ok(!("received" in merged["Klar"]));
});

test("the seed wins on configuration, the live file cannot override it", () => {
  // A cut day edited by hand on the container, or corrupted there, is exactly
  // what version control is supposed to correct on the next deploy.
  const drifted: Registry = { "Meli": { cutDay: 1, source: "email", lastReceived: "2026-07", received: ["2026-07"] } };
  const merged = mergeRegistry(seed, drifted);
  assert.equal(merged["Meli"].cutDay, 21);
  assert.equal(merged["Meli"].source, "manual");
  assert.equal(merged["Meli"].startMonth, "2026-05");
  assert.deepEqual(merged["Meli"].received, ["2026-07"]);
});

test("an account that exists only on the container is kept, not dropped", () => {
  // Dropping it would un-chase an account someone added live, and the registry
  // is the only thing that decides a missing statement is ever mentioned.
  const merged = mergeRegistry(seed, {
    ...LIVE,
    "Hey Banco": { cutDay: 15, source: "manual", lastReceived: "2026-06", received: ["2026-06"] },
  });
  assert.equal(Object.keys(merged).length, Object.keys(seed).length + 1);
  assert.deepEqual(merged["Hey Banco"], { cutDay: 15, source: "manual", lastReceived: "2026-06", received: ["2026-06"] });
});

test("merging onto an empty registry bootstraps a fresh container", () => {
  const merged = mergeRegistry(seed, {});
  assert.deepEqual(Object.keys(merged), Object.keys(seed));
  for (const e of Object.values(merged)) {
    assert.equal(e.lastReceived, null);
    assert.equal(e.received, undefined);
  }
});

test("merging does not mutate either input", () => {
  // The live registry is written straight back out by saveRegistry(); a merge
  // that aliased its arrays could append a month to the file it just read.
  const live: Registry = { "Meli": { cutDay: 21, source: "manual", lastReceived: "2026-07", received: ["2026-07"] } };
  const merged = mergeRegistry(seed, live);
  merged["Meli"].received!.push("2026-08");
  merged["Meli"].cutDay = 99;
  assert.deepEqual(live["Meli"].received, ["2026-07"]);
  assert.equal(live["Meli"].cutDay, 21);
  assert.equal(seed["Meli"].cutDay, 21);
});
