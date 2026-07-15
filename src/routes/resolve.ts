import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index';
import { companies, contacts, email_resolutions, resolve_cache } from '../db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { allowHourly, getEntitlements, getCount, bumpCounter, monthPeriod, quotaExceededPayload, rateLimitedReply, LIMITS } from '../middleware/quota';
import { resolveEmail, resolveKnownEmail } from '../engine/email';
import { fetchApolloContacts, type SourcedContact } from '../engine/apollo';
import { fetchHunterContacts } from '../engine/hunter';
import { isAlumniMatch } from '../engine/schoolMatch';
import { v4 as uuidv4 } from 'uuid';

// One resolved contact as returned to the client and stored in resolve_cache.
interface ResolvedContact {
  contact: {
    id: string;
    full_name: string;
    first_name: string;
    last_name: string;
    title: string;
    persona: string;
    school_match: boolean;
    linkedin_url: string;
    company_domain: string;
    candidate_schools?: string[];
  };
  email_resolution: {
    id?: string;
    email: string | null;
    status: string;
    tier: string;
    source: string;
    pattern_used?: string | null;
  };
}

const TIER_ORDER: Record<string, number> = { green: 0, amber: 1, blue: 2 };
// Ordered by how likely each persona is to reply to a student (and their referral value), so the
// UI list and any "top" selection favor reachable people over execs.
const PERSONA_ORDER: Record<string, number> = {
  alumni: 0,
  near_peer: 1,
  recruiter: 2,
  hiring_manager: 3,
  senior_ic: 4,
};

// Final ordering: verified (green) first, then within a tier put ALUMNI first (a same-school
// contact is the warmest intro a student can get, so a detected alum outranks persona), then fall
// back to persona rank. Mutates in place.
function rankResolved(results: ResolvedContact[]): void {
  results.sort((a, b) => {
    const tierDiff =
      (TIER_ORDER[a.email_resolution.tier] ?? 99) - (TIER_ORDER[b.email_resolution.tier] ?? 99);
    if (tierDiff !== 0) return tierDiff;
    const alumDiff = (a.contact.school_match ? 0 : 1) - (b.contact.school_match ? 0 : 1);
    if (alumDiff !== 0) return alumDiff;
    return (PERSONA_ORDER[a.contact.persona] ?? 99) - (PERSONA_ORDER[b.contact.persona] ?? 99);
  });
}

const resolveBodySchema = z.object({
  company: z.string().min(1),
  domain: z.string().min(1),
  role: z.string().min(1),
  team: z.string().optional(),
  user_school: z.string().optional(),
});

// Per-company+role cache (persistent, DB-backed via the resolve_cache table). A resolve is
// the expensive step (provider search + per-contact verification credits), and the same
// company/role gets looked up repeatedly across students and sessions. Caching the finished
// result makes repeat resolves cost zero credits, and it survives process restarts.
const RESOLVE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSizeBucket(domain: string): { size_bucket: string; employee_count: number } {
  // Heuristic bucket assignment based on well-known companies
  // In production this would come from a data provider
  const largeDomains = ['google.com', 'meta.com', 'amazon.com', 'microsoft.com', 'apple.com', 'netflix.com', 'salesforce.com', 'oracle.com'];
  const midDomains = ['stripe.com', 'airbnb.com', 'lyft.com', 'dropbox.com', 'twilio.com', 'zendesk.com'];

  if (largeDomains.includes(domain)) return { size_bucket: 'large', employee_count: 50000 };
  if (midDomains.includes(domain)) return { size_bucket: 'mid', employee_count: 5000 };
  return { size_bucket: 'small', employee_count: 150 };
}

function generateSyntheticContacts(
  companyName: string,
  domain: string,
  role: string,
  team: string | undefined,
  userSchool: string | undefined
): Array<{
  full_name: string;
  first_name: string;
  last_name: string;
  title: string;
  persona: string;
  school_match: boolean;
  linkedin_url: string;
}> {
  const teamLabel = team || extractTeam(role);
  const companySlug = domain.split('.')[0];

  const contacts: Array<{
    full_name: string;
    first_name: string;
    last_name: string;
    title: string;
    persona: string;
    school_match: boolean;
    linkedin_url: string;
  }> = [];

  // Alumni contact (only if user_school provided)
  if (userSchool) {
    contacts.push({
      full_name: 'Priya Sharma',
      first_name: 'Priya',
      last_name: 'Sharma',
      title: `Software Engineer, ${teamLabel}`,
      persona: 'alumni',
      school_match: true,
      linkedin_url: `https://linkedin.com/in/priya-sharma-${companySlug}`,
    });
  }

  // Recruiter
  contacts.push({
    full_name: 'Jordan Lee',
    first_name: 'Jordan',
    last_name: 'Lee',
    title: `University Recruiter, ${companyName}`,
    persona: 'recruiter',
    school_match: false,
    linkedin_url: `https://linkedin.com/in/jordan-lee-${companySlug}-recruiting`,
  });

  // Hiring manager
  contacts.push({
    full_name: 'Marcus Chen',
    first_name: 'Marcus',
    last_name: 'Chen',
    title: `Engineering Manager, ${teamLabel}`,
    persona: 'hiring_manager',
    school_match: false,
    linkedin_url: `https://linkedin.com/in/marcus-chen-${companySlug}`,
  });

  // Senior IC
  contacts.push({
    full_name: 'Aisha Williams',
    first_name: 'Aisha',
    last_name: 'Williams',
    title: `Senior ${extractJobTitle(role)}, ${teamLabel}`,
    persona: 'senior_ic',
    school_match: false,
    linkedin_url: `https://linkedin.com/in/aisha-williams-${companySlug}`,
  });

  // Near-peer (2-3 years ahead)
  contacts.push({
    full_name: 'Ryan Park',
    first_name: 'Ryan',
    last_name: 'Park',
    title: `${extractJobTitle(role)}, ${teamLabel}`,
    persona: 'near_peer',
    school_match: false,
    linkedin_url: `https://linkedin.com/in/ryan-park-${companySlug}`,
  });

  return contacts;
}

