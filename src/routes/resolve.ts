import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index';
import { applications, companies, contacts, email_resolutions, monetization_events, resolve_cache, user_contact_unlocks } from '../db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { getEntitlements, getCount, bumpCounter, monthPeriod, quotaExceededPayload } from '../middleware/quota';
import { resolveEmail, resolveKnownEmail } from '../engine/email';
import { fetchApolloContacts, type SourcedContact } from '../engine/apollo';
import { fetchHunterContacts } from '../engine/hunter';
import { isAlumniMatch } from '../engine/schoolMatch';
import { v4 as uuidv4 } from 'uuid';
import { isLegacyExtensionVersion } from '../lib/clientCompatibility';
import { upsertCanonicalApplicationForUser } from './canonicalApplications';
import {
  canonicalCompanyScope,
  commitContactUnlocks,
  entitledUsageRequestHash,
  getEntitledUsageReplay,
  requireFeature,
  releaseEntitledUsage,
  reserveEntitledUsage,
  usesLegacyMonthlyProductQuota,
  usesV2TrialMetering,
} from '../lib/entitlements';

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

async function unlockedContactIds(userId: string, contactIds: string[]): Promise<Set<string>> {
  if (contactIds.length === 0) return new Set();
  const rows = await db.select({ contact_id: user_contact_unlocks.contact_id }).from(user_contact_unlocks).where(and(
    eq(user_contact_unlocks.user_id, userId),
    inArray(user_contact_unlocks.contact_id, contactIds),
  ));
  return new Set(rows.map((row) => row.contact_id));
}

function verifiedContacts(results: ResolvedContact[]): ResolvedContact[] {
  return results.filter((row) => row.email_resolution.tier === 'green');
}

const resolveBodySchema = z.object({
  company: z.string().min(1),
  domain: z.string().min(1),
  role: z.string().min(1),
  team: z.string().optional(),
  user_school: z.string().optional(),
  company_id: z.string().uuid().optional(),
  application_id: z.string().uuid(),
  operation_id: z.string().uuid(),
});

