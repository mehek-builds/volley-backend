import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import {
  users,
  profiles,
  application_profile,
  experience_bank,
  targeting,
  autofill_events,
} from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { decryptField } from '../lib/fieldCrypto';
import { ENCRYPTED_FIELDS } from './applicationProfile';
import { AUTOMATIC_SUBMISSION_CONSENT_VERSION, automationConsentValues } from '../lib/automationConsent';
import { standingConsentEligibility, mayChangeStandingConsent } from '../engine/standingConsent';
import { generated_resumes } from '../db/schema';
import { hasActiveEmailConnection, isComposioConfigured } from '../lib/composioConnections';

/**
 * How many submissions has this student personally approved AND seen reach the employer?
 *
 * Both halves matter. `per_application_approval` means the student clicked the final submit
 * themselves, and `submitted` means it actually landed: an approval that then failed taught them
 * nothing about what Litos fills in on a real form. This is the counter that unlocks unattended
 * submission, so it counts experience, not intent.
 */
/**
 * The ONE way either route may turn automatic submission on.
 *
 * Pre-merge review found the gate had a second, unguarded writer: POST /onboarding/complete wrote
 * the column straight from the request body, with no completed-onboarding guard, so a curl (or the
 * /start finish screen's own checkbox) turned standing consent on at reviewed_submits = 0 and
 * defeated the feature entirely. Two call sites checking the same rule is a rule that will be
 * skipped a third time; this makes skipping it impossible without deleting the helper.
 */
async function gatedAutomationConsent(
  userId: string,
  settings: { automatic_submission_enabled?: boolean; automatic_verification_enabled?: boolean },
): Promise<{ ok: true } | { ok: false; status: 403; body: { error: string; eligibility: unknown } }> {
  if (settings.automatic_submission_enabled !== true) return { ok: true };
  const eligibility = standingConsentEligibility(await reviewedSubmitCount(userId));
  const verdict = mayChangeStandingConsent({ enabling: true, eligibility });
  if (verdict.allowed) return { ok: true };
  return { ok: false, status: 403, body: { error: verdict.reason, eligibility } };
}

async function verificationConnectionProblem(
  userId: string,
  settings: { automatic_verification_enabled?: boolean },
): Promise<{ status: 409 | 503; error: string } | null> {
  if (settings.automatic_verification_enabled !== true) return null;
  if (!isComposioConfigured()) {
    return { status: 503, error: 'Email connections are not configured yet' };
  }
  if (!await hasActiveEmailConnection(userId)) {
    return { status: 409, error: 'Connect Gmail or Outlook before turning on email verification' };
  }
  return null;
}

async function reviewedSubmitCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(generated_resumes)
    .where(
      sql`${generated_resumes.user_id} = ${userId}
        and ${generated_resumes.spec}->'_review'->>'status' = 'submitted'
        and ${generated_resumes.spec}->'_review'->'submission_authorization'->>'source' = 'per_application_approval'`,
    );
  return row?.n ?? 0;
}

// GET /onboarding/state - the one call /start needs to decide what to render.
//
// Every step except the last is DERIVED from data that already exists, rather than stored as a
// cursor. A stored step number is a second source of truth about the same facts, and it goes
// stale the moment a student does anything out of order (installs the extension first, applies
// before finishing, edits Settings mid-flow). Deriving means "Finish later" and "resume where you
// left off" are the same code path as a fresh start, and neither can disagree with reality.
//
// The one thing that IS stored is completion (users.onboarding_completed_at), because it gates
// harvest and therefore has to be an explicit act rather than an inference. See harvest.ts.

type Step = 'focus' | 'sponsorship' | 'resume' | 'impact' | 'base' | 'done';

export function onboardingStepFrom(input: {
  completed: boolean;
  hasResume: boolean;
  hasImpactReview?: boolean;
  hasFocus: boolean;
  hasSponsorshipAnswer: boolean;
  hasBaseResume: boolean;
}): Step {
  if (input.completed && input.hasImpactReview !== false) return 'done';
  if (!input.hasResume) return 'resume';
  if (input.hasImpactReview === false) return 'impact';
  if (!input.hasFocus) return 'focus';
  if (!input.hasSponsorshipAnswer) return 'sponsorship';
  if (!input.hasBaseResume) return 'base';
  return 'done';
}

