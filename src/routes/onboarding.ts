import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, getTableColumns, sql } from 'drizzle-orm';
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
import { decryptRow, ENCRYPTED_FIELDS } from './applicationProfile';
import {
  AUTOMATIC_CAPTCHA_CONSENT_VERSION,
  AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION,
  AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
  AUTOMATIC_SUBMISSION_CONSENT_VERSION,
  automationConsentState,
  automationConsentValues,
  captchaResumeGranted,
  conductAcceptanceGranted,
  consentAcceptanceGranted,
} from '../lib/automationConsent';
import { standingConsentEligibility, mayChangeStandingConsent } from '../engine/standingConsent';
import { generated_resumes } from '../db/schema';
import { isComposioConfigured } from '../lib/composioConnections';
import { isUndefinedColumnError, selectApplicationProfileRow, upsertApplicationProfile } from '../lib/applicationFacts';
import { verificationEmailSource } from '../lib/verificationEmailSource';
import { countryEligibilityForRead } from '../lib/workEligibility';

/**
 * How many submissions has this student personally approved AND seen reach the employer?
 *
 * This is now profile evidence, not an unlock. `per_application_approval` means the student clicked
 * the final submit themselves, and `submitted` means it actually landed. The value is still returned
 * in onboarding state for transparency, but standing consent no longer waits for a minimum count.
 */
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
  if (await verificationEmailSource(userId)) return null;
  if (!isComposioConfigured()) {
    return { status: 503, error: 'The Litos application inbox is unavailable and email connections are not configured yet' };
  }
  return { status: 409, error: 'Connect Gmail or Outlook, or wait until the Litos application inbox is available' };
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
// TWO things are stored rather than derived, and both for the same reason: they record an ACT that
// no amount of inspecting the profile can infer.
//   users.onboarding_completed_at              - finishing setup, because it gates harvest and so
//                                                has to be explicit rather than inferred. See harvest.ts.
//   application_profile.setup_gaps_asked_at    - having been SHOWN the setup gaps screen. Every field
//                                                on it is skippable, so "answered" and "asked" are
//                                                different facts and only the second can end the step.
//                                                See SETUP_GAP_FIELDS and gapsAskedFrom below.

/* The three columns scripts/apply-consent-acceptance-schema.mjs adds, named here so the read below
 * can drop them when the deploy has landed ahead of the migration. */
const CONSENT_ACCEPTANCE_COLUMNS: ReadonlySet<string> = new Set([
  'automatic_consent_acceptance_enabled',
  'automatic_consent_acceptance_consented_at',
  'automatic_consent_acceptance_consent_version',
  'automatic_conduct_acceptance_enabled',
  'automatic_conduct_acceptance_consented_at',
  'automatic_conduct_acceptance_consent_version',
]);

/**
 * The user row, tolerating a database that has not run the consent-acceptance migration.
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
async function selectOnboardingUserRow(userId: string) {
  try {
    return await db.select().from(users).where(eq(users.id, userId));
  } catch (error) {
    if (!isUndefinedColumnError(error)) throw error;
    const all = getTableColumns(users);
    const legacy: Record<string, unknown> = {};
    for (const [name, column] of Object.entries(all)) {
      if (!CONSENT_ACCEPTANCE_COLUMNS.has(name)) legacy[name] = column;
    }
    const rows = await db
      .select(legacy as Partial<typeof users._.columns>)
      .from(users)
      .where(eq(users.id, userId));
    return rows as (typeof users.$inferSelect)[];
  }
}

type Step = 'focus' | 'sponsorship' | 'resume' | 'impact' | 'base' | 'gaps' | 'done';

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
}): Step {
  if (input.completed && input.hasImpactReview !== false) return 'done';
  if (!input.hasResume) return 'resume';
  if (input.hasImpactReview === false) return 'impact';
  if (!input.hasFocus) return 'focus';
  if (!input.hasSponsorshipAnswer) return 'sponsorship';
  if (!input.hasBaseResume) return 'base';
  if (input.hasSetupGaps && !input.gapsAsked) return 'gaps';
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
const GAP_FIELDS = [
  'gpa',
  'gpa_scale',
  'major',
  'languages',
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

/** Whether the setup gaps screen has something to ask THIS student. */
export function hasSetupGapsFrom(gaps: readonly string[]): boolean {
  return SETUP_GAP_FIELDS.some((f) => gaps.includes(f));
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
export function includesGapsStepFrom(gaps: readonly string[], row: Record<string, unknown> | undefined): boolean {
  if (!gapsAskedColumnPresent(row)) return false;
  return hasSetupGapsFrom(gaps) || gapsAskedFrom(row);
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
});
const automationBodySchema = z.object({
  automatic_submission_enabled: z.boolean().optional(),
  automatic_verification_enabled: z.boolean().optional(),
  automatic_captcha_enabled: z.boolean().optional(),
  automatic_consent_acceptance_enabled: z.boolean().optional(),
  automatic_conduct_acceptance_enabled: z.boolean().optional(),
}).refine((value) => (
  value.automatic_submission_enabled !== undefined
  || value.automatic_verification_enabled !== undefined
  || value.automatic_captcha_enabled !== undefined
  || value.automatic_consent_acceptance_enabled !== undefined
  || value.automatic_conduct_acceptance_enabled !== undefined
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
    // Checks a REQUIRED key, not object truthiness: `!!{}` is true, so a parse that returned
    // nothing usable would advance the student past step 01 with no name, school or grad_year -
    // and the targeting screen would then derive its period options from grad_year 0.
    const parsed = profile?.parsed_json as {
      full_name?: string;
      source_pages?: number;
      target_roles?: unknown;
      languages?: unknown;
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
    const step = onboardingStepFrom({
      completed: !!user.onboarding_completed_at,
      hasResume: has_resume,
      hasImpactReview: parsed?.recent_experience_review?.completed !== false,
      hasFocus: has_focus,
      hasSponsorshipAnswer: has_sponsorship_answer,
      hasBaseResume: has_base_resume,
      // The academic three only, and only until the screen has been shown once. See
      // SETUP_GAP_FIELDS and gapsAskedFrom for why each half is needed.
      hasSetupGaps: hasSetupGapsFrom(gaps),
      gapsAsked: gapsAskedFrom(appProfile),
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
      // Whether the flow contains the setup gaps screen, which is the step rail's denominator. The
      // client must not re-derive this from `gaps`: see includesGapsStepFrom for the two states
      // that look identical from the gap list alone.
      includes_gaps_step: includesGapsStepFrom(gaps, appProfile),
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
    });
  });
}
