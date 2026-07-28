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
