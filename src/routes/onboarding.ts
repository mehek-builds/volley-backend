import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, sql } from 'drizzle-orm';
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

type Step = 'focus' | 'resume' | 'install' | 'apply' | 'gaps' | 'targeting' | 'done';

// Asked on screen 03 only if the first application did not teach us. Order is the render order.
//
// This list is deliberately SHORT. Every field here is one the student has to type by hand, so
// anything that a form will reliably ask - phone, city, links, citizenship, DOB - belongs in the
// harvest instead and must not appear here. If a gap shows up for everyone, that is a signal the
// harvest is missing a classifier, not that the question belongs in onboarding.
const GAP_FIELDS = ['gpa', 'gpa_scale', 'major', 'desired_salary', 'desired_salary_currency'] as const;

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
    const parsed = profile?.parsed_json as { full_name?: string } | null | undefined;
    const has_resume = !!parsed?.full_name && (bankCount?.n ?? 0) > 0;
    const has_applied = (applyCount?.n ?? 0) > 0;

    const learned = HARVEST_FIELDS.filter((f) => readable(appProfile, f) !== null);
    const gaps = GAP_FIELDS.filter((f) => readable(appProfile, f) === null);

    // The five targeting questions split on ONE fact: whether they need the resume.
    //
    // categories and role_types do not - a student knows what kind of work they want before they
    // upload anything. titles are seeded from ParsedProfile.target_roles and the period options are
    // computed from grad_year, so those three cannot be asked until the resume is parsed.
    //
    // So the two resume-independent ones move BEFORE the upload, as step 00. That is the honest
    // version of what Simplify does: they open with two cheap questions ("how soon?", "where?")
    // and only ask for the resume fourth, which earns commitment before the expensive ask. The
    // difference is that their opener exists to manufacture a yes, while these are questions we
    // were always going to ask - just reordered to the point where they cost nothing.
    // Answered, not non-empty. `length > 0` looks stricter but it strands: a PUT of
    // {categories: []} is valid per targetingBodySchema, saves fine, and then derives 'focus'
    // forever with no way forward through the API. The UI already requires at least one before
    // Continue enables, so tolerating [] costs nothing real and removes a footgun whose only
    // guard would otherwise live in the client - the wrong layer for an invariant the server's
    // own state machine reads.
    const has_focus = Array.isArray(target?.categories);

    // Targeting counts as answered on the main period: it is the only one of the remaining three
    // with no sensible default, so a student who set it went through the screen on purpose.
    const has_targeting = !!target?.primary_period;

    // The extension cannot be detected from here (no externally_connectable, and adding it would
    // widen the manifest mid-review). An autofill event IS proof of install - it can only be
    // POSTed by a running extension - so install and apply collapse into one derived signal
    // rather than a handshake the web app cannot perform.
    // Gaps do NOT gate progress, and that is load-bearing rather than a preference. Every gap
    // field is optional and skippable, so gating on `gaps.length` derives 'gaps' FOREVER for
    // anyone who skipped them: targeting becomes unreachable, and worse, a student who reached
    // targeting anyway and saved it still lands back on gaps on every reload. Gaps is a screen on
    // the way to targeting, not a checkpoint. Targeting is the real gate, because it is the one
    // thing nothing else can supply.
    const step: Step = user.onboarding_completed_at
      ? 'done'
      : !has_focus
        ? 'focus'
        : !has_resume
          ? 'resume'
          : !has_applied
            ? 'install'
            : !has_targeting
              ? gaps.length > 0
                ? 'gaps'
                : 'targeting'
              : 'done';

    return reply.status(200).send({
      step,
      completed_at: user.onboarding_completed_at,
      has_focus,
      has_resume,
      has_applied,
      has_targeting,
      learned,
      gaps,
      // True while the extension is allowed to read values back out of a form. Surfaced so the
      // student can always see whether it is on, rather than having to trust that it stopped.
      harvest_active: !user.onboarding_completed_at,
    });
  });

  // Explicit act, not an inference: this is what turns harvest off, so the student takes it.
  fastify.post('/onboarding/complete', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    try {
      await db
        .update(users)
        .set({ onboarding_completed_at: new Date() })
        .where(eq(users.id, userId));
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to complete onboarding' });
    }
    return reply.status(200).send({ ok: true, harvest_active: false });
  });
}
