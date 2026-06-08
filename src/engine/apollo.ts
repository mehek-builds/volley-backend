import axios from 'axios';
import { extractTeam } from './patterns';

// A real contact sourced from Apollo. Shape is identical to the synthetic generator's
// output so resolve.ts can treat both paths uniformly (email is still resolved + verified
// by our own engine, so we never spend Apollo enrichment credits here).
export interface SourcedContact {
  full_name: string;
  first_name: string;
  last_name: string;
  title: string;
  persona: string;
  school_match: boolean;
  linkedin_url: string;
}

interface ApolloPerson {
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  linkedin_url?: string;
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
 * Fetch real people at a company from Apollo's People Search API.
 * Returns [] on any error or when no key is configured, so the caller can fall back
 * to synthetic contacts and the product keeps working.
 *
 * Note: Apollo search results do not include education, so school_match is left false
 * here. Alumni detection would require per-person enrichment (extra credits) and is a
 * deliberate follow-up.
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
    const response = await axios.post(
      'https://api.apollo.io/api/v1/mixed_people/search',
      {
        q_organization_domains_list: [domain],
        person_titles: searchTitlesFor(role, team),
        page: 1,
        per_page: Math.max(limit * 2, 10),
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'X-Api-Key': apiKey,
        },
        timeout: 15000,
      }
    );

    const people: ApolloPerson[] = response.data?.people ?? [];

    const sourced: SourcedContact[] = people
      .map((p) => {
        const first = (p.first_name ?? '').trim();
        const last = (p.last_name ?? '').trim();
        const full = (p.name ?? `${first} ${last}`).trim();
        const title = (p.title ?? '').trim();
        if (!first || !last || !title) return null;
        return {
          full_name: full,
          first_name: first,
          last_name: last,
          title,
          persona: classifyPersona(title, p.seniority),
          school_match: false,
          linkedin_url: p.linkedin_url ?? '',
        };
      })
      .filter((c): c is SourcedContact => c !== null);

    // Prefer one of each persona, recruiters/hiring managers first, then fill to limit.
    const order: Record<string, number> = {
      recruiter: 0,
      hiring_manager: 1,
      senior_ic: 2,
      near_peer: 3,
    };
    sourced.sort((a, b) => (order[a.persona] ?? 9) - (order[b.persona] ?? 9));

    return sourced.slice(0, limit);
  } catch (err) {
    const msg = axios.isAxiosError(err) ? `${err.response?.status} ${JSON.stringify(err.response?.data)?.slice(0, 200)}` : String(err);
    console.error('[apollo] People Search error:', msg);
    return [];
  }
}
