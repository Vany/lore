/**
 * How long ago something happened, in words a client can act on.
 *
 * Written for one sentence and kept pure so it can be tested without a clock: the
 * inbox has to tell a caller how long a review has been sitting untouched, because
 * that is the ONLY fact lore holds that distinguishes the two things a quiet review
 * can mean.
 *
 * The incident, 2026-09-03. A client asked whether everything was ready, read
 * `new_findings: 0` on three reviews in `findings_ready`, and reported back that "the
 * agents already collected them and are working the fixes". Nothing lore returned said
 * that or could have: lore cannot see sessions, so a client mid-fix and a client that
 * ended four days ago produce byte-identical inbox rows. The client filled the gap with
 * the more comfortable of the two readings and told a person the work was in hand.
 *
 * A raw timestamp does not close that gap — reasoning badly from a number is exactly
 * what went wrong — so the boundary hands over the interpretation, not the arithmetic.
 * The buckets are chosen for the decision being made rather than for precision: under
 * an hour is somebody who is probably still there, days are somebody who is not, and
 * the granularity between them never changes what a reader should do.
 */
export function elapsedWords(sinceIso: string, now: number = Date.now()): string {
  const ms = now - Date.parse(sinceIso);
  // An unparseable or future timestamp says so rather than rendering "NaN days" or a
  // confident "0 minutes". A clock that disagrees with itself is a fact about lore, and
  // INV-1's rule applies to small claims too: no silent tidy answer for something that
  // was not measured.
  if (!Number.isFinite(ms)) return "an unknown time";
  if (ms < 0) return "no time at all (its last movement is in the future — lore's clock and this record disagree)";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${String(days)} days`;
}
