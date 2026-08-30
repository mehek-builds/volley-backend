import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import {
  users,
  profiles,
  application_profile,
  experience_bank,
  targeting,
  autofill_events,
  onboarding_flow_runs,
  onboarding_flow_step_acknowledgements,
} from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { cardGateInstant, requiresPaymentMethodFor } from '../lib/cardGate';
import { CURRENT_ONBOARDING_FLOW_VERSION, onboardingFlowLedger } from '../lib/onboardingFlowLedger';
import { decryptField } from '../lib/fieldCrypto';
import { decryptRow, ENCRYPTED_FIELDS } from './applicationProfile';
import {
  AUTOMATIC_CAPTCHA_CONSENT_VERSION,
  AUTOMATIC_ACCOUNT_CREATION_VERSION,
  AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION,
  AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
  AUTOMATIC_SUBMISSION_CONSENT_VERSION,
  accountCreationGranted,
  automationConsentState,
  automationConsentValues,
  captchaResumeGranted,
  conductAcceptanceGranted,
  consentAcceptanceGranted,
} from '../lib/automationConsent';
import { standingConsentEligibility, mayChangeStandingConsent } from '../engine/standingConsent';
import { monitored_jobs } from '../db/schema';
import { isComposioConfigured } from '../lib/composioConnections';
import { isUndefinedColumnError, selectApplicationProfileRow, upsertApplicationProfile } from '../lib/applicationFacts';
import { verificationEmailSource } from '../lib/verificationEmailSource';
import { countryEligibilityForRead } from '../lib/workEligibility';
import { requireFeature } from '../lib/entitlements';
import { rememberReusableAnswers } from '../lib/savedAnswerStore';
import { accountSponsorshipAnswer, declarationFromEmployerAnswers } from '../lib/declarationFromEmployerAnswers';
import { persistProfileWithCountryEligibility } from '../lib/countryEligibilityPersistence';
import { reviewedSubmitCount } from '../lib/approvedApplicationSubmissions';

/**
 * The ONE way either route may turn automatic submission on.
 *
 * Pre-merge review found the gate had a second, unguarded writer: POST /onboarding/complete wrote
 * the column straight from the request body, with no completed-onboarding guard, so a curl (or the
 * /start finish screen's own checkbox) turned standing consent on with different consent evidence
 * than Settings. The helper remains the one writer path so version stamping and connection checks
 * cannot drift apart by route.
 */
async function gatedAutomationConsent(
  userId: string,
  settings: { automatic_submission_enabled?: boolean; automatic_verification_enabled?: boolean },
): Promise<{ ok: true } | { ok: false; status: 402 | 403; body: unknown }> {
  if (settings.automatic_submission_enabled !== true) return { ok: true };
  const entitlement = await requireFeature(userId, 'automatic_submission', 'automatic_submission_consent');
  if (!entitlement.allowed) {
    return { ok: false, status: 402, body: entitlement.denial };
  }
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
  if (await verificationEmailSource(userId)) return null;
  if (!isComposioConfigured()) {
    return { status: 503, error: 'The Litos application inbox is unavailable and email connections are not configured yet' };
  }
  return { status: 409, error: 'Connect Gmail or Outlook, or wait until the Litos application inbox is available' };
}

// GET /onboarding/state - the one call /start needs to decide what to render.
//
// Every step except the last is DERIVED from data that already exists, rather than stored as a
// cursor. A stored step number is a second source of truth about the same facts, and it goes
// stale the moment a student does anything out of order (installs the extension first, applies
// before finishing, edits Settings mid-flow). Deriving means "Finish later" and "resume where you
// left off" are the same code path as a fresh start, and neither can disagree with reality.
//
// TWO things are stored rather than derived, and both for the same reason: they record an ACT that
// no amount of inspecting the profile can infer.
//   users.onboarding_completed_at              - finishing setup, because it gates harvest and so
//                                                has to be explicit rather than inferred. See harvest.ts.
//   application_profile.setup_gaps_asked_at    - having been SHOWN the setup gaps screen. Every field
//                                                on it is skippable, so "answered" and "asked" are
//                                                different facts and only the second can end the step.
//                                                See SETUP_GAP_FIELDS and gapsAskedFrom below.

/* EVERY users COLUMN WHOSE MIGRATION MAY NOT HAVE LANDED YET, named here so the read below can drop
 * them in the window where the deploy leads the migration.
 *
 * THE LIST GROWS WITH EACH MIGRATION AND IS NOT PRUNED ON A SCHEDULE. A column that has been in
 * production for months costs nothing by staying here: the fallback only ever runs after a 42703,
 * which a migrated database never raises. Removing entries is therefore all risk and no benefit,
 * and the risk is the one this set exists to prevent.
 *
 * WHY EVERY NEW users COLUMN HAS TO BE ADDED HERE. `db.select().from(users)` compiles to an
 * EXPLICIT column list built from schema.ts, so the moment schema.ts names a column the database
 * has not got, the whole read fails rather than just the new field. This route is the first call
 * /start makes, so that failure is a blank setup flow for every account in the window. The
 * notification columns were the second set to land in this shape and were very nearly the first
 * to land without a seatbelt. */
export const MIGRATION_PENDING_COLUMNS: ReadonlySet<string> = new Set([
  // scripts/apply-consent-acceptance-schema.mjs
  'automatic_consent_acceptance_enabled',
  'automatic_consent_acceptance_consented_at',
  'automatic_consent_acceptance_consent_version',
  'automatic_conduct_acceptance_enabled',
  'automatic_conduct_acceptance_consented_at',
  'automatic_conduct_acceptance_consent_version',
  // scripts/apply-notifications-schema.mjs
  'notify_strong_match_enabled',
  'notify_strong_match_granted_at',
  'notify_employer_reply_enabled',
  'notify_employer_reply_granted_at',
  'notify_activity_digest_enabled',
  'notify_activity_digest_granted_at',
  // scripts/apply-account-creation-schema.mjs
  'automatic_account_creation_enabled',
  'automatic_account_creation_consented_at',
  'automatic_account_creation_consent_version',
  // scripts/apply-job-first-entry-migration.mjs
  'job_first_entry',
  'pinned_onboarding_job_id',
]);

/**
 * The user row, tolerating a database that has not run the most recent users migrations.
 *
 * SAME REASON THE PROFILE READ BELOW IT IS TOLERANT, and the comment there states the stake:
 * /onboarding/state is the first call /start makes, and a 500 here is a blank setup flow for every
 * student in the window. `db.select().from(users)` compiles to an EXPLICIT column list built from
 * schema.ts, so the moment schema.ts names a column the database has not got, the whole read fails
 * with 42703 rather than just the new fields.
 *
 * The fallback returns the row with the three permission columns absent, which
 * consentAcceptanceGranted reads as "not granted" - identical to a migrated database holding the
 * default. So the window behaves as an account that has not turned the permission on, which is the
 * state every account is in anyway until it does.
 */
/**
 * cardGateInstant and requiresPaymentMethodFor now live in lib/cardGate.ts (imported
 * above), so middleware/auth.ts can enforce the gate server-side (see
 * accountIsCardGateLocked there) without importing a route file. Re-exported here so
 * every existing import of them from './onboarding' -- including onboarding.test.ts --
 * keeps working unchanged.
 */
export { cardGateInstant, requiresPaymentMethodFor };
/**
 * CURRENT_ONBOARDING_FLOW_VERSION and onboardingFlowLedger live in lib/onboardingFlowLedger.ts
 * (imported above) purely so this file and its own routes (POST /onboarding/flow/steps and
 * /onboarding/flow/complete, the version-2 replay walk) do not have to duplicate them. THE CARD GATE
 * (lib/cardGate.ts) no longer reads this ledger at all -- FINDING #1 (2026-08-29 code review) moved
 * TIER B2's closure signal off the client-driven acknowledgement ledger onto a server-owned "has this
 * account actually sent an application" fact (lib/approvedApplicationSubmissions.ts), because nothing
 * required a client to ever send the acknowledgement that used to close it, and nothing stopped one
 * from sending it as its literal first call, before building anything. Re-exported here anyway so
 * every existing import of them from './onboarding' keeps working unchanged.
 */
