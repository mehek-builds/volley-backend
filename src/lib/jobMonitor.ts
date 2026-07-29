import type { AutonomousPortalFamily } from './portalSubmission';

// The boards the job monitor may poll.
//
// CONSTRAINED, not just declared: `extends AutonomousPortalFamily` means this union can only ever
// contain portals Litos can carry all the way to a confirmation by itself. Adding, say,
// 'smartrecruiters' or 'jazzhr' here is a COMPILE ERROR, not a silent product regression - which is
// the point, because the failure it prevents is invisible at the seam. A job from a portal Litos
// cannot finish looks exactly like any other job on the board; the student only finds out after
// choosing it and tailoring a resume to it.
//
// To add a board: make the portal genuinely autonomous in portalSubmission.ts first (an adapter that
// reaches a real receipt), and it becomes available here automatically. 'workable' is eligible today
// and not yet polled - adding sources for it is pure upside.
// Two different questions, and a source has to satisfy BOTH:
//   1. Can Litos finish an application on that portal alone?  -> AutonomousPortalFamily
//   2. Can this module actually poll that portal's boards?     -> needs a fetchSourceJobs branch
// Workable answers yes to (1) as of 2026-07-28 but has no fetcher, so it is not listed here yet.
// Adding one makes it a one-word change, and the `satisfies` below is what keeps (1) enforced.
export const POLLABLE_JOB_BOARDS = ['greenhouse', 'lever', 'ashby'] as const satisfies readonly AutonomousPortalFamily[];

export type SupportedJobBoard = typeof POLLABLE_JOB_BOARDS[number];

export type JobSourceInput = {
  company_name: string;
  ats_name: SupportedJobBoard;
  board_token: string;
  career_url: string;
  enabled?: boolean;
};

export type NormalizedJob = {
  external_id: string;
  title: string;
  location?: string;
  department?: string;
  employment_type?: string;
  description: string;
  apply_url: string;
  posting_url: string;
  remote: boolean;
  posted_at?: Date;
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const token = entity.toLowerCase();
    if (token[0] !== '#') return NAMED_ENTITIES[token] ?? match;
    const code = token[1] === 'x'
      ? Number.parseInt(token.slice(2), 16)
      : Number.parseInt(token.slice(1), 10);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return match;
    /* Drop, do not emit. A Postgres text column cannot hold U+0000 ("invalid
       byte sequence for encoding UTF8: 0x00"), and one such character fails the
       whole 200-row upsert chunk, which takes that board's poll down with it.
       Lone surrogates do not survive a UTF-8 roundtrip. Neither belongs in a
       job description. */
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return '';
    if (code >= 0x7f && code <= 0x9f) return '';
    if (code >= 0xd800 && code <= 0xdfff) return '';
    return String.fromCodePoint(code);
  });
}

/* Escape depth is not fixed at two. Greenhouse escapes the document, and a
   posting whose source text already spelled an entity out picks up a third
   layer: `&amp;amp;amp;` reaches us and two decodes leave a visible `&amp;`.
   Seven postings do this today (Gemini, Asana, SpaceX, Elastic, natera). Decode
   to a fixed point instead of guessing the depth. Safe to iterate because this
   only ever collapses entities, never strips, so it cannot eat prose. */
