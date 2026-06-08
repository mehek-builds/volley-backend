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

/**
 * Find real contacts at a company via Hunter Domain Search. Returns [] when no key is set
 * or on error, so callers can fall back to Apollo/synthetic.
 *
 * Departments are biased toward the people a student should contact (recruiting + the role's
 * function + leadership). One call costs a single Hunter "search" credit and yields many
 * contacts, each already carrying an email.
 */
export async function fetchHunterContacts(
  domain: string,
  role: string,
  team: string | undefined,
  limit = 6
): Promise<SourcedContact[]> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await axios.get('https://api.hunter.io/v2/domain-search', {
      params: {
        domain,
        limit: Math.max(limit * 2, 10),
        department: 'hr,executive,management,engineering,it',
        api_key: apiKey,
      },
      timeout: 20000,
    });

    const emails: HunterEmail[] = res.data?.data?.emails ?? [];

    const sourced: SourcedContact[] = emails
      .map((e): SourcedContact | null => {
        const first = (e.first_name ?? '').trim();
        const last = (e.last_name ?? '').trim();
        const email = (e.value ?? '').trim();
        const title = (e.position ?? '').trim();
        if (!first || !last || !email) return null;
        return {
          full_name: `${first} ${last}`,
          first_name: first,
          last_name: last,
          title: title || 'Team member',
          persona: classifyPersona(title, e.seniority),
          school_match: false,
          linkedin_url: e.linkedin ?? '',
          email,
          // Hunter Domain Search confidence (0-100); the verifier in resolveKnownEmail
          // produces the authoritative tier. We pass 'guessed' so it never shortcuts to green.
          email_status: 'guessed',
        };
      })
      .filter((c): c is SourcedContact => c !== null);

    const order: Record<string, number> = { recruiter: 0, hiring_manager: 1, senior_ic: 2, near_peer: 3 };
    sourced.sort((a, b) => (order[a.persona] ?? 9) - (order[b.persona] ?? 9));

    return sourced.slice(0, limit);
  } catch (err) {
    const msg = axios.isAxiosError(err)
      ? `${err.response?.status} ${JSON.stringify(err.response?.data)?.slice(0, 200)}`
      : String(err);
    console.error('[hunter] domain-search error:', msg);
    return [];
  }
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
