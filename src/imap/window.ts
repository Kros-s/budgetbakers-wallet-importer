/** IMAP searches have day precision; pad the search, then filter exact instants. */
export function imapSearchWindow(from: Date, to: Date): { since: Date; before: Date } {
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) {
    throw new Error("Invalid email processing window");
  }
  const day = 86_400_000;
  return { since: new Date(from.getTime() - day), before: new Date(to.getTime() + day) };
}
export function inProcessingWindow(date: Date, from: Date, to: Date): boolean {
  return date >= from && date < to;
}
