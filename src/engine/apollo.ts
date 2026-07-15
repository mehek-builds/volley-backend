import axios from 'axios';
import { extractTeam } from './patterns';
import { isAlumniMatch } from './schoolMatch';

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
  // Raw school names the provider returned for this person (0-2 typically). Carried through so
  // /resolve can (re)compute school_match against the requesting student's school - crucially,
  // this is what lets a shared (per company+role) cache entry recompute the alum flag per user
  // instead of leaking one student's alma mater onto another's results.
  candidate_schools?: string[];
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

interface ApolloEducation {
  school_name?: string;
  school?: string;
  institution?: string;
  degree?: string;
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
  // Education is parsed defensively across the shapes Apollo has been observed to return it in
  // (an `education`/`education_history` array of objects or strings, or a flat `schools` array).
  // NOTE: the standard people/bulk_match response does NOT reliably include education; when it is
  // absent, extractSchools returns [] and school_match stays false (we never guess an alum).
  education?: Array<ApolloEducation | string> | null;
  education_history?: Array<ApolloEducation | string> | null;
  schools?: string[] | null;
}

// Pull every school name off an Apollo match, tolerating the several shapes education can arrive
// in. Returns [] when Apollo gave us no education data.
export function extractSchools(m: ApolloMatch): string[] {
  const out: string[] = [];
  const pushStr = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  };
  const fromArray = (arr: Array<ApolloEducation | string> | null | undefined) => {
    if (!Array.isArray(arr)) return;
    for (const e of arr) {
      if (typeof e === 'string') pushStr(e);
      else if (e && typeof e === 'object') {
        pushStr(e.school_name);
        pushStr(e.school);
        pushStr(e.institution);
      }
    }
  };
  fromArray(m.education);
  fromArray(m.education_history);
  if (Array.isArray(m.schools)) for (const s of m.schools) pushStr(s);
  return out;
}

// One persona bucket = one Apollo search with titles that target that kind of person.
// Searching per persona (instead of one blended title list) keeps the shortlist from being
// dominated by recruiters, who otherwise crowd out the results.
function personaTitleBuckets(role: string, team: string | undefined): Array<{ persona: string; titles: string[] }> {
  const fn = team || extractTeam(role);
  return [
    { persona: 'recruiter', titles: ['University Recruiter', 'Technical Recruiter', 'Recruiter', 'Talent Acquisition'] },
    { persona: 'hiring_manager', titles: [`${fn} Manager`, `Head of ${fn}`, `Director of ${fn}`, 'Engineering Manager'] },
    { persona: 'near_peer', titles: [role, `${fn} Engineer`, 'Software Engineer'] },
  ];
}

// Search Apollo for matching person IDs by title (no enrichment credits spent).
async function apolloSearchIds(domain: string, titles: string[], apiKey: string, perPage: number): Promise<string[]> {
  try {
    const res = await axios.post(
      'https://api.apollo.io/api/v1/mixed_people/api_search',
      { q_organization_domains_list: [domain], person_titles: titles, page: 1, per_page: perPage },
      { headers: APOLLO_HEADERS(apiKey), timeout: 15000 }
    );
    const people: ApolloSearchPerson[] = res.data?.people ?? [];
    return people.map((p) => p.id).filter((id): id is string => Boolean(id));
  } catch (err) {
    const msg = axios.isAxiosError(err) ? `${err.response?.status}` : String(err);
    console.error('[apollo] search error:', msg);
    return [];
  }
}

export function classifyPersona(title: string, seniority: string | undefined): string {
  const t = title.toLowerCase();
  if (/recruit|talent acquisition|sourcer/.test(t)) return 'recruiter';
  // Leadership / founders / C-suite are decision-makers, not near-peers - group them with
  // hiring managers (which the draft selection deprioritizes for cold student outreach).
  if (/\b(ceo|cto|coo|cfo|cmo|cpo|chief|founder|co-?founder|president|owner|partner)\b/.test(t)) return 'hiring_manager';
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
 * Alumni detection: when Apollo's enrichment returns education for a person, we compare it to the
 * requesting student's school (userSchool) and set school_match. When Apollo returns no education,
 * school_match stays false - we never fabricate an alum. See extractSchools's NOTE on coverage.
 */
export async function fetchApolloContacts(
  domain: string,
  role: string,
  team: string | undefined,
  userSchool: string | undefined,
  limit = 6
): Promise<SourcedContact[]> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    console.warn('[apollo] APOLLO_API_KEY not set - falling back to synthetic contacts');
    return [];
  }

  try {
    // Step 1: one search per persona bucket (in parallel), then round-robin the IDs so the
    // enriched set spans recruiter / hiring manager / near-peer instead of all recruiters.
    const buckets = personaTitleBuckets(role, team);
    const idLists = await Promise.all(buckets.map((b) => apolloSearchIds(domain, b.titles, apiKey, 5)));

    const ids: string[] = [];
    const seenId = new Set<string>();
    let added = true;
    while (ids.length < limit && added) {
      added = false;
      for (const list of idLists) {
        const next = list.find((id) => !seenId.has(id));
        if (next && ids.length < limit) {
          ids.push(next);
          seenId.add(next);
          added = true;
        }
      }
    }
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
        const schools = extractSchools(m);
        return {
          full_name: full,
          first_name: first,
          last_name: last,
          title,
          persona: classifyPersona(title, m.seniority),
          school_match: isAlumniMatch(userSchool, schools),
          candidate_schools: schools,
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
