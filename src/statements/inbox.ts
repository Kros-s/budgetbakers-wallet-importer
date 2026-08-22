/**
 * @file statements/inbox.ts
 * @description Where statement PDFs land, and when they stop being kept.
 *
 * A statement is the one document in this pipeline that is both the most
 * sensitive — every movement of a month, in the clear — and the most
 * replaceable: the bank will hand it over again. So it is not backed up and it
 * does not linger. It is kept exactly as long as it is still needed to answer a
 * question, and no longer.
 */

import fs from "fs";
import path from "path";
import { pruneOldFiles, type PruneResult } from "../batch/retention.js";

export const INBOX_DIR = path.resolve("data/statements/inbox");

/** Two months, matching what the user asked to hold at most. */
export const STATEMENT_RETENTION_DAYS = 60;

export interface RetireOutcome {
  removed: boolean;
  reason: string;
}

/**
 * Drops the PDF once its month closes cleanly.
 *
 * The ambiguous rows are the whole reason this is conditional. `markReceived()`
 * stamps the month as reconciled even when rows were too uncertain to write,
 * and those rows are exactly the ones that send you back to the PDF. Deleting
 * on "reconciled" alone would throw away the source at the precise moment it
 * became necessary.
 */
export function retireStatement(pdfPath: string, ambiguousCount: number): RetireOutcome {
  if (ambiguousCount > 0) {
    return {
      removed: false,
      reason: `${ambiguousCount} ambiguo(s) por revisar — el PDF se queda hasta que se resuelvan`,
    };
  }
  // Only ever delete out of the inbox. A PDF passed by absolute path from
  // somewhere else on disk belongs to the user, not to us.
  const resolved = path.resolve(pdfPath);
  if (path.dirname(resolved) !== INBOX_DIR) {
    return { removed: false, reason: `fuera de ${path.relative(process.cwd(), INBOX_DIR)} — no se toca` };
  }
  try {
    fs.rmSync(resolved, { force: true });
    return { removed: true, reason: "mes conciliado sin ambiguos" };
  } catch (err) {
    return { removed: false, reason: `no se pudo borrar: ${err instanceof Error ? err.message : err}` };
  }
}

/**
 * The backstop, for statements that never reconcile — a month that was chased,
 * downloaded, and then abandoned would otherwise sit there forever.
 */
export function pruneStatementInbox(now?: number): PruneResult {
  return pruneOldFiles({
    dir: INBOX_DIR,
    pattern: /\.pdf$/i,
    maxAgeDays: STATEMENT_RETENTION_DAYS,
    keepNewest: 0,
    now,
  });
}
