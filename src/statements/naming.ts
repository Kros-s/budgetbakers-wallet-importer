/**
 * @file statements/naming.ts
 * @description The one place that turns a Wallet account name into a filename.
 *
 * There were three of these. `filing.ts` stripped accents before slugging,
 * `ledgers.ts` did not, and `reconcile-statement.ts` carried a byte-copy of the
 * `ledgers.ts` version. For "Banorte débito" that meant the PDF filed under
 * `banorte-debito-2026-07.pdf`, the extraction saved as
 * `ledger-banorte-débito-2026-07.json`, and the per-bank profile looked for at
 * `banorte-débito.md` — one account, three shelves, and a coverage check that
 * could not see the statement it had just filed.
 *
 * Accent-stripping is the convention that survives. The same file has to be
 * legible from macOS (APFS, which hands back decomposed NFD names) and from the
 * Linux container (which stores whatever bytes it was given, usually composed
 * NFC): a filename containing "é" is two different byte strings depending on
 * which machine wrote it, so `existsSync` on one can miss a file created by the
 * other. ASCII has no such ambiguity.
 *
 * Everything here is pure — no fs, no cwd, no side effects — so the switchover
 * can be reasoned about and tested without a disk.
 */

import type { Registry, RegistryEntry } from "./registry.js";

/**
 * The canonical account slug. Lowercase, accent-free, ASCII-only.
 *
 * Anything outside [a-z0-9] collapses to a single hyphen, so spacing and
 * punctuation cannot make two spellings of one account file apart.
 */
