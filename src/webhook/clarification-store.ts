import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export interface ClarificationEntry {
  chatId: number;
  emailFrom: string;
  emailSubject: string;
  emailText: string;
  claudeQuestion: string;
  createdAt: number;
}

const STORE_PATH = join(process.cwd(), "data/bot/pending-clarifications.json");
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Store = Record<string, ClarificationEntry>;

function load(): Store {
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf8")) as Store;
  } catch {
    return {};
  }
}

function save(store: Store): void {
  mkdirSync(join(process.cwd(), "data/bot"), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function storeClarification(messageId: number, entry: ClarificationEntry): void {
  const store = load();
  // Prune stale entries
  const cutoff = Date.now() - TTL_MS;
  for (const key of Object.keys(store)) {
    if (store[key].createdAt < cutoff) delete store[key];
  }
  store[String(messageId)] = entry;
  save(store);
}

/** Removes and returns the clarification tied to a Telegram message_id. */
export function takeClarification(messageId: number): ClarificationEntry | null {
  const store = load();
  const key = String(messageId);
  const entry = store[key] ?? null;
  if (entry) {
    delete store[key];
    save(store);
  }
  return entry;
}

/** Returns (without removing) the most recent clarification for a chat, if any. */
export function peekLatestClarification(
  chatId: number
): { messageId: number; entry: ClarificationEntry } | null {
  const store = load();
  let latest: { messageId: number; entry: ClarificationEntry } | null = null;
  for (const [key, entry] of Object.entries(store)) {
    if (entry.chatId === chatId) {
      if (!latest || entry.createdAt > latest.entry.createdAt) {
        latest = { messageId: Number(key), entry };
      }
    }
  }
  return latest;
}