function decodeFully(value: string): string {
  let current = value;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = decodeEntities(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

function stripTags(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
}

/* The tag vocabulary a job board actually emits. Used for the SECOND strip only,
   where the text is no longer known to be markup, so "looks like <letter...>" is
   not good enough a test. */
const HTML_TAG_NAME = [
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br', 'caption',
  'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl',
  'dt', 'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hr', 'i', 'iframe', 'img', 'ins', 'kbd', 'li', 'main',
  'mark', 'nav', 'ol', 'p', 'picture', 'pre', 'q', 's', 'samp', 'script', 'section',
  'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var', 'video', 'wbr',
].join('|');
const RESIDUAL_BR = new RegExp('<br\\s*/?>', 'gi');
const RESIDUAL_P_CLOSE = new RegExp('</p\\s*>', 'gi');
const RESIDUAL_TAG = new RegExp(`</?(?:${HTML_TAG_NAME})(?:\\s[^>]*)?/?>`, 'gi');

function stripKnownTags(value: string): string {
  return value
    .replace(RESIDUAL_BR, '\n')
    .replace(RESIDUAL_P_CLOSE, '\n\n')
    .replace(RESIDUAL_TAG, ' ');
}

/* Decode BEFORE stripping tags. Greenhouse's board API returns `content` as
 * HTML-ESCAPED markup (`&lt;p&gt;`), so a tag-stripping pass that runs first
 * matches nothing and the literal `<p>`/`<em>` tags survive into the stored
 * description.
 *
 * Decode, strip, decode again, then strip ONLY known tag names. The second
 * decode is required because Greenhouse escapes the whole document, so
 * text-level entities arrive double-escaped (`&amp;amp;`, 185-581 per board).
 *
 * That second decode can also expose angle brackets, and at that point the text
 * is no longer known to be markup, so the two cases are genuinely ambiguous:
 *
 *   `&amp;lt;p&amp;gt;`          double-escaped markup, should be stripped
 *   `&amp;lt;Karnataka, ...&amp;gt;`  prose in brackets, must be kept
 *
 * A "looks like <letter...>" strip cannot tell them apart and eats the prose.
 * Measured across all 253 boards (22,084 postings): 9 postings carry prose in
 * brackets (Twilio's "<Karnataka, Tamil Nadu, ...>", Amplitude's "<<NAMER
 * version ...>>"), and 0 carry double-escaped markup. So the second strip
 * matches a tag-name allowlist: it removes markup if it ever shows up, and
 * leaves prose alone. The residual risk is prose like "<b and c>", where the
 * first token really is a tag name; unobserved, and cheaper than losing the 9.
 */
function cleanHtml(value: unknown): string {
  if (typeof value !== 'string') return '';
  return stripKnownTags(decodeFully(stripTags(decodeEntities(value))))
    /* `&nbsp;` decodes to a space but `&#160;` decodes to U+00A0, which no
       later rule collapses. 879 descriptions carried one. Normalize so the two
       spellings of the same character do not produce different text. */
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    // Inline tags (<em>, <strong>) each collapse to a space, which otherwise
    // leaves "fast ." wherever a posting emphasized the last word of a clause.
    .replace(/ +([.,;:!?)\]])/g, '$1')
    .replace(/([([]) +/g, '$1')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/* Lever and Ashby both offer a `descriptionPlain`, and it is USUALLY plain: real
   line breaks, indented bullets, no markup. Running the HTML cleaner over it
   unconditionally flattens that indentation for no gain. But it is not RELIABLY
   plain either (a live Cursor posting carries `</aside>`), and nothing
   downstream sanitizes. So clean it only when it is not actually plain. */
const LOOKS_LIKE_MARKUP = /<\/?[a-zA-Z][^>]*>|&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i;

function cleanPlain(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  if (LOOKS_LIKE_MARKUP.test(raw)) return cleanHtml(raw);
  /* Layout is preserved, but U+00A0 is a character detail rather than layout,
     and 1,283 Lever/Ashby postings carry one. Normalizing it keeps the same
     sentence identical across providers without flattening the indentation. */
  return raw.replace(/\u00a0/g, ' ');
}

function date(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function normalizeGreenhouseJobs(payload: unknown): NormalizedJob[] {
  const jobs = (payload as { jobs?: unknown[] } | null)?.jobs;
  if (!Array.isArray(jobs)) throw new Error('Greenhouse board returned an invalid jobs payload');
  return jobs.flatMap((raw) => {
    const job = raw as Record<string, unknown>;
    const id = String(job.id ?? '').trim();
    const title = text(job.title);
    const postingUrl = text(job.absolute_url);
    if (!id || !title || !postingUrl) return [];
    const location = text((job.location as Record<string, unknown> | undefined)?.name);
    const departments = Array.isArray(job.departments) ? job.departments : [];
    const department = departments
      .map((item) => text((item as Record<string, unknown>)?.name))
      .filter(Boolean)
      .join(', ') || undefined;
    return [{
      external_id: id,
      title,
      location,
      department,
      description: cleanHtml(job.content),
      apply_url: postingUrl,
      posting_url: postingUrl,
      remote: /\bremote\b/i.test(location ?? ''),
      posted_at: date(job.updated_at),
    }];
  });
}

export function normalizeLeverJobs(payload: unknown): NormalizedJob[] {
  if (!Array.isArray(payload)) throw new Error('Lever board returned an invalid jobs payload');
  return payload.flatMap((raw) => {
    const job = raw as Record<string, unknown>;
    const id = text(job.id);
    const title = text(job.text);
    const postingUrl = text(job.hostedUrl);
    const applyUrl = text(job.applyUrl) ?? postingUrl;
    if (!id || !title || !postingUrl || !applyUrl) return [];
    const categories = (job.categories ?? {}) as Record<string, unknown>;
    const location = text(categories.location);
    const description = [cleanPlain(job.descriptionPlain), ...(Array.isArray(job.lists)
      ? job.lists.map((item) => cleanHtml((item as Record<string, unknown>).content))
      : [])].filter(Boolean).join('\n\n');
    return [{
      external_id: id,
      title,
      location,
      department: text(categories.department) ?? text(categories.team),
      employment_type: text(categories.commitment),
      description,
      apply_url: applyUrl,
      posting_url: postingUrl,
      remote: /\bremote\b/i.test([location, text(job.workplaceType)].filter(Boolean).join(' ')),
      posted_at: date(job.createdAt),
    }];
  });
}

export function normalizeAshbyJobs(payload: unknown): NormalizedJob[] {
  const jobs = (payload as { jobs?: unknown[] } | null)?.jobs;
  if (!Array.isArray(jobs)) throw new Error('Ashby board returned an invalid jobs payload');
  return jobs.flatMap((raw) => {
    const job = raw as Record<string, unknown>;
    const postingUrl = text(job.jobUrl);
    const applyUrl = text(job.applyUrl) ?? postingUrl;
    const id = text(job.id) ?? postingUrl;
    const title = text(job.title);
    if (!id || !title || !postingUrl || !applyUrl) return [];
    const location = text(job.location);
    return [{
      external_id: id,
      title,
      location,
      department: text(job.department) ?? text(job.team),
      employment_type: text(job.employmentType),
      description: cleanPlain(job.descriptionPlain) || cleanHtml(job.descriptionHtml),
      apply_url: applyUrl,
      posting_url: postingUrl,
      remote: job.isRemote === true || /\bremote\b/i.test(location ?? ''),
      posted_at: date(job.publishedAt),
    }];
  });
}

/* A DESCRIPTION THAT DESCRIBES NOTHING IS NOT A POSTING.
 *
 * 14 live rows carried a placeholder instead of a job description: Disney's "MASTER TEMPLATE" ->
 * "PLACEHOLDER" and "prospecting test" -> "afdsfasdfasdf", 12 Point72 postings whose entire
 * description is the job title again ("Software Engineer, Bpm" -> "Software Engineer, Bpm"), plus
 * btgpactual's "(#LI-DNI)" and Physical Intelligence's "Research Internships" -> "Internships"
 * outside the freshness window. Verified against the raw board APIs, so this is employer data, not
 * a normalizer bug.
 *
 * It is not only a browse-page blemish. jdMatch.ts scores this text, resumePolicy.ts and
 * resumeRender.ts rank bullets against it, and the src/llm prompts write from it. A description
 * that is the title repeated does not merely look empty - it produces a confident, meaningless
 * match score and pulls the wrong bullets into a generated PDF. There is no consumer that does
 * something useful with it, which is why these are DROPPED rather than flagged and hidden: a flag
 * would need a migration, a board filter, and a check at every one of those call sites, all to
 * preserve a row carrying no information. Dropping is also self-healing, exactly like the freshness
 * filter - if the employer writes a real description, the next poll inserts it as normal.
 *
 * THE THRESHOLD IS MEASURED, NOT GUESSED. Across all 253 boards (22,119 postings): the junk cluster
 * ends at 62 characters and the shortest REAL description is 353 (Latch's "I don't see the right
 * role"), then Cursor's genuine 434-character "Software Engineer, Generalist". Nothing at all lives
 * between 177 and 353. 120 sits inside that empty gap with ~3x margin under the shortest real
 * posting, so a board that legitimately ships a terse description is not caught. */
export const MIN_DESCRIPTION_CHARS = 120;

/* Compared on letters and digits only, so "Software Engineer, Bpm" and "Software Engineer Bpm"
   are the same string and punctuation drift cannot defeat the check. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/* Descriptions that are ONE marker and nothing else. Matched against the WHOLE folded description,
   never as a substring, and the difference is not academic: 6 postings contain "#LI-DNI" and 5 of
   them are real, full-length descriptions that merely carry the LinkedIn do-not-index tag in a
   corner (Cursor, Recursion x2, IMC Trading, btgpactual's BTG Experience 2026). A `contains` rule
   here would delete five good jobs to remove one bad one. Only btgpactual's "(#LI-DNI)", where the
   marker IS the entire description, is junk.
   "placeholder" and the LI-DNI spellings are observed; "n a" and "tbd" are not, and are here only
   because a whole-description match cannot produce a false positive. Every entry is shorter than
   MIN_DESCRIPTION_CHARS, so this set catches nothing the length floor would not already catch - it
   earns its place by documenting the substring trap above, and by still holding if someone later
   pads a marker past the floor. */
const PLACEHOLDER_DESCRIPTIONS = new Set(['placeholder', 'li dni', 'li dnp', 'li dni li dnp', 'n a', 'tbd']);

/* The title echoed back, with at most a word of drift: Point72 ships both the exact repeat and
   "Software Engineer, Investor and Fund Administration" -> "...Administration Technology", and
   Physical Intelligence ships the reverse containment ("Research Internships" -> "Internships").
   Bounded by the RESIDUE rather than by absolute length, which is what makes it independent of the
   length floor above: it still fires on a company with a 200-character title, and it cannot fire on
   the real postings that simply OPEN with their own title - Datadog, Databricks and Match Group do
   that in their Japanese and Korean listings, and leave 2,700-3,900 characters of prose after it. */
const TITLE_ECHO_SLACK = 15;

/**
 * Whether a posting carries a description a student (or the matcher) can actually read.
 *
 * Applied in pollSource next to the freshness filter rather than inside the normalizers, and that
 * placement is load-bearing. Disney's board is 2 postings and BOTH are placeholders, so a filter
 * inside normalizeGreenhouseJobs would make its fetch return zero, trip
 * shouldKeepPostingsOnEmptyFetch, and pin those exact two rows on the board permanently - the fix
 * would be a no-op for the worst case it was written for. "The API returned nothing" and "the API
 * returned nothing USABLE" are different facts, and only the first one is a fault.
 */
export function hasUsableDescription(job: Pick<NormalizedJob, 'description' | 'title'>): boolean {
  /* Length and emptiness are judged on the RAW text, never on the folded form. Folding keeps only
     letters and digits, and "letters" there means a-z, so a description written entirely in
     Chinese, Japanese or Korean folds to the EMPTY string and a folded-length test would read it as
     missing. Riot Games, Match Group and Databricks all ship CJK descriptions; none of them folds
     fully away today, because each happens to carry a Latin token somewhere ("Riot", "UE5", "AI"),
     so this is a near miss rather than an observed loss. It is guarded anyway because the margin is
     one word wide and the failure would be silent and in bulk. */
  const raw = job.description.trim();
  if (!raw) return false;

  const description = fold(raw);
  if (description && PLACEHOLDER_DESCRIPTIONS.has(description)) return false;

  const rawTitle = job.title.trim();
  const title = fold(rawTitle);
  /* Both sides must fold to something before comparing, for the same reason: an all-CJK description
     folds to '' and would otherwise read as a perfect echo of any short title.
     The two halves of this test deliberately use different strings. CONTAINMENT is checked on the
     folded text, so punctuation and case drift cannot defeat it. But SIZE is checked on the raw
     text, because folding discards every non-Latin character: a 2,763-character Korean description
     that opens with its English title folds down to roughly the title alone, and a folded-length
     residue would have read it as an echo and dropped it. Datadog, Databricks and Match Group all
     ship exactly that shape. */
  if (description && title) {
    const [shorter, longer] = description.length <= title.length
      ? [description, title]
      : [title, description];
    const echoed = longer.includes(shorter) && Math.abs(raw.length - rawTitle.length) <= TITLE_ECHO_SLACK;
    if (echoed) return false;
  }

  return raw.length >= MIN_DESCRIPTION_CHARS;
}

/* A POSTING THAT SAYS IT IS NOT A REAL POSTING.
 *
 * A different failure from an empty description, and worse for the student: the text reads like a
 * normal job, so nothing on the board looks wrong, but applying is pointless. BCG ships four of
 * these from Greenhouse, and two of them carry a full, convincing role description with the
 * disclaimer bolted on the front: "This is a fake job. Do not apply unless you are a Greenhouse
 * employee. This is for testing purposes only... If you do apply, your application will be
 * deleted." No length or title rule can catch that, because the description is real prose.
 *
 * EVERY PATTERN IS A STATEMENT ABOUT THE POSTING ITSELF, and that is the whole design, not a
 * stylistic preference. Measured across all 253 boards (22,124 postings), the phrase "fake job"
 * appears in 329 descriptions and only 4 of them are fake: the other 325 are Samsara's anti-scam
 * boilerplate, "Samsara is aware of scams involving fake job interviews and offers". A substring
 * match on "fake job" would delete 325 real jobs to remove 4. "do not apply" is the same trap from
 * the other direction: 75 real postings use it for routing ("if you are an intern, please do not
 * apply using this link" - Stripe; "if you are a current employee, do not apply here" - SoFi).
 *
 * So the rule matches only self-declarations - "THIS POSTING is a fake job" - never a mention of
 * fakery or testing in passing. Verified: the set below matches exactly the 4 BCG postings, 0 of
 * Samsara's 325, and 0 of the 199 postings with "Test" in the title (real SpaceX, Rocket Lab and
 * graphcore test-engineering roles). Several patterns match nothing today; they are safe by
 * construction, since no real posting describes itself as not real, and they cost one regex each.
 */
const TEST_POSTING_SUBJECT = '(?:job|posting|position|role|listing|req(?:uisition)?)';
const TEST_POSTING_DECLARATIONS = [
  new RegExp(`\\bthis (?:is|was) (?:a|an) fake ${TEST_POSTING_SUBJECT}\\b`, 'i'),
  new RegExp(`\\bthis (?:is|was) (?:a|an) test ${TEST_POSTING_SUBJECT}\\b`, 'i'),
  new RegExp(`\\bthis ${TEST_POSTING_SUBJECT} is (?:only )?for testing purposes\\b`, 'i'),
  new RegExp(`\\bthis ${TEST_POSTING_SUBJECT} is not (?:a|an) real ${TEST_POSTING_SUBJECT}\\b`, 'i'),
  new RegExp(`\\b(?:please )?disregard this ${TEST_POSTING_SUBJECT}\\b`, 'i'),
  /* Not phrased as a declaration, but it can only mean one thing: an employer promising to bin
     whatever you send is telling you the posting is not real. 4 matches, all BCG. */
  /\byour application will be deleted\b/i,
];

/**
 * Whether the posting declares itself a test or a fake.
 *
 * Deliberately reads the DESCRIPTION only. The title is not a usable signal here: 199 postings
 * carry "Test" in the title and essentially all are real test-engineering roles, so a title rule
 * would delete most of SpaceX's and Rocket Lab's hardware openings.
 */
export function isSelfDeclaredTestPosting(job: Pick<NormalizedJob, 'description'>): boolean {
  return TEST_POSTING_DECLARATIONS.some((pattern) => pattern.test(job.description));
}

/**
 * THE INGEST GATE. Everything the poller stores passes through here first, which is what makes this
 * the one place to add the next rule rather than a fourth filter somewhere down the chain.
 *
 * Applied in pollSource, after the empty-response guard and next to the freshness window. See
 * hasUsableDescription for why that placement is load-bearing rather than incidental.
 */
export function isIngestablePosting(job: Pick<NormalizedJob, 'description' | 'title'>): boolean {
  return hasUsableDescription(job) && !isSelfDeclaredTestPosting(job);
}

export function sourceEndpoint(source: Pick<JobSourceInput, 'ats_name' | 'board_token'>): string {
  const token = encodeURIComponent(source.board_token.trim());
  if (source.ats_name === 'greenhouse') {
    return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`;
  }
  if (source.ats_name === 'lever') {
    return `https://api.lever.co/v0/postings/${token}?mode=json`;
  }
  return `https://api.ashbyhq.com/posting-api/job-board/${token}`;
}

export async function fetchSourceJobs(
  source: Pick<JobSourceInput, 'ats_name' | 'board_token'>,
  fetcher: typeof fetch = fetch,
): Promise<NormalizedJob[]> {
  const response = await fetcher(sourceEndpoint(source), {
    headers: { Accept: 'application/json', 'User-Agent': 'LitosJobMonitor/1.0' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${source.ats_name} board returned HTTP ${response.status}`);
  const payload = await response.json();
  if (source.ats_name === 'greenhouse') return normalizeGreenhouseJobs(payload);
  if (source.ats_name === 'lever') return normalizeLeverJobs(payload);
  return normalizeAshbyJobs(payload);
}
