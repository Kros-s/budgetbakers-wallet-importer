/**
 * @file bot/instance-lock.ts
 * @description Single-instance guard via a pidfile. Prevents two bot
 * processes (e.g. launchd + a manual `pnpm main`, or a restart where the old
 * process didn't die) from both polling Telegram and sending duplicate
 * messages.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";

const LOCK_PATH = join(process.cwd(), "data/bot/bot.pid");

/** True if a process with this pid is currently alive. */
function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 does not kill — it just checks existence/permission.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claims the single-instance pidfile lock for this process.
 *
 * Throws if another live process already holds the lock. An orphaned
 * pidfile (process no longer alive) is silently overwritten.
 */
export function acquireInstanceLock(): void {
  if (existsSync(LOCK_PATH)) {
    const raw = readFileSync(LOCK_PATH, "utf8").trim();
    const existingPid = Number(raw);
    if (Number.isInteger(existingPid) && existingPid > 0 && isProcessAlive(existingPid)) {
      throw new Error(
        `Another bot instance (pid ${existingPid}) is already running. ` +
        `Stop it first, or remove ${LOCK_PATH} if you're sure it's stale.`
      );
    }
    // Orphaned pidfile — previous process died without cleaning up.
  }

  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  writeFileSync(LOCK_PATH, String(process.pid));

  process.on("exit", () => {
    try {
      if (readFileSync(LOCK_PATH, "utf8").trim() === String(process.pid)) {
        unlinkSync(LOCK_PATH);
      }
    } catch {
      // best-effort cleanup only
    }
  });
}