function extractTeam(role: string): string {
  const lower = role.toLowerCase();
  if (lower.includes('machine learning') || lower.includes('ml')) return 'ML Platform';
  if (lower.includes('data')) return 'Data Engineering';
  if (lower.includes('frontend') || lower.includes('front-end')) return 'Frontend';
  if (lower.includes('backend') || lower.includes('back-end')) return 'Backend Infrastructure';
  if (lower.includes('mobile') || lower.includes('ios') || lower.includes('android')) return 'Mobile';
  if (lower.includes('product')) return 'Product';
  return 'Engineering';
}

function extractJobTitle(role: string): string {
  const lower = role.toLowerCase();
  if (lower.includes('engineer')) return 'Software Engineer';
  if (lower.includes('analyst')) return 'Data Analyst';
  if (lower.includes('scientist')) return 'Data Scientist';
  if (lower.includes('manager')) return 'Product Manager';
  if (lower.includes('designer')) return 'Product Designer';
  return 'Software Engineer';
}

export async function resolveRoutes(fastify: FastifyInstance) {
  fastify.post('/resolve', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof resolveBodySchema>;

    try {
      body = resolveBodySchema.parse(request.body);
    } catch (err) {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    const { company: companyName, domain, role, team, user_school } = body;

    // Volume gating per PRD Section 10: hourly abuse limit, then the monthly
    // verified-contact quota (trial = pro limits for 7 days, then free tier).
    const userId = request.jwtPayload!.userId;
    if (!(await allowHourly(userId, 'resolve', LIMITS.perHour.resolve))) {
      return rateLimitedReply(reply);
    }
    const ent = await getEntitlements(userId);
    const usedContacts = await getCount(userId, monthPeriod(), 'verified_contacts');
    if (usedContacts >= ent.monthlyContacts) {
      return reply.status(402).send(quotaExceededPayload(ent, usedContacts, 'contacts'));
    }

    // Cache check: same company+role within the TTL -> return the cached result, spending no
    // provider/verification credits.
    const cacheKey = `${domain}|${role}`.toLowerCase();
    try {
      const cachedRows = await db.select().from(resolve_cache).where(eq(resolve_cache.cache_key, cacheKey)).limit(1);
      const cached = cachedRows[0];
      if (cached && Date.now() - new Date(cached.cached_at).getTime() < RESOLVE_CACHE_TTL_MS) {
        // The cache is keyed by company+role and SHARED across students, so school_match (which is
        // per-student) must be recomputed here from the stored candidate_schools rather than served
        // verbatim - otherwise one student's alma mater would leak onto another's results. Then
        // re-rank so any alum for THIS student floats up.
        const cachedResults: ResolvedContact[] = Array.isArray(cached.results)
          ? (cached.results as ResolvedContact[]).map((r) => ({
              ...r,
              contact: {
                ...r.contact,
                school_match: isAlumniMatch(user_school, r.contact.candidate_schools ?? []),
              },
            }))
          : [];
        rankResolved(cachedResults);
        // Cache hits cost us nothing but deliver the same user value: they spend quota too.
        const cachedVerified = cachedResults.filter((r) => r.email_resolution.tier === 'green').length;
        if (cachedVerified > 0) await bumpCounter(userId, monthPeriod(), 'verified_contacts', cachedVerified);
        return reply.status(200).send({ contacts: cachedResults, source: cached.source, cached: true });
      }
    } catch (err) {
      fastify.log.error({ err }, 'resolve_cache read failed; continuing uncached');
    }

    try {
      // Step 1: Look up or create company record
      let companyRecord = await db
        .select()
        .from(companies)
        .where(eq(companies.domain, domain))
        .limit(1);

      if (companyRecord.length === 0) {
        const { size_bucket, employee_count } = getSizeBucket(domain);
        await db.insert(companies).values({
          id: uuidv4(),
          domain,
          name: companyName,
          employee_count,
          size_bucket,
        });
        companyRecord = await db.select().from(companies).where(eq(companies.domain, domain)).limit(1);
      }

      const company = companyRecord[0];

      // Step 2: Source contacts. Priority: Hunter (cheapest, emails included) -> Apollo ->
      // synthetic, so the product always returns something even with no provider keys.
      let sourcedContacts: SourcedContact[] = await fetchHunterContacts(domain, role, team, 6);
      let contactSource: 'hunter' | 'apollo' | 'synthetic' = 'hunter';
      if (sourcedContacts.length === 0) {
        sourcedContacts = await fetchApolloContacts(domain, role, team, user_school, 6);
        contactSource = 'apollo';
      }
      // Synthetic contacts are demo fixtures (invented people with guessed emails), never a
      // production fallback: drafting real cold emails to people who don't exist is worse
      // than an honest empty state. Opt in explicitly for local demos only.
      if (sourcedContacts.length === 0 && process.env.ENABLE_SYNTHETIC_CONTACTS === 'true') {
        sourcedContacts = generateSyntheticContacts(companyName, domain, role, team, user_school);
        contactSource = 'synthetic';
      }
      if (sourcedContacts.length === 0) {
        // Deliberately uncached: a later attempt may find real contacts once providers
        // recover or the company appears in their indexes.
        return reply.status(200).send({ contacts: [], source: 'none', cached: false });
      }

      // Step 3: Insert contacts and resolve emails. Contacts are independent of each other, so
      // resolve them CONCURRENTLY: each resolveEmail runs several sequential verifier HTTP calls
      // (10-20s timeouts apiece), and doing the up-to-6 contacts in series made this the dominant
      // latency behind "finding contacts". Promise.all collapses it to roughly one contact's
      // resolution time. Ordering doesn't matter here - results are sorted by tier/persona below.
      const settled = await Promise.allSettled(
        sourcedContacts.map(async (sc): Promise<ResolvedContact> => {
          const contactId = uuidv4();
          await db.insert(contacts).values({
            id: contactId,
            full_name: sc.full_name,
            first_name: sc.first_name,
            last_name: sc.last_name,
            linkedin_url: sc.linkedin_url,
            company_domain: domain,
            title: sc.title,
            persona: sc.persona,
            school_match: sc.school_match,
          });

          // Resolve email. If the source already gave us a real address (Apollo), verify that
          // directly; otherwise generate + verify candidate patterns.
          const emailResult = sc.email
            ? await resolveKnownEmail(sc.email, sc.email_status)
            : await resolveEmail(
                {
                  id: contactId,
                  first_name: sc.first_name,
                  last_name: sc.last_name,
                  company_domain: domain,
                },
                { size_bucket: company.size_bucket }
              );

          // Store email resolution
          const resolutionId = uuidv4();
          await db.insert(email_resolutions).values({
            id: resolutionId,
            contact_id: contactId,
            email: emailResult.email,
            status: emailResult.status,
            tier: emailResult.tier,
            source: emailResult.source,
            verifier_raw_json: emailResult.verifierRawJson ?? null,
            resolved_at: new Date(),
          });

          return {
            contact: {
              id: contactId,
              full_name: sc.full_name,
              first_name: sc.first_name,
              last_name: sc.last_name,
              title: sc.title,
              persona: sc.persona,
              school_match: sc.school_match,
              // Carried so a shared cache hit can recompute the per-student alum flag later.
              candidate_schools: sc.candidate_schools ?? [],
              linkedin_url: sc.linkedin_url,
              company_domain: domain,
            },
            email_resolution: {
              id: resolutionId,
              email: emailResult.email,
              status: emailResult.status,
              tier: emailResult.tier,
              source: emailResult.source,
              pattern_used: emailResult.patternUsed,
            },
          };
        })
      );

      // A single contact's DB insert failing shouldn't 500 the whole request and lose the other
      // five. Keep the ones that resolved; log and drop any that threw.
      const results: ResolvedContact[] = [];
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') results.push(outcome.value);
        else fastify.log.error(outcome.reason, 'failed to resolve a sourced contact; dropping it');
      }

      // Green first, then amber, then blue; alumni first within a tier, then persona rank.
      rankResolved(results);

      try {
        await db
          .insert(resolve_cache)
          .values({ cache_key: cacheKey, results, source: contactSource, cached_at: new Date() })
          .onConflictDoUpdate({
            target: resolve_cache.cache_key,
            set: { results, source: contactSource, cached_at: new Date() },
          });
      } catch (err) {
        fastify.log.error({ err }, 'resolve_cache write failed; result still returned');
      }
      // Spend quota only on verified (green) contacts: never on a guess (PRD).
      const verifiedCount = results.filter(r => r.email_resolution.tier === 'green').length;
      if (verifiedCount > 0) await bumpCounter(userId, monthPeriod(), 'verified_contacts', verifiedCount);

      return reply.status(200).send({ contacts: results, source: contactSource, cached: false });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to resolve contacts' });
    }
  });
}