export { CURRENT_ONBOARDING_FLOW_VERSION, onboardingFlowLedger };

async function selectOnboardingUserRow(userId: string) {
  try {
    return await db.select().from(users).where(eq(users.id, userId));
  } catch (error) {
    if (!isUndefinedColumnError(error)) throw error;
    const all = getTableColumns(users);
    const legacy: Record<string, unknown> = {};
    for (const [name, column] of Object.entries(all)) {
      if (!MIGRATION_PENDING_COLUMNS.has(name)) legacy[name] = column;
    }
    const rows = await db
      .select(legacy as Partial<typeof users._.columns>)
      .from(users)
      .where(eq(users.id, userId));
    return rows as (typeof users.$inferSelect)[];
  }
}

type Step =
  | 'focus' | 'sponsorship' | 'resume' | 'impact' | 'base' | 'gaps'
  /* The application sequence. These six are LEDGER-DRIVEN rather than derived from profile facts,
     and that separation is deliberate: every step above answers "is this fact on the account yet",
     which is a question the database can always answer. "Has this student seen the match screen"
     is not a fact about their profile, it is a fact about their session, and inventing a profile
     column for each would put six booleans on the account to record what the acknowledgement
     ledger already records for every other screen. */
  | 'match' | 'build' | 'questions' | 'review' | 'trial' | 'notifications' | 'plan'
  | 'done';
/* 'build', 'impact', 'base' and 'gaps' stay in the union although nothing derives them any more.
   impact and base are still walked by a version-2 REPLAY, and a client already mid-sequence when
   this deploys can still acknowledge 'build'. Removing them would turn a harmless late
   acknowledgement into a 400 in the one window where a student is mid-flow. */

/* CURRENT_ONBOARDING_FLOW_VERSION lives in lib/onboardingFlowLedger.ts (imported above); see the
   comment on the re-export below for why lib/cardGate.ts no longer needs it. */
/* ORDER IS THE RENDER ORDER, and 'focus' leads it now. See onboardingStepFrom for why. */
const REPLAY_STEPS_WITHOUT_GAPS = ['focus', 'resume', 'impact', 'sponsorship', 'base'] as const;

/* The application sequence, in render order. Reached only once every profile-derived step is
 * satisfied, so it is what a student walks between finishing setup and finishing onboarding. */
/* NOTIFICATIONS SITS BETWEEN TRIAL AND PLAN, which is where screen 08 sits in the design, and the
 * position is an argument rather than an ordering. Permission is asked AFTER the seven free days
 * are given and BEFORE the price: a student who has just been handed something is being asked to
 * let Litos write to her, and she is asked while nothing is being sold. Moving it after `plan`
 * would put a consent question after a checkout redirect, where most people never arrive.
 *
 * ADDING A STEP HERE IS A DEPLOY-ORDER HAZARD, and it is the one thing to check before merging.
 * The website's /start switch has no default case, so a backend serving `step: "notifications"` to
 * a client that has no case for it renders a blank screen in the middle of onboarding. The website
 * change ships FIRST; this one follows it. The reverse order is not a degraded experience, it is
 * an empty page on the flow that ends in a real application. */
/* THE SEQUENCE, capped at what a person will actually walk.
 *
 * `build` is gone as a step and lives inside `match`: that screen already showed the posting, asked
 * "shall I build this", and then handed off. Two step numbers for one continuous action was the
 * rail counting a transition rather than a decision. The build phases still exist inside the
 * screen, which is where the deck always drew them.
 *
 * `impact` is likewise folded into `resume` on the setup side: reviewing the strongest bullet from
 * a resume is part of handing over that resume, not a separate errand. */
export const APPLICATION_STEPS = ['match', 'questions', 'sponsorship', 'review', 'trial', 'notifications', 'plan'] as const;
export type ApplicationStep = (typeof APPLICATION_STEPS)[number];

/**
 * The next application screen this student has not acknowledged, or 'done'.
 *
 * ACKNOWLEDGEMENTS, NOT PROFILE FACTS. A student who declines a match, or saves a packet to send
 * later, has still SEEN the screen, and the flow must not put them back on it forever; the ledger
 * records having been shown, which is exactly the distinction setup_gaps_asked_at exists to make
 * one screen earlier. Anything they actually produced lives in the tracker either way.
 */
/** Whether a submitted step belongs to the version-2 replay walk. The application sequence does
 *  not: replay exists to walk an EXISTING account back through the setup screens, and no existing
 *  account has an application sequence to replay. */
export function isReplayStep(step: string): step is ReplayStep {
  return step === 'gaps' || (REPLAY_STEPS_WITHOUT_GAPS as readonly string[]).includes(step);
}

export function applicationStepFrom(
  acknowledged: readonly string[],
  options: { hasSponsorshipAnswer?: boolean } = {},
): Step {
  const seen = new Set(acknowledged);
  return APPLICATION_STEPS.find((step) => {
    /* The one conditional member. It sits AFTER the questions screen on purpose: if the employer
       asked, POST /onboarding/answers has already written the declaration by the time this is
       evaluated, and the screen is skipped without the student ever seeing it. If they did not
       ask, nothing else on the account can answer it and the board's sponsor-only filter depends
       on it, so it is asked here rather than left unset. */
    if (step === 'sponsorship' && options.hasSponsorshipAnswer) return false;
    return !seen.has(step);
  }) ?? 'done';
}
type ReplayStep = (typeof REPLAY_STEPS_WITHOUT_GAPS)[number] | 'gaps';

export function replaySteps(includesGaps: boolean): ReplayStep[] {
  return includesGaps
    ? [...REPLAY_STEPS_WITHOUT_GAPS, 'gaps']
    : [...REPLAY_STEPS_WITHOUT_GAPS];
}

export function nextReplayStep(acknowledged: readonly string[], includesGaps: boolean): Step {
  const seen = new Set(acknowledged);
  return replaySteps(includesGaps).find((step) => !seen.has(step)) ?? 'done';
}

/* WHICH STEP, IF ANY, BLOCKS COMPLETION. `replayRequired` is the only thing that can hold an
 * account in the walkthrough, and that is the same condition the step resolver reads, so the
 * screen a student is served and the screen completion demands can never disagree.
 *
 * An ABSENT run row must not stand in for a required replay. A version bump starts every existing
 * account on an empty ledger at the new version, so `exists` is false for precisely the accounts
 * the bump is meant to leave alone (see CURRENT_ONBOARDING_FLOW_VERSION). Reading it as "has not
 * replayed yet" served those accounts `done` and then refused to record it, which locked every
 * pre-existing account out of the dashboard behind a button that could not work. Only a migration
 * that deliberately sets replay_required enrolls anyone in a replay. */
export function replayBlockingStep(
  flow: { replayRequired: boolean; acknowledged: readonly string[] },
  includesGaps: boolean,
): ReplayStep | null {
  if (!flow.replayRequired) return null;
  const seen = new Set(flow.acknowledged);
  return replaySteps(includesGaps).find((step) => !seen.has(step)) ?? null;
}

export function flowAcknowledgementDecision(
  acknowledged: readonly string[],
  submitted: ReplayStep,
  includesGaps: boolean,
): { accepted: boolean; alreadyRecorded: boolean; expected: Step } {
  const expected = nextReplayStep(acknowledged, includesGaps);
  if (acknowledged.includes(submitted)) {
    return { accepted: true, alreadyRecorded: true, expected };
  }
  return { accepted: expected === submitted, alreadyRecorded: false, expected };
}

