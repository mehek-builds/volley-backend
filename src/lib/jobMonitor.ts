import type { AutonomousPortalFamily } from './portalSubmission';
import {
  resolveEmploymentType,
  readAshbyPay,
  readGreenhousePay,
  readLeverPay,
  type NormalizedPay,
} from './compensation';

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
// reaches a real receipt), and it becomes available here automatically.
// Two different questions, and a source has to satisfy BOTH:
//   1. Can Litos finish an application on that portal alone?  -> AutonomousPortalFamily
//   2. Can this module actually poll that portal's boards?     -> needs a fetchSourceJobs branch
//
// Rippling, Breezy and Recruitee answered yes to (1) as far back as 2026-07-29/08-19 and sat unpolled
// for months - a gap the 2026-08-04 audit named explicitly ("Rippling and Breezy are already proven
// single-step and CAPTCHA-free but have no fetchSourceJobs branch"). Wired 2026-08-29. Rippling and
// Breezy could not reuse the single-fetch-then-normalize shape the other five share: both publish a
// list endpoint with no description (Rippling has no date either), so surfacing either one costs one
// detail request per distinct posting. See fetchRipplingJobs and fetchBreezyJobs.
export const POLLABLE_JOB_BOARDS = [
  'greenhouse', 'lever', 'ashby', 'workable', 'rippling', 'breezy', 'recruitee',
] as const satisfies readonly AutonomousPortalFamily[];

export type SupportedJobBoard = typeof POLLABLE_JOB_BOARDS[number];

function assertNever(value: never): never {
  throw new Error(`Unsupported job board: ${String(value)}`);
}

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
  /**
   * WHAT THE PORTAL SAYS THE COUNTRY IS, rather than what we guessed from the location string.
   *
   * All four boards publish it in structured fields: Lever gives an ISO-3166 code ("GB"), Ashby
   * gives a postal address with `addressCountry` ("United States"), Greenhouse gives office
   * locations, and Workable gives a country per location. Reading it is the whole reason this field exists -
   * inferring it from free text meant "IN - Bengaluru" read as Indiana, "Amsterdam, NH" as New
   * Hampshire, and "Georgia" as the state rather than the country, and each of those put a foreign
   * job in front of somebody who needs a US work visa.
   *
   * Undefined when the portal published nothing, which is common on Greenhouse. The string
   * classifier in lib/jobLocation.ts is the fallback for exactly that case, and only that case.
   */
  portal_country?: string;
  /**
   * The company as the PORTAL names it, for the boards that publish it (Greenhouse does, on every
   * job). This is the authority on who a board belongs to.
   *
   * It exists because six of our sources were not the company their token suggested: `sas` is
   * Superior Alarm Systems, `bcg` is Bohen Consulting Group, `tcs` is Thornbury Community Services,
   * `disney` is a board called "Sgt. Pepper's Lonely Hearts Club Band". Each was found by hand
   * after the fact; the portal was publishing the right answer the entire time.
   */
  portal_company_name?: string;
  /* What the employer published about pay, or undefined where they published nothing - which is
     two thirds of the board, and is left blank rather than filled in. See lib/compensation.ts. */
  pay?: NormalizedPay;
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
    /* GREENHOUSE OFFICE NAMES ARE NOT COUNTRIES, and reading them as one was the same mistake in a
       new place. Stripe's groups happen to be "US" and "India Locations", so it looked like a
       country field - but Superior Alarm Systems names its office after itself, and that string
       would then have been treated as a country.
       `offices[].location` IS a real address ("Canoga Park, California, United States"), when the
       employer filled one in. Stripe's India office has none, which is exactly why this returns
       undefined there and lets the location parser answer instead. */
    const offices = Array.isArray(job.offices) ? job.offices : [];
    const officeLocations = offices
      .map((item) => text((item as Record<string, unknown>)?.location))
      .filter((value): value is string => Boolean(value));
    /* Cleaned ONCE. resolveEmploymentType has to read decoded text - Greenhouse returns
       entity-escaped markup, so "As an <strong>intern</strong>" would not match against the raw
       payload - and cleaning it twice per posting is ~30,000 redundant decodes per poll. */
    const greenhouseDescription = cleanHtml(job.content);
    return [{
      external_id: id,
      title,
      location,
      department,
      /* Greenhouse has no employment-type field, so the title and the body are the only evidence,
         and NOTHING is the answer for most of the board - deliberately, because "the title did not
         say" is not the same fact as "full-time".
         The description is passed because on this board it is sometimes the ONLY evidence: Jane
         Street posts its summer internships under the same plain titles as its full-time reqs
         ("Software Engineer", "Quantitative Trader") and only the body says which is which.
         See resolveEmploymentType. */
      employment_type: resolveEmploymentType(title, undefined, greenhouseDescription),
      description: greenhouseDescription,
      apply_url: postingUrl,
      posting_url: postingUrl,
      remote: /\bremote\b/i.test(location ?? ''),
      posted_at: date(job.updated_at),
      portal_country: officeLocations.join(' | ') || undefined,
      portal_company_name: text(job.company_name),
      pay: readGreenhousePay(job) ?? undefined,
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
      /* The employer's own commitment field, EXCEPT that a title saying internship beats it -
         see resolveEmploymentType for why that one exception and nothing else. */
      employment_type: resolveEmploymentType(title, text(categories.commitment), description),
      description,
      apply_url: applyUrl,
      posting_url: postingUrl,
      remote: /\bremote\b/i.test([location, text(job.workplaceType)].filter(Boolean).join(' ')),
      posted_at: date(job.createdAt),
      // An ISO-3166 alpha-2 code, published per posting. The least ambiguous signal any provider
      // gives us.
      portal_country: text(job.country),
      pay: readLeverPay(job) ?? undefined,
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
    const postal = ((job.address as Record<string, unknown> | undefined)?.postalAddress
      ?? {}) as Record<string, unknown>;
    const ashbyDescription = cleanPlain(job.descriptionPlain) || cleanHtml(job.descriptionHtml);
    return [{
      external_id: id,
      title,
      location,
      department: text(job.department) ?? text(job.team),
      employment_type: resolveEmploymentType(title, text(job.employmentType), ashbyDescription),
      description: ashbyDescription,
      apply_url: applyUrl,
      posting_url: postingUrl,
      remote: job.isRemote === true || /\bremote\b/i.test(location ?? ''),
      posted_at: date(job.publishedAt),
      // A structured postal address when the employer filled one in: "United States", "Germany".
      portal_country: text(postal.addressCountry),
      pay: readAshbyPay(job) ?? undefined,
    }];
  });
}

