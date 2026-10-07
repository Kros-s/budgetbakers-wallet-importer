import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Folder-independent identity: same RFC822 message moved to a new UID.
 * Includes the complete message, so a sender reusing Message-ID cannot
 * suppress a different transaction. Normalize transport line endings only.
 */
export function messageFingerprint(source: Buffer): string {
  return createHash("sha256").update(source.toString("binary").replace(/\r\n/g, "\n"), "binary").digest("hex");
}
export class MessageIdentities {
  private readonly file: string;
  private readonly entries: Set<string>;
  constructor(directory = path.resolve("data/imap"), account = process.env.ICLOUD_EMAIL ?? "") {
    const accountKey = createHash("sha256").update(account.trim().toLowerCase()).digest("hex").slice(0, 16);
    this.file = path.join(directory, `message-identities-${accountKey}.json`);
    const values: unknown = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : [];
    if (!Array.isArray(values) || values.some(v => typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))) {
      throw new Error("Invalid message identity store; refusing to discard deduplication history");
    }
    this.entries = new Set(values);
  }
  has(key: string): boolean { return this.entries.has(key); }
  add(key: string): void {
    this.entries.add(key);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify([...this.entries]), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}
/** Atomic exclusive lock; children accept only their living parent's lock. */
export function acquireBatchLock(): void {
  const file = path.resolve("data/imap/batch.pid");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, "utf8"));
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch (err) { alive = (err as NodeJS.ErrnoException).code === "EPERM"; }
    }
    if (alive) {
      if (pid === process.ppid && process.env.BBW_BATCH_PARENT === String(pid)) return;
      throw new Error(`Another email batch is running (pid ${pid})`);
    }
    fs.unlinkSync(file);
  }
  fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
  process.on("exit", () => {
    try { if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.unlinkSync(file); } catch { /* best effort */ }
  });
}
