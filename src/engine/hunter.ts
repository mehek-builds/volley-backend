import axios from 'axios';
import { classifyPersona, type SourcedContact } from './apollo';
import type { VerifyStatus } from './verify';

// Hunter is the primary provider: Domain Search returns real people WITH emails in a single
// call (no separate enrichment step), and Email Verifier resolves catch-all domains well.

interface HunterEmail {
  value?: string;
  first_name?: string;
  last_name?: string;
  position?: string;
  seniority?: string;
  department?: string;
  confidence?: number;
  linkedin?: string;
}

// One persona bucket = one Hunter Domain Search with department/seniority filters that bias
// the result toward that kind of person. Running these separately (instead of one blended
// search) is what prevents the list from being dominated by recruiters.
interface PersonaBucket {
  persona: string;
  params: Record<string, string>;
}

const PERSONA_BUCKETS: PersonaBucket[] = [
  { persona: 'recruiter', params: { department: 'hr' } },
  { persona: 'hiring_manager', params: { department: 'management,it', seniority: 'executive,senior' } },
  { persona: 'near_peer', params: { department: 'it', seniority: 'junior' } },
];

function mapHunterEmail(e: HunterEmail, fallbackPersona: string): SourcedContact | null {
  const first = (e.first_name ?? '').trim();
  const last = (e.last_name ?? '').trim();
  const email = (e.value ?? '').trim();
  const title = (e.position ?? '').trim();
  if (!first || !last || !email) return null;
  // Use the title to classify when it's explicit; otherwise trust the bucket the search
  // targeted (e.g. a junior IT person with a vague title stays a near_peer).
  const classified = classifyPersona(title, e.seniority);
  const persona = title ? classified : fallbackPersona;
  return {
    full_name: `${first} ${last}`,
    first_name: first,
    last_name: last,
    title: title || 'Team member',
    persona,
    school_match: false,
    linkedin_url: e.linkedin ?? '',
    email,
    // The verifier in resolveKnownEmail produces the authoritative tier; 'guessed' ensures
    // we never shortcut a Domain Search result straight to green.
    email_status: 'guessed',
  };
}

async function hunterSearch(domain: string, bucket: PersonaBucket, apiKey: string): Promise<SourcedContact[]> {
  try {
    const res = await axios.get('https://api.hunter.io/v2/domain-search', {
      params: { domain, limit: 5, ...bucket.params, api_key: apiKey },
      timeout: 20000,
    });
    const emails: HunterEmail[] = res.data?.data?.emails ?? [];
    return emails
      .map((e) => mapHunterEmail(e, bucket.persona))
      .filter((c): c is SourcedContact => c !== null);
  } catch (err) {
    const msg = axios.isAxiosError(err)
      ? `${err.response?.status} ${JSON.stringify(err.response?.data)?.slice(0, 200)}`
      : String(err);
    console.error(`[hunter] domain-search error (${bucket.persona}):`, msg);
    return [];
  }
}

/**
 * Find a *balanced* set of real contacts via Hunter Domain Search. Runs one search per persona
 * bucket (recruiter / hiring manager / near-peer IC) in parallel, then round-robins the
 * buckets so the shortlist always spans personas instead of being all recruiters. Each contact
 * already carries an email. Returns [] when no key is set, so callers fall back to Apollo.
 */
export async function fetchHunterContacts(
  domain: string,
  _role: string,
  _team: string | undefined,
  limit = 6
): Promise<SourcedContact[]> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return [];

  const buckets = await Promise.all(PERSONA_BUCKETS.map((b) => hunterSearch(domain, b, apiKey)));

  // Round-robin across buckets, de-duping by email, so the final list interleaves personas.
  const final: SourcedContact[] = [];
  const seen = new Set<string>();
  let added = true;
  while (final.length < limit && added) {
    added = false;
    for (const list of buckets) {
      const next = list.find((c) => !seen.has(c.email!));
      if (next && final.length < limit) {
        final.push(next);
        seen.add(next.email!);
        added = true;
      }
    }
  }
  return final;
}

export interface HunterVerifyResult {
  status: VerifyStatus;
  raw: unknown;
}

/**
 * Verify a single email via Hunter Email Verifier. Maps Hunter's result/status to our
 * VerifyStatus. Returns UNKNOWN (and lets the caller fall through) when no key or on error.
 */
export async function verifyHunter(email: string): Promise<HunterVerifyResult> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return { status: 'UNKNOWN', raw: null };

  try {
    const res = await axios.get('https://api.hunter.io/v2/email-verifier', {
      params: { email, api_key: apiKey },
      timeout: 20000,
    });

    const data = res.data?.data as {
      status?: string;
      result?: string;
      accept_all?: boolean;
    };

    let status: VerifyStatus;
    if (data?.status === 'valid' || data?.result === 'deliverable') status = 'VALID';
    else if (data?.status === 'invalid' || data?.result === 'undeliverable') status = 'INVALID';
    else if (data?.accept_all || data?.status === 'accept_all') status = 'CATCH_ALL';
    else status = 'UNKNOWN';

    return { status, raw: data };
  } catch (err) {
    const msg = axios.isAxiosError(err)
      ? `${err.response?.status} ${JSON.stringify(err.response?.data)?.slice(0, 200)}`
      : String(err);
    console.error('[hunter] email-verifier error:', msg);
    return { status: 'UNKNOWN', raw: null };
  }
}
