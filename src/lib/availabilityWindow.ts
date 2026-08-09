/* THE SCOPED, EXPIRING AVAILABILITY WINDOW.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT `availability_date`.
 *
 * Counted across the owner's 112 stored application packets, the largest cluster of required-and-
 * blank questions is one fact asked five ways: when the internship can run. `availability_date` and
 * `availability_term` have held a value the whole time and the resolver has always refused to answer
 * from them, correctly. The reason is written into
 * questionDiscovery.test.ts's "legacy availability facts never authorize a new date, season,
 * duration, or cadence commitment": a bare stored date carries
 *   - no recruiting cycle, so it cannot be shown to be about THIS posting, and
 *   - no expiry, so a value typed for Summer 2026 answers a Summer 2027 form forever.
 * Answering from it is a commitment to an employer that the applicant never made, and she may be
 * held to it. That refusal stays exactly as it is; the legacy columns are reference data and this
 * module never reads them.
 *
 * WHAT A DECLARATION HAS TO CARRY BEFORE IT MAY ANSWER ANYTHING. Four values, all of them the
 * applicant's own words, none of them derived from another:
 *
 *   availability_window_start   ISO YYYY-MM-DD. The EARLIEST she could begin.
 *   availability_window_end     ISO YYYY-MM-DD. The LATEST she is available through.
 *   availability_cycle          "Summer 2027" - the recruiting cycle the window is ABOUT. This is
 *                               what makes the record scoped: a window with no cycle is the legacy
 *                               field again with extra digits.
 *   availability_valid_through  ISO YYYY-MM-DD. The explicit boundary after which this declaration
 *                               says nothing at all. Not derived from the window: a student may
 *                               well want her Summer 2027 answer to stop being used in March 2027
 *                               once she has accepted something, and only she knows that date.
 *
 * ALL FOUR OR NOTHING. A partial record resolves to null and every question falls back to the human.
 * The asymmetry is the whole design: an unanswered question costs one manual entry, and a wrong
 * availability date is a promise made in her name.
 */

/** The four stored columns, as the resolver sees them. undefined means never asked. */
export type AvailabilityWindowFacts = {
  availability_window_start?: string;
  availability_window_end?: string;
  availability_cycle?: string;
  availability_valid_through?: string;
};

