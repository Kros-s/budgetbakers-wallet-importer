import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMonthWindow,
  formatAccountPeriods,
  isNearAccountBoundary,
  periodFor,
  periodFromCutDay,
  resolveAccountPeriod,
  splitAtAccountBoundary,
  unionPeriod,
  walletFetchRange,
  type LedgerPeriodInput,
} from "../../statements/month-window.js";

/** The three real accounts this whole problem was found on. */
const CUT_DAYS = {
  Costco: { cutDay: 8 },
  Meli: { cutDay: 21 },
  MIFEL: { cutDay: 28 },
  Bancomer: { cutDay: 16 },
};

const led = (account: string, from?: string, to?: string): LedgerPeriodInput =>
  ({ account, period: from && to ? { from, to } : null });

// ---------------------------------------------------------------------------
// periodFromCutDay
// ---------------------------------------------------------------------------

test("a statement belongs to the month its cut date falls in, so the period closes inside that month", () => {
  // Costco cuts on the 8th: its "July" statement is 9-jun..8-jul, not 1-jul..31-jul.
  // Reading it as the calendar month is what left 19 of its days with no Wallet
  // candidate and turned every one of them into a false orphan.
  assert.deepEqual(periodFromCutDay("2026-07", 8), { from: "2026-06-09", to: "2026-07-08" });
  // Meli cuts on the 21st — the ledger on disk declares exactly this.
  assert.deepEqual(periodFromCutDay("2026-07", 21), { from: "2026-06-22", to: "2026-07-21" });
});

test("an end-of-month account derives the calendar month rather than a 29th-to-28th period", () => {
  // The registry caps cutDay at 28 so February still has the day. MIFEL is
  // stored as 28 and its statement declares 1-jul..31-jul; deriving
  // 29-jun..28-jul would invent a period the bank never used and push 29-jul,
  // 30-jul and 31-jul out of the month they were filed under.
  assert.deepEqual(periodFromCutDay("2026-07", 28), { from: "2026-07-01", to: "2026-07-31" });
  assert.deepEqual(periodFromCutDay("2026-02", 28), { from: "2026-02-01", to: "2026-02-28" });
});

test("a January period opens in December of the previous year", () => {
  // The open date is computed by stepping a month back; January must not wrap
  // to December of the SAME year, which would put the window a year in the future.
  assert.deepEqual(periodFromCutDay("2026-01", 8), { from: "2025-12-09", to: "2026-01-08" });
});

test("a period opening in February lands on a real day", () => {
  // Cut day 2 opens on the 3rd of the previous month; short months must not
  // roll the open date into the named month itself.
  assert.deepEqual(periodFromCutDay("2026-03", 2), { from: "2026-02-03", to: "2026-03-02" });
  assert.deepEqual(periodFromCutDay("2026-03", 24), { from: "2026-02-25", to: "2026-03-24" });
});

test("every cut day in use produces a period that closes in the named month", () => {
  // The nine cut days actually on file: 2, 6, 8, 10, 13, 16, 21, 24, 28.
  for (const cut of [2, 6, 8, 10, 13, 16, 21, 24, 28]) {
    for (const month of ["2026-01", "2026-02", "2026-03", "2026-07", "2026-12"]) {
      const p = periodFromCutDay(month, cut);
      assert.ok(p.from < p.to, `${month}/${cut}: ${p.from}..${p.to} está al revés`);
      assert.equal(p.to.slice(0, 7), month, `${month}/${cut}: cierra fuera del mes`);
    }
  }
});

// ---------------------------------------------------------------------------
// resolveAccountPeriod — precedence
// ---------------------------------------------------------------------------

test("the period the statement declares beats anything derived from the registry", () => {
  // The document prints its own period on page one; our arithmetic never
  // overrules it. Costco slides its cut to Friday the 6th when the 8th is a
  // Sunday, and only the PDF knows that happened.
  const got = resolveAccountPeriod("Costco", "2026-03", { from: "2026-02-07", to: "2026-03-06" }, 8);
  assert.deepEqual(got.period, { from: "2026-02-07", to: "2026-03-06" });
  assert.equal(got.source, "declared");
});

test("a ledger with no declared period falls back to the registry cut day, not the calendar", () => {
  // Older extractions banked `period: null`. Falling straight to the calendar
  // month there is the original bug in miniature.
  const got = resolveAccountPeriod("Costco", "2026-07", null, 8);
  assert.deepEqual(got.period, { from: "2026-06-09", to: "2026-07-08" });
  assert.equal(got.source, "cutDay");
});