async function adaptLegacyResolveRequest(request: FastifyRequest, userId: string): Promise<unknown> {
  if (!isLegacyExtensionVersion(request.headers) || !request.body || typeof request.body !== 'object') {
    return request.body;
  }
  const raw = request.body as Record<string, unknown>;
  const company = typeof raw.company === 'string' ? raw.company.trim() : '';
  const domain = typeof raw.domain === 'string' ? raw.domain.trim() : '';
  const role = typeof raw.role === 'string' ? raw.role.trim() : '';
  if (!company || !domain || !role) return request.body;
  let applicationId = typeof raw.application_id === 'string' ? raw.application_id : null;
  if (!applicationId) {
    const companyScopeKey = canonicalCompanyScope({ domain, companyName: company });
    const result = await upsertCanonicalApplicationForUser({
      userId,
      companyScopeKey,
      companyName: company,
      role,
      sourceSurface: 'extension',
    });
    applicationId = result.application.id;
  }
  const operationId = typeof raw.operation_id === 'string' ? raw.operation_id : uuidv4();
  try {
    await db.insert(monetization_events).values({
      event_key: `legacy-extension-resolve:${userId}:${operationId}`,
      user_id: userId,
      event_name: 'legacy_extension_contract_used',
      surface: 'extension',
      placement: 'contact_discovery',
      trigger: 'pre_0_6_0_adapter',
      feature_key: 'contact_discovery',
      application_id: applicationId,
      occurred_at: new Date(),
      properties: { client_version: request.headers['x-litos-version'], route: '/resolve' },
    }).onConflictDoNothing({ target: monetization_events.event_key });
  } catch (error) {
    request.log.warn({ error, userId }, 'could not record legacy extension resolve adapter telemetry');
  }
  return { ...raw, application_id: applicationId, operation_id: operationId };
}

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
      const strict = resolveBodySchema.safeParse(request.body);
      body = strict.success
        ? strict.data
        : resolveBodySchema.parse(await adaptLegacyResolveRequest(request, request.jwtPayload!.userId));
    } catch (err) {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    // Volume gating per PRD Section 10: hourly abuse limit, then the monthly
    // verified-contact quota (trial = pro limits for 7 days, then free tier).
    const userId = request.jwtPayload!.userId;
    const [application] = await db.select().from(applications).where(and(
      eq(applications.id, body.application_id),
      eq(applications.user_id, userId),
    )).limit(1);
    if (!application) return reply.status(404).send({ error: 'Application not found.', code: 'application_not_found' });
    const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
    const submittedScope = canonicalCompanyScope({ domain: body.domain, companyName: body.company });
    if (
      normalized(body.company) !== normalized(application.company_name)
      || normalized(body.role) !== normalized(application.role)
      || submittedScope !== application.company_scope_key
    ) return reply.status(409).send({
      error: 'Contact discovery context does not match the selected application.',
      code: 'resolve_context_mismatch',
    });
    const domain = application.company_scope_key.startsWith('domain:')
      ? application.company_scope_key.slice('domain:'.length)
      : null;
    if (!domain) return reply.status(409).send({
      error: 'The selected application needs a canonical company domain before contact discovery.',
      code: 'company_domain_required',
    });
    const companyName = application.company_name;
    const role = application.role;
    const { team, user_school } = body;
    const companyScopeKey = application.company_scope_key;
    const operationId = body.operation_id;
    const requestHash = entitledUsageRequestHash('contact', {
      company_scope_key: companyScopeKey,
      company: companyName.trim(),
      domain: domain.trim().toLowerCase(),
      role: role.trim(),
      team: team?.trim() ?? null,
      user_school: user_school?.trim() ?? null,
      application_id: body.application_id ?? null,
    });
    try {
      const replay = await getEntitledUsageReplay({
        userId,
        kind: 'contact',
        idempotencyKey: operationId,
        scopeKey: companyScopeKey,
        requestHash,
      });
      if (replay) return reply.status(replay.statusCode).send(replay.body);
    } catch (error) {
      const candidate = error as { statusCode?: number; code?: string; message?: string };
      return reply.status(candidate.statusCode ?? 409).send({
        error: candidate.message ?? 'Contact unlock cannot be replayed.',
        code: candidate.code ?? 'contact_unlock_conflict',
      });
    }
    const featureVerdict = await requireFeature(userId, 'contact_discovery', 'contact_discovery');
    if (!featureVerdict.allowed) return reply.status(402).send(featureVerdict.denial);
    const trialAccess = usesV2TrialMetering(featureVerdict.snapshot);
    const usesMonthlyProductQuota = usesLegacyMonthlyProductQuota(featureVerdict.snapshot);
    const ent = await getEntitlements(userId);
    const usedContacts = usesMonthlyProductQuota ? await getCount(userId, monthPeriod(), 'verified_contacts') : 0;
    const monthlyRemaining = usesMonthlyProductQuota
      ? Math.max(0, ent.monthlyContacts - usedContacts)
      : Number.MAX_SAFE_INTEGER;

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
        const verified = verifiedContacts(cachedResults);
        const previouslyUnlocked = await unlockedContactIds(userId, verified.map((row) => row.contact.id));
        if (trialAccess) {
          const existing = verified.filter((row) => previouslyUnlocked.has(row.contact.id)).slice(0, 2);
          const candidates = verified.filter((row) => !previouslyUnlocked.has(row.contact.id));
          const needed = Math.min(Math.max(0, 2 - existing.length), candidates.length);
          if (needed > 0) {
            let reservation;
            try {
              reservation = await reserveEntitledUsage({
                userId,
                kind: 'contact',
                idempotencyKey: operationId,
                requestHash,
                trigger: 'contact_discovery',
                applicationId: body.application_id,
                companyScopeKey,
                companyName,
                units: needed,
              });
            } catch (error) {
              const candidate = error as { statusCode?: number; code?: string; message?: string };
              return reply.status(candidate.statusCode ?? 409).send({
                error: candidate.message ?? 'Contact unlock is already in progress.',
                code: candidate.code ?? 'contact_unlock_in_progress',
              });
            }
            if (!reservation.allowed
              && needed === 2
              && reservation.denial.reason === 'trial_company_contact_limit'
              && reservation.denial.used === 1) {
              reservation = await reserveEntitledUsage({
                userId,
                kind: 'contact',
                idempotencyKey: operationId,
                requestHash,
                trigger: 'contact_discovery',
                applicationId: body.application_id,
                companyScopeKey,
                companyName,
                units: 1,
              });
            }
            if (!reservation.allowed) {
              if (existing.length > 0) {
                return reply.status(200).send({ contacts: existing, source: cached.source, cached: true, unlock_limit_reached: true });
              }
              return reply.status(402).send(reservation.denial);
            }
            if (reservation.replay) return reply.status(reservation.replay.statusCode).send(reservation.replay.body);
            const expectedUnlocks = new Set([
              ...previouslyUnlocked,
              ...candidates.slice(0, reservation.units).map((row) => row.contact.id),
            ]);
            const response = {
              contacts: verified.filter((row) => expectedUnlocks.has(row.contact.id)).slice(0, 2),
              source: cached.source,
              cached: true,
            };
            await commitContactUnlocks({
              userId,
              companyScopeKey,
              contactIds: candidates.slice(0, reservation.units).map((row) => row.contact.id),
              source: cached.source,
              reservationId: reservation.reservationId,
              replay: { statusCode: 200, body: response },
            });
            return reply.status(200).send(response);
          }
          const finalUnlocks = await unlockedContactIds(userId, verified.map((row) => row.contact.id));
          return reply.status(200).send({
            contacts: verified.filter((row) => finalUnlocks.has(row.contact.id)).slice(0, 2),
            source: cached.source,
            cached: true,
          });
        }
        const newVerified = verified.filter((row) => !previouslyUnlocked.has(row.contact.id)).slice(0, monthlyRemaining);
        if (newVerified.length === 0) {
          return reply.status(200).send({
            contacts: verified.filter((row) => previouslyUnlocked.has(row.contact.id)),
            source: cached.source,
            cached: true,
            unlock_limit_reached: verified.some((row) => !previouslyUnlocked.has(row.contact.id)),
          });
        }
        const reservation = await reserveEntitledUsage({
          userId,
          kind: 'contact',
          idempotencyKey: operationId,
          requestHash,
          trigger: 'contact_discovery',
          applicationId: body.application_id,
          companyScopeKey,
          companyName,
          units: newVerified.length,
        });
        if (!reservation.allowed) return reply.status(402).send(reservation.denial);
        if (reservation.replay) return reply.status(reservation.replay.statusCode).send(reservation.replay.body);
        const expectedUnlocks = new Set([
          ...previouslyUnlocked,
          ...newVerified.map((row) => row.contact.id),
        ]);
        const returnedResults = verified.filter((row) => expectedUnlocks.has(row.contact.id));
        const response = {
          contacts: returnedResults,
          source: cached.source,
          cached: true,
          unlock_limit_reached: newVerified.length < verified.filter((row) => !previouslyUnlocked.has(row.contact.id)).length,
        };
        const newlyUnlocked = await commitContactUnlocks({
          userId,
          companyScopeKey,
          contactIds: newVerified.map((row) => row.contact.id),
          source: cached.source,
          reservationId: reservation.reservationId,
          replay: { statusCode: 200, body: response },
        });
        if (usesMonthlyProductQuota && newlyUnlocked > 0) {
          await bumpCounter(userId, monthPeriod(), 'verified_contacts', newlyUnlocked);
        }
        return reply.status(200).send(response);
      }
    } catch (err) {
      fastify.log.error({ err }, 'resolve_cache read failed; continuing uncached');
    }

    let reservation: Awaited<ReturnType<typeof reserveEntitledUsage>> = {
      allowed: true,
      snapshot: featureVerdict.snapshot,
      reservationId: null,
      units: monthlyRemaining,
    };
    if (trialAccess) {
      try {
        reservation = await reserveEntitledUsage({
          userId,
          kind: 'contact',
          idempotencyKey: operationId,
          requestHash,
          trigger: 'contact_discovery',
          applicationId: body.application_id,
          companyScopeKey,
          companyName,
          units: 2,
        });
      } catch (error) {
        const candidate = error as { statusCode?: number; code?: string; message?: string };
        return reply.status(candidate.statusCode ?? 409).send({
          error: candidate.message ?? 'Contact unlock is already in progress.',
          code: candidate.code ?? 'contact_unlock_in_progress',
        });
      }
      if (!reservation.allowed
        && reservation.denial.reason === 'trial_company_contact_limit'
        && reservation.denial.used === 1) {
        reservation = await reserveEntitledUsage({
          userId,
          kind: 'contact',
          idempotencyKey: operationId,
          requestHash,
          trigger: 'contact_discovery',
          applicationId: body.application_id,
          companyScopeKey,
          companyName,
          units: 1,
        });
      }
      if (!reservation.allowed) return reply.status(402).send(reservation.denial);
      if (reservation.replay) return reply.status(reservation.replay.statusCode).send(reservation.replay.body);
    } else if (usesMonthlyProductQuota && monthlyRemaining === 0) {
      return reply.status(402).send(quotaExceededPayload(ent, usedContacts, 'contacts'));
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
        await releaseEntitledUsage(reservation.reservationId);
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

      // Cache publication, user ownership, and the v2 trial counter commit are one transaction.
      // A lost response can therefore be replayed from the cache without charging these contacts
      // twice or leaving a charged contact inaccessible.
      const selectedVerified = verifiedContacts(results).slice(0, trialAccess ? reservation.units : monthlyRemaining);
      if (!trialAccess && selectedVerified.length > 0) {
        try {
          reservation = await reserveEntitledUsage({
            userId,
            kind: 'contact',
            idempotencyKey: operationId,
            requestHash,
            trigger: 'contact_discovery',
            applicationId: body.application_id,
            companyScopeKey,
            companyName,
            units: selectedVerified.length,
          });
        } catch (error) {
          const candidate = error as { statusCode?: number; code?: string; message?: string };
          return reply.status(candidate.statusCode ?? 409).send({
            error: candidate.message ?? 'Contact unlock is already in progress.',
            code: candidate.code ?? 'contact_unlock_in_progress',
          });
        }
        if (!reservation.allowed) return reply.status(402).send(reservation.denial);
        if (reservation.replay) return reply.status(reservation.replay.statusCode).send(reservation.replay.body);
      }
      const selectedIds = new Set(selectedVerified.map((row) => row.contact.id));
      const response = {
        contacts: selectedVerified.filter((row) => selectedIds.has(row.contact.id)),
        source: contactSource,
        cached: false,
      };
      const newlyUnlocked = await commitContactUnlocks({
        userId,
        companyScopeKey,
        contactIds: selectedVerified.map((row) => row.contact.id),
        source: contactSource,
        reservationId: reservation.reservationId,
        replay: { statusCode: 200, body: response },
        cache: { key: cacheKey, results, source: contactSource },
      });
      if (usesMonthlyProductQuota && newlyUnlocked > 0) {
        await bumpCounter(userId, monthPeriod(), 'verified_contacts', newlyUnlocked);
      }
      return reply.status(200).send(response);
    } catch (err) {
      await releaseEntitledUsage(reservation.reservationId);
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to resolve contacts' });
    }
  });
}
