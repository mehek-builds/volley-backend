import { createHash } from 'node:crypto';

export const JOB_CERTIFICATION_FINGERPRINT_VERSION = 'v1';

export type JobCertificationIdentity = {
  employer_name: string;
  title: string;
  description: string;
};

const LATIN_LEGAL_SUFFIXES = new Set([
  'ag', 'bv', 'co', 'corp', 'corporation', 'gmbh', 'inc', 'incorporated', 'limited', 'llc',
  'lp', 'llp', 'ltd', 'pbc', 'plc', 'pte',
]);

const DESCRIPTION_BOILERPLATE = [
  /\bequal (?:employment|opportunity) (?:employer|statement)\b/i,
  /\b(?:eeo|affirmative action) (?:employer|statement)\b/i,
  /\bcandidate privacy (?:notice|policy)\b/i,
  /\bprivacy notice for (?:job )?applicants\b/i,
  /\b(?:cookie|tracking) (?:notice|disclosure|policy)\b/i,
  /\b(?:third[- ]party )?(?:recruiting )?agencies\b.*\bunsolicited resumes?\b/i,
  /\bpowered by (?:greenhouse|lever|ashby|workable|breezy|recruitee|crelate|rippling)\b/i,
  /^(?:job|requisition|tracking) (?:id|code|number)\s*[:#]/i,
  /^#li-[a-z0-9_-]+$/i,
];

/** Unicode-safe content text that preserves meaningful punctuation such as C++ versus C. */
export function normalizeJobIdentityText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fold title separator punctuation without erasing language identities such as C++ and C#. */
export function normalizeJobCertificationTitle(value: string | null | undefined): string {
  return normalizeJobIdentityText(value)
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeDescriptionMarkup(value: string): string {
  return value
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]{0,2000}>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;|&#38;|&#x26;/gi, '&')
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (match, raw: string) => {
      const codePoint = Number.parseInt(raw, 16);
      return Number.isInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    })
    .replace(/&#(\d+);/g, (match, raw: string) => {
      const codePoint = Number.parseInt(raw, 10);
      return Number.isInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    });
}

/**
 * Canonical description content for cross-provider certification.
 *
 * ATS markup, bullet punctuation, tracking URLs, and clearly labeled provider, privacy, agency,
 * and equal-opportunity footers are presentation metadata rather than a distinct opening. The
 * remaining word sequence stays complete, including language-level markers such as C++ and C#,
 * so a changed responsibility or qualification still produces a different fingerprint.
 */
export function normalizeJobCertificationDescription(value: string | null | undefined): string {
  const segments = decodeDescriptionMarkup(value ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .split(/\n+|(?<=[.!?])\s+(?=[\p{Lu}\d#])/u)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !DESCRIPTION_BOILERPLATE.some((pattern) => pattern.test(segment)));
  return segments
    .join(' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeEmployerCertificationIdentity(value: string): string {
  const parts = normalizeJobIdentityText(value)
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (parts.length > 1 && LATIN_LEGAL_SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

/**
 * Versioned, conservative cross-source identity for certification counts.
 *
 * It deliberately excludes provider, source, URLs, location, and external IDs, since aliases of
 * the same first-party role can differ in all of them. Two genuinely separate requisitions with
 * identical verified employer, title, and canonicalized full description may collapse to one.
 * That can undercount inventory, but provider markup and known boilerplate cannot inflate the
 * 500,000-job certificate.
 */
export function buildJobCertificationFingerprint(job: JobCertificationIdentity): string | null {
  const employer = normalizeEmployerCertificationIdentity(job.employer_name);
  const title = normalizeJobCertificationTitle(job.title);
  const description = normalizeJobCertificationDescription(job.description);
  if (!employer || !title || !description) return null;
  const roleDigest = createHash('sha256')
    .update(JSON.stringify([employer, title]))
    .digest('hex');
  const descriptionDigest = createHash('sha256').update(description).digest('hex');
  return `${JOB_CERTIFICATION_FINGERPRINT_VERSION}:${roleDigest}:${descriptionDigest}`;
}