export function normalizeWorkableJobs(payload: unknown): NormalizedJob[] {
  const account = payload as { name?: unknown; jobs?: unknown[] } | null;
  if (!Array.isArray(account?.jobs)) throw new Error('Workable board returned an invalid jobs payload');
  const portalCompanyName = text(account?.name);
  const normalized = account.jobs.flatMap((raw) => {
    const job = raw as Record<string, unknown>;
    const id = text(job.shortcode);
    const title = text(job.title);
    const postingUrl = id ? validatedWorkableUrl(text(job.url) ?? text(job.shortlink), id) : null;
    const applicationCandidate = text(job.application_url);
    const applyUrl = id
      ? (applicationCandidate ? validatedWorkableUrl(applicationCandidate, id, true) : postingUrl)
      : null;
    if (!id || !title || !postingUrl || !applyUrl) return [];

    const locations = Array.isArray(job.locations) ? job.locations : [];
    const locationParts = [text(job.city), text(job.state), text(job.country)].filter(Boolean);
    const location = locationParts.join(', ') || locations
      .map((item) => {
        const value = item as Record<string, unknown>;
        return [text(value.city), text(value.region), text(value.country)].filter(Boolean).join(', ');
      })
      .filter(Boolean)
      .join(' | ') || undefined;
    const portalCountries = locations
      .map((item) => text((item as Record<string, unknown>).country))
      .filter((value): value is string => Boolean(value));
    const topLevelCountry = text(job.country);
    if (topLevelCountry && !portalCountries.includes(topLevelCountry)) portalCountries.push(topLevelCountry);

    const workableDescription = cleanHtml(job.description);
    return [{
      external_id: id,
      title,
      location,
      department: text(job.department) ?? text(job.function),
      employment_type: resolveEmploymentType(title, text(job.employment_type), workableDescription),
      description: workableDescription,
      apply_url: applyUrl,
      posting_url: postingUrl,
      remote: job.telecommuting === true || /\bremote\b/i.test(location ?? ''),
      posted_at: date(job.published_on) ?? date(job.created_at),
      portal_country: portalCountries.join(' | ') || undefined,
      portal_company_name: portalCompanyName,
    }];
  });

  /* Workable repeats one shortcode for every location attached to a posting. Huzzle's live feed,
     for example, returns 2,220 records with 392 duplicated shortcodes. Passing those records to a
     multi-row INSERT makes PostgreSQL reject the entire chunk because ON CONFLICT cannot update
     the same (source_id, external_id) row twice in one statement. Collapse to the database's real
     identity here while retaining every published location and country. */
  const byShortcode = new Map<string, NormalizedJob>();
  for (const job of normalized) {
    const current = byShortcode.get(job.external_id);
    if (!current) {
      byShortcode.set(job.external_id, job);
      continue;
    }
    byShortcode.set(job.external_id, {
      ...current,
      location: mergePipeSeparated(current.location, job.location),
      portal_country: mergePipeSeparated(current.portal_country, job.portal_country),
      remote: current.remote || job.remote,
    });
  }
  return [...byShortcode.values()];
}

