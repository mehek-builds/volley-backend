/**
 * The slice of a job description worth scoring, computed once at poll time.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ranking scores `left(description, SCORING_CHARS)`, a prefix of whatever the board returned. That
 * is crude in two directions at once, and both of them cost something real:
 *
 *  - IT READS TOO MUCH. `description` is an unbounded `text` column of employer prose. Pulling a
 *    multi-kilobyte prefix for every pooled row, on every ranking miss, was the largest single
 *    reader of bytes out of Neon in this backend, and it exhausted the free tier's 5 GB/month
 *    transfer allowance, which suspends the compute for the rest of the billing period.
 *  - IT READS THE WRONG PART. A prefix is whatever the employer put first, which is usually a
 *    company blurb. The terms that decide fit are in the requirements block, and lowering the cap
 *    to save bytes walks straight into cutting that block off. Cost and quality pull in opposite
 *    directions as long as the unit being read is "the first N characters".
 *
 * A digest breaks that trade. It is computed ONCE, when the description arrives at poll time, and
 * stored in `monitored_jobs.description_digest`. Writes are ingress, which Neon does not bill, so
 * this moves the work to the side of the connection that is free. The read then fetches roughly 2 KB
 * of already-relevant text instead of a multi-kilobyte prefix that is mostly preamble.
 *
 * WHAT IT KEEPS
 * -------------
 * The requirements block if the posting has a recognisable one, otherwise the opening prose. That
 * ordering is the whole point: an employer who buries requirements behind 4 KB of mission statement
 * gets the requirements, where a prefix would have got the mission statement.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a summary, not a parse, and not a promise. It is a heuristic slice, and it is allowed to be
 * wrong: the worst case is that a posting scores off its intro, which is exactly what EVERY posting
 * did before this file existed. Nothing downstream may treat the digest as structured, and nothing
 * may assume it is non-null (see the coalesce in jobMonitor.ts, which covers rows polled before this
 * column existed).
 */

/**
 * How much of a posting the digest keeps.
 *
 * Roughly 2 KB, against SCORING_CHARS' 6 KB fallback. Sized to hold a requirements block, which
 * runs a few hundred to a low thousand characters on the postings in this corpus, plus enough
 * surrounding context that a scorer sees the role and not just a bullet list. Going much below this
 * starts truncating genuinely long requirement sections at large employers.
 */
export const DIGEST_CHARS = 2_000;

/**
 * Headings that introduce the part of a posting that describes the JOB rather than the COMPANY.
 *
 * Deliberately broad, and deliberately ordered by how reliably each one introduces requirements
 * rather than by how common it is. "Requirements" and the qualifications family are unambiguous;
 * "responsibilities" and "what you'll do" describe the work, which carries nearly as much scorable
 * vocabulary; "about you" and "who you are" are the softer phrasings of the same section.
 *
 * Not anchored to line starts with a heading syntax, because there is no heading syntax to anchor
 * to: descriptions arrive from a dozen ATS platforms as HTML converted to text by whatever each
 * adapter does, so a "heading" may be a bare line, a bolded run, or a bullet. Matching the phrase
 * near a line boundary is the most that can be relied on across all of them.
 */