/** A declaration that has passed every structural and expiry check. Dates are ISO YYYY-MM-DD. */
export type AvailabilityWindow = {
  start: string;
  end: string;
  /** Normalised "Summer 2027". */
  cycle: string;
  validThrough: string;
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SEASONS = ['spring', 'summer', 'fall', 'winter'] as const;
const CYCLE = new RegExp(String.raw`\b(${SEASONS.join('|')})\s+((?:20)\d{2})\b`, 'i');

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * An ISO date, or null.
 *
 * Deliberately strict. A free-text "June 2027" is NOT accepted here even though the codebase parses
 * that shape elsewhere for graduation dates: a graduation month is a fact being reported, and this
 * is a boundary being enforced. "June 2027" would have to be widened to a day to compare against a
 * posting, and choosing which day is inventing the edge of a commitment.
 */
function isoDate(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const match = ISO_DATE.exec(trimmed);
  if (!match) return null;
  const [, year, month, day] = match;
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects 2027-02-31, which Date rolls forward into March rather than refusing.
  if (parsed.getUTCFullYear() !== Number(year)) return null;
  if (parsed.getUTCMonth() + 1 !== Number(month)) return null;
  if (parsed.getUTCDate() !== Number(day)) return null;
  return trimmed;
}

/** Today in UTC as YYYY-MM-DD, so every comparison in this file is a plain string compare. */
function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * "Summer 2027" out of any text that names a season and a year, normalised to one capitalisation.
 *
 * Shared by the stored cycle and the posting's cycle ON PURPOSE. The comparison between them is only
 * meaningful if both sides were read by the same rule, and this is already the rule this codebase
 * trusts to say what cycle a posting is for (see postingSeasonAnswer, which answers "please confirm
 * the season you are applying for" from exactly this match).
 */
export function readCycle(text: string | undefined | null): string | null {
  const match = CYCLE.exec(text ?? '');
  if (!match) return null;
  const season = match[1].toLowerCase();
  return `${season.charAt(0).toUpperCase()}${season.slice(1)} ${match[2]}`;
}

/**
 * The stored declaration, if it is complete, coherent and still live. Otherwise null.
 *
 * Every rejection below leaves the employer's question for the applicant, which is the safe outcome.
 */
export function readAvailabilityWindow(
  facts: AvailabilityWindowFacts,
  now: Date,
): AvailabilityWindow | null {
  const start = isoDate(facts.availability_window_start);
  const end = isoDate(facts.availability_window_end);
  const validThrough = isoDate(facts.availability_valid_through);
  const cycle = readCycle(facts.availability_cycle);
  if (!start || !end || !validThrough || !cycle) return null;

  // A window that ends before it begins is a typo, and there is no reading of it that is safe.
  if (start > end) return null;

  const today = todayIso(now);

  // LAPSED. The applicant set this boundary herself; past it the record says nothing.
  if (validThrough < today) return null;

  /* SPENT. A window whose last day has already passed cannot describe availability for any posting,
   * whatever the expiry says. This is the case the expiry alone would miss: a student who set a
   * generous valid_through and then let the season go by would otherwise keep offering dates that
   * are behind her. */
  if (end < today) return null;

  /* The cycle and the window must be talking about the same year. This catches the one data-entry
   * error that would otherwise sail through every other check: cycle "Summer 2027" saved against a
   * window of 2026-06-01 to 2026-08-20, left over from last year's answer. Deliberately a YEAR
   * check and not a month-boundary check - employers disagree about when "Summer" ends, and a
   * refusal caused by our own calendar opinion would cost her answers she did give. */
  const cycleYear = cycle.split(' ')[1];
  if (cycleYear !== start.slice(0, 4) && cycleYear !== end.slice(0, 4)) return null;

  return { start, end, cycle, validThrough };
}

/**
 * The stored declaration, but ONLY if it is provably about the posting in hand.
 *
 * THE POSTING HAS TO NAME ITS CYCLE. When the job description does not say which season and year it
 * is for, coverage cannot be established, and this returns null rather than assuming the stored
 * window applies. That is the strict reading on purpose: "her window has not lapsed" is not the same
 * claim as "her window covers this job", and only the second one authorises an answer.
 */
export function availabilityWindowForPosting(
  facts: AvailabilityWindowFacts,
  jdText: string | undefined,
  now: Date,
): AvailabilityWindow | null {
  const stored = readAvailabilityWindow(facts, now);
  if (!stored) return null;
  const posting = readCycle(jdText);
  if (!posting) return null;
  return posting === stored.cycle ? stored : null;
}

/** "2027-06-01" as the control wants it: ISO for a date picker, "June 1, 2027" for anything else. */
export function formatWindowDate(iso: string, inputType: string | undefined): string {
  if (inputType === 'date') return iso;
  const match = ISO_DATE.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  return `${MONTH_NAMES[Number(month) - 1]} ${Number(day)}, ${year}`;
}

/** Both ends of the window, for a question that asked for both. */
export function formatWindowRange(window: AvailabilityWindow, inputType: string | undefined): string {
  /* A native date picker holds ONE date and cannot hold a range, so a range question rendered as
   * `input[type=date]` gets the start: the earliest date she declared she could begin. It is the
   * only value of the two that a single date control can be asked for, it is her own figure, and it
   * understates rather than overstates the commitment. */
  if (inputType === 'date') return window.start;
  return `${formatWindowDate(window.start, inputType)} to ${formatWindowDate(window.end, inputType)}`;
}