/* 'gaps' IS BACK IN THIS UNION, and the reason #116 took it out is the reason this is safe now.
 *
 * #116's diff recorded the failure exactly: "Every gap field is optional and skippable, so gating
 * on `gaps.length` derives 'gaps' FOREVER for anyone who skipped them: targeting becomes
 * unreachable, and worse, a student who reached targeting anyway and saved it still lands back on
 * gaps on every reload."
 *
 * Two things changed, and both are load-bearing:
 *
 *  1. WHAT IS ASKED. It gates on SETUP_GAP_FIELDS (gpa, gpa_scale, major), not on `gaps.length`.
 *     The old gate counted desired_salary - a field whose own label says "Optional. Left blank on
 *     every form unless you set it." - so the screen appeared for essentially everybody and
 *     appeared forever. It also counted languages and referral_source_default, which the base
 *     screen now collects, so gating on them would re-ask a question the student just answered one
 *     screen earlier.
 *  2. WHETHER IT WAS ASKED. `gapsAsked` is a stored fact
 *     (application_profile.setup_gaps_asked_at), not an inference from the fields being filled.
 *     Skipping stamps it. That is the whole of what "forever" needed and did not have: skipping
 *     left the fields empty, the fields being empty was the gate, so skipping re-derived the
 *     screen. Asking is now a different question from answering.
 *
 * The step also sits immediately before 'done' rather than before the old 'targeting' gate, so
 * even if the stamp never lands the student is one Finish away from a completed account, and
 * `completed` short-circuits at the top of this function permanently.
 */
export function onboardingStepFrom(input: {
  completed: boolean;
  hasResume: boolean;
  hasImpactReview?: boolean;
  hasFocus: boolean;
  hasSponsorshipAnswer: boolean;
  hasBaseResume: boolean;
  /** At least one of SETUP_GAP_FIELDS is still missing. */
  hasSetupGaps?: boolean;
  /** The screen has been PUT IN FRONT OF the student before, answered or skipped. */
  gapsAsked?: boolean;
  /** users.job_first_entry: this account was created from a /browse-jobs posting rather than
   *  through the front door, and its whole point is speed to that posting's tailored resume.
   *  Swaps the order below so resume leads instead of focus, and stops this gate from holding
   *  the student on 'focus' at all - see the route handler for where 'focus' is served instead,
   *  once the application sequence (which spends the pinned job) has also resolved. */
  jobFirstEntry?: boolean;
}): Step {
  /* The impact review no longer derives a step of its own: it is part of the resume screen now,
     because reviewing the strongest bullet from a resume is part of handing over that resume. The
     completed short-circuit therefore no longer has to hold it open either. */
  if (input.completed) return 'done';
  /* JOB-FIRST ACCOUNTS SKIP THIS GATE'S OWN FOCUS CHECK ENTIRELY, not just reorder it.
     The whole reason someone arrives with job_first_entry set is that they already told Litos
     which posting they want tailored to, by clicking it - asking them to pick target roles before
     showing them that resume would re-ask a question their click already answered. 'focus' is not
     skipped forever, only moved: the route handler serves it once more, after the application
     sequence (which is what actually spends the pinned job) has itself resolved to 'done', so it
     stays a required step and simply lands where it stops being in the way.
     The resume check below is shared with the ordinary path rather than repeated in a branch of
     its own - a job-first account and an ordinary one agree on exactly one thing, "no resume yet
     means the resume screen", and writing that once keeps the two paths unable to quietly
     disagree about it. */
  if (!input.jobFirstEntry && !input.hasFocus) return 'focus';
  /* FOCUS LEADS for an ordinary account. A resume upload is the heaviest act in the flow and it
     used to be the front door; roles is three taps and it is now what a student meets first.
     The ordering is only safe because the focus screen no longer needs a resume to draw itself.
     It used to seed its title list from inferResumeTargeting, which is why it sat third; the
     field-then-stage-then-titles picker derives its candidates from the chosen field instead
     (lib/onboarding-role-inference.ts, FIELDS), so there is nothing left here to wait on.
     The resume inference still seeds a RETURNING student's screen - it just no longer gates it. */
  if (!input.hasResume) return 'resume';
  if (input.jobFirstEntry) return 'done';
  /* BASE, GAPS AND SPONSORSHIP ARE NO LONGER DERIVED HERE, each for its own measured reason.
   *
   * base: the one-page review was never a question, it was an artifact review. The packet is built
   * behind the match screen now and the ATS gate still runs and still fails closed; what went away
   * is a screen asking a student to approve a document before they had seen a single job.
   *
   * gaps: only 21.7% of applications ask for a GPA at all (measured, 318 real packets), and the
   * questions screen collects it from the employer's own banded list when they do. That is also
   * the answer that actually persists, where a cold text box produced the `no option matched
   * "3.89"` class of stuck packet.
   *
   * sponsorship: MOVED into the application sequence rather than removed. 39.9% of first
   * applications ask both halves themselves and POST /onboarding/answers records those as the
   * declaration, so the screen derives only for the ~60% whose first employer did not ask.
   * Deriving it here would ask everybody before the employer ever got the chance, which is the
   * screen this change exists to remove. */
  return 'done';
}

export function hasFocusTargeting(target: { categories?: unknown; titles?: unknown; role_types?: unknown } | null | undefined): boolean {
  return Array.isArray(target?.categories)
    && Array.isArray(target?.titles)
    && target.titles.length > 0
    && Array.isArray(target?.role_types)
    && target.role_types.length > 0;
}

export function hasResumeEvidence(
  parsed: { full_name?: unknown } | null | undefined,
  bankCount: number,
): boolean {
  return typeof parsed?.full_name === 'string' && parsed.full_name.trim().length > 0 && bankCount > 0;
}

