/**
 * Creating accounts, from a terminal.
 *
 *   npx tsx src/cli/accounts.ts list
 *   npx tsx src/cli/accounts.ts create --name "Plata Card" --type debito
 *   npx tsx src/cli/accounts.ts create --name "Plata Card" --type debito --write
 *
 * The Wallet MCP is read-only — its granted scopes are all `.read` — so a new
 * account can only be created in the phone app or here. The app is fine for
 * one; it is not fine for a backlog, and an account typed by hand is an account
 * whose name does not quite match what the importer looks up.
 *
 * Dry by default. Creating an account is not destructive, but it is visible in
 * every client the moment it syncs, so it stays a separate decision.
 */
import { v4 as uuidv4 } from "uuid";

import { loadEnvLocal } from "../env.js";
import { buildCouchClient, buildLookupMapsFromData, fetchLookupData } from "../couch.js";
import { loadDirectCredentials } from "../direct-auth.js";

/**
 * `accountType` as the real documents use it, read off all 52 accounts in this
 * database rather than from any spec.
 *
 * The split between 2 and 4 does not survive inspection — Bancomer and NuBank
 * Débito are 2 while Banorte débito and Ualá are 4 — so this maps the words a
 * person would use onto the value its closest existing sibling carries. Wallet
 * treats the type as a label anyway: Costco is a credit card filed as savings
 * and nothing downstream cares.
 */
export const ACCOUNT_TYPES: Record<string, number> = {
  general: 1,
  efectivo: 1,
  cheques: 2,
  debito: 4,
  ahorro: 4,
  credito: 3,
  vales: 5,
  inversion: 7,
};

/** The fields every account document in this database carries. */
export interface NewAccountInput {
  name: string;
  accountType: number;
  currencyId: string;
  userId: string;
  initAmount?: number;
  color?: string;
  position: number;
}

/**
 * Builds the document, shaped after the accounts already here.
 *
 * `initAmount` is minor units like everywhere else, and its `decimal*` twins
 * are strings — that is what the iOS client writes, and a mismatch between the
 * two is how an account shows one balance on the phone and another on the web.
 */
export function buildAccountDoc(input: NewAccountInput): Record<string, unknown> {
  const now = new Date().toISOString();
  const init = input.initAmount ?? 0;
  return {
    _id: `-Account_${uuidv4()}`,
    name: input.name,
    accountType: input.accountType,
    currencyId: input.currencyId,
    color: input.color ?? "#6a1b9a",
    position: input.position,
    excludeFromStats: false,
    archived: false,
    gps: false,
    initAmount: init,
    initRefAmount: init,
    decimalInitAmount: String(init / 100),
    decimalInitRefAmount: String(init / 100),
    reservedModelType: "Account",
    reservedSource: "web",
    reservedOwnerId: input.userId,
    reservedAuthorId: input.userId,
    reservedCreatedAt: now,
    reservedUpdatedAt: now,
  };
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "list";

  loadEnvLocal();
  const credentials = loadDirectCredentials();
  const couch = buildCouchClient(credentials.replication);
  const data = await fetchLookupData(couch);
  const lookup = buildLookupMapsFromData(data);

  const accounts = (data.accounts ?? []) as Array<Record<string, unknown>>;

  if (cmd === "list") {
    const byType = new Map<number, string[]>();
    for (const a of accounts) {
      const t = Number(a.accountType);
      byType.set(t, [...(byType.get(t) ?? []), String(a.name)]);
    }
    for (const t of [...byType.keys()].sort((x, y) => x - y)) {
      console.log(`accountType ${t}: ${byType.get(t)!.join(", ")}`);
    }
    return;
  }

  if (cmd !== "create") throw new Error(`Comando desconocido: ${cmd}. Usa list | create.`);

  const name = arg(argv, "--name");
  const typeWord = (arg(argv, "--type") ?? "debito").toLowerCase();
  const currencyCode = (arg(argv, "--currency") ?? "MXN").toUpperCase();
  const initial = Number(arg(argv, "--initial") ?? "0");

  if (!name) throw new Error(`Uso: accounts.ts create --name "Nombre" [--type debito] [--initial 0] [--write]`);
  const accountType = ACCOUNT_TYPES[typeWord];
  if (accountType === undefined) {
    throw new Error(`Tipo desconocido "${typeWord}". Usa uno de: ${Object.keys(ACCOUNT_TYPES).join(", ")}`);
  }
  if (!Number.isFinite(initial)) throw new Error(`--initial no es un número: ${arg(argv, "--initial")}`);

  // A duplicate name is accepted by the API and is a trap here: every lookup in
  // this codebase resolves accounts by name.
  const clash = accounts.find((a) => String(a.name).toLowerCase() === name.toLowerCase());
  if (clash) throw new Error(`Ya existe una cuenta llamada "${String(clash.name)}" — los lookups la resuelven por nombre.`);

  const currencyId = lookup.currencies?.[currencyCode];
  if (!currencyId) {
    throw new Error(`No encuentro la moneda ${currencyCode}. Disponibles: ${Object.keys(lookup.currencies ?? {}).join(", ")}`);
  }

  const position = Math.max(0, ...accounts.map((a) => Number(a.position) || 0)) + 10_000;
  const doc = buildAccountDoc({
    name,
    accountType,
    currencyId,
    userId: credentials.userId,
    initAmount: Math.round(initial * 100),
    position,
    color: arg(argv, "--color"),
  });

  console.log(`Cuenta a crear:\n${JSON.stringify(doc, null, 2)}\n`);

  if (!argv.includes("--write")) {
    console.log("Nada escrito. Repite con --write para crearla.");
    return;
  }

  const res = await couch.post<Array<{ id: string; ok?: boolean; error?: string; reason?: string }>>(
    "/_bulk_docs",
    { docs: [doc] }
  );
  const failed = res.data.filter((r) => r.error);
  if (failed.length) {
    throw new Error(`CouchDB rechazó la cuenta: ${failed.map((f) => `${f.error} — ${f.reason}`).join("; ")}`);
  }
  console.log(`✅ Creada "${name}" → ${res.data[0].id}`);
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
