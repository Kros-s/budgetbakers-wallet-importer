# Statement pipeline — open issues

Two independent reviews went over the reconciliation pipeline on 2026-08-22.
Everything that loses or duplicates money, or misreports state, was fixed in
`40747ba` and the commits before it. What follows is what was found and left,
ranked by damage, so none of it survives on trust alone.

Each entry says what breaks, not just what is untidy.

## 1. The bot can never write — the write path has no caller

`reconcileCommand`'s `write` and `fromLedger` options (`src/bot/statement-flow.ts`)
are passed by nothing. `tryStatementRoute` runs a dry pass and stops; `/cross`
only reports. Held transfer legs are therefore never settled by any command:
today the only way to write a statement is the CLI by hand.

This is deliberate as far as it goes — writes wait for the crossing — but the
crossing has no write step, so the loop is open.

## 2. The statement write path bypasses the batch's safeguards

`reconcile-statement.ts` calls `writeRecords` directly. It does not go through
`buildWalletDedup` (`src/batch/wallet-dedup.ts`) or `checkRunIntegrity`
(`src/batch/integrity.ts`), which both other write paths use.

Its own `diff()` is a narrower dedup — same account, same cents, same type,
within the date slack, over a window derived from the statement's period. Any
row whose amount is changed between the diff and the write is unchecked, which
is exactly what a first instalment does (see 3). No integrity pass means the
`large-non-transfer` and `orphan-transfer-leg` checks never see the one path
that writes a whole month at once.

## 3. A first instalment is diffed at one amount and written at another

`diff()` matches on the instalment amount, because the prompt requires it so the
statement's totals balance. `splitForWriting` then restates the row to the full
purchase price. So a `1/6` row is looked for in Wallet at $5,480, never found,
and written at $32,880 — which is precisely the figure a purchase already
recorded from its email alert would carry. The duplicate check ran against the
wrong number.

## 4. `/cross` reads a calendar window over period-based ledgers

`handlers.ts` fetches Wallet for the calendar month ±3/4 days, but the ledgers it
loads cover declared statement periods: Costco's "July" runs 9-jun→8-jul. Rows
before the window are crossed against records that were never fetched and surface
as orphans. `deferNearBoundary` has the same mismatch — it measures the edge
against 1-jul/31-jul rather than each account's real period, which is carried in
`StoredLedger.period` and ignored.

## 5. A coincidence still consumes a real transfer's counterpart

`crossTransfers` adds a `possible` match to `used`, so the row is unavailable to
a genuine transfer found later. `f8c970c` fixed `unpaired` but not `used`:
Costco −500 (Groceries) can still claim Bancomer +500 before Banorte −500
(Transfer) reaches it, and the real transfer is then reported as an orphan.

## 6. `alreadyInWallet` cannot answer the question its name asks

The matcher pairs opposite signs in *different* accounts. A statement row that is
already recorded is the *same* account and the *same* sign, so it is skipped by
construction. The `/cross` line "N of these cross against something already
recorded — don't write them" therefore never reports an actual duplicate, and
what it does report includes coincidences.

## 7. Three slug derivations, two conventions

`filing.slug` strips accents; `ledgers.ledgerSlug` and
`reconcile-statement.profileSlug` (a byte copy of it) do not. So one account can
have three names: `inbox/banorte-debito-2026-07.pdf`,
`ledger-banorte-débito-2026-07.json`, `profiles/banorte-débito.md`. Two tests
assert the opposite conventions and both pass. It also makes the filenames
Unicode-normalisation sensitive between macOS and the Linux container.

`reconcile-statement.ts` rebuilds the ledger path by concatenation instead of
calling `ledgerPath()`, which is what reads it back — one edit splits writer from
reader silently.

## 8. `registry.json` is unversioned configuration

`data/` is gitignored, so fourteen hand-verified cut days live only on the
container's disk and in the nightly tarball. A fresh provision gets an empty
registry, and `loadRegistry` swallows that: the nag never fires, `/statements`
says the registry is empty, and `/cross` refuses every month. A committed seed
file with `lastReceived: null`, falling back when the live file is absent, keeps
mutable state in `data/` while making the configuration reviewable.

## 9. Ledgers are not pruned, and they hold the same movements as the PDF

The inbox sweeps statements after 60 days because they are the most sensitive
file the pipeline holds. `ledger-<account>-<month>.json` sits in the parent
directory with the same movements in plaintext, is included in the backup, and
has no retention at all.

## 10. A malformed `PERIODO` line drops the statement into the generic handler

`tryStatementRoute` returns `false` when detection fails to parse, which sends the
PDF to the "read it and propose a CSV" path the routing exists to avoid. Same for
a detection timeout. The failure is swallowed rather than reported.

## 11. The Telegram summary counts what was found, not what was written

`➕ Agregados del estado` uses `d.missing.length`, before held rows, ignored
instalments and skipped rows are removed. The pasted CSV block has the same
problem, and `rowsToCsv` drops `opdate`/`meses`/`montooriginal`, so a row
re-imported from that block loses the marker that would have excluded it.

## 12. Range keys are UTC while `recordDate` carries a local offset

`walletWindow` serialises with `toISOString()` (`…Z`) while records are written
by `toLocalIsoDateTime` as `…-06:00`. CouchDB compares `startkey`/`endkey` as
strings, so the ordering is lexicographic, not chronological, and the window is
skewed by the offset. Immaterial against a 5-day slack, but the window is not the
window the docstring describes.

## Smaller

- `monthKey`/`addMonths` are duplicated byte-for-byte between `registry.ts` and
  `statements-view.ts`.
- Four different definitions of "is this a transfer row"; `csv.ts`'s is the one
  that decides the flag actually written, and it does not match `"Traspaso"`.
- Nothing checks that every entry in `BOT_COMMANDS` has a registered handler.
- `statement-flow.test.ts`'s fixture is billed as verbatim CLI output and no
  longer is.
- `Coverage.complete` needs all fourteen statements for a month, which may never
  hold in practice; `/cross` would then stay permanently in its partial branch.
- `docker-compose.yml` still advertises `/statement`, the singular that never
  existed.
