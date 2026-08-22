/**
 * @file statements/period.ts
 * @description The window a statement actually covers, and the window Wallet
 * gets asked about.
 *
 * These were the same thing until they weren't. The reconciler compared a
 * statement against Wallet's records for the CALENDAR month named by --month,
 * which is right only for accounts whose statement is a calendar month. A
 * credit card that cuts mid-month breaks it: Costco's "March" statement runs
 * 7-feb to 6-mar, so against a 26-feb→4-apr window, 19 of its 28 days find no
 * candidate at all. They land in `missing`, and --write books every one of them
 * a second time. This path has no Wallet dedup behind it — that safeguard
 * covers the batch and the Telegram confirmation, not this CLI.
 */

export interface StatementPeriod {
  /** YYYY-MM-DD, inclusive. */
  from: string;
  /** YYYY-MM-DD, inclusive. */
  to: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads the `PERIODO: YYYY-MM-DD..YYYY-MM-DD` line the extractor is asked to
 * emit. The statement prints its own period on page one — every format seen so
 * far does — so the authority is the document, not our arithmetic.
 */
export function parsePeriodLine(text: string): StatementPeriod | null {
  const m = /PERIODO:\s*(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})/.exec(text);
  if (!m) return null;
  const [, from, to] = m;
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) return null;
  return { from, to };
}

/** The fallback: the calendar month itself, which is what the old code assumed. */
export function calendarPeriod(month: string): StatementPeriod {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** The Wallet query range: the period widened by the matcher's date slack. */
export function walletWindow(period: StatementPeriod, slackDays: number): { from: string; to: string } {
  const [fy, fm, fd] = period.from.split("-").map(Number);
  const [ty, tm, td] = period.to.split("-").map(Number);
  return {
    from: new Date(fy, fm - 1, fd - slackDays).toISOString(),
    to: new Date(ty, tm - 1, td + slackDays + 1).toISOString(),
  };
}

function isLastDayOfMonth(day: string): boolean {
  const [y, m, d] = day.split("-").map(Number);
  return d === new Date(y, m, 0).getDate();
}

/**
 * Flags a period whose close does not look like the cut day on file.
 *
 * Real cut dates drift — Costco cuts on the 8th and slides to Friday the 6th
 * when the 8th is a Sunday — so this tolerates a few days. It is here to catch
 * the wrong PDF filed against the wrong account, not to police the calendar.
 */
export function cutDayMismatch(period: StatementPeriod, cutDay: number, toleranceDays = 5): string | null {
  const closingDay = Number(period.to.split("-")[2]);
  // An end-of-month account is stored as 28 because the registry caps it there;
  // a period closing on the 30th or 31st is the same thing, not a mismatch.
  if (cutDay >= 28 && isLastDayOfMonth(period.to)) return null;
  if (Math.abs(closingDay - cutDay) <= toleranceDays) return null;
  return `el estado cierra el día ${closingDay} y el registro dice corte ${cutDay} — ¿es el PDF de esta cuenta?`;
}