function mergePipeSeparated(...values: Array<string | undefined>): string | undefined {
  const parts = values
    .flatMap((value) => value?.split(' | ') ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const unique = [...new Set(parts)];
  return unique.length > 0 ? unique.join(' | ') : undefined;
}

function validatedWorkableUrl(
  value: string | undefined,
  shortcode: string,
  allowApplicationPath = false,
): string | null {
  if (!value || !/^[A-Za-z0-9]+$/.test(shortcode)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'apply.workable.com') return null;
    if (url.username || url.password || url.port || url.search || url.hash) return null;
    const basePath = `/j/${shortcode}`;
    const paths = allowApplicationPath ? [basePath, `${basePath}/apply`] : [basePath];
    if (!paths.includes(url.pathname.replace(/\/$/, ''))) return null;
    return url.toString();
  } catch {
    return null;
  }
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
const PLACEHOLDER_DESCRIPTIONS = new Set(['placeholder', 'li dni', 'li dnp', 'n a', 'tbd']);

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

  /* `?? ''` rather than a bare .trim(): the type says string and the normalizers guarantee one, but
     this is now the single gate every ingested posting passes through, and a throw here aborts the
     whole source's poll before the sweep, not just this posting. */
  const rawTitle = (job.title ?? '').trim();
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
 * Samsara's 325, and 0 of the other 194 postings with "Test" in the title (real SpaceX, Rocket Lab
 * and graphcore test-engineering roles; 198 carry it, 4 of which are BCG's). Two patterns match
 * nothing today and are safe by construction, since no real posting describes itself as not real.
 */
const TEST_POSTING_SUBJECT = '(?:job|posting|position|role|listing|req(?:uisition)?)';
const TEST_POSTING_DECLARATIONS = [
  new RegExp(`\\bthis (?:is|was) (?:a|an) fake ${TEST_POSTING_SUBJECT}\\b`, 'i'),
  new RegExp(`\\bthis (?:is|was) (?:a|an) test ${TEST_POSTING_SUBJECT}\\b`, 'i'),
  new RegExp(`\\bthis ${TEST_POSTING_SUBJECT} is (?:only )?for testing purposes\\b`, 'i'),
  new RegExp(`\\bthis ${TEST_POSTING_SUBJECT} is not (?:a|an) real ${TEST_POSTING_SUBJECT}\\b`, 'i'),
  /* Not phrased as a declaration, but it can only mean one thing: an employer promising to bin
     whatever you send is telling you the posting is not real. 4 matches, all BCG.
     NOT included, deliberately: "disregard this posting". It reads like a self-declaration but it
     is usually CONDITIONAL in real prose ("if you have already applied, please disregard this
     posting"), which is the same shape as the "do not apply" routing trap above, and it catches
     nothing today. A pattern that can be true for only some readers does not belong here. */
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

/* THE PAY FLAGS ARE NOT OPTIONAL EXTRAS - THEY ARE WHY THE BOARD SHOWED NO SALARIES.
 *
 * Greenhouse omits `pay_input_ranges` and Ashby omits `compensation` unless the request asks for
 * them, and neither errors or warns when you do not: the response is a complete, valid, healthy
 * payload with the field simply absent. So this failed exactly the way the empty board did - every
 * check passed, 7,205 postings' published salaries just never arrived.
 *
 * Lever needs no flag; `salaryRange` has always been in the response and the normalizer dropped it.
 *
 * If pay ever silently disappears from the board again, look here first. */
export function sourceEndpoint(source: Pick<JobSourceInput, 'ats_name' | 'board_token'>): string {
  const token = encodeURIComponent(source.board_token.trim());
  switch (source.ats_name) {
    case 'greenhouse':
      return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true&pay_transparency=true`;
    case 'lever':
      return `https://api.lever.co/v0/postings/${token}?mode=json`;
    case 'ashby':
      return `https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`;
    case 'workable':
      return `https://www.workable.com/api/accounts/${token}?details=true`;
    // The list endpoint only. Rippling and Breezy both need a second, per-posting request for
    // anything ingestible - see fetchRipplingJobs and fetchBreezyJobs, which call this for the
    // list URL and never reach the generic single-fetch path below.
    case 'rippling':
      return `https://api.rippling.com/platform/api/ats/v1/board/${token}/jobs`;
    case 'breezy':
      return `https://${token}.breezy.hr/json`;
    case 'recruitee':
      return `https://${token}.recruitee.com/api/offers/`;
    default:
      return assertNever(source.ats_name);
  }
}

/**
 * Runs `items` through `fn` with at most `limit` in flight at once.
 *
 * Exists for Rippling and Breezy, whose list endpoints carry no usable description and force one
 * detail request per posting. Reused rather than firing every request at once, which would either
 * blow past each provider's own rate limiting or eat the whole cron's POLL_TIME_BUDGET_MS on one
 * oversized board.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const DETAIL_FETCH_CONCURRENCY = 8;
/* One oversized board (Rippling's own is 752 rows before de-duplication by posting) must not eat the
   whole cron's time budget by itself. Sources past the cap keep polling on later runs; a cap this
   size covers essentially every real board, so it is a backstop rather than a routine truncation. */
const MAX_DETAIL_FETCHES_PER_SOURCE = 600;

function detailRequestInit(): RequestInit {
  return { headers: { Accept: 'application/json', 'User-Agent': 'LitosJobMonitor/1.0' }, signal: AbortSignal.timeout(20_000) };
}

/**
 * Rippling's list endpoint (see sourceEndpoint) repeats one job once per work location and carries
 * neither a create date nor a description - both live only on the per-job detail endpoint
 * (`.../jobs/{uuid}`), alongside the employer's own employmentType and a `workLocations` array of
 * plain location strings that REPLACES the list endpoint's per-row `workLocation` object. Verified
 * live 2026-08-29 against the rippling/rippling board (752 list rows, 372 distinct postings).
 */
async function fetchRipplingJobs(
  source: Pick<JobSourceInput, 'ats_name' | 'board_token'>,
  fetcher: typeof fetch,
): Promise<NormalizedJob[]> {
  const listResponse = await fetcher(sourceEndpoint(source), detailRequestInit());
  if (!listResponse.ok) throw new Error(`rippling board returned HTTP ${listResponse.status}`);
  const listPayload = await listResponse.json();
  if (!Array.isArray(listPayload)) throw new Error('Rippling board returned an invalid jobs payload');

  const token = encodeURIComponent(source.board_token.trim());
  const uuids = [...new Set(
    listPayload
      .map((raw) => text((raw as Record<string, unknown>).uuid))
      .filter((value): value is string => Boolean(value)),
  )].slice(0, MAX_DETAIL_FETCHES_PER_SOURCE);

  const details = await mapWithConcurrency(uuids, DETAIL_FETCH_CONCURRENCY, async (uuid) => {
    try {
      const response = await fetcher(
        `https://api.rippling.com/platform/api/ats/v1/board/${token}/jobs/${encodeURIComponent(uuid)}`,
        detailRequestInit(),
      );
      return response.ok ? await response.json() : null;
    } catch {
      /* One posting's detail request failing (timeout, transient 5xx) costs that posting, not the
         whole board - the list call already succeeded, so every other row still ingests normally. */
      return null;
    }
  });

  return details.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const job = raw as Record<string, unknown>;
    const id = text(job.uuid);
    const title = text(job.name);
    const postingUrl = text(job.url);
    if (!id || !title || !postingUrl) return [];

    const location = Array.isArray(job.workLocations)
      ? job.workLocations
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' | ') || undefined
      : undefined;
    const department = job.department as Record<string, unknown> | undefined;
    const employmentType = job.employmentType as Record<string, unknown> | undefined;
    /* `role` is the job-specific body; `company` is generic "about us" boilerplate that reads
       nearly identically across every posting on the same board. Preferring role keeps descriptions
       distinct and avoids feeding the title-echo/placeholder guards a paragraph that says nothing
       about this particular job. Only fall back to the boilerplate when role is genuinely empty. */
    const descriptionFields = job.description as Record<string, unknown> | undefined;
    const ripplingDescription = cleanHtml(descriptionFields?.role) || cleanHtml(descriptionFields?.company);

    return [{
      external_id: id,
      title,
      location,
      department: text(department?.name) ?? text(department?.base_department),
      employment_type: resolveEmploymentType(title, text(employmentType?.id), ripplingDescription),
      description: ripplingDescription,
      apply_url: postingUrl,
      posting_url: postingUrl,
      remote: /\bremote\b/i.test(location ?? ''),
      posted_at: date(job.createdOn),
    }];
  });
}

