import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { applications, monetization_events, profiles } from '../db/schema';
import { v4 as uuidv4 } from 'uuid';
import { readExperienceBankOrSeedFromBaseResume } from '../db/experienceBank';
import { requireAuth } from '../middleware/auth';
import { applicantGroundingFacts, draftApplicationAnswer } from '../llm/applicationAnswer';
import { loadApplicationProfileLike } from '../lib/applicationProfileLike';
import { declaredSkillsList } from './profile';
import { isBillingOrAuthFailure, LLM_BILLING_LOG, LLM_BILLING_PAYLOAD } from './resume';
import {
  commitEntitledUsage,
  entitledUsageRequestHash,
  releaseEntitledUsage,
  reserveEntitledUsage,
} from '../lib/entitlements';
import { canonicalCompanyScope } from '../lib/entitlements';
import { isLegacyExtensionVersion } from '../lib/clientCompatibility';
import { upsertCanonicalApplicationForUser } from './canonicalApplications';

const bodySchema = z.object({
  question: z.string().min(1),
  company: z.string().min(1),
  role: z.string().min(1),
  jd_text: z.string().min(1),
  application_id: z.string().uuid(),
  operation_id: z.string().uuid(),
});

const legacyBodySchema = bodySchema.partial({ application_id: true, operation_id: true });

async function adaptLegacyAnswerRequest(request: FastifyRequest, userId: string): Promise<unknown> {
  if (!isLegacyExtensionVersion(request.headers)) return request.body;
  const parsed = legacyBodySchema.safeParse(request.body);
  if (!parsed.success) return request.body;
  const companyScopeKey = canonicalCompanyScope({ companyName: parsed.data.company });
  let ownedApplication = parsed.data.application_id
    ? (await db.select().from(applications).where(and(
      eq(applications.id, parsed.data.application_id),
      eq(applications.user_id, userId),
    )).limit(1))[0]
    : undefined;
  const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  if (ownedApplication && (
    normalized(ownedApplication.company_name) !== normalized(parsed.data.company)
    || normalized(ownedApplication.role) !== normalized(parsed.data.role)
  )) ownedApplication = undefined;
  if (!ownedApplication) {
    const result = await upsertCanonicalApplicationForUser({
      userId,
      companyScopeKey,
      companyName: parsed.data.company,
      role: parsed.data.role,
      sourceSurface: 'extension',
    });
    ownedApplication = result.application;
  }
  const operationId = parsed.data.operation_id ?? uuidv4();
  try {
    await db.insert(monetization_events).values({
      event_key: `legacy-extension-answer:${userId}:${operationId}`,
      user_id: userId,
      event_name: 'legacy_extension_contract_used',
      surface: 'extension',
      placement: 'application_answer',
      trigger: 'pre_0_6_0_adapter',
      feature_key: 'ai_application_answer_generation',
      application_id: ownedApplication.id,
      occurred_at: new Date(),
      properties: { client_version: request.headers['x-litos-version'], route: '/application/answer' },
    }).onConflictDoNothing({ target: monetization_events.event_key });
  } catch (error) {
    request.log.warn({ error, userId }, 'could not record legacy extension answer adapter telemetry');
  }
  return {
    ...parsed.data,
    application_id: ownedApplication.id,
    operation_id: operationId,
  };
}

