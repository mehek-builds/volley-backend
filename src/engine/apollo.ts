import axios from 'axios';
import { extractTeam } from './patterns';

// A real contact sourced from Apollo. Mirrors the synthetic generator's shape so resolve.ts
// can treat both paths uniformly, plus the real Apollo email + status when available (the
// search step withholds these; the enrichment step returns them).
export interface SourcedContact {
  full_name: string;
  first_name: string;
  last_name: string;
  title: string;
  persona: string;
  school_match: boolean;
  linkedin_url: string;
  email?: string;
  email_status?: string; // Apollo's own verification status: 'verified' | 'guessed' | ...
}

const APOLLO_HEADERS = (apiKey: string) => ({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
  'X-Api-Key': apiKey,
});

interface ApolloSearchPerson {
  id?: string;
  first_name?: string;
  title?: string;
}

interface ApolloMatch {
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  linkedin_url?: string;
  email?: string;
  email_status?: string;
  seniority?: string;
}

// Titles we search for: recruiters, the role itself, and the managers above it.
function searchTitlesFor(role: string, team: string | undefined): string[] {
  const fn = team || extractTeam(role);
  return [
    'University Recruiter',
    'Technical Recruiter',
    'Recruiter',
    'Talent Acquisition',
    role,
    `${fn} Manager`,
    `Head of ${fn}`,
    `Director of ${fn}`,
  ];
}

function classifyPersona(title: string, seniority: string | undefined): string {
  const t = title.toLowerCase();
  if (/recruit|talent acquisition|sourcer/.test(t)) return 'recruiter';
  if (/(manager|head of|director|vp|vice president|lead)\b/.test(t)) return 'hiring_manager';
  if (seniority && /senior|staff|principal|lead/.test(seniority.toLowerCase())) return 'senior_ic';
  if (/senior|staff|principal|lead/.test(t)) return 'senior_ic';
  return 'near_peer';
}

/**
 * Fetch real people at a company from Apollo in two steps:
 *   1. People Search (mixed_people/api_search) - returns matching person IDs by title.
 *      Free of enrichment credits, but withholds real last name / LinkedIn / email.
 *   2. Bulk Enrichment (people/bulk_match) - reveals full name, LinkedIn, and the real
 *      professional email + Apollo's own email_status. Costs 1 credit per record.
 *
 * Returns [] on any error or when no key is configured, so the caller can fall back to
 * synthetic contacts and the product keeps working.
 *
 * Note: school_match is left false (Apollo does not return education here). Alumni
 * detection is a deliberate follow-up.
 */
export async function fetchApolloContacts(
  domain: string,
  role: string,
  team: string | undefined,
  limit = 6
): Promise<SourcedContact[]> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    console.warn('[apollo] APOLLO_API_KEY not set - falling back to synthetic contacts');
    return [];
  }

  try {
    // Step 1: search for matching person IDs by title.
    const searchRes = await axios.post(
      'https://api.apollo.io/api/v1/mixed_people/api_search',
      {
        q_organization_domains_list: [domain],
        person_titles: searchTitlesFor(role, team),
        page: 1,
        per_page: Math.max(limit * 2, 10),
      },
      { headers: APOLLO_HEADERS(apiKey), timeout: 15000 }
    );

    const found: ApolloSearchPerson[] = searchRes.data?.people ?? [];
    const ids = found.map((p) => p.id).filter((id): id is string => Boolean(id)).slice(0, limit);
    if (ids.length === 0) {
      console.warn(`[apollo] no people found for ${domain} (${role})`);
      return [];
    }

    // Step 2: enrich those IDs to reveal name, LinkedIn, and real email.
    const matchRes = await axios.post(
      'https://api.apollo.io/api/v1/people/bulk_match',
      { details: ids.map((id) => ({ id })), reveal_personal_emails: false },
      { headers: APOLLO_HEADERS(apiKey), timeout: 25000 }
    );

    const matches: ApolloMatch[] = matchRes.data?.matches ?? [];
    if (typeof matchRes.data?.credits_consumed === 'number') {
      console.info(`[apollo] enriched ${matches.length} contacts for ${domain}, credits_consumed=${matchRes.data.credits_consumed}`);
    }

    const sourced: SourcedContact[] = matches
      .map((m): SourcedContact | null => {
        const first = (m.first_name ?? '').trim();
        const last = (m.last_name ?? '').trim();
        const full = (m.name ?? `${first} ${last}`).trim();
        const title = (m.title ?? '').trim();
        // Need at least a usable name and a title; email is optional (engine can still try).
        if (!first || !last || !title) return null;
        return {
          full_name: full,
          first_name: first,
          last_name: last,
          title,
          persona: classifyPersona(title, m.seniority),
          school_match: false,
          linkedin_url: m.linkedin_url ?? '',
          email: m.email,
          email_status: m.email_status,
        };
      })
      .filter((c): c is SourcedContact => c !== null);

    // Recruiters / hiring managers first, then ICs.
    const order: Record<string, number> = { recruiter: 0, hiring_manager: 1, senior_ic: 2, near_peer: 3 };
    sourced.sort((a, b) => (order[a.persona] ?? 9) - (order[b.persona] ?? 9));

    return sourced.slice(0, limit);
  } catch (err) {
    const msg = axios.isAxiosError(err)
      ? `${err.response?.status} ${JSON.stringify(err.response?.data)?.slice(0, 200)}`
      : String(err);
    console.error('[apollo] error:', msg);
    return [];
  }
}
