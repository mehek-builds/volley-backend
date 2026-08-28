import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { db } from '../db/index';
import { applications, companies, contacts, entitlement_usage_reservations, monetization_events, outreach_draft_generations, profiles, user_contact_unlocks } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { getEntitlements, getCount, monthPeriod, quotaExceededPayload } from '../middleware/quota';
import { generateDraft } from '../llm/draft';
import { declaredSkillsList } from './profile';
import { upsertCanonicalApplicationForUser } from './canonicalApplications';
import { isLegacyExtensionVersion } from '../lib/clientCompatibility';
import { OUTREACH_DRAFT_TYPES } from '../lib/outreachDraftTypes';
import {
  canonicalCompanyScope,
  commitOutreachDraftGeneration,
  entitledUsageRequestHash,
  persistedOutreachDraftResponse,
  releaseEntitledUsage,
  reserveEntitledUsage,
  usesLegacyMonthlyProductQuota,
} from '../lib/entitlements';

const draftBodySchema = z.object({
  contact: z.object({
    id: z.string().uuid().optional(),
    full_name: z.string().min(1),
    title: z.string().trim().min(1).max(240),
    persona: z.string(),
    company: z.string().min(1).optional(),
    school_match: z.boolean(),
    linkedin_url: z.string().optional(),
    company_domain: z.string().trim().min(1).max(255).optional(),
    email: z.string().trim().email().max(320).optional(),
  }),
  role: z.string().min(1).optional(),
  company: z.string().min(1).optional(),
  company_domain: z.string().optional(),
  application_id: z.string().uuid(),
  operation_id: z.string().uuid(),
  draft_type: z.enum(OUTREACH_DRAFT_TYPES),
  user_profile: z.object({
    experience: z.array(
      z.object({
        company: z.string(),
        title: z.string(),
        start: z.string(),
        end: z.string(),
        description: z.string(),
      })
    ),
    skills: z.array(z.string()),
    school: z.string(),
    grad_year: z.number(),
  }),
});

const manualDraftBodySchema = z.object({
  application_id: z.string().uuid(),
  operation_id: z.string().uuid(),
  draft_type: z.enum(OUTREACH_DRAFT_TYPES),
  contact: draftBodySchema.shape.contact,
  subject: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(20_000),
}).strict();

type DraftBody = z.infer<typeof draftBodySchema>;

function normalizedText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function routeError(statusCode: number, code: string, message: string, details?: unknown) {
  return Object.assign(new Error(message), { statusCode, code, details });
}

function domainFromScope(scope: string): string | null {
  return scope.startsWith('domain:') ? scope.slice('domain:'.length) : null;
}

export type CanonicalDraftContext = {
  applicationId: string;
  operationId: string;
  companyScopeKey: string;
  company: string;
  role: string;
  contact: {
    id: string;
    full_name: string;
    title: string;
    persona: string;
    company: string;
    school_match: boolean;
    linkedin_url?: string;
    company_domain?: string;
    email?: string;
  };
};

function draftReadResponse(
  row: typeof outreach_draft_generations.$inferSelect,
  contact: Pick<typeof contacts.$inferSelect, 'id' | 'full_name' | 'title' | 'persona' | 'company_domain'>,
) {
  return {
    ...persistedOutreachDraftResponse(row),
    contact: {
      id: contact.id,
      full_name: contact.full_name ?? '',
      title: contact.title ?? '',
      persona: contact.persona ?? 'manual',
      company_domain: contact.company_domain,
      email: row.contact_email,
    },
  };
}