const SECTION_PATTERNS: RegExp[] = [
  /^[^\S\n]*(?:minimum|basic|preferred|required)\s+qualifications\b.*$/im,
  /^[^\S\n]*(?:requirements|qualifications)\b.*$/im,
  /^[^\S\n]*what\s+(?:you'?ll|you\s+will)\s+(?:need|bring)\b.*$/im,
  /^[^\S\n]*what\s+we'?re\s+looking\s+for\b.*$/im,
  /^[^\S\n]*(?:responsibilities|what\s+you'?ll\s+do|the\s+role)\b.*$/im,
  /^[^\S\n]*(?:about\s+you|who\s+you\s+are|your\s+experience|skills(?:\s+&|\s+and)?\s*(?:experience)?)\b.*$/im,
];

/**
 * Trailing sections that carry no signal about fit, cut when they can be found.
 *
 * EEO and benefits boilerplate is long, highly repetitive across postings, and made of exactly the
 * kind of generic professional vocabulary a naive scorer would happily match on. Dropping it is
 * both a byte saving and a small accuracy win.
 *
 * Only ever applied to text AFTER the chosen start point, so a posting that opens with an EEO
 * statement is not truncated to nothing.
 */
const TRAILING_PATTERNS: RegExp[] = [
  /^[^\S\n]*(?:equal\s+opportunity|eeo\b|e\.e\.o\.)/im,
  /^[^\S\n]*(?:we\s+are\s+an\s+equal|is\s+an\s+equal)/im,
  /^[^\S\n]*(?:benefits|perks|what\s+we\s+offer|compensation\s+and\s+benefits)\b[^\n]*$/im,
  /^[^\S\n]*(?:privacy\s+(?:policy|notice)|applicant\s+privacy)/im,
];

/**
 * Collapse the whitespace an HTML-to-text conversion leaves behind.
 *
 * Runs of blank lines and trailing spaces are pure overhead in a column whose size is the reason
 * this file exists, and they also break the line-anchored patterns above by putting a heading
 * behind leading whitespace on a line of its own. Single newlines are PRESERVED, because the
 * patterns need line boundaries to find a heading at all.
 */
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[^\S\n]+\n/g, '\n')
    .trim();
}

/**
 * Where the scorable part of this posting starts.
 *
 * Returns the EARLIEST match among the patterns rather than the first pattern that matches. A
 * posting with both "Responsibilities" and "Minimum qualifications" should start at whichever comes
 * first in the text, not at whichever appears first in the pattern list, because the goal is to
 * skip the preamble and not to pick a favourite section.
 *
 * Matches in the first 200 characters are ignored. A posting that opens directly on "The role" has
 * no preamble to skip, and starting there would drop the title line and any one-sentence summary
 * above it for no benefit.
 */
function sectionStart(text: string): number {
  let earliest = -1;
  for (const pattern of SECTION_PATTERNS) {
    const match = pattern.exec(text);
    if (!match || match.index < 200) continue;
    if (earliest === -1 || match.index < earliest) earliest = match.index;
  }
  return earliest;
}

/**
 * How far into the slice a boilerplate heading has to sit to count as a TRAILING section.
 *
 * Only meant to catch the case where the slice opens directly on boilerplate, where cutting at the
 * match would leave nothing at all. That is a matter of a heading line, so the threshold is one
 * heading line. It was briefly 200, which is not "the slice opens on this" but "the first third of
 * a real requirements block", and it silently disabled the EEO cut on any posting whose
 * requirements ran shorter than 200 characters. Plenty do.
 */
const TRAILING_MIN_OFFSET = 40;

/** Where the scorable part stops, or -1 when no trailing boilerplate is recognisable. */
function trailingStart(text: string): number {
  let earliest = -1;
  for (const pattern of TRAILING_PATTERNS) {
    const match = pattern.exec(text);
    if (!match || match.index < TRAILING_MIN_OFFSET) continue;
    if (earliest === -1 || match.index < earliest) earliest = match.index;
  }
  return earliest;
}

/**
 * Build the digest for one description.
 *
 * Total function: every input produces a string, including empty and whitespace-only input, because
 * this runs inside a 200-row upsert chunk during a poll and a throw here would take a whole board's
 * poll down with it over one malformed posting.
 */
export function buildDescriptionDigest(description: string | null | undefined): string {
  if (!description) return '';
  const text = normalize(description);
  if (!text) return '';
  /* Short postings are kept whole. Slicing a 900-character posting saves nothing worth the risk of
     the heuristic picking the wrong start. */
  if (text.length <= DIGEST_CHARS) return text;

  const start = sectionStart(text);
  const body = start === -1 ? text : text.slice(start);

  const end = trailingStart(body);
  const trimmed = end === -1 ? body : body.slice(0, end);

  /* The only thing worth guarding against here is an EMPTY digest, which scores as unscorable and
     is strictly worse than a short one carrying some boilerplate. A short trimmed result is not a
     failure: a posting whose requirements are two lines has a two-line digest, and that is the
     honest answer rather than padding it back out with an EEO statement.
     An earlier version required the trim to keep half the body, which rejected correct trims
     whenever the boilerplate was longer than the requirements: exactly the postings where cutting
     it matters most. */
  const chosen = trimmed.trim().length > 0 ? trimmed : body;

  return chosen.slice(0, DIGEST_CHARS).trim();
}
