/**
 * @file statements/filing.ts
 * @description What a statement is called once it lands, and the record of it
 * having landed.
 *
 * Statements arrive from three directions — a PDF sent over Telegram, an
 * attachment on a bank's email, a file dropped in by hand — and each brought
 * whatever name it happened to have: "20267.pdf", "creditcardmpstatement.pdf",
 * "Estado_de_cuenta_Mifel__TDD_22082026.pdf". None of those say which Wallet
 * account they belong to or which month they close, which is the only thing
 * anyone needs to know when looking for one later.
 *
 * So a statement gets one canonical name, and every arrival is written down.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { INBOX_DIR } from "./inbox.js";
import { accountSlug, statementPdfName } from "./naming.js";

export const ARRIVALS_LOG = path.resolve("data/statements/arrivals.jsonl");

export type ArrivalSource = "telegram" | "email" | "manual";

export interface Arrival {
  /** ISO timestamp of when it landed. */
  at: string;
  source: ArrivalSource;
  /** Wallet account, or null while it is still unidentified. */
  account: string | null;
  /** "YYYY-MM", or null while unidentified. */
  month: string | null;
  /** The name it was given here. */
  filed: string;
  /** The name it arrived with — the only way back to the original. */
  original: string;
  bytes: number;
  /** First 16 hex of the SHA-256, enough to tell two statements apart. */
  digest: string;
  /** Where it came from: sender address, chat id, or a note. */
  via?: string;
}

// One authority for how an account becomes a filename — three copies with two
// conventions gave a single account a PDF, a ledger and a profile under three
// different names.
const slug = accountSlug;

/**
 * The canonical name: account and month, which is what anyone looking for a
 * statement actually knows.
 */
export function statementFileName(account: string, month: string, ext = ".pdf"): string {
  return statementPdfName(account, month, ext);
}

/**
 * A provisional name for something that has landed but is not identified yet.
 *
 * It carries the digest so the same file arriving twice lands on the same name
 * instead of piling up, and so a name can be traced back to its bytes.
 */
export function provisionalFileName(original: string, digest: string, ext = ".pdf"): string {
  const base = slug(path.basename(original, path.extname(original))).slice(0, 24) || "sin-nombre";
  return `_sin-identificar-${base}-${digest.slice(0, 8)}${ext}`;
}

export function digestOf(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * Resolves a name collision without ever overwriting.
 *
 * The same statement re-sent is the common case and lands on the same name
 * harmlessly. A DIFFERENT document claiming the same account and month is the
 * dangerous one — a corrected statement, or a misidentification — so it is
 * kept beside the first under "-v2" rather than replacing a file we may have
 * already reconciled against.
 */
export function resolveCollision(
  dir: string,
  name: string,
  digest: string,
  exists: (p: string) => boolean = fs.existsSync,
  digestAt: (p: string) => string | null = (p) => {
    try { return digestOf(fs.readFileSync(p)); } catch { return null; }
  }
): { name: string; duplicate: boolean } {
  const ext = path.extname(name);
  const stem = name.slice(0, -ext.length || undefined);
  for (let v = 1; v < 50; v++) {
    const candidate = v === 1 ? name : `${stem}-v${v}${ext}`;
    const full = path.join(dir, candidate);
    if (!exists(full)) return { name: candidate, duplicate: false };
    if (digestAt(full) === digest) return { name: candidate, duplicate: true };
  }
  return { name: `${stem}-${digest.slice(0, 8)}${ext}`, duplicate: false };
}

/** Appends one line to the arrivals record. Never throws — filing must not fail a run. */
export function recordArrival(arrival: Arrival, logPath = ARRIVALS_LOG): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(arrival)}\n`);
  } catch { /* the statement is filed; losing its log line is not worth a crash */ }
}

export function readArrivals(logPath = ARRIVALS_LOG): Arrival[] {
  try {
    return fs.readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Arrival);
  } catch {
    return [];
  }
}

export interface FileResult {
  path: string;
  name: string;
  duplicate: boolean;
}

/** Writes the bytes into the inbox under their proper name and records the arrival. */
export function fileStatement(opts: {
  bytes: Buffer;
  original: string;
  source: ArrivalSource;
  account?: string | null;
  month?: string | null;
  via?: string;
  dir?: string;
}): FileResult {
  const dir = opts.dir ?? INBOX_DIR;
  const digest = digestOf(opts.bytes);
  const ext = path.extname(opts.original).toLowerCase() || ".pdf";
  const wanted = opts.account && opts.month
    ? statementFileName(opts.account, opts.month, ext)
    : provisionalFileName(opts.original, digest, ext);

  fs.mkdirSync(dir, { recursive: true });
  const { name, duplicate } = resolveCollision(dir, wanted, digest);
  const full = path.join(dir, name);
  if (!duplicate) fs.writeFileSync(full, opts.bytes);

  recordArrival({
    at: new Date().toISOString(),
    source: opts.source,
    account: opts.account ?? null,
    month: opts.month ?? null,
    filed: name,
    original: path.basename(opts.original),
    bytes: opts.bytes.length,
    digest,
    via: opts.via,
  });
  return { path: full, name, duplicate };
}

/**
 * Arrivals still waiting to be told what they are.
 *
 * A statement that came in by email and could not be identified is the one that
 * would otherwise sit in the inbox unseen: nobody sent it, so nobody is waiting
 * for an answer about it. Deduplicated by digest — the same file re-sent is one
 * thing to look at, not three.
 */
export function unidentifiedArrivals(arrivals = readArrivals()): Arrival[] {
  const seen = new Set<string>();
  const out: Arrival[] = [];
  for (const a of arrivals) {
    if (a.account && a.month) { seen.add(a.digest); continue; }
    if (seen.has(a.digest)) continue;
    seen.add(a.digest);
    out.push(a);
  }
  // An arrival identified later stops being pending, whichever order it landed.
  const identified = new Set(arrivals.filter((a) => a.account && a.month).map((a) => a.digest));
  return out.filter((a) => !identified.has(a.digest));
}

export function formatArrivals(arrivals: Arrival[], limit = 8): string {
  if (arrivals.length === 0) return "";
  const shown = arrivals.slice(-limit);
  const lines = shown.map((a) => `${a.at.slice(0, 10)} ${a.filed}  ←  ${a.via || a.source}`);
  const more = arrivals.length > shown.length ? `\n…y ${arrivals.length - shown.length} más.` : "";
  return lines.join("\n") + more;
}