async function adaptLegacyDraftRequest(
  request: FastifyRequest,
  userId: string,
): Promise<unknown> {
  if (!isLegacyExtensionVersion(request.headers) || !request.body || typeof request.body !== 'object') {
    return request.body;
  }
  const raw = request.body as Record<string, unknown>;
  const company = typeof raw.company === 'string' ? raw.company.trim() : '';
  const role = typeof raw.role === 'string' ? raw.role.trim() : '';
  if (!company || !role) return request.body;
  let applicationId = typeof raw.application_id === 'string' ? raw.application_id : null;
  if (!applicationId) {
    const domain = typeof raw.company_domain === 'string'
      ? raw.company_domain
      : raw.contact && typeof raw.contact === 'object' && typeof (raw.contact as Record<string, unknown>).company_domain === 'string'
        ? String((raw.contact as Record<string, unknown>).company_domain)
        : null;
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
  if (!applicationId) return request.body;
  const operationId = typeof raw.operation_id === 'string' ? raw.operation_id : randomUUID();
  try {
    await db.insert(monetization_events).values({
      event_key: `legacy-extension-draft:${userId}:${operationId}`,
      user_id: userId,
      event_name: 'legacy_extension_contract_used',
      surface: 'extension',
      placement: 'outreach_draft',
      trigger: 'pre_0_6_0_adapter',
      feature_key: 'outreach_email_generation',
      application_id: applicationId,
      occurred_at: new Date(),
      properties: { client_version: request.headers['x-litos-version'], route: '/draft' },
    }).onConflictDoNothing({ target: monetization_events.event_key });
  } catch (error) {
    request.log.warn({ error, userId }, 'could not record legacy extension draft adapter telemetry');
  }
  return {
    ...raw,
    application_id: applicationId,
    operation_id: operationId,
    draft_type: 'first_note',
  };
}

// Manual contacts are canonicalized before any entitlement reservation or model call. Their
// deterministic id is private to the account and stable contact identity. A supplied email is
// kept only on the user-owned draft row and never written to shared contacts or email resolutions.
export async function canonicalDraftContext(userId: string, body: DraftBody): Promise<CanonicalDraftContext> {
  const [application] = await db.select().from(applications).where(and(
    eq(applications.id, body.application_id),
    eq(applications.user_id, userId),
  )).limit(1);
  if (!application) throw routeError(404, 'application_not_found', 'Application not found.');

  const suppliedCompanies = [body.company, body.contact.company].filter((value): value is string => Boolean(value));
  if (suppliedCompanies.some((value) => normalizedText(value) !== normalizedText(application.company_name))) {
    throw routeError(409, 'draft_context_mismatch', 'Company does not match the selected application.', ['company']);
  }
  if (body.role && normalizedText(body.role) !== normalizedText(application.role)) {
    throw routeError(409, 'draft_context_mismatch', 'Role does not match the selected application.', ['role']);
  }
  const suppliedDomains = [body.company_domain, body.contact.company_domain]
    .filter((value): value is string => Boolean(value));
  const canonicalDomains = new Set(suppliedDomains.map((domain) => canonicalCompanyScope({
    domain,
    companyName: application.company_name,
  })));
  if (canonicalDomains.size > 1 || [...canonicalDomains].some((scope) => scope !== application.company_scope_key)) {
    throw routeError(409, 'draft_context_mismatch', 'Company domain does not match the selected application.', ['company_domain']);
  }
  const applicationDomain = domainFromScope(application.company_scope_key);

  let contactId = body.contact.id;
  if (!contactId) {
    const stableIdentity = body.contact.linkedin_url?.trim().toLowerCase()
      || body.contact.email?.trim().toLowerCase()
      || `${normalizedText(body.contact.full_name)}|${normalizedText(body.contact.title)}`;
    contactId = uuidv5(
      `https://trylitos.com/accounts/${userId}/outreach-contacts/${application.company_scope_key}/${stableIdentity}`,
      uuidv5.URL,
    );
    const names = body.contact.full_name.trim().split(/\s+/);
    await db.transaction(async (tx) => {
      if (applicationDomain) {
        await tx.insert(companies).values({
          domain: applicationDomain,
          name: application.company_name,
        }).onConflictDoNothing({ target: companies.domain });
      }
      const [prior] = await tx.select().from(contacts).where(eq(contacts.id, contactId!)).limit(1);
      if (prior && (
        normalizedText(prior.full_name ?? '') !== normalizedText(body.contact.full_name)
        || normalizedText(prior.title ?? '') !== normalizedText(body.contact.title)
        || prior.company_domain !== applicationDomain
      )) throw routeError(409, 'idempotency_conflict', 'Operation id is already bound to a different manual contact.');
      if (!prior) {
        await tx.insert(contacts).values({
          id: contactId,
          full_name: body.contact.full_name.trim(),
          first_name: names[0] ?? body.contact.full_name.trim(),
          last_name: names.slice(1).join(' ') || null,
          linkedin_url: body.contact.linkedin_url,
          company_domain: applicationDomain,
          title: body.contact.title.trim(),
          persona: body.contact.persona.trim() || 'manual',
          school_match: body.contact.school_match,
        });
      }
      const [priorUnlock] = await tx.select().from(user_contact_unlocks).where(and(
        eq(user_contact_unlocks.user_id, userId),
        eq(user_contact_unlocks.contact_id, contactId!),
      )).limit(1);
      if (priorUnlock && priorUnlock.company_scope_key !== application.company_scope_key) {
        throw routeError(409, 'idempotency_conflict', 'Operation id is already bound to a different company.');
      }
      await tx.insert(user_contact_unlocks).values({
        user_id: userId,
        contact_id: contactId!,
        company_scope_key: application.company_scope_key,
        source: 'manual',
      }).onConflictDoNothing();
    });
  }

  const [owned] = await db.select({
    contact: contacts,
    unlockScope: user_contact_unlocks.company_scope_key,
  }).from(user_contact_unlocks).innerJoin(contacts, eq(contacts.id, user_contact_unlocks.contact_id)).where(and(
    eq(user_contact_unlocks.user_id, userId),
    eq(user_contact_unlocks.contact_id, contactId),
  )).limit(1);
  if (!owned) throw routeError(404, 'contact_not_found', 'Contact not found for this account.');
  if (owned.unlockScope !== application.company_scope_key) {
    throw routeError(409, 'draft_context_mismatch', 'Contact does not belong to the selected application company.', ['contact']);
  }
  if (applicationDomain && owned.contact.company_domain !== applicationDomain) {
    throw routeError(409, 'draft_context_mismatch', 'Contact domain does not match the selected application.', ['contact']);
  }
  if (!owned.contact.full_name || !owned.contact.title) {
    throw routeError(409, 'contact_incomplete', 'Contact is missing the name or title needed for a draft.');
  }
  return {
    applicationId: application.id,
    operationId: body.operation_id,
    companyScopeKey: application.company_scope_key,
    company: application.company_name,
    role: application.role,
    contact: {
      id: owned.contact.id,
      full_name: owned.contact.full_name,
      title: owned.contact.title,
      persona: owned.contact.persona ?? 'manual',
      company: application.company_name,
      school_match: owned.contact.school_match ?? false,
      ...(owned.contact.linkedin_url ? { linkedin_url: owned.contact.linkedin_url } : {}),
      ...(owned.contact.company_domain ? { company_domain: owned.contact.company_domain } : {}),
      ...(body.contact.email ? { email: body.contact.email.trim().toLowerCase() } : {}),
    },
  };
}

async function persistManualOutreachDraft(input: {
  userId: string;
  context: CanonicalDraftContext;
  draftType: typeof OUTREACH_DRAFT_TYPES[number];
  subject: string;
  body: string;
  requestHash: string;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`manual-draft:${input.userId}:${input.context.operationId}`}, 0::bigint))`);
    const [prior] = await tx.select().from(outreach_draft_generations).where(and(
      eq(outreach_draft_generations.user_id, input.userId),
      eq(outreach_draft_generations.operation_id, input.context.operationId),
    )).limit(1);
    if (prior) {
      if (
        prior.request_hash !== input.requestHash
        || prior.application_id !== input.context.applicationId
        || prior.contact_id !== input.context.contact.id
        || prior.draft_type !== input.draftType
        || prior.generation_source !== 'user_written'
      ) throw routeError(409, 'idempotency_conflict', 'Operation id is already bound to a different draft.');
      return { row: prior, created: false };
    }
    const now = new Date();
    const [created] = await tx.insert(outreach_draft_generations).values({
      user_id: input.userId,
      operation_id: input.context.operationId,
      request_hash: input.requestHash,
      contact_id: input.context.contact.id,
      contact_email: input.context.contact.email ?? null,
      application_id: input.context.applicationId,
      company_scope_key: input.context.companyScopeKey,
      company_name: input.context.company,
      role: input.context.role,
      draft_type: input.draftType,
      generation_source: 'user_written',
      original_subject: input.subject,
      original_body: input.body,
      subject: input.subject,
      body: input.body,
      word_count: input.body.trim().split(/\s+/).filter(Boolean).length,
      warnings: [],
      created_at: now,
      updated_at: now,
    }).returning();
    if (!created) throw new Error('Manual draft persistence returned no record');
    return { row: created, created: true };
  });
}

// A non-empty DECLARED skills list replaces whatever the client sent (R-027). /draft's
// user_profile arrives from the client, which historically built it from GET /profile's bare
// parsed_json spread - so outreach drafts ran on resume-INFERRED skills even after R-015 made
// profiles.skills authoritative for the resume. Fixing GET /profile helps a current client, but
// the server cannot know the caller rebuilt its cache, so the override is enforced here too:
// the declared list reaches drafting no matter what the extension has stored. An empty declared
// list means "never declared" and leaves the client's skills alone (same NULL-vs-[] semantics
// as the resume path).
export function applyDeclaredSkills<T extends { skills: string[] }>(userProfile: T, declared: string[]): T {
  return declared.length > 0 ? { ...userProfile, skills: declared } : userProfile;
}

export function canonicalDraftCompanyScope(input: {
  company: string;
  company_id?: string;
  company_domain?: string;
  contact: { company_domain?: string };
}): string {
  const topLevel = input.company_domain
    ? canonicalCompanyScope({ domain: input.company_domain, companyName: input.company })
    : null;
  const contactLevel = input.contact.company_domain
    ? canonicalCompanyScope({ domain: input.contact.company_domain, companyName: input.company })
    : null;
  if (topLevel && contactLevel && topLevel !== contactLevel) {
    throw Object.assign(new Error('Company domain does not match the selected contact'), { statusCode: 400 });
  }
  return topLevel ?? contactLevel ?? canonicalCompanyScope({
    companyId: input.company_id,
    companyName: input.company,
  });
}

export async function draftRoutes(fastify: FastifyInstance) {
  fastify.post('/drafts/manual', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = manualDraftBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({
      error: 'Invalid manual draft',
      code: 'invalid_request',
      detail: parsed.error.issues,
    });
    const userId = request.jwtPayload!.userId;
    let context: CanonicalDraftContext;
    try {
      context = await canonicalDraftContext(userId, {
        application_id: parsed.data.application_id,
        operation_id: parsed.data.operation_id,
        draft_type: parsed.data.draft_type,
        contact: parsed.data.contact,
        user_profile: { experience: [], skills: [], school: '', grad_year: 0 },
      });
    } catch (error) {
      const candidate = error as { statusCode?: number; code?: string; message?: string; details?: unknown };
      return reply.status(candidate.statusCode ?? 409).send({
        error: candidate.message ?? 'Manual draft context could not be verified.',
        code: candidate.code ?? 'draft_context_mismatch',
        ...(candidate.details ? { details: candidate.details } : {}),
      });
    }
    const requestHash = entitledUsageRequestHash('draft', {
      generation_source: 'user_written',
      application_id: context.applicationId,
      company_scope_key: context.companyScopeKey,
      role: context.role,
      contact: context.contact,
      draft_type: parsed.data.draft_type,
      subject: parsed.data.subject,
      body: parsed.data.body,
    });
    try {
      const saved = await persistManualOutreachDraft({
        userId,
        context,
        draftType: parsed.data.draft_type,
        subject: parsed.data.subject,
        body: parsed.data.body,
        requestHash,
      });
      return reply.header('Cache-Control', 'private, no-store').status(saved.created ? 201 : 200).send(
        draftReadResponse(saved.row, {
          id: context.contact.id,
          full_name: context.contact.full_name,
          title: context.contact.title,
          persona: context.contact.persona,
          company_domain: context.contact.company_domain ?? null,
        }),
      );
    } catch (error) {
      const candidate = error as { statusCode?: number; code?: string; message?: string };
      return reply.status(candidate.statusCode ?? 500).send({
        error: candidate.message ?? 'Manual draft could not be saved.',
        code: candidate.code ?? 'manual_draft_save_failed',
      });
    }
  });

  fastify.get('/drafts', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = z.object({
      application_id: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid draft list request', code: 'invalid_request' });
    const userId = request.jwtPayload!.userId;
    const where = parsed.data.application_id
      ? and(
        eq(outreach_draft_generations.user_id, userId),
        eq(outreach_draft_generations.application_id, parsed.data.application_id),
      )
      : eq(outreach_draft_generations.user_id, userId);
    const rows = await db.select({
      draft: outreach_draft_generations,
      contact: {
        id: contacts.id,
        full_name: contacts.full_name,
        title: contacts.title,
        persona: contacts.persona,
        company_domain: contacts.company_domain,
      },
    }).from(outreach_draft_generations)
      .innerJoin(contacts, eq(contacts.id, outreach_draft_generations.contact_id)).where(where)
      .orderBy(desc(outreach_draft_generations.created_at)).limit(parsed.data.limit);
    return reply.header('Cache-Control', 'private, no-store').send({
      drafts: rows.map((row) => draftReadResponse(row.draft, row.contact)),
    });
  });

  fastify.get('/drafts/:id', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid draft id', code: 'invalid_request' });
    const [row] = await db.select({
      draft: outreach_draft_generations,
      contact: {
        id: contacts.id,
        full_name: contacts.full_name,
        title: contacts.title,
        persona: contacts.persona,
        company_domain: contacts.company_domain,
      },
    }).from(outreach_draft_generations)
      .innerJoin(contacts, eq(contacts.id, outreach_draft_generations.contact_id)).where(and(
      eq(outreach_draft_generations.id, parsed.data.id),
      eq(outreach_draft_generations.user_id, request.jwtPayload!.userId),
    )).limit(1);
    if (!row) return reply.status(404).send({ error: 'Draft not found', code: 'draft_not_found' });
    return reply.header('Cache-Control', 'private, no-store').send({ draft: draftReadResponse(row.draft, row.contact) });
  });

  fastify.patch('/drafts/:id', { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({
      subject: z.string().trim().min(1).max(240),
      body: z.string().trim().min(1).max(20_000),
      contact_email: z.string().trim().email().max(320).nullable().optional(),
    }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: 'Invalid draft edit', code: 'invalid_request' });
    }
    const userId = request.jwtPayload!.userId;
    const now = new Date();
    const wordCount = body.data.body.trim().split(/\s+/).filter(Boolean).length;
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(outreach_draft_generations).set({
        subject: body.data.subject,
        body: body.data.body,
        ...(body.data.contact_email !== undefined ? { contact_email: body.data.contact_email } : {}),
        word_count: wordCount,
        updated_at: now,
      }).where(and(
        eq(outreach_draft_generations.id, params.data.id),
        eq(outreach_draft_generations.user_id, userId),
      )).returning();
      if (!row) return null;
      const response = persistedOutreachDraftResponse(row);
      await tx.update(entitlement_usage_reservations).set({
        result_envelope: response,
      }).where(and(
        eq(entitlement_usage_reservations.user_id, userId),
        eq(entitlement_usage_reservations.usage_kind, 'draft'),
        eq(entitlement_usage_reservations.idempotency_key, row.operation_id),
        eq(entitlement_usage_reservations.status, 'committed'),
        gt(entitlement_usage_reservations.result_expires_at, now),
      ));
      return row;
    });
    if (!updated) return reply.status(404).send({ error: 'Draft not found', code: 'draft_not_found' });
    const [contact] = await db.select({
      id: contacts.id,
      full_name: contacts.full_name,
      title: contacts.title,
      persona: contacts.persona,
      company_domain: contacts.company_domain,
    }).from(contacts).where(eq(contacts.id, updated.contact_id)).limit(1);
    if (!contact) return reply.status(409).send({ error: 'Draft contact is unavailable', code: 'contact_not_found' });
    return reply.header('Cache-Control', 'private, no-store').send({ draft: draftReadResponse(updated, contact) });
  });

  fastify.post('/draft', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof draftBodySchema>;

    try {
      const strict = draftBodySchema.safeParse(request.body);
      body = strict.success
        ? strict.data
        : draftBodySchema.parse(await adaptLegacyDraftRequest(request, request.jwtPayload!.userId));
    } catch (err) {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    const userId = request.jwtPayload!.userId;
    let context: CanonicalDraftContext;
    try {
      context = await canonicalDraftContext(userId, body);
    } catch (error) {
      const candidate = error as { statusCode?: number; code?: string; message?: string; details?: unknown };
      return reply.status(candidate.statusCode ?? 409).send({
        error: candidate.message ?? 'Draft context could not be verified.',
        code: candidate.code ?? 'draft_context_mismatch',
        ...(candidate.details ? { details: candidate.details } : {}),
      });
    }
    const { contact, role, company, companyScopeKey } = context;
    const requestHash = entitledUsageRequestHash('draft', {
      draft_type: body.draft_type,
      company_scope_key: companyScopeKey,
      company,
      role,
      contact,
      contact_email: body.contact.email ?? null,
      application_id: context.applicationId,
      user_profile: body.user_profile,
    });
    let reservation: Awaited<ReturnType<typeof reserveEntitledUsage>>;
    try {
      reservation = await reserveEntitledUsage({
        userId,
        kind: 'draft',
        idempotencyKey: context.operationId,
        requestHash,
        trigger: 'outreach_draft_generate',
        applicationId: context.applicationId,
        companyScopeKey,
        companyName: company,
      });
    } catch (error) {
      const candidate = error as { statusCode?: number; code?: string; message?: string };
      return reply.status(candidate.statusCode ?? 409).send({
        error: candidate.message ?? 'Draft operation is already in progress.',
        code: candidate.code ?? 'draft_operation_conflict',
      });
    }
    if (!reservation.allowed) return reply.status(402).send({
      ...reservation.denial,
      contact_id: contact.id,
      application_id: context.applicationId,
    });
    if (reservation.replay) return reply.status(reservation.replay.statusCode).send(reservation.replay.body);
    const ent = await getEntitlements(userId);
    const useLegacyMonthlyCounter = usesLegacyMonthlyProductQuota(reservation.snapshot);
    if (useLegacyMonthlyCounter) {
      const usedDrafts = await getCount(userId, monthPeriod(), 'drafts');
      if (usedDrafts >= ent.monthlyDrafts) {
        await releaseEntitledUsage(reservation.reservationId);
        return reply.status(402).send(quotaExceededPayload(ent, usedDrafts, 'drafts'));
      }
    }

    // Read the declared list server-side rather than trusting the body. Non-fatal on a read
    // failure, but LOUD: silently drafting from client-supplied skills is exactly the half-applied
    // R-015 state this override exists to end, so a fallback here must be visible in logs.
    let declared: string[] = [];
    try {
      const profileRows = await db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
      declared = declaredSkillsList(profileRows[0]?.skills);
    } catch (err) {
      fastify.log.error({ err, userId }, 'could not read declared skills for outreach draft; falling back to client-supplied skills (R-027 override skipped)');
    }

    try {
      const draft = await generateDraft(
        contact,
        role,
        company,
        applyDeclaredSkills(body.user_profile, declared),
        body.draft_type,
      );
      if (!reservation.reservationId) throw new Error('Draft operation is missing its replay reservation');
      const persisted = await commitOutreachDraftGeneration({
        reservationId: reservation.reservationId,
        userId,
        operationId: context.operationId,
        requestHash,
        contactId: contact.id,
        contactEmail: body.contact.email,
        applicationId: context.applicationId,
        companyScopeKey,
        companyName: company,
        role,
        draftType: body.draft_type,
        draft,
        ...(useLegacyMonthlyCounter ? { legacyMonthlyCounterPeriod: monthPeriod() } : {}),
      });
      return reply.status(200).send(persisted);
    } catch (err) {
      await releaseEntitledUsage(reservation.reservationId);
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to generate draft' });
    }
  });
}
