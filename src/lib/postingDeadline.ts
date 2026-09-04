import type { ApplicationReviewState } from './applicationReview';

/**
 * A conservative reader of an employer's OWN STATED APPLICATION DEADLINE, from free-form English
 * job-description prose.
 *
 * MEASURED CASE, 2026-09-04/05: Mercari's "Class of 2028 Software Engineer Internship" (Workable,
 * `apply.workable.com/mercari/j/EC5A1078C4`) shows "READY - Litos can send this application for
 * you" while its own jd_text says "Application Deadline: August 31, 2026, 23:59 (JST)". Workable's
 * public API still answers `state: published` for it, so this is not a take-down (see
 * applicationPortalRepair.ts's monitor-inactive check, the other half of this feature) - the
 * posting is still live, but the EMPLOYER'S OWN TEXT says it stopped taking applications weeks ago.
 * Nothing upstream of this file ever read that sentence; it was captured, verbatim, at packet
 * creation, and simply never looked at again.
 *
 * CONSERVATIVE ON PURPOSE, matching the brief this shipped against: only four fixed English label
 * phrases are recognised ("Application Deadline:", "Deadline:", "Apply by", "Applications close"),
 * only a month-NAME date with an explicit year counts (no "08/31/2026" - MM/DD or DD/MM is a guess
 * this file refuses to make), and a parenthesised timezone abbreviation that is not on the short
 * known list below is treated as ambiguous and the WHOLE match is refused rather than silently
 * assumed to be UTC. A parser that occasionally misses a real deadline is a missed flag; a parser
 * that occasionally invents a wrong one tells an applicant Litos will not send something it safely
 * could, which is the worse failure for a tool she is trusting to act on her behalf.
 *
 * PURE, DELIBERATELY. This runs at packet-creation time (managedPrepare.ts, against a fresh
 * monitored_jobs.description) and, just as importantly, at READ time against a packet's own
 * already-frozen jd_text - which is what lets an application prepared before this shipped start
 * flagging immediately, with no rebuild, no repoll and no monitored_jobs dependency at all. See
 * derivePostingDeadlineStatus below.
 */

export type StatedDeadline = {
  /** The exact instant the parser computed, in UTC. What "has this passed" compares `now` against. */
  deadlineUtc: Date;
  /**
   * The employer's OWN calendar date, as written ("August 31, 2026") - not the UTC calendar date
   * derived from deadlineUtc, which can fall a day earlier or later once a stated time and zone are
   * converted. Shown to the applicant so the sentence she reads names the date the posting itself
   * named, never a UTC-shifted one that reads as if Litos got it wrong.
   */
  displayDate: string;
};

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const MONTH_DISPLAY_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/* A short, deliberately incomplete list of the zone abbreviations actually measured on job
 * postings. Anything not here is refused rather than guessed - see the file header. Offsets are
 * STANDARD TIME, not DST-adjusted: a job posting's own deadline is rarely worth modelling daylight
 * saving for, and the alternative (silently picking a wrong hour half the year) is worse than the
 * conservative one-hour-off a DST abbreviation like EDT already names explicitly. */
const ZONE_OFFSET_MINUTES: Readonly<Record<string, number>> = {
  UTC: 0, GMT: 0,
  EST: -5 * 60, EDT: -4 * 60,
  CST: -6 * 60, CDT: -5 * 60,
  MST: -7 * 60, MDT: -6 * 60,
  PST: -8 * 60, PDT: -7 * 60,
  AKST: -9 * 60, AKDT: -8 * 60,
  JST: 9 * 60,
  KST: 9 * 60,
  IST: 5 * 60 + 30, // India Standard Time - the reading an English-language job posting means.
  BST: 1 * 60,
  CET: 1 * 60, CEST: 2 * 60,
  SGT: 8 * 60,
  HKT: 8 * 60,
  AEST: 10 * 60, AEDT: 11 * 60,
};

const MONTH_NAME_PATTERN = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

/* Anchored to the START of the text handed to it (see parseStatedApplicationDeadline, which slices
 * the text right after a label match before running this). Requires a day and a four-digit year;
 * time and a parenthesised zone are optional. "August 31, 2026, 23:59 (JST)" and "August 31 2026"
 * both match; "August 2026" (no day) and "08/31/2026" (no month name) both do not. */
const MONTH_DAY_YEAR_RE = new RegExp(
  `^(${MONTH_NAME_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`
  + '(?:,?\\s+(\\d{1,2}):(\\d{2})(?::\\d{2})?\\s*(?:\\(([A-Za-z]{2,6})\\))?)?',
  'i',
);

/* The four label phrases the brief names, colon optional on all of them so "Apply by:" also
 * matches - permissive there costs nothing since the date grammar right after it still has to
 * parse clean. Global so parseStatedApplicationDeadline can walk every occurrence in a long
 * description, not just the first. */
function labelPattern(): RegExp {
  return /(?:application\s+deadline|deadline|apply\s+by|applications?\s+clos(?:e|es|ing))\s*:?\s*/gi;
}

/** How far past a label match this looks for a date before giving up on that occurrence. */
const DATE_LOOKAHEAD_CHARS = 60;