test("an account in neither the ledger nor the registry falls back to the calendar month last", () => {
  const got = resolveAccountPeriod("Cuenta nueva", "2026-07", null, undefined);
  assert.deepEqual(got.period, { from: "2026-07-01", to: "2026-07-31" });
  assert.equal(got.source, "calendar");
});

test("a malformed declared period is discarded instead of being trusted", () => {
  // A backwards period would make the union span nonsense and the boundary test
  // meaningless; the cut day is a better answer than a corrupt one.
  const got = resolveAccountPeriod("Meli", "2026-07", { from: "2026-07-21", to: "2026-06-22" }, 21);
  assert.equal(got.source, "cutDay");
  assert.deepEqual(got.period, { from: "2026-06-22", to: "2026-07-21" });
});

// ---------------------------------------------------------------------------
// unionPeriod / buildMonthWindow / walletFetchRange
// ---------------------------------------------------------------------------

test("the union spans from the earliest open to the latest close of the month", () => {
  const got = unionPeriod([
    { from: "2026-06-09", to: "2026-07-08" }, // Costco
    { from: "2026-06-22", to: "2026-07-21" }, // Meli
    { from: "2026-07-01", to: "2026-07-31" }, // MIFEL
  ]);
  assert.deepEqual(got, { from: "2026-06-09", to: "2026-07-31" });
});

test("an empty month still yields a window, falling back to the calendar month", () => {
  assert.equal(unionPeriod([]), null);
  const w = buildMonthWindow("2026-07", [], CUT_DAYS);
  assert.deepEqual(w.span, { from: "2026-07-01", to: "2026-07-31" });
  assert.deepEqual(w.accounts, []);
});

test("one Wallet fetch covers every account's period, including the days before the calendar month", () => {
  // The failure: `/cross 2026-07` queried Wallet for 27-jun..4-ago. Costco rows
  // dated 9-jun..26-jun were crossed against records that were never fetched,
  // so all of them surfaced as orphan legs.
  const w = buildMonthWindow("2026-07", [
    led("Costco", "2026-06-09", "2026-07-08"),
    led("Meli", "2026-06-22", "2026-07-21"),
    led("MIFEL", "2026-07-01", "2026-07-31"),
  ], CUT_DAYS);
  assert.deepEqual(w.span, { from: "2026-06-09", to: "2026-07-31" });

  const { from, to } = walletFetchRange(w);
  // Costco's first day, minus the posting lag, is inside the fetch.
  assert.ok(Date.parse(from) <= Date.parse("2026-06-04T00:00:00"), `abre demasiado tarde: ${from}`);
  // MIFEL's last day, plus the posting lag, is inside the fetch.
  assert.ok(Date.parse(to) >= Date.parse("2026-08-05T23:59:59"), `cierra demasiado pronto: ${to}`);
});

test("the fetch range is widened by the posting lag, not just by the periods", () => {
  // A movement operated on the last day of a period can post five days later
  // (Banamex's measured maximum). Querying the bare span would miss the Wallet
  // record that the statement row is supposed to match.
  const w = buildMonthWindow("2026-07", [led("MIFEL", "2026-07-01", "2026-07-31")], CUT_DAYS);
  const { from, to } = walletFetchRange(w);
  assert.ok(Date.parse(from) <= Date.parse("2026-06-26T00:00:00"), `abre demasiado tarde: ${from}`);
  assert.ok(Date.parse(to) >= Date.parse("2026-08-05T23:59:59"), `cierra demasiado pronto: ${to}`);
});

test("a single fetch is enough — one range contains every account's own window", () => {
  // The whole point of the union: the command must not need one CouchDB query
  // per account. Every per-account window, slack included, has to fit inside it.
  const ledgers = [
    led("Costco", "2026-06-09", "2026-07-08"),
    led("Meli", "2026-06-22", "2026-07-21"),
    led("MIFEL", "2026-07-01", "2026-07-31"),
    led("Bancomer"), // no declared period: derived 17-jun..16-jul
  ];
  const w = buildMonthWindow("2026-07", ledgers, CUT_DAYS);
  const outer = walletFetchRange(w);
  for (const a of w.accounts) {
    // Compare against the same widening applied to that account alone.
    const own = walletFetchRange({ month: "2026-07", span: a.period, accounts: [] });
    assert.ok(Date.parse(outer.from) <= Date.parse(own.from), `${a.account}: la unión abre tarde`);
    assert.ok(Date.parse(outer.to) >= Date.parse(own.to), `${a.account}: la unión cierra pronto`);
  }
});

