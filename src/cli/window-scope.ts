/**
 * @file cli/window-scope.ts
 * @description Which emails of a window still need work, and when a replay is allowed.
 *
 * These two decisions live apart from `process-window.ts` because that module
 * runs `main()` on import, so nothing in it can be unit-tested — and the
 * replay bypass is exactly the kind of rule that has to be tested rather than
 * read.
 */
/**
 * Whether a uid needs no further work in this run.
 *
 * `--force` only revives uids that FAILED past their attempt cap; a uid that
 * succeeded is skipped for good, which is what makes the batch idempotent. So
 * there was no way to re-read mail already handled, and the question that
 * wanted it — "did the Codex fallback miss anything between 07-oct and
 * 11-oct?" — could not be asked at all.
 *
 * `--replay` answers it by ignoring the processed store entirely. It is
 * accepted ONLY with `--dry-run` (see `assertReplaySafe`): a replay that could
 * write would re-propose every row in the window, and the ±48h Wallet dedup
 * narrows duplicates but does not promise to catch all of them. Kept as a pure
 * function so the bypass is tested rather than inspected.
 */
export function isAlreadyHandled(
  uid: number,
  opts: { processed: Set<number>; ledgerKnown: Set<number>; failedRetryable: Map<number, number>; replay: boolean }
): boolean {
  if (opts.replay) return false;
  const known = opts.processed.has(uid) || opts.ledgerKnown.has(uid);
  return known && !opts.failedRetryable.has(uid);
}

/** Refuses `--replay` outside a dry run, before a single email is fetched. */
export function assertReplaySafe(args: { replay: boolean; dryRun: boolean }): void {
  if (args.replay && !args.dryRun) {
    throw new Error("--replay solo se permite con --dry-run: reprocesar correos ya escritos duplicaría registros en Wallet.");
  }
}