/* A single JobPosting entry from a Breezy detail page's schema.org JSON-LD block. */
type BreezyLdJson = { '@type'?: unknown; description?: unknown };

const LD_JSON_BLOCK = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;

/** Breezy's detail page is an Angular SPA with no plain JSON endpoint, but it server-renders one
 *  schema.org JobPosting block per page for search engines, and that block carries the real
 *  description. Verified live 2026-08-29 against a transparent-hiring.breezy.hr posting. */
function extractBreezyDescription(html: string): string | undefined {
  for (const match of html.matchAll(LD_JSON_BLOCK)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const candidate of candidates) {
      const entry = candidate as BreezyLdJson;
      if (entry?.['@type'] === 'JobPosting' && typeof entry.description === 'string') return entry.description;
    }
  }
  return undefined;
}

/**
 * Breezy's list endpoint (see sourceEndpoint) carries `published_date`, a structured `location`
 * with `is_remote`, `salary`, `department` and a native `type` field, but no description at all -
 * that lives only on the public posting page, and only inside an embedded JSON-LD block (Breezy has
 * no separate JSON detail endpoint; both `/p/{id}.json` and `/json/{id}` answer with the same SPA
 * shell). See extractBreezyDescription.
 */
async function fetchBreezyJobs(
  source: Pick<JobSourceInput, 'ats_name' | 'board_token'>,
  fetcher: typeof fetch,
): Promise<NormalizedJob[]> {
  const listResponse = await fetcher(sourceEndpoint(source), detailRequestInit());
  if (!listResponse.ok) throw new Error(`breezy board returned HTTP ${listResponse.status}`);
  const listPayload = await listResponse.json();
  if (!Array.isArray(listPayload)) throw new Error('Breezy board returned an invalid jobs payload');

  const candidates = listPayload.slice(0, MAX_DETAIL_FETCHES_PER_SOURCE);
  const jobs = await mapWithConcurrency(candidates, DETAIL_FETCH_CONCURRENCY, async (raw) => {
    const job = raw as Record<string, unknown>;
    const id = text(job.id);
    const title = text(job.name);
    const postingUrl = text(job.url);
    if (!id || !title || !postingUrl) return null;

    let breezyDescription = '';
    try {
      const detailResponse = await fetcher(postingUrl, {
        headers: { Accept: 'text/html', 'User-Agent': 'LitosJobMonitor/1.0' },
        signal: AbortSignal.timeout(20_000),
      });
      if (detailResponse.ok) breezyDescription = cleanHtml(extractBreezyDescription(await detailResponse.text()));
    } catch {
      /* Same reasoning as Rippling above: one posting's detail page failing to load costs this one
         row, not the source's whole poll. */
    }

    const type = job.type as Record<string, unknown> | undefined;
    const location = job.location as Record<string, unknown> | undefined;
    const locations = Array.isArray(job.locations) ? job.locations : [];
    const locationName = text(location?.name) ?? (locations
      .map((item) => text((item as Record<string, unknown>).name))
      .filter(Boolean)
      .join(' | ') || undefined);
    const isRemote = location?.is_remote === true
      || locations.some((item) => (item as Record<string, unknown>).is_remote === true);

    const result: NormalizedJob = {
      external_id: id,
      title,
      location: locationName,
      department: text(job.department),
      employment_type: resolveEmploymentType(title, text(type?.name), breezyDescription),
      description: breezyDescription,
      apply_url: postingUrl,
      posting_url: postingUrl,
      remote: isRemote || /\bremote\b/i.test(locationName ?? ''),
      posted_at: date(job.published_date),
    };
    return result;
  });

  return jobs.filter((job): job is NormalizedJob => job !== null);
}