test("an account whose ledger declares no period still widens the union by its cut day", () => {
  // Bancomer cuts on the 16th, so its July opens 17-jun — eleven days before
  // the earliest date the calendar window would ever have asked Wallet for.
  const w = buildMonthWindow("2026-07", [led("Bancomer")], CUT_DAYS);
  assert.deepEqual(w.span, { from: "2026-06-17", to: "2026-07-16" });
  assert.equal(w.accounts[0].source, "cutDay");
});

test("the window reports one entry per contributing account and none for the rest", () => {
  // The registry holds fourteen accounts; only the ones with an extraction for
  // the month contribute rows, so only those need coverage or a boundary test.
  const w = buildMonthWindow("2026-07", [
    led("Meli", "2026-06-22", "2026-07-21"),
    led("MIFEL", "2026-07-01", "2026-07-31"),
  ], CUT_DAYS);
  assert.deepEqual(w.accounts.map((a) => a.account), ["Meli", "MIFEL"]);
  assert.deepEqual(w.accounts.map((a) => a.source), ["declared", "declared"]);
});

test("an account outside the window is judged by the calendar month rather than crashing", () => {
  const w = buildMonthWindow("2026-07", [led("Meli", "2026-06-22", "2026-07-21")], CUT_DAYS);
  assert.deepEqual(periodFor(w, "Meli"), { from: "2026-06-22", to: "2026-07-21" });
  assert.deepEqual(periodFor(w, "Stocks"), { from: "2026-07-01", to: "2026-07-31" });
});

// ---------------------------------------------------------------------------
// Per-account boundary
// ---------------------------------------------------------------------------

const WINDOW = buildMonthWindow("2026-07", [
  led("Costco", "2026-06-09", "2026-07-08"),
  led("Meli", "2026-06-22", "2026-07-21"),
  led("MIFEL", "2026-07-01", "2026-07-31"),
], CUT_DAYS);

const row = (account: string, date: string, opTime?: number) => ({ account, date, opTime });

test("a row is judged against its own statement period, not the calendar month", () => {
  // 8-jul is Costco's cut — the riskiest day it has — and the calendar test
  // called it safely inside July. 15-jul is the dead centre of MIFEL's period
  // and nowhere near an edge.
  assert.equal(isNearAccountBoundary(row("Costco", "2026-07-08"), WINDOW), true);
  assert.equal(isNearAccountBoundary(row("MIFEL", "2026-07-15"), WINDOW), false);
});

test("the middle of an account's period is decidable even when it sits at the edge of the calendar month", () => {
  // Costco's 1-jul and 2-jul are three weeks into its statement and more than
  // five days from its 8-jul cut. The calendar test deferred them for being
  // near 1-jul, holding back rows that had nothing to wait for while the real
  // edges went through.
  assert.equal(isNearAccountBoundary(row("Costco", "2026-07-01"), WINDOW), false);
  assert.equal(isNearAccountBoundary(row("Costco", "2026-07-02"), WINDOW), false);
  // 3-jul is five days out, so it IS at the edge — of Costco's cut, not July's.
  assert.equal(isNearAccountBoundary(row("Costco", "2026-07-03"), WINDOW), true);
  // Meli's 30-jun is likewise mid-statement.
  assert.equal(isNearAccountBoundary(row("Meli", "2026-06-30"), WINDOW), false);
});

test("the opening edge of a mid-month period is deferred even though it is in the previous calendar month", () => {
  // Costco opens 9-jun. A purchase there may have been charged to the June
  // statement instead; the calendar test never even looked at June.
  assert.equal(isNearAccountBoundary(row("Costco", "2026-06-09"), WINDOW), true);
  assert.equal(isNearAccountBoundary(row("Costco", "2026-06-11"), WINDOW), true);
  assert.equal(isNearAccountBoundary(row("Costco", "2026-06-16"), WINDOW), false);
});

test("the boundary still reaches five days, the widest measured posting lag", () => {
  // Banamex: 183 movements, 95% within 3 days, maximum 5. A tighter window
  // calls a real end-of-period movement settled while its counterpart is still
  // in next month's statement.
  assert.equal(isNearAccountBoundary(row("Meli", "2026-07-16"), WINDOW), true);  // 5 before the 21st
  assert.equal(isNearAccountBoundary(row("Meli", "2026-07-15"), WINDOW), false); // 6 before
  assert.equal(isNearAccountBoundary(row("Meli", "2026-07-26"), WINDOW), true);  // 5 after
  assert.equal(isNearAccountBoundary(row("Meli", "2026-07-27"), WINDOW), false); // 6 after
});