// POST /application/answer — drafts one open-ended application answer from the student's own
// experience bank + the JD. Cheap enough (one short Sonnet call, ~1-2K tokens) that it isn't
// metered like /resume/generate; the extension flags every drafted field for review.
export async function applicationAnswerRoutes(fastify: FastifyInstance) {
  fastify.post('/application/answer', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const strict = bodySchema.safeParse(request.body);
    const parsed = strict.success
      ? strict
      : bodySchema.safeParse(await adaptLegacyAnswerRequest(request, request.jwtPayload!.userId));
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', detail: parsed.error.issues });
    }
    const userId = request.jwtPayload!.userId;
    const [application] = await db.select().from(applications).where(and(
      eq(applications.id, parsed.data.application_id),
      eq(applications.user_id, userId),
    )).limit(1);
    if (!application) return reply.status(404).send({ error: 'Application not found.', code: 'application_not_found' });
    const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
    if (
      normalized(parsed.data.company) !== normalized(application.company_name)
      || normalized(parsed.data.role) !== normalized(application.role)
    ) return reply.status(409).send({
      error: 'Answer context does not match the selected application.',
      code: 'answer_context_mismatch',
    });
    const { question, jd_text } = parsed.data;
    const company = application.company_name;
    const role = application.role;
    let reservation: Awaited<ReturnType<typeof reserveEntitledUsage>>;
    try {
      reservation = await reserveEntitledUsage({
        userId,
        kind: 'answer_application',
        idempotencyKey: parsed.data.operation_id,
        requestHash: entitledUsageRequestHash('answer_application', {
          application_id: application.id,
          question,
          company,
          role,
          jd_text,
        }),
        trigger: 'application_answer_generate',
        applicationId: application.id,
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      const candidate = error as { statusCode?: number; code?: string; message?: string };
      return reply.status(statusCode ?? 409).send({
        error: candidate.message ?? 'Answer operation is already in progress.',
        code: candidate.code ?? 'answer_operation_conflict',
      });
    }
    if (!reservation.allowed) return reply.status(402).send(reservation.denial);
    if (reservation.replay) return reply.status(reservation.replay.statusCode).send(reservation.replay.body);

    // Ordered read, always: see readExperienceBank (R-022). The bank goes into a cached prompt
    // prefix, so an unstable order busts the cache as well as making drafts non-reproducible.
    const bank = await readExperienceBankOrSeedFromBaseResume(userId);
    if (bank.length === 0) {
      await releaseEntitledUsage(reservation.reservationId);
      return reply.status(400).send({ error: 'Nothing saved about your work yet. Finish setting up first.' });
    }
    const profileRows = await db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
    // The same corpus the dashboard runner grounds against, built by the same function. When this
    // route carried only { school, grad_year }, a draft naming the city of the applicant's own
    // university was returned with a "names not found in your background" warning attached.
    const groundingFacts = applicantGroundingFacts(
      profileRows[0]?.parsed_json,
      await loadApplicationProfileLike(userId),
    );
    // The declared skills list (profiles.skills, R-015's authority) rides along for the R-042
    // ranking grounding: a "rank these languages" ask may rank only the intersection of the
    // question's own items and this list. [] means "never declared" and disables the check.
    const declaredSkills = declaredSkillsList(profileRows[0]?.skills);

    try {
      const { answer, warnings } = await draftApplicationAnswer(
        question, company, role, jd_text, bank, groundingFacts, declaredSkills,
      );
      if (!answer) {
        await releaseEntitledUsage(reservation.reservationId);
        return reply.status(502).send({ error: 'Empty draft returned' });
      }
      const response = { answer, warnings, grounded: warnings.length === 0 };
      await commitEntitledUsage(reservation.reservationId, 1, new Date(), { statusCode: 200, body: response });
      return reply.status(200).send(response);
    } catch (err) {
      await releaseEntitledUsage(reservation.reservationId);
      fastify.log.error(err);
      // Same classification as /resume/generate (R-012): the essay drafter dies on the exact
      // same exhausted account, and its generic 500 hid the cause just as thoroughly - three
      // required essays came back empty on a live Perplexity fill with nothing naming billing.
      if (isBillingOrAuthFailure(err)) {
        fastify.log.error({ status: (err as { status?: number })?.status, userId }, LLM_BILLING_LOG);
        return reply.status(503).send(LLM_BILLING_PAYLOAD);
      }
      return reply.status(500).send({ error: 'Failed to draft answer' });
    }
  });
}