export function accountSlug(account: string): string {
  return account
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // "débito" and "debito" are one account
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The statement PDF as filed: account and month, which is all anyone knows. */
export function statementPdfName(account: string, month: string, ext = ".pdf"): string {
  return `${accountSlug(account)}-${month}${ext}`;
}

/** The stored extraction for one account-month. */
export function ledgerFileName(account: string, month: string): string {
  return `ledger-${accountSlug(account)}-${month}.json`;
}

/** The per-bank profile: the format quirks learned about one issuer's PDFs. */
export function bankProfileFileName(account: string): string {
  return `${accountSlug(account)}.md`;
}

/**
 * Accounts that would end up sharing one slug.
 *
 * Stripping accents merges spellings on purpose, but it could also merge two
 * accounts that are genuinely distinct. Nothing in the current registry
 * collides; this is the check to run before adding an account, because the
 * collision only shows up as one statement silently overwriting another.
 */
export function slugCollisions(accounts: string[]): Record<string, string[]> {
  const bySlug = new Map<string, string[]>();
  for (const account of accounts) {
    const slug = accountSlug(account);
    const got = bySlug.get(slug);
    if (got) { if (!got.includes(account)) got.push(account); } else bySlug.set(slug, [account]);
  }
  const out: Record<string, string[]> = {};
  for (const [slug, names] of bySlug) if (names.length > 1) out[slug] = names;
  return out;
}

// ── Migrating what is already on disk ────────────────────────────────────────

export type StatementFileKind = "statement" | "ledger" | "profile" | "provisional" | "unknown";

export interface ParsedStatementFile {
  kind: StatementFileKind;
  /** The account slug exactly as it appears in the name, before canonicalising. */
  slug: string | null;
  /** "YYYY-MM", for the kinds that carry one. */
  month: string | null;
}

const PROVISIONAL_PREFIX = "_sin-identificar-";
const LEDGER_RE = /^ledger-(.+)-(\d{4}-\d{2})\.json$/;
const STATEMENT_RE = /^(.+)-(\d{4}-\d{2})((?:-v\d+)?)(\.pdf)$/i;
const PROFILE_RE = /^(.+)\.md$/i;

export function parseStatementFile(fileName: string): ParsedStatementFile {
  if (fileName.startsWith(PROVISIONAL_PREFIX)) return { kind: "provisional", slug: null, month: null };

  const ledger = LEDGER_RE.exec(fileName);
  if (ledger) return { kind: "ledger", slug: ledger[1], month: ledger[2] };

  const statement = STATEMENT_RE.exec(fileName);
  if (statement) return { kind: "statement", slug: statement[1], month: statement[2] };

  const profile = PROFILE_RE.exec(fileName);
  if (profile) return { kind: "profile", slug: profile[1], month: null };

  return { kind: "unknown", slug: null, month: null };
}

/**
 * What this file would be called under the canonical convention, or null if it
 * is not a file this module names.
 *
 * The account is recovered from the slug that is already in the name rather
 * than from the registry: a ledger written for an account that has since been
 * renamed still has to be findable, and re-slugging an existing slug is
 * idempotent for anything already canonical.
 */
export function canonicalFileName(fileName: string): string | null {
  const parsed = parseStatementFile(fileName);
  switch (parsed.kind) {
    // A provisional name is deliberately not an account name — its leading
    // underscore is what keeps it sorted apart and out of the coverage count,
    // and slugging would eat it.
    case "provisional": return fileName;
    case "ledger": return `ledger-${accountSlug(parsed.slug!)}-${parsed.month}.json`;
    case "statement": {
      const [, , , version, ext] = STATEMENT_RE.exec(fileName)!;
      // "-v2" marks a second, different document for the same month. Dropping
      // it would rename the correction on top of the original.
      return `${accountSlug(parsed.slug!)}-${parsed.month}${version}${ext.toLowerCase()}`;
    }
    case "profile": return `${accountSlug(parsed.slug!)}.md`;
    default: return null;
  }
}

export interface Rename {
  from: string;
  to: string;
}

export interface MigrationPlan {
  /** Safe to rename: the target is free. */
  renames: Rename[];
  /**
   * Must NOT be renamed unattended: the target already exists, or two files
   * want the same target. Renaming either would destroy a statement.
   */
  conflicts: Rename[];
  /** Already canonical. */
  unchanged: string[];
  /** Not a name this module owns — left alone, but reported rather than hidden. */
  unrecognised: string[];
}

/**
 * What the switchover would do to the files that are already there.
 *
 * Pure by design: the migration gets read and approved before anything on the
 * container's disk moves.
 */
export function migrationPlan(existingFilenames: string[]): MigrationPlan {
  const plan: MigrationPlan = { renames: [], conflicts: [], unchanged: [], unrecognised: [] };
  const present = new Set(existingFilenames);
  const claimed = new Set<string>();

  for (const from of existingFilenames) {
    const to = canonicalFileName(from);
    if (to === null) { plan.unrecognised.push(from); continue; }
    if (to === from) { plan.unchanged.push(from); claimed.add(to); continue; }
    // `present` catches an untouched file already sitting on the target name;
    // `claimed` catches two accented spellings folding onto one canonical name.
    if (present.has(to) || claimed.has(to)) plan.conflicts.push({ from, to });
    else { plan.renames.push({ from, to }); claimed.add(to); }
  }
  return plan;
}

// ── Seeding the registry ─────────────────────────────────────────────────────
//
// This is not naming, and it does not belong here long-term — it lives here
// only because it has to ship in a new file. Its home is `registry.ts`, beside
// `loadRegistry()`, or a `statements/seed.ts` of its own.

/**
 * One account as it is checked into version control: configuration only.
 *
 * `data/` is gitignored, so the fourteen hand-verified cut days existed on
 * exactly one disk. A rebuilt container came up with an empty registry, chased
 * nothing, and nobody was told.
 */
export interface SeedEntry {
  cutDay: number;
  source: "email" | "manual";
  startMonth?: string;
  graceDays?: number;
  /** Always null in the seed; present so the shape matches a live entry. */
  lastReceived?: null;
}

export type RegistrySeed = Record<string, SeedEntry>;

/**
 * Seed plus live state.
 *
 * The seed is the authority on configuration — cut day, source, how far back to
 * chase — because that is the part that is reviewed and versioned. The live
 * file is the authority on what has actually been reconciled, because that is
 * the part the container earns at runtime and cannot be recovered from git.
 *
 * An account that exists only in the live file is KEPT. Dropping it would
 * unchase an account someone added on the container, and the registry is what
 * decides whether a missing statement is ever mentioned again.
 */
export function mergeRegistry(seed: RegistrySeed, live: Registry): Registry {
  const out: Registry = {};

  for (const [account, s] of Object.entries(seed)) {
    const l = live[account] as RegistryEntry | undefined;
    const entry: RegistryEntry = {
      cutDay: s.cutDay,
      source: s.source,
      lastReceived: l?.lastReceived ?? null,
    };
    if (s.startMonth !== undefined) entry.startMonth = s.startMonth;
    if (s.graceDays !== undefined) entry.graceDays = s.graceDays;
    // Only carry `received` when the live file actually has one. An absent
    // `received` is not an empty one: `receivedMonths()` falls back to
    // `lastReceived` for a pre-`received` registry, and writing [] here would
    // erase that fallback and re-chase months already reconciled.
    if (l?.received) entry.received = [...l.received];
    out[account] = entry;
  }

  for (const [account, l] of Object.entries(live)) {
    if (!(account in out)) out[account] = l;
  }
  return out;
}