test("the operation date counts as an edge as well as the posting date", () => {
  // Statements print both, and the counterpart in another account may be dated
  // by either. A row operated on Costco's cut and posted four days later is
  // still a row that may belong to the next statement.
  const opAtCut = Date.parse("2026-07-08T12:00:00");
  assert.equal(isNearAccountBoundary(row("Costco", "2026-07-08"), WINDOW), true);
  // Posted well inside MIFEL's month, but operated at MIFEL's opening edge.
  const opAtOpen = Date.parse("2026-07-02T12:00:00");
  assert.equal(isNearAccountBoundary(row("MIFEL", "2026-07-20", opAtOpen), WINDOW), true);
  // And a row with a harmless operation date is not dragged to the edge by it.
  assert.equal(isNearAccountBoundary(row("MIFEL", "2026-07-20", Date.parse("2026-07-18T12:00:00")), WINDOW), false);
  assert.equal(isNearAccountBoundary(row("Costco", "2026-07-08", opAtCut), WINDOW), true);
});

test("an unparseable or absent operation date does not defer a row on its own", () => {
  assert.equal(isNearAccountBoundary(row("MIFEL", "2026-07-15", NaN), WINDOW), false);
  assert.equal(isNearAccountBoundary(row("MIFEL", "2026-07-15", undefined), WINDOW), false);
});

test("the split holds back the edge rows of each account and lets the interiors through", () => {
  const rows = [
    row("Costco", "2026-06-09"), // Costco's opening edge — deferred
    row("Costco", "2026-07-01"), // mid-statement for Costco — through
    row("Costco", "2026-07-08"), // Costco's cut — deferred
    row("Meli", "2026-07-05"),   // mid-statement for Meli — through
    row("Meli", "2026-07-21"),   // Meli's cut — deferred
    row("MIFEL", "2026-07-15"),  // dead centre — through
    row("MIFEL", "2026-07-31"),  // month end, and MIFEL's cut — deferred
  ];
  const { deferred, inside } = splitAtAccountBoundary(rows, WINDOW);
  assert.deepEqual(
    deferred.map((r) => `${r.account} ${r.date}`),
    ["Costco 2026-06-09", "Costco 2026-07-08", "Meli 2026-07-21", "MIFEL 2026-07-31"]
  );
  assert.deepEqual(
    inside.map((r) => `${r.account} ${r.date}`),
    ["Costco 2026-07-01", "Meli 2026-07-05", "MIFEL 2026-07-15"]
  );
});

test("the same date is deferred for one account and decided for another", () => {
  // This is the invariant the calendar month cannot express: 8-jul is Costco's
  // cut and an ordinary Tuesday for MIFEL. One window, two verdicts.
  const { deferred, inside } = splitAtAccountBoundary(
    [row("Costco", "2026-07-08"), row("MIFEL", "2026-07-08")],
    WINDOW
  );
  assert.deepEqual(deferred.map((r) => r.account), ["Costco"]);
  assert.deepEqual(inside.map((r) => r.account), ["MIFEL"]);
});

test("the split loses no row and duplicates none", () => {
  const rows = [
    row("Costco", "2026-06-20"), row("Meli", "2026-07-21"), row("MIFEL", "2026-07-31"),
    row("Stocks", "2026-07-15"), // not in the window at all
  ];
  const { deferred, inside } = splitAtAccountBoundary(rows, WINDOW);
  assert.equal(deferred.length + inside.length, rows.length);
  assert.deepEqual(new Set([...deferred, ...inside]), new Set(rows));
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test("the report names the period each account contributes and where it came from", () => {
  // Seeing "calendario" in the output is how a missing registry entry gets
  // noticed: that account is being judged by the very assumption that produced
  // the false orphans.
  const w = buildMonthWindow("2026-07", [
    led("Costco", "2026-06-09", "2026-07-08"),
    led("Bancomer"),
    led("Stocks"),
  ], CUT_DAYS);
  const out = formatAccountPeriods(w);
  assert.match(out, /Costco\s+2026-06-09\.\.2026-07-08\s+declarado/);
  assert.match(out, /Bancomer\s+2026-06-17\.\.2026-07-16\s+corte 16/);
  assert.match(out, /Stocks\s+2026-07-01\.\.2026-07-31\s+calendario/);
  assert.equal(out.split("\n").length, 3);
});

test("a month with no extractions says so instead of printing an empty block", () => {
  assert.match(formatAccountPeriods(buildMonthWindow("2026-07", [], CUT_DAYS)), /Sin extracciones de 2026-07/);
});