export function hasFocusTargeting(target: { categories?: unknown; titles?: unknown; role_types?: unknown } | null | undefined): boolean {
  return Array.isArray(target?.categories)
    && Array.isArray(target?.titles)
    && target.titles.length > 0
    && Array.isArray(target?.role_types)
    && target.role_types.length > 0;
}

export function hasFiveTargetRoles(parsed: { target_roles?: unknown } | null | undefined): boolean {
  if (!Array.isArray(parsed?.target_roles)) return false;
  const roles = parsed.target_roles
    .filter((role): role is string => typeof role === 'string' && role.trim().length > 0)
    .map((role) => role.trim().toLowerCase());
  return new Set(roles).size >= 5;
}

// Asked on screen 03 only if the first application did not teach us. Order is the render order.
//
// This list is deliberately SHORT. Every field here is one the student has to type by hand, so
// anything that a form will reliably ask - phone, city, links, citizenship, DOB - belongs in the
// harvest instead and must not appear here. If a gap shows up for everyone, that is a signal the
// harvest is missing a classifier, not that the question belongs in onboarding.
//
// languages belongs here and can never move to the harvest, for a structural reason: a form asks
// "Do you speak German?" about ITS language, so watching an application teaches at most one
// yes/no about one language, never the student's own list - and the declared list is the
// authority (R-015, see schema.ts). ZURU asked about Spanish and Enpal about German with nothing
// on file (2026-07-17); only the student can close that gap, so onboarding asks once.
const GAP_FIELDS = ['gpa', 'gpa_scale', 'major', 'languages', 'desired_salary', 'desired_salary_currency'] as const;
const completeBodySchema = z.object({
  automatic_submission_enabled: z.boolean().default(false),
  automatic_verification_enabled: z.boolean().default(false),
});
const automationBodySchema = z.object({
  automatic_submission_enabled: z.boolean().optional(),
  automatic_verification_enabled: z.boolean().optional(),
}).refine((value) => value.automatic_submission_enabled !== undefined || value.automatic_verification_enabled !== undefined, {
  message: 'At least one automation permission is required',
});

// Fields worth having before the student's SECOND application. Not a completeness bar: a student
// with no portfolio has no gap. Used only to report `learned` for the receipt on screen 05.
const HARVEST_FIELDS = [
  'phone',
  'address_city',
  'address_country',
  'linkedin_url',
  'github_url',
  'portfolio_url',
  'citizenship',
  'date_of_birth',
  'availability_date',
  'referral_source_default',
] as const;

function readable(row: Record<string, unknown> | undefined, key: string): string | null {
  if (!row) return null;
  const stored = row[key];
  if (typeof stored !== 'string' || stored.length === 0) return null;
  if (!(ENCRYPTED_FIELDS as readonly string[]).includes(key)) return stored;
  try {
    return decryptField(stored);
  } catch {
    return null;
  }
}

// The gap list /onboarding/state serves, in GAP_FIELDS render order. Extracted and exported so a
// test can pin the semantics without a live server or database.
//
// languages is the one gap field readable() cannot judge: it is a jsonb string[], not text, so
// "answered" means a non-empty array. An empty array is still a gap, on purpose - [] is what a
// student who skipped the screen saves, and skipped and never-asked are the same fact to the next
// application: a language question it cannot answer.
export function gapsFrom(row: Record<string, unknown> | undefined) {
  return GAP_FIELDS.filter((f) => {
    if (f !== 'languages') return readable(row, f) === null;
    const langs = row?.['languages'];
    return !Array.isArray(langs) || langs.length === 0;
  });
}