/** Recruitee's `/api/offers/` list endpoint carries the full posting - title, HTML description,
 *  location, department, an ISO country code and both a careers page and a direct apply link - so,
 *  unlike Rippling and Breezy, this fits the same single-fetch-then-normalize shape as the first
 *  four boards. Verified live 2026-08-29 against cbsconsulting.recruitee.com (201 offers). */
export function normalizeRecruiteeJobs(payload: unknown): NormalizedJob[] {
  const offers = (payload as { offers?: unknown[] } | null)?.offers;
  if (!Array.isArray(offers)) throw new Error('Recruitee board returned an invalid jobs payload');
  return offers.flatMap((raw) => {
    const job = raw as Record<string, unknown>;
    const id = job.id !== undefined && job.id !== null ? String(job.id) : undefined;
    const title = text(job.title);
    const postingUrl = text(job.careers_url);
    const applyUrl = text(job.careers_apply_url) ?? postingUrl;
    if (!id || !title || !postingUrl || !applyUrl) return [];

    const location = text(job.city) && text(job.country)
      ? [text(job.city), text(job.country)].filter(Boolean).join(', ')
      : text(job.location);
    const recruiteeDescription = cleanHtml(job.description);
    return [{
      external_id: id,
      title,
      location,
      department: text(job.department),
      employment_type: resolveEmploymentType(title, text(job.employment_type_code), recruiteeDescription),
      description: recruiteeDescription,
      apply_url: applyUrl,
      posting_url: postingUrl,
      remote: job.remote === true || /\bremote\b/i.test(location ?? ''),
      posted_at: date(job.published_at) ?? date(job.created_at),
      portal_country: text(job.country_code),
      portal_company_name: text(job.company_name),
    }];
  });
}

export async function fetchSourceJobs(
  source: Pick<JobSourceInput, 'ats_name' | 'board_token'>,
  fetcher: typeof fetch = fetch,
): Promise<NormalizedJob[]> {
  // Rippling and Breezy cannot go through the generic single-fetch path below: neither one's list
  // endpoint carries a usable description, so both need their own multi-request fetch.
  if (source.ats_name === 'rippling') return fetchRipplingJobs(source, fetcher);
  if (source.ats_name === 'breezy') return fetchBreezyJobs(source, fetcher);

  const response = await fetcher(sourceEndpoint(source), {
    headers: { Accept: 'application/json', 'User-Agent': 'LitosJobMonitor/1.0' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${source.ats_name} board returned HTTP ${response.status}`);
  const payload = await response.json();
  switch (source.ats_name) {
    case 'greenhouse': return normalizeGreenhouseJobs(payload);
    case 'lever': return normalizeLeverJobs(payload);
    case 'ashby': return normalizeAshbyJobs(payload);
    case 'workable': return normalizeWorkableJobs(payload);
    case 'recruitee': return normalizeRecruiteeJobs(payload);
    default: return assertNever(source.ats_name);
  }
}