function toStatedDeadline(match: RegExpExecArray): StatedDeadline | null {
  const [, monthRaw, dayRaw, yearRaw, hourRaw, minuteRaw, zoneRaw] = match;
  const monthIndex = MONTHS[(monthRaw ?? '').toLowerCase().replace(/\.$/, '')];
  if (monthIndex === undefined) return null;
  const day = Number(dayRaw);
  const year = Number(yearRaw);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  // A plausible range, not a real calendar bound - Date.UTC below is the actual validity check
  // (it rolls an invalid day like Feb 31 into the next month, which the comparison after catches).
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;

  let hour = 23;
  let minute = 59;
  let second = 59;
  let offsetMinutes = 0;
  if (hourRaw !== undefined && minuteRaw !== undefined) {
    hour = Number(hourRaw);
    minute = Number(minuteRaw);
    second = 0;
    if (hour > 23 || minute > 59) return null;
    if (zoneRaw !== undefined) {
      const offset = ZONE_OFFSET_MINUTES[zoneRaw.toUpperCase()];
      // An explicit zone this file does not recognise is exactly the ambiguity the header
      // describes: refuse the whole match rather than silently assume UTC for it.
      if (offset === undefined) return null;
      offsetMinutes = offset;
    }
    // No zone stated at all with an explicit time: assumed UTC, documented in the file header.
  }
  // No time stated at all: treated as the end of the stated calendar day, UTC - "the deadline is
  // August 31" reads as "you have through August 31", not "August 31 at midnight".

  // Validated BEFORE the zone offset shifts the instant: Date.UTC silently rolls an out-of-range
  // day (Feb 31) into the next month rather than failing, so a round-trip check against the naive
  // (still zone-free) fields is what catches "February 31, 2026". Checking after the offset shift
  // would also reject the many valid dates that legitimately land on a different UTC day once
  // converted, which is not a defect - it is the entire point of applying the zone at all.
  const naiveMillis = Date.UTC(year, monthIndex, day, hour, minute, second);
  const naive = new Date(naiveMillis);
  if (naive.getUTCFullYear() !== year || naive.getUTCMonth() !== monthIndex || naive.getUTCDate() !== day) {
    return null;
  }
  const deadlineUtc = new Date(naiveMillis - offsetMinutes * 60_000);

  return {
    deadlineUtc,
    displayDate: `${MONTH_DISPLAY_NAMES[monthIndex]} ${day}, ${year}`,
  };
}

/**
 * Find the employer's stated application deadline in free-form job-description text, if this file
 * can read one confidently. See the module header for exactly what counts and what does not.
 */
export function parseStatedApplicationDeadline(text: string | null | undefined): StatedDeadline | null {
  if (!text) return null;
  const label = labelPattern();
  let labelMatch: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((labelMatch = label.exec(text))) {
    const start = labelMatch.index + labelMatch[0].length;
    const candidate = text.slice(start, start + DATE_LOOKAHEAD_CHARS);
    const dateMatch = MONTH_DAY_YEAR_RE.exec(candidate);
    if (dateMatch) {
      const parsed = toStatedDeadline(dateMatch);
      if (parsed) return parsed;
    }
    // A label with no clean date after it (a false positive like "deadline-driven environment", or
    // a real deadline this file cannot confidently parse) is not the only occurrence necessarily -
    // keep walking the rest of the text rather than giving up on the whole description.
  }
  return null;
}

/**
 * A take-down (posting_status.state 'closed') OUTRANKS a stated deadline: the employer's own
 * missing posting is stronger evidence than a sentence in a description that might be stale in
 * either direction, and applicationPortalRepair.ts's monitor-inactive check already ran by the
 * time this is called on every read path that uses both (see applications.ts, resume.ts). Left
 * untouched here rather than overwritten.
 */
export function derivePostingDeadlineStatus(
  review: ApplicationReviewState,
  now: Date = new Date(),
): ApplicationReviewState {
  if (review.posting_status?.state === 'closed') return review;

  const stated = parseStatedApplicationDeadline(review.jd_text);
  if (!stated) return review;
  if (now.getTime() <= stated.deadlineUtc.getTime()) return review;

  /* THE PERSISTED FIELD IS THE ONLY SOURCE OF TRUTH, always, never `review.posting_status`'s own
   * nested copy: that copy is written by THIS function, on a possibly-earlier read, and trusting it
   * back would let a stale 'deadline_passed' object with no confirmation shadow a confirmation that
   * landed since. posting_confirmed_open_at is the one fact about this that is ever stored (see its
   * own doc comment on ApplicationReviewState) - re-deriving posting_status from it here, every
   * time, is what keeps the two from disagreeing. */
  const confirmedOpenAt = review.posting_confirmed_open_at;
  const postingStatus: ApplicationReviewState['posting_status'] = {
    state: 'deadline_passed',
    reason: 'stated_deadline',
    deadline: stated.deadlineUtc.toISOString(),
    ...(confirmedOpenAt ? { confirmed_open_at: confirmedOpenAt } : {}),
  };
  if (confirmedOpenAt) {
    // She has already told Litos the employer still accepts applications for this one - keep the
    // review sendable and quiet about it beyond carrying the status for display. Re-litigating the
    // attention sentence and portal_supported on every read would undo her own confirmation.
    return { ...review, posting_status: postingStatus };
  }
  return {
    ...review,
    posting_status: postingStatus,
    portal_supported: false,
    attention_reason: `This posting's stated deadline (${stated.displayDate}) has passed. Litos will `
      + 'not send it unless you confirm the employer still accepts applications.',
    attention_categories: ['posting_closed'],
  };
}