export function hasWorkEligibilityDeclaration(input: {
  sponsorship_answer?: unknown;
  work_eligibility_by_country?: unknown;
  work_authorized?: boolean | null;
  needs_sponsorship?: boolean | null;
}): boolean {
  return (countryEligibilityForRead({
    stored: input.work_eligibility_by_country,
    work_authorized: input.work_authorized,
    needs_sponsorship: input.needs_sponsorship,
    sponsorship_answer: input.sponsorship_answer,
  })?.length ?? 0) > 0;
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
//
// The three standardized test fields join it under the same structural test, and they pass it for
// the same reason gpa and major do: a form ASKS for a test score, it never offers one, so watching
// a hundred applications teaches Litos nothing about it. Measured at 8 distinct blocked packets
// each across the 158-packet corpus (2026-08-11), which is 2 postings at one employer.
//
// A `coursework` gap was here on this branch and was removed before merge. It needs a column on
// `profiles`, and that table has 27 bare selects and no narrowed-projection helper, so declaring a
// column on it ahead of its migration takes the backend down rather than degrading one feature.
// See the note where that column would have gone in db/schema.ts.
//
// address_city and address_state are deliberately still NOT here, though "current location" blocks
// 9 packets and the resume header needs it. A form asks for a city on nearly every application, so
// it is exactly what the harvest is for, and it is populated on this account already. The header
// was empty because nothing READ it, which is fixed in lib/resumeContactOfRecord.ts, not by asking
// a question the harvest already answers.
const GAP_FIELDS = [
  'gpa',
  'gpa_scale',
  'major',
  'languages',
  'standardized_test_type',
  'sat_score',
  'act_score',
  'desired_salary',
  'desired_salary_currency',
  'referral_source_default',
] as const;

/* The subset of GAP_FIELDS that DECIDES WHETHER THE SCREEN APPEARS. Not the same list, on purpose.
 *
 * The screen still RENDERS every outstanding gap it is given - if a student is routed here for a
 * missing major, they are shown the salary and referral inputs too, because they are already on the
 * screen and the marginal cost of one more input is a second. This list is only the gate.
 *
 * Why these three and not the other four:
 *   gpa, gpa_scale, major   Academic facts every early-career form asks and no form can teach us,
 *                           because a form asks for them rather than offering them. academicSeedFrom
 *                           seeds all three from the resume parse, so the students who reach this
 *                           screen are the ones whose resume did not print them - a small set, which
 *                           is what makes a whole screen affordable.
 *   desired_salary,         Explicitly optional; its own label reads "Left blank on every form
 *   desired_salary_currency unless you set it." Gating on it would show the screen to every student
 *                           who never set a salary, which is nearly all of them. This is the field
 *                           that made the pre-#116 gate fire for everybody.
 *   languages,              Already collected one screen earlier, on base (BaseResumeStep writes
 *   referral_source_default both). Gating on them would re-ask what the student just answered.
 */
const SETUP_GAP_FIELDS: readonly (typeof GAP_FIELDS)[number][] = ['gpa', 'gpa_scale', 'major'];

/* THE FOURTH FIELD, AND WHY IT IS NOT ON THE LIST ABOVE.
 *
 * standardized_test_type is real evidence for the same reason gpa/gpa_scale/major are: no form can
 * teach Litos a value it never asked her for, and standardizedTestAnswer (questionDiscovery.ts)
 * already implements the never-fabricate rule correctly - it just has nothing to read, because
 * nothing has ever asked. Gating on it unconditionally would repeat exactly the desired_salary
 * mistake this file's own comment above warns about: SAT/ACT questions are measured, so far, on
 * ONLY early-career-recruiting forms (IMC Trading, DRW, Optiver - quant-trading internship
 * pipelines), never on a senior or general job posting. Showing this screen to every account with
 * years of work experience would be the "fires for everybody" failure a second time, on a field
 * even less universal than salary.
 *
 * Mehek's explicit scope (2026-08-20): only for an applicant Litos can already tell is a current
 * student or recent grad targeting internship/co-op/new-grad roles - not identity alone
 * (currently_enrolled), but what she is actually applying for, which is the self-declared,
 * already-collected 'Your roles' answer this flow asks before it ever reaches gaps. */
const STUDENT_ROLE_TYPES = new Set(['internship', 'co-op', 'new-grad']);

/** Whether this applicant's own declared role targets are the early-career population the
 *  standardized-test question is measured to appear for. */
export function targetsStudentRoles(roleTypes: unknown): boolean {
  return Array.isArray(roleTypes) && roleTypes.some((value) => STUDENT_ROLE_TYPES.has(value as string));
}

/** Whether the setup gaps screen has something to ask THIS student. */
export function hasSetupGapsFrom(gaps: readonly string[], roleTypes?: unknown): boolean {
  if (SETUP_GAP_FIELDS.some((f) => gaps.includes(f))) return true;
  return targetsStudentRoles(roleTypes) && gaps.includes('standardized_test_type');
}

/* Has the screen been put in front of this student before?
 *
 * THREE STATES, not two, and the third is the whole reason this is a function.
 *   a timestamp -> asked. Answered or skipped; the screen is done with them either way.
 *   null        -> never asked. Route to it.
 *   undefined   -> the column is not there: `setup_gaps_asked_at` is in APPLICATION_FACT_COLUMNS,
 *                  so selectApplicationProfileRow drops it from the projection when the migration
 *                  has not run and the key is simply absent from the row.
 *
 * Undefined reads as ASKED, which suppresses the step. Both repos deploy on merge and the migration
 * is run by hand, so the deploy CAN lead it; in that window there is nowhere to record the stamp,
 * and a step that cannot record having been asked is a step nobody can leave. Suppressing it makes
 * the gaps step fail safe rather than trap anyone.
 *
 * That is a seatbelt, not a licence to deploy first. The 42703 fallback this rides on is GROUP-WIDE
 * (lib/applicationFacts.ts), so an unmigrated column blanks every OTHER fact column too, across
 * autofill and the submission runner. Run scripts/apply-setup-gaps-asked-schema.mjs first; this
 * branch exists to make the window survivable, not routine.
 *
 * A missing ROW is a different thing from a missing column and reads as NOT asked: an account with
 * no application_profile row has answered nothing, and POST /onboarding/gaps-asked creates the row.
 */
export function gapsAskedFrom(row: Record<string, unknown> | undefined): boolean {
  if (!row) return false;
  if (!('setup_gaps_asked_at' in row)) return true;
  return row['setup_gaps_asked_at'] != null;
}

/** Can the stamp be recorded at all? False only in the window where the deploy leads the migration. */
export function gapsAskedColumnPresent(row: Record<string, unknown> | undefined): boolean {
  // No row is not evidence either way, and it is the COMMON case here: profile.ts only creates the
  // row when the parse produced a seed, so a student whose resume printed no GPA and no major - the
  // exact population this screen exists for - reaches it with no row at all. Assuming supported is
  // what keeps the rail's denominator and the route's answer agreeing for them; if the column really
  // is missing, POST /onboarding/gaps-asked answers `recorded: false` and the client advances on its
  // own rather than re-reading a step it can never leave.
  if (!row) return true;
  return 'setup_gaps_asked_at' in row;
}

/* DOES THIS STUDENT'S FLOW CONTAIN THE GAPS SCREEN? Served to /start so the step rail's denominator
 * is the server's answer rather than a second derivation of it.
 *
 * `|| asked` is the part that is easy to leave out and wrong to. Without it the value is true while
 * the student stands on the screen and false the moment they answer it, so the printed total drops
 * from seven to six underneath them on the last screen of setup. Having been asked is permanent, so
 * a flow that contained the screen goes on containing it. That is also why this is not simply
 * `step === 'gaps'`: the rail has to count the screen from 'base', one step BEFORE they reach it.
 */
export function includesGapsStepFrom(
  gaps: readonly string[],
  row: Record<string, unknown> | undefined,
  roleTypes?: unknown,
): boolean {
  if (!gapsAskedColumnPresent(row)) return false;
  return hasSetupGapsFrom(gaps, roleTypes) || gapsAskedFrom(row);
}

const completeBodySchema = z.object({
  automatic_submission_enabled: z.boolean().default(false),
  automatic_verification_enabled: z.boolean().default(false),
  // OPTIONAL, deliberately not .default(false). automationConsentValues spreads into a column
  // update, so a default would make every /start finish silently revoke a permission granted in
  // settings. Undefined means "leave it alone".
  automatic_captcha_enabled: z.boolean().optional(),
  /* Standing permission to accept an employer's privacy statement, applicant terms or code of
   * conduct in her name. Optional for the same reason captcha resume is, and it rides the
   * permissions block that already ends setup rather than becoming a Step of its own: see the note
   * on `Step` above, and #116, which is why adding to that union is not a free act. Nothing about
   * reachability changes here - the screen that already asks the other three asks this one. */
  automatic_consent_acceptance_enabled: z.boolean().optional(),
  // The code-of-conduct permission, asked and stored separately. See db/schema.ts.
  automatic_conduct_acceptance_enabled: z.boolean().optional(),
  /* The account-creation permission. Optional like the two above, and for the reason
     automationConsentValues states: a writer that does not mention it must not revoke it. */
  automatic_account_creation_enabled: z.boolean().optional(),
});
const onboardingAnswersBodySchema = z.object({
  job_id: z.string().trim().min(1).max(200).optional().nullable(),
  company: z.string().trim().max(200).optional().nullable(),
  answers: z.array(z.object({
    question: z.string().trim().min(1).max(2000),
    answer: z.string().trim().min(1).max(10000),
  })).max(50),
});

const flowStepBodySchema = z.object({
  flow_version: z.literal(CURRENT_ONBOARDING_FLOW_VERSION),
  step: z.enum(['resume', 'impact', 'focus', 'sponsorship', 'base', 'gaps', ...APPLICATION_STEPS]),
  disposition: z.enum(['continued', 'skipped']),
});
const flowCompleteBodySchema = z.object({
  flow_version: z.literal(CURRENT_ONBOARDING_FLOW_VERSION),
});
const automationBodySchema = z.object({
  automatic_submission_enabled: z.boolean().optional(),
  automatic_verification_enabled: z.boolean().optional(),
  automatic_captcha_enabled: z.boolean().optional(),
  automatic_consent_acceptance_enabled: z.boolean().optional(),
  automatic_conduct_acceptance_enabled: z.boolean().optional(),
  automatic_account_creation_enabled: z.boolean().optional(),
}).refine((value) => (
  value.automatic_submission_enabled !== undefined
  || value.automatic_verification_enabled !== undefined
  || value.automatic_captcha_enabled !== undefined
  || value.automatic_consent_acceptance_enabled !== undefined
  || value.automatic_conduct_acceptance_enabled !== undefined
  || value.automatic_account_creation_enabled !== undefined
), {
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

/* The most a gap question may be pre-answered with: what the student's own resume printed.
 *
 * WHY THIS IS NOT INFERENCE, and why it does not weaken the rule in schema.ts that
 * application_profile.languages may never be inferred - "not from citizenship, not from resume
 * text, not from where a posting is based". Nothing here writes that column. It offers the parsed
 * list back as the starting value of a question the student still has to answer, and their Save is
 * the declaration. Inference would be Litos deciding they are fluent; this is Litos declining to
 * ask them to retype six languages it already has on file.
 *
 * The gap it closes: the parser has extracted `languages` into parsed_json since 2026-08-03, and
 * academicSeedFrom seeds gpa, gpa_scale and major from a parse but deliberately not this. So the
 * screen opened blank for a student whose resume listed six languages, and if they skipped it saved
 * [], discarding what was already known. Asking is correct; asking blank was not.
 *
 * Suggestions are offered ONLY for fields listed as gaps. A field already answered is not a
 * question, and overwriting a student's own declaration with resume text is the exact thing the
 * rule forbids.
 */
export const MAX_SUGGESTED_LANGUAGES = 30;

export function gapSuggestionsFrom(
  gaps: readonly string[],
  parsed: { languages?: unknown } | null | undefined,
): { languages?: string[] } {
  if (!gaps.includes('languages')) return {};
  const raw = Array.isArray(parsed?.languages) ? parsed.languages : [];
  const seen = new Set<string>();
  const printed: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    printed.push(name);
    if (printed.length === MAX_SUGGESTED_LANGUAGES) break;
  }
  return printed.length > 0 ? { languages: printed } : {};
}

export async function onboardingRoutes(fastify: FastifyInstance) {
  fastify.get('/onboarding/state', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    const [[user], [profile], appProfile, [bankCount], [applyCount], [target]] = await Promise.all([
      selectOnboardingUserRow(userId),
      db.select().from(profiles).where(eq(profiles.user_id, userId)),
      // Tolerant read, see lib/applicationFacts.ts: /onboarding/state is the first call /start
      // makes, and a 500 here is a blank setup flow for every student in the deploy window.
      selectApplicationProfileRow(userId),
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
    // Focus is collected before upload in the current flow, so inferred target roles enrich a
    // successful model parse but are not resume evidence and cannot hold an otherwise usable local
    // fallback on this screen. A name plus a grounded bank row is the contract generation needs.
    const parsed = profile?.parsed_json as {
      full_name?: string;
      source_pages?: number;
      target_roles?: unknown;
      languages?: unknown;
      recent_experience_review?: { completed?: boolean };
    } | null | undefined;
    const has_resume = hasResumeEvidence(parsed, bankCount?.n ?? 0);
    const has_applied = (applyCount?.n ?? 0) > 0;

    // The base resume: built once from the bank, with no job description. Stored rather than
    // derived (see schema.ts), so this is a real column read and not an inference.
    const has_base_resume = !!profile?.base_resume_json;

    const learned = HARVEST_FIELDS.filter((f) => readable(appProfile, f) !== null);
    const gaps = gapsFrom(appProfile);

    // Focus leads the current flow and is independent of model-inferred resume roles. Require the
    // fields that screen actually collects. Existing users may still have only a category from the
    // older flow, so titles and role type remain required before focus is complete.
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
    const readableEligibilityProfile = appProfile ? decryptRow(appProfile) : undefined;
    const has_sponsorship_answer = hasWorkEligibilityDeclaration({
      sponsorship_answer: user.sponsorship_answer,
      work_eligibility_by_country: readableEligibilityProfile?.work_eligibility_by_country,
      work_authorized: appProfile?.work_authorized,
      needs_sponsorship: appProfile?.needs_sponsorship,
    });

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
    const jobFirstEntry = !!user.job_first_entry;
    const derivedStep = onboardingStepFrom({
      completed: !!user.onboarding_completed_at,
      hasResume: has_resume,
      hasImpactReview: parsed?.recent_experience_review?.completed !== false,
      hasFocus: has_focus,
      hasSponsorshipAnswer: has_sponsorship_answer,
      hasBaseResume: has_base_resume,
      // The academic three, plus the standardized-test question for the early-career population
      // it is measured to appear for. See SETUP_GAP_FIELDS, targetsStudentRoles and gapsAskedFrom
      // for why each part is needed.
      hasSetupGaps: hasSetupGapsFrom(gaps, target?.role_types),
      gapsAsked: gapsAskedFrom(appProfile),
      jobFirstEntry,
    });
    const includesGaps = includesGapsStepFrom(gaps, appProfile, target?.role_types);
    const flow = await onboardingFlowLedger(userId);
    /* Existing accounts already contain the facts that normally derive every setup step as done.
       A separate acknowledgement ledger makes them review each version 2 screen without deleting
       those facts. If the migration has not landed, fail open to the legacy derived route rather
       than blanking /start for every account. */
    /* THE APPLICATION SEQUENCE, and the one guard that keeps it off accounts it does not belong to.
     *
     * It runs only once every profile-derived step is satisfied (derivedStep === 'done') AND the
     * account has never completed onboarding. That second half is load-bearing. Flow version 3 is
     * new, so every existing account has an empty version-3 ledger; without the completed_at check
     * a student who finished setup months ago would be handed the match screen on their next visit
     * to /start, which is a flow they never opted into and, worse, one that ends in sending a real
     * application. `onboarding_completed_at` is the stored consent boundary and is read as one. */
    const inApplicationSequence = flow.available && !flow.completed && !user.onboarding_completed_at;
    const step = flow.available && flow.replayRequired && !flow.completed
      ? nextReplayStep(flow.acknowledged, includesGaps)
      : derivedStep === 'done' && inApplicationSequence
        ? applicationStepFrom(flow.acknowledged, { hasSponsorshipAnswer: has_sponsorship_answer })
        : derivedStep;
    const flowCompleted = flow.available ? flow.completed : !!user.onboarding_completed_at;
    /* THE CARD GATE. The dashboard does not open until a payment method is on file.
     *
     * It is expressed as an outstanding ONBOARDING step rather than as a paywall on
     * the data routes, and that is the only shape that works here: the card is the
     * LAST rung of /start, after the student has uploaded a resume, built an
     * application, answered an employer and sent it. A guard on the dashboard's
     * data endpoints would have to allow almost every one of them to let setup run
     * at all, and would still answer the wrong question -- the question is not "may
     * this route be called", it is "is this account finished".
     *
     * `billing_customer_id` is the honest record of a card. Nothing sets it except
     * the subscription webhook, and checkout cannot complete without a card now that
     * payment_method_collection is always (lib/stripeBilling.ts), so its presence
     * means Stripe took one. It survives cancellation, which is correct: someone who
     * cancels still HAS a card on file and belongs on the dashboard on Free, not
     * thrown back into setup.
     *
     * WHO IS GATED IS AN ENV DECISION, AND IT FAILS OPEN. CARD_GATE_FROM is an ISO
     * instant; accounts created before it are never gated. Unset, the gate is off
     * for everyone.
     *
     * That default is deliberate and it is not timidity. This is the one flag in the
     * product whose wrong value locks EVERY student out of work they already own,
     * and it cannot be inferred from the entitlement cutover: inferGrandfathered()
     * returns false for every account carrying the current policy version, which is
     * every account signup has created for months. Reusing it here would have read
     * as "grandfather the old accounts" and behaved as "lock out the entire user
     * base". So the cutover is explicit, separate, and off until someone sets it:
     * deploy first, verify, then flip it, and set it to the deploy instant to gate
     * only new signups or to a past date to gate everyone. */
    const requiresPaymentMethod = requiresPaymentMethodFor(user);
    /* THE THIRD TERM IS THE JOB-FIRST FOCUS GATE, and it has to be OR'd in here too, not only
       into the step served below. onboardingStepFrom skipped this account's own focus check
       entirely so derivedStep reads 'done' the moment a job-first account has a resume - that is
       correct for THAT function's job, but it means derivedStep !== 'done' alone can no longer
       stand in for "onboarding is finished" the way it always has for every other account. A
       job-first account can satisfy every term above (derivedStep 'done', flow completed, no
       card owed) while still owing the deferred focus screen. Without this term, a caller that
       reads requires_onboarding instead of step (the field's own documented purpose - see the
       CARD GATE comment above) would wave the account into the dashboard having never set a
       target role, the same class of gap the card gate exists to close for payment. */
    const requiresOnboarding = requiresPaymentMethod || (flow.available
      ? !flowCompleted || derivedStep !== 'done'
      : derivedStep !== 'done')
      || (jobFirstEntry && !has_focus && step === 'done');
    /* AND THE STEP HAS TO BE THE ONE THAT TAKES A CARD, or the gate is a loop.
       Saying "onboarding is not finished" while serving 'done' sends the student to
       /start, which draws the finished screen, which offers no way to pay, while the
       dashboard keeps bouncing them back to it. Every other path already resolves to
       'plan' on its own; this covers the ones that do not -- an account whose flow
       ledger is unavailable, and anyone who finished setup before the gate applied. */
    const gatedStep = requiresPaymentMethod && step === 'done' ? 'plan' : step;
    /* The rail's denominator for the application half, so the client never re-derives it. Same
       rule as includes_gaps_step: the server owns which screens this student's flow contains. */
    /* ...and the rail has to CONTAIN the screen being drawn. `plan` is one of the
       conditional application steps, so serving it while includes_application_steps is
       false hands StepRail a key its list does not have; findIndex returns -1 and the
       rail draws with no position at all, which is the exact failure #285 documents.
       Reachable whenever the gate catches an account that already finished setup. */
    const includesApplicationSteps = inApplicationSequence || gatedStep !== step;
    /* JOB-FIRST FOCUS, TACKED ON AFTER EVERYTHING ELSE INCLUDING THE CARD GATE.
       onboardingStepFrom skipped this account's own focus check outright, so 'gaps' and 'plan'
       above never had to reason about it. It only surfaces once gatedStep has independently
       resolved to 'done' - meaning the application sequence AND the card gate have both cleared
       - so paying still comes before it, and it never displaces 'plan' the way it would if this
       lived inside the card-gate check itself. Computed here rather than folded into `step`
       above because `includesApplicationSteps` just above needs the PRE-tack-on comparison: this
       is a profile-fact gate like `has_focus`, not a ledger-driven application step, and mixing
       the two would make the rail's "does this flow include X" reasoning wrong for a step that
       was never part of the ledger to begin with. */
    const servedStep = jobFirstEntry && !has_focus && gatedStep === 'done' ? 'focus' : gatedStep;

    return reply.status(200).send({
      step: servedStep,
      /* The specific posting this account is entitled to spend its one free build on, from
         wherever it clicked in on /browse-jobs. Only meaningful while the match step is still
         ahead: the client uses it to skip the ranked-board algorithm and build against exactly
         the job the student chose, and it stops mattering (and gets cleared) the moment 'match'
         is acknowledged. Never set for an ordinary account in the first place - see auth.ts,
         which only ever writes this column alongside job_first_entry - so reading the column
         directly here already means "never surfaced for an ordinary account" without a redundant
         jobFirstEntry guard restating the same fact. */
      pinned_target_job_id: user.pinned_onboarding_job_id ?? null,
      flow_version: CURRENT_ONBOARDING_FLOW_VERSION,
      flow_completed: flowCompleted,
      requires_onboarding: requiresOnboarding,
      /* Sent separately from requires_onboarding because the client has to tell the
         two apart. "Finish later" may defer ordinary setup; it may not defer this,
         or the gate is a suggestion. */
      requires_payment_method: requiresPaymentMethod,
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
      // Whether the flow contains the setup gaps screen, which is the step rail's denominator. The
      // client must not re-derive this from `gaps`: see includesGapsStepFrom for the two states
      // that look identical from the gap list alone.
      includes_gaps_step: includesGaps,
      includes_application_steps: includesApplicationSteps,
      /* Whether the work-visa screen is in this student's flow. Its own flag rather than a client
         re-derivation of has_sponsorship_answer, for the reason #285 recorded about the gaps
         screen: the server owns which screens a flow contains, and a client that guesses gets it
         wrong in the deploy window.

         A SCREEN THAT WAS SHOWN STAYS IN THE FLOW, and this read `!has_sponsorship_answer` alone
         until walking production caught it. Answering the work-visa screen is what SETS that
         answer, so the moment a student finished it the flow it belonged to lost a step: the rail
         went "step 5 of 10" on the visa screen and "step 5 of 9" on the very next one. The count
         shrank underneath somebody who had just done the work, and two different screens both
         called themselves five - the exact class of bug #285 exists for, in the other direction.

         So the screen counts if it is still NEEDED or if it was already WALKED. The ledger is what
         knows the second half, which is why this is answered here and not from a profile column. */
      includes_sponsorship_step:
        includesApplicationSteps && (!has_sponsorship_answer || flow.acknowledged.includes('sponsorship')),
      // Starting values for the gap questions, from the student's own resume. Never a stored
      // answer: see gapSuggestionsFrom for why offering one is not the inference schema.ts forbids.
      gap_suggestions: gapSuggestionsFrom(gaps, parsed),
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
      // Every automation permission, from one place. See automationConsentState: a verdict with no
      // date beside it is the defect this route shipped for eight days, and it is now a property of
      // a function a test can call rather than of a literal a reader has to audit by eye.
      ...automationConsentState(user),
    });
  });

  /* Record that the setup gaps screen was PUT IN FRONT OF the student. Save and Skip both call it.
   *
   * This is the exit from that screen, and it has to be a separate act from saving the fields
   * because skipping saves nothing - which is precisely how gating on the fields alone derived
   * 'gaps' forever before #116 removed the step. See setup_gaps_asked_at in schema.ts.
   *
   * NEVER 500s, and never blocks the student on a database that has not run the migration. The
   * write is the only thing that can fail here, the client's next move is a state refresh either
   * way, and gapsAskedFrom already reads an absent column as asked - so a failed stamp on an
   * unmigrated database lands the student on 'done', which is where they were going.
   */
  /* NOTE, because this is the first writer that can create an application_profile row holding no
     student-supplied value at all. Two readers treat row EXISTENCE as the whole answer for the
     academic three - academicsOfRecord (routes/profile.ts) and academicsOfRecordForResume
     (engine/resumePolicy.ts) - where a blank on an existing row means "not on record" and overrides
     what the resume parse printed. A row created by this stamp is blank by construction.

     Harmless today, and not by luck: profile.ts creates the row only when academicSeedFrom produced
     something, so "no row" already implies "the parse carried no gpa, gpa_scale or major" and there
     is nothing for the blank to override. Measured against production 2026-08-10: of 54 accounts, 37
     have no row and ZERO of those have academics in parsed_json.

     It stops being harmless if that seed write ever starts failing silently (profile.ts catches and
     only logs it), or if the parse gains a later-populated academic field. If either happens, seed
     the row here from the parse rather than inserting it bare. */
  /**
   * POST /onboarding/answers
   *
   * What the student typed on the "what the job asks" screen, kept.
   *
   * WITHOUT THIS THAT SCREEN DISCARDS EVERYTHING. It asks a student real questions from a real
   * employer, in the employer's own words, and until this existed the client counted the answers,
   * advanced the flow, and threw them away. The screen's own promise - answer once and Litos
   * carries them into every application after this - was false.
   *
   * ACCOUNT-SCOPED, and deliberately routed through rememberReusableAnswers rather than written
   * here. That helper applies answerReuseScope, which classifies a SELF-DECLARATION as
   * posting_specific and refuses to store it: a sponsorship answer, an EEO answer or a
   * commitment made to one employer is not a fact about the account and must not be replayed to
   * the next one. This route inherits that rule rather than restating it, so the two can never
   * drift apart.
   *
   * The application-scoped copy is NOT written here. PUT /applications/:id/review/answers owns
   * that and refuses unless a review exists, which it does not until a fill has run; an onboarding
   * packet has been generated but never filled. Writing the reusable half now is what makes the
   * next application shorter, and the fill picks these up through loadSavedAnswers when it runs.
   */
  fastify.post('/onboarding/answers', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = onboardingAnswersBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid answers', detail: parsed.error.issues });
    const userId = request.jwtPayload!.userId;
    const stored = await rememberReusableAnswers(
      userId,
      parsed.data.answers,
      { company: parsed.data.company ?? undefined, jobId: parsed.data.job_id ?? null },
    );

    /* THE WORK-VISA DECLARATION, WHEN THE EMPLOYER ALREADY ASKED FOR IT.
     *
     * Measured across 318 real packets: 39.9% ask BOTH the authorization and the sponsorship
     * question. For those students the work-visa screen asks a second time what they have just
     * answered in the employer's own words, so this records it as the account's declaration for
     * that posting's country and the screen never derives.
     *
     * declarationFromEmployerAnswers refuses unless the answers genuinely support a complete
     * record, so the common outcome here is null and the screen still appears. That refusal is the
     * safety: a guessed declaration is a false legal statement made on the applicant's behalf.
     *
     * FIRST WRITE WINS, matching POST /onboarding/sponsorship exactly. The `isNull` guard on the
     * update is what enforces it, so an employer answer can only ever FILL an empty declaration
     * and can never overwrite one the student made herself. */
    let declaredCountry: string | null = null;
    if (parsed.data.job_id) {
      /* Read fresh rather than threaded in: this route is called once per onboarding and the read
         is what makes the first-write-wins check honest about what is already on file. */
      const appProfileRow = await selectApplicationProfileRow(userId);
      const [job] = await db
        .select({ country: monitored_jobs.job_country })
        .from(monitored_jobs)
        .where(eq(monitored_jobs.id, parsed.data.job_id))
        .limit(1);
      const record = declarationFromEmployerAnswers(parsed.data.answers, job?.country ?? null);
      if (record) {
        const existing = countryEligibilityForRead({ stored: appProfileRow?.work_eligibility_by_country });
        const already = (existing ?? []).some((row) => row.country_code === record.country_code);
        if (!already) {
          await persistProfileWithCountryEligibility(userId, {}, [...(existing ?? []), record]);
          await db
            .update(users)
            .set({
              sponsorship_required_at_onboarding: accountSponsorshipAnswer(record) === 'yes',
              sponsorship_declared_at: new Date(),
              sponsorship_answer: accountSponsorshipAnswer(record) === 'yes' ? 'needs_now' : 'no',
            })
            .where(and(eq(users.id, userId), isNull(users.sponsorship_declared_at)));
          declaredCountry = record.country_code;
        }
      }
    }
    /* `remembered` is what was actually kept, not what was sent, and the difference is the point:
       a screen that reported "3 saved" after storing 1 would be describing a promise it did not
       keep for the two declarations the store correctly refused. */
    return reply.status(200).send({
      ok: true,
      remembered: stored.length,
      submitted: parsed.data.answers.length,
      /* Which country, if any, now carries a declaration because of these answers. The client uses
         it to say so on screen rather than silently changing what the board shows. */
      declared_country: declaredCountry,
    });
  });

  fastify.post('/onboarding/gaps-asked', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    try {
      await upsertApplicationProfile(userId, { setup_gaps_asked_at: new Date() });
      return reply.status(200).send({ recorded: true });
    } catch (error) {
      // setup_gaps_asked_at is the ONLY value in this write, so upsertApplicationProfile has
      // nothing left after stripping the fact columns and rethrows rather than reporting a success
      // that wrote nothing. That is right for a save and wrong for this: with the column absent the
      // step is suppressed anyway, so there is nothing to record and nothing to fail.
      if (!isUndefinedColumnError(error)) throw error;
      return reply.status(200).send({ recorded: false });
    }
  });

  /* Acknowledging a walkthrough screen is not the same act as changing profile data. The profile
     endpoint owns any edits, and this append-only receipt records only that the version 2 screen
     was continued or skipped. Finish later does not call this route. */
  fastify.post('/onboarding/flow/steps', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = flowStepBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid onboarding step acknowledgement' });
    const userId = request.jwtPayload!.userId;
    const [[user], appProfile, [target]] = await Promise.all([
      db.select({ onboarding_completed_at: users.onboarding_completed_at }).from(users).where(eq(users.id, userId)).limit(1),
      selectApplicationProfileRow(userId),
      db.select().from(targeting).where(eq(targeting.user_id, userId)),
    ]);
    if (!user) return reply.status(404).send({ error: 'No such user' });

    const flow = await onboardingFlowLedger(userId);
    if (!flow.available) return reply.status(503).send({ error: 'The onboarding update is still being prepared. Try again shortly.' });
    /* The replay ordering check applies to the setup screens only. An application step arriving
       here is not out of order, it is simply not part of the walk replay describes. */
    if (flow.replayRequired && isReplayStep(parsed.data.step)) {
      const decision = flowAcknowledgementDecision(
        flow.acknowledged,
        parsed.data.step,
        includesGapsStepFrom(gapsFrom(appProfile), appProfile, target?.role_types),
      );
      if (decision.alreadyRecorded) return reply.status(200).send({ ok: true, ...parsed.data });
      if (!decision.accepted) {
        return reply.status(409).send({ error: `Review ${decision.expected} before continuing.` });
      }
    }

    await db.transaction(async (tx) => {
      await tx.insert(onboarding_flow_runs).values({
        user_id: userId,
        flow_version: CURRENT_ONBOARDING_FLOW_VERSION,
          replay_required: false,
      }).onConflictDoNothing();
      await tx.insert(onboarding_flow_step_acknowledgements).values({
        user_id: userId,
        flow_version: CURRENT_ONBOARDING_FLOW_VERSION,
        step: parsed.data.step,
        disposition: parsed.data.disposition,
      }).onConflictDoNothing();
      /* Best-effort, and inside the same transaction rather than a fire-and-forget after it: the
         match screen has now been acknowledged, so whatever job was pinned for this account has
         either been built or been declined - either way, a later reload must not offer it again.
         Scoped to 'match' specifically, not every step, because pinned_onboarding_job_id has no
         meaning past that screen. */
      if (parsed.data.step === 'match') {
        await tx.update(users).set({ pinned_onboarding_job_id: null }).where(eq(users.id, userId));
      }
    });
    return reply.status(200).send({ ok: true, ...parsed.data });
  });

  fastify.post('/onboarding/flow/complete', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = flowCompleteBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid onboarding flow version' });
    const userId = request.jwtPayload!.userId;
    const [[user], appProfile, [target]] = await Promise.all([
      db.select({ onboarding_completed_at: users.onboarding_completed_at }).from(users).where(eq(users.id, userId)).limit(1),
      selectApplicationProfileRow(userId),
      db.select().from(targeting).where(eq(targeting.user_id, userId)),
    ]);
    if (!user) return reply.status(404).send({ error: 'No such user' });
    if (!user.onboarding_completed_at) {
      return reply.status(409).send({ error: 'Finish the initial setup before recording this walkthrough version.' });
    }

    const flow = await onboardingFlowLedger(userId);
    if (!flow.available) return reply.status(503).send({ error: 'The onboarding update is still being prepared. Try again shortly.' });
    if (flow.completed) return reply.status(200).send({ ok: true, flow_version: CURRENT_ONBOARDING_FLOW_VERSION });

    const blocking = replayBlockingStep(flow, includesGapsStepFrom(gapsFrom(appProfile), appProfile, target?.role_types));
    if (blocking) {
      return reply.status(409).send({ error: `Review ${blocking} before finishing this walkthrough.` });
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(onboarding_flow_runs).values({
        user_id: userId,
        flow_version: CURRENT_ONBOARDING_FLOW_VERSION,
        replay_required: false,
        completed_at: now,
      }).onConflictDoNothing();
      await tx.update(onboarding_flow_runs)
        .set({ completed_at: now })
        .where(sql`${onboarding_flow_runs.user_id} = ${userId}
          and ${onboarding_flow_runs.flow_version} = ${CURRENT_ONBOARDING_FLOW_VERSION}`);
    });
    return reply.status(200).send({ ok: true, flow_version: CURRENT_ONBOARDING_FLOW_VERSION });
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

    const [[eligibilityUser], eligibilityRow] = await Promise.all([
      db.select({ sponsorship_answer: users.sponsorship_answer }).from(users).where(eq(users.id, userId)).limit(1),
      selectApplicationProfileRow(userId),
    ]);
    const readableEligibility = eligibilityRow ? decryptRow(eligibilityRow) : undefined;
    if (!hasWorkEligibilityDeclaration({
      sponsorship_answer: eligibilityUser?.sponsorship_answer,
      work_eligibility_by_country: readableEligibility?.work_eligibility_by_country,
      work_authorized: eligibilityRow?.work_authorized,
      needs_sponsorship: eligibilityRow?.needs_sponsorship,
    })) {
      return reply.status(409).send({ error: 'Complete work eligibility before finishing setup.' });
    }

    try {
      const now = new Date();
      await db
        .update(users)
        .set({
          onboarding_completed_at: sql`coalesce(${users.onboarding_completed_at}, ${now})`,
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
    // Ungated on purpose, unlike standing submission consent. Resuming a fill after the applicant
    // clears a challenge sends nothing to anyone: it finishes the boxes and stops at the submit
    // button, which is what the unpermissioned path already does. The gate that matters for sending
    // is automatic_submission_enabled, and it still applies afterwards.
    if (parsed.data.automatic_captcha_enabled !== undefined) {
      patch.automatic_captcha_enabled = parsed.data.automatic_captcha_enabled;
      patch.automatic_captcha_consented_at = parsed.data.automatic_captcha_enabled ? now : null;
      patch.automatic_captcha_consent_version = parsed.data.automatic_captcha_enabled
        ? AUTOMATIC_CAPTCHA_CONSENT_VERSION
        : null;
    }
    /* Ungated, like captcha resume and unlike standing submission consent: accepting a privacy
     * notice sends nothing to anybody. It ticks a box on a form that then stops at the submit
     * button exactly where it stops today, and automatic_submission_enabled still decides whether
     * anything is ever sent. Turning it off is always allowed, from any state, and clears the date
     * and the version with it so a revocation leaves no record that could be read as a grant. */
    if (parsed.data.automatic_consent_acceptance_enabled !== undefined) {
      patch.automatic_consent_acceptance_enabled = parsed.data.automatic_consent_acceptance_enabled;
      patch.automatic_consent_acceptance_consented_at = parsed.data.automatic_consent_acceptance_enabled ? now : null;
      patch.automatic_consent_acceptance_consent_version = parsed.data.automatic_consent_acceptance_enabled
        ? AUTOMATIC_CONSENT_ACCEPTANCE_VERSION
        : null;
    }
    // Separate from the one above at every layer, including here: granting one must never write the
    // other's columns, and revoking one must leave the other's date and version standing.
    if (parsed.data.automatic_conduct_acceptance_enabled !== undefined) {
      patch.automatic_conduct_acceptance_enabled = parsed.data.automatic_conduct_acceptance_enabled;
      patch.automatic_conduct_acceptance_consented_at = parsed.data.automatic_conduct_acceptance_enabled ? now : null;
      patch.automatic_conduct_acceptance_consent_version = parsed.data.automatic_conduct_acceptance_enabled
        ? AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION
        : null;
    }
    /* Its own arm for the same reason the two above have theirs, and the stakes are higher: this
       is the permission whose act leaves a third-party account behind, so granting or revoking a
       neighbouring one must never touch its date or version. */
    if (parsed.data.automatic_account_creation_enabled !== undefined) {
      patch.automatic_account_creation_enabled = parsed.data.automatic_account_creation_enabled;
      patch.automatic_account_creation_consented_at = parsed.data.automatic_account_creation_enabled ? now : null;
      patch.automatic_account_creation_consent_version = parsed.data.automatic_account_creation_enabled
        ? AUTOMATIC_ACCOUNT_CREATION_VERSION
        : null;
    }
    const [updated] = await db.update(users).set(patch).where(eq(users.id, userId)).returning({
      automatic_submission_enabled: users.automatic_submission_enabled,
      automatic_submission_consent_version: users.automatic_submission_consent_version,
      automatic_verification_enabled: users.automatic_verification_enabled,
      automatic_captcha_enabled: users.automatic_captcha_enabled,
      // Selected so the response can carry it, matching /onboarding/state. Without it a settings
      // screen that hydrates from this write loses the date it had until the next state read, and
      // the same field would then mean two different things on the two routes.
      automatic_captcha_consented_at: users.automatic_captcha_consented_at,
      automatic_captcha_consent_version: users.automatic_captcha_consent_version,
      automatic_consent_acceptance_enabled: users.automatic_consent_acceptance_enabled,
      automatic_consent_acceptance_consented_at: users.automatic_consent_acceptance_consented_at,
      automatic_consent_acceptance_consent_version: users.automatic_consent_acceptance_consent_version,
      automatic_conduct_acceptance_enabled: users.automatic_conduct_acceptance_enabled,
      automatic_conduct_acceptance_consented_at: users.automatic_conduct_acceptance_consented_at,
      automatic_conduct_acceptance_consent_version: users.automatic_conduct_acceptance_consent_version,
      automatic_account_creation_enabled: users.automatic_account_creation_enabled,
      automatic_account_creation_consented_at: users.automatic_account_creation_consented_at,
      automatic_account_creation_consent_version: users.automatic_account_creation_consent_version,
    });
    if (!updated) return reply.status(404).send({ error: 'No such user' });
    // The VERDICT, matching /onboarding/state exactly. Returning the raw column here would give the
    // same field name two meanings on two endpoints: for the accounts holding a stale consent
    // version this would echo true while the state route reported false, and a settings page
    // hydrating from this response would show a permission the backend does not honour.
    return reply.send({
      ...updated,
      automatic_captcha_enabled: captchaResumeGranted(updated),
      automatic_consent_acceptance_enabled: consentAcceptanceGranted(updated),
      automatic_conduct_acceptance_enabled: conductAcceptanceGranted(updated),
      automatic_account_creation_enabled: accountCreationGranted(updated),
    });
  });
}
