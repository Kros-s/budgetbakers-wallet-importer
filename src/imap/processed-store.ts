import fs from "fs";
import path from "path";

const STORE_PATH = path.resolve("data/imap/processed-uids.json");
const MAX_UIDS = 2000;

interface FolderEntry {
  uidValidity: string; // bigint serialized as string
  uids: number[];
}

type Store = Record<string, FolderEntry>;

function load(): Store {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as Store;
  } catch {
    return {};
  }
}

function save(store: Store): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store));
}

export function getProcessed(folder: string, uidValidity: bigint): Set<number> {
  const entry = load()[folder];
  if (!entry || entry.uidValidity !== uidValidity.toString()) return new Set();
  return new Set(entry.uids);
}

export function saveProcessed(folder: string, uidValidity: bigint, newUids: number[]): void {
  const store = load();
  const existing = store[folder]?.uidValidity === uidValidity.toString()
    ? store[folder].uids
    : [];
  const merged = [...new Set([...existing, ...newUids])];
  store[folder] = {
    uidValidity: uidValidity.toString(),
    uids: merged.length > MAX_UIDS ? merged.slice(-MAX_UIDS) : merged,
  };
  save(store);
}