export async function onboardingRoutes(fastify: FastifyInstance) {
  fastify.get('/onboarding/state', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    const [[user], [profile], [appProfile], [bankCount], [applyCount], [target]] = await Promise.all([
      db.select().from(users).where(eq(users.id, userId)),
      db.select().from(profiles).where(eq(profiles.user_id, userId)),
      db.select().from(application_profile).where(eq(application_profile.user_id, userId)),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(experience_bank)
        .where(eq(experience_bank.user_id, userId)),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(autofill_events)
        .where(eq(autofill_events.user_id, userId)),
      db.select().from(targeting).where(eq(targeting.user_id, userId)),
    ]);

    if (!user) return reply.status(404).send({ error: 'No such user' });

    // A resume is only "done" when it produced a usable bank. profiles.parsed_json alone is not
    // enough: /resume/generate and /application/answer both hard-400 without bank entries, so a
    // student with a parse but no bank has an account that looks set up and cannot generate
    // anything. Treating that as step 0 sends them back to the one screen that fixes it.
    // Checks a REQUIRED key, not object truthiness: `!!{}` is true, so a parse that returned
    // nothing usable would advance the student past step 01 with no name, school or grad_year -
    // and the targeting screen would then derive its period options from grad_year 0.
    const parsed = profile?.parsed_json as {
      full_name?: string;
      source_pages?: number;
      target_roles?: unknown;
      recent_experience_review?: { completed?: boolean };
    } | null | undefined;
    const has_resume = !!parsed?.full_name && hasFiveTargetRoles(parsed) && (bankCount?.n ?? 0) > 0;
    const has_applied = (applyCount?.n ?? 0) > 0;

    // The base resume: built once from the bank, with no job description. Stored rather than
    // derived (see schema.ts), so this is a real column read and not an inference.
    const has_base_resume = !!profile?.base_resume_json;

    const learned = HARVEST_FIELDS.filter((f) => readable(appProfile, f) !== null);
    const gaps = gapsFrom(appProfile);

    // Targeting follows the upload. The parser now returns five ordered role suggestions based on
    // dated experience, past titles and skills, and the client derives an initial employment type
    // from the same profile. Putting the resume first means the first targeting screen is mostly a
    // confirmation instead of a blank form.
    // Require the resume-informed fields, not only the legacy category answer. Existing users may
    // already have categories from the old pre-upload screen while titles are still null. Treating
    // that row as complete would skip the new five-role confirmation and leave no later screen
    // where those titles can be collected.
    const has_focus = hasFocusTargeting(target);

    /* THE SPONSORSHIP QUESTION, and why it is a step of its own rather than a field on the focus
       screen.
       It is the only answer in the flow that permanently changes WHICH JOBS EXIST for this person
       (see lib/sponsorship.ts), and an answer with that weight cannot be the fourth control on a
       screen about job categories - it has to be asked on its own, with the consequence written
       next to it. It sits second because it needs nothing from the resume and because a board
       filtered from the first search is the point: the alternative is showing somebody a week of
       postings they cannot take and then quietly removing them.
       Derived from the timestamp, not from the boolean: "no, I do not need sponsorship" is a real
       answer that stores `false`, and gating on the boolean would ask that person again forever. */
    const has_sponsorship_answer = user.sponsorship_declared_at !== null;

    // Period preferences remain editable in the dashboard, but they no longer gate setup. They do
    // not currently change job ranking, so requiring them here would add a screen without changing
    // what Litos can do for the student.
    const has_targeting = !!target?.primary_period;

    // The Chrome extension and a manually completed sample application are no longer onboarding
    // gates. The dashboard is the primary product: it can prepare a real supported application,
    // ask for missing facts in context, and let the student review it there. Requiring an extension
    // event before setup can finish would make the secondary path a prerequisite for the primary
    // one. Optional profile gaps follow the same rule and are collected only when a real job needs
    // them.
    // The base resume sits directly after the upload and before the install, because it is the
    // payoff for the upload: the student has just handed over a two- or three-page document and
    // has no evidence we understood any of it. Showing them the one-page result closes that loop
    // while the upload is still the thing they are thinking about.
    //
    // It gates like `has_resume` and unlike `gaps`: it is a real artifact the rest of the product
    // depends on, not an optional detail screen. But the gate is the STORED SPEC, so a student who
    // rebuilds or hand-edits later never gets sent back here, and an account created before this
    // shipped derives 'base' exactly once and then moves on for good.
    const step = onboardingStepFrom({
      completed: !!user.onboarding_completed_at,
      hasResume: has_resume,
      hasImpactReview: parsed?.recent_experience_review?.completed !== false,
      hasFocus: has_focus,
      hasSponsorshipAnswer: has_sponsorship_answer,
      hasBaseResume: has_base_resume,
    });

    return reply.status(200).send({
      step,
      completed_at: user.onboarding_completed_at,
      has_focus,
      has_sponsorship_answer,
      // The declaration itself, so /start can show what was recorded and the dashboard can explain
      // a filtered board without a second round trip.
      sponsorship_answer: user.sponsorship_answer,
      sponsorship_required: user.sponsorship_required_at_onboarding,
      has_resume,
      has_impact_review: parsed?.recent_experience_review?.completed !== false,
      has_base_resume,
      has_applied,
      has_targeting,
      learned,
      gaps,
      // Measured from the uploaded file at parse time (routes/profile.ts). 0 means we never got a
      // page count - an older upload, or a parse that predates the measurement - and the base
      // screen simply omits the "from N pages" line rather than guessing one.
      source_pages: typeof parsed?.source_pages === 'number' ? parsed.source_pages : 0,
      // Uploaded originals are parsing input and are never retained server-side. A same-session
      // comparison can use the browser's local File object; a reload degrades to the parsed facts.
      source_resume_url: null,
      // True while the extension is allowed to read values back out of a form. Surfaced so the
      // student can always see whether it is on, rather than having to trust that it stopped.
      harvest_active: !user.onboarding_completed_at,
      standing_consent_eligibility: standingConsentEligibility(await reviewedSubmitCount(userId)),
      automatic_submission_enabled: user.automatic_submission_enabled,
      automatic_submission_consented_at: user.automatic_submission_consented_at,
      automatic_submission_consent_version: user.automatic_submission_consent_version,
      automatic_verification_enabled: user.automatic_verification_enabled,
    });
  });

  // Explicit act, not an inference: this is what turns harvest off, so the student takes it.
  fastify.post('/onboarding/complete', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const parsed = completeBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid automation permissions' });

    // The second writer. Ungated, this route re-enabled standing consent from any state at any
    // time, which is the whole feature defeated by one curl.
    const gate = await gatedAutomationConsent(userId, parsed.data);
    if (!gate.ok) return reply.status(gate.status).send(gate.body);
    const verificationProblem = await verificationConnectionProblem(userId, parsed.data);
    if (verificationProblem) return reply.status(verificationProblem.status).send({ error: verificationProblem.error });

    try {
      const now = new Date();
      await db
        .update(users)
        .set({
          onboarding_completed_at: now,
          ...automationConsentValues(parsed.data, now),
        })
        .where(eq(users.id, userId));
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to complete onboarding' });
    }
    return reply.status(200).send({ ok: true, harvest_active: false, ...parsed.data });
  });

  fastify.put('/onboarding/automation', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = automationBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid automation permissions' });
    const userId = request.jwtPayload!.userId;

    // Enforced HERE, not only in the UI. Hiding the toggle is presentation; this is the one control
    // where a client that lies must not be believed. Turning it OFF is always allowed, from any
    // state: a safety gate the student cannot re-arm is not a safety gate.
    const gate = await gatedAutomationConsent(userId, parsed.data);
    if (!gate.ok) return reply.status(gate.status).send(gate.body);
    const verificationProblem = await verificationConnectionProblem(userId, parsed.data);
    if (verificationProblem) return reply.status(verificationProblem.status).send({ error: verificationProblem.error });

    const now = new Date();
    const patch: Partial<typeof users.$inferInsert> = {};
    if (parsed.data.automatic_submission_enabled !== undefined) {
      patch.automatic_submission_enabled = parsed.data.automatic_submission_enabled;
      patch.automatic_submission_consented_at = parsed.data.automatic_submission_enabled ? now : null;
      patch.automatic_submission_consent_version = parsed.data.automatic_submission_enabled
        ? AUTOMATIC_SUBMISSION_CONSENT_VERSION
        : null;
    }
    if (parsed.data.automatic_verification_enabled !== undefined) {
      patch.automatic_verification_enabled = parsed.data.automatic_verification_enabled;
      patch.automatic_verification_consented_at = parsed.data.automatic_verification_enabled ? now : null;
    }
    const [updated] = await db.update(users).set(patch).where(eq(users.id, userId)).returning({
      automatic_submission_enabled: users.automatic_submission_enabled,
      automatic_submission_consent_version: users.automatic_submission_consent_version,
      automatic_verification_enabled: users.automatic_verification_enabled,
    });
    if (!updated) return reply.status(404).send({ error: 'No such user' });
    return reply.send(updated);
  });
}
