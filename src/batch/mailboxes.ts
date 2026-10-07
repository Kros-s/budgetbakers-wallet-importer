import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildImapClient } from "../imap/client.js";
import { acquireBatchLock } from "../imap/message-identities.js";
import { latestWatermark } from "./ledger.js";

export function processingFolders(mailboxes: { path: string; specialUse?: string }[]): string[] {
  const inbox = mailboxes.find(m => m.specialUse === "\\Inbox" || m.path.toUpperCase() === "INBOX");
  const archives = mailboxes.filter(m => m.specialUse === "\\Archive");
  if (!inbox || !archives.length) throw new Error("INBOX or IMAP Archive special-use folder missing; refusing to advance coverage");
  return [...new Set([inbox.path, ...archives.map(m => m.path)])];
}
interface Coverage { from: string; to: string; folders: string[] }
export async function runMailboxes(argv: string[]): Promise<void> {
  acquireBatchLock();
  const file = path.resolve("data/imap/mailbox-coverage.json");
  let saved: Coverage | undefined = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
  const get = (flag: string) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
  const day = get("--day");
  const explicitFrom = get("--from");
  const toArg = get("--to");
  const to = day ? new Date(`${day}T20:00:00`) : toArg ? new Date(toArg.includes("T") ? toArg : `${toArg}T23:59:59`) : new Date();
  let from: Date;
  if (day) { from = new Date(to); from.setDate(from.getDate() - 1); }
  else if (explicitFrom) from = new Date(explicitFrom.includes("T") ? explicitFrom : `${explicitFrom}T00:00:00`);
  else {
    const watermark = saved ? new Date(saved.to) : latestWatermark();
    if (!watermark) throw new Error("No coverage watermark; pass --from for the initial run");
    // Revisit recent dates to catch moves; never broaden the initial recovery.
    from = saved ? new Date(Math.max(Date.parse(saved.from), watermark.getTime() - 7 * 86400000)) : watermark;
  }
  if (![from, to].every(d => Number.isFinite(d.getTime())) || from >= to) throw new Error("Invalid mailbox processing window");
  if (saved && (!Number.isFinite(Date.parse(saved.from)) || !Number.isFinite(Date.parse(saved.to)))) throw new Error("Invalid mailbox coverage state");
  const client = buildImapClient();
  await client.connect();
  let folders: string[];
  try { folders = processingFolders(await client.list()); } finally { await client.logout(); }
  if (!argv.includes("--dry-run")) {
    const baseline = saved ? new Date(saved.to) : latestWatermark();
    if (baseline && from > baseline) throw new Error("Requested window leaves a coverage gap; run the earliest missing day first");
    // Save the starting point BEFORE either child can advance its own ledger.
    // If Archive fails, the next daily run must re-cover it despite INBOX success.
    if (!saved) {
      saved = { from: from.toISOString(), to: from.toISOString(), folders };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(saved, null, 2), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    }
  }
  console.log(`[mailboxes] ${JSON.stringify({ folders, from: from.toISOString(), to: to.toISOString(), dryRun: argv.includes("--dry-run") })}`);
  for (const folder of folders) {
    const childArgs = [process.argv[1], "--folder", folder, "--from", from.toISOString(), "--to", to.toISOString()];
    // --day is translated to the exact common window; --ledger-day only labels it.
    if (day) childArgs.push("--ledger-day", day);
    for (const flag of ["--dry-run", "--force"]) if (argv.includes(flag)) childArgs.push(flag);
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [...process.execArgv, ...childArgs], {
        stdio: "inherit", env: { ...process.env, BBW_BATCH_PARENT: String(process.pid) },
      });
      child.once("error", reject); child.once("exit", resolve);
    });
    if (code !== 0) throw new Error(`Mailbox ${folder} did not complete; coverage watermark unchanged`);
  }
  if (!argv.includes("--dry-run")) {
    // A historical/manual run must not jump across an uncovered gap.
    if (saved && from.getTime() > Date.parse(saved.to)) throw new Error("Historical window left a coverage gap; checkpoint unchanged");
    const coverage: Coverage = {
      from: saved ? new Date(Math.min(Date.parse(saved.from), from.getTime())).toISOString() : from.toISOString(),
      to: new Date(Math.max(saved ? Date.parse(saved.to) : to.getTime(), to.getTime())).toISOString(), folders,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(coverage, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    console.log(`[mailboxes-complete] ${JSON.stringify(coverage)}`);
  }
}
