import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "filing-test-"));
const originalCwd = process.cwd();
process.chdir(scratch);

const {
  digestOf, fileStatement, provisionalFileName, readArrivals, resolveCollision, statementFileName,
} = await import("../../statements/filing.js");

const bytes = (s: string): Buffer => Buffer.from(s);

beforeEach(() => fs.rmSync(path.join(scratch, "data"), { recursive: true, force: true }));
after(() => { process.chdir(originalCwd); fs.rmSync(scratch, { recursive: true, force: true }); });

test("the name says the account and the month, which is what anyone looks for", () => {
  assert.equal(statementFileName("Platinum Credit Card", "2026-07"), "platinum-credit-card-2026-07.pdf");
  assert.equal(statementFileName("Nu crédito", "2026-07"), "nu-credito-2026-07.pdf");
});

test("accents do not file apart from their unaccented spelling", () => {
  // "Banorte débito" and "Banorte debito" must be the same shelf.
  assert.equal(statementFileName("Banorte débito", "2026-07"), statementFileName("Banorte debito", "2026-07"));
});

test("something unidentified still lands somewhere traceable", () => {
  // The names they really arrive with: "20267.pdf", "creditcardmpstatement.pdf".
  const d = digestOf(bytes("x"));
  const n = provisionalFileName("20267.pdf", d);
  assert.match(n, /^_sin-identificar-20267-[0-9a-f]{8}\.pdf$/);
});

test("the same statement sent twice does not pile up", () => {
  const first = fileStatement({ bytes: bytes("pdf-a"), original: "x.pdf", source: "telegram", account: "Meli", month: "2026-07" });
  const again = fileStatement({ bytes: bytes("pdf-a"), original: "otro.pdf", source: "email", account: "Meli", month: "2026-07" });
  assert.equal(again.name, first.name);
  assert.equal(again.duplicate, true);
});

test("a DIFFERENT document for the same month never overwrites the first", () => {
  // A corrected statement, or a misidentification. Replacing a file we may
  // already have reconciled against is the one thing filing must not do.
  const first = fileStatement({ bytes: bytes("pdf-a"), original: "x.pdf", source: "telegram", account: "Meli", month: "2026-07" });
  const other = fileStatement({ bytes: bytes("pdf-b"), original: "y.pdf", source: "telegram", account: "Meli", month: "2026-07" });
  assert.equal(first.name, "meli-2026-07.pdf");
  assert.equal(other.name, "meli-2026-07-v2.pdf");
  assert.equal(fs.readFileSync(first.path, "utf8"), "pdf-a");
});

test("collision resolution needs no filesystem to be reasoned about", () => {
  const taken = new Set(["/d/meli-2026-07.pdf"]);
  const r = resolveCollision("/d", "meli-2026-07.pdf", "deadbeef", (p) => taken.has(p), () => "otro");
  assert.equal(r.name, "meli-2026-07-v2.pdf");
  assert.equal(r.duplicate, false);
});

test("every arrival is written down, with where it came from", () => {
  fileStatement({
    bytes: bytes("pdf-a"), original: "creditcardmpstatement.pdf", source: "email",
    account: "Meli", month: "2026-07", via: "no-reply@mercadopago.com",
  });
  const [a] = readArrivals();
  assert.equal(a.source, "email");
  assert.equal(a.account, "Meli");
  assert.equal(a.filed, "meli-2026-07.pdf");
  assert.equal(a.original, "creditcardmpstatement.pdf", "el nombre original es el único camino de vuelta");
  assert.equal(a.via, "no-reply@mercadopago.com");
  assert.equal(a.bytes, 5);
  assert.match(a.at, /^\d{4}-\d{2}-\d{2}T/);
});

test("an unidentified arrival is recorded as such, not guessed", () => {
  fileStatement({ bytes: bytes("z"), original: "20267.pdf", source: "email", via: "avisos@klar.mx" });
  const [a] = readArrivals();
  assert.equal(a.account, null);
  assert.equal(a.month, null);
  assert.match(a.filed, /^_sin-identificar-/);
});

test("no arrivals log yet is not an error", () => {
  assert.deepEqual(readArrivals(), []);
});

test("an unidentified arrival shows up as pending", async () => {
  const { unidentifiedArrivals, formatArrivals } = await import("../../statements/filing.js");
  fileStatement({ bytes: bytes("q"), original: "20267.pdf", source: "email", via: "avisos@klar.mx" });
  const pend = unidentifiedArrivals();
  assert.equal(pend.length, 1);
  assert.match(formatArrivals(pend), /avisos@klar\.mx/);
});

test("once identified it stops being pending, whichever order it landed", async () => {
  const { unidentifiedArrivals } = await import("../../statements/filing.js");
  fileStatement({ bytes: bytes("q"), original: "20267.pdf", source: "email" });
  fileStatement({ bytes: bytes("q"), original: "20267.pdf", source: "telegram", account: "Klar", month: "2026-07" });
  assert.deepEqual(unidentifiedArrivals(), []);
});

test("the same unidentified file arriving twice is one thing to look at", async () => {
  const { unidentifiedArrivals } = await import("../../statements/filing.js");
  fileStatement({ bytes: bytes("q"), original: "a.pdf", source: "email" });
  fileStatement({ bytes: bytes("q"), original: "a.pdf", source: "email" });
  assert.equal(unidentifiedArrivals().length, 1);
});
