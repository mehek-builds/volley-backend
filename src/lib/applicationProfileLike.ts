import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { application_profile, profiles, users } from '../db/schema';
import { decryptRow } from '../routes/applicationProfile';
import { readExperienceBankOrSeedFromBaseResume } from '../db/experienceBank';
import type { ApplicationProfileLike } from './questionDiscovery';
import type { ExperiencePeriod } from './experienceTenure';
import {
  selectApplicationProfileRow,
  factBoolean,
  factString,
  factStringList,
  isUndefinedColumnError,
} from './applicationFacts';
import { submittedApplicationCompanies } from './duplicateApplication';
import {
  AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION,
  AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
  conductAcceptanceGranted,
  consentAcceptanceGranted,
} from './automationConsent';
import { countryEligibilityForRead } from './workEligibility';
import { acknowledgementPermissionsFor } from './grantedAnswerReplay';
import { resumeEmailOfRecord } from './resumeEmail';

export function eligibilityFromLoadedApplicationProfile(
  app: Record<string, unknown>,
  input: {
    work_authorized?: boolean;
    needs_sponsorship?: boolean;
    sponsorship_answer?: unknown;
  },
) {
  return countryEligibilityForRead({
    // app is the decrypted profile view. appRow is the database envelope and must never be sent
    // into the resolver as though its ciphertext were a country declaration.
    stored: app.work_eligibility_by_country,
    work_authorized: input.work_authorized,
    needs_sponsorship: input.needs_sponsorship,
    sponsorship_answer: input.sponsorship_answer,
  });
}

export function workEligibilityFromSponsorshipAnswer(answer: unknown): {
  workAuthorized?: boolean;
  needsSponsorship?: boolean;
} {
  switch (answer) {
    case 'needs_now':
      return { needsSponsorship: true };
    case 'needs_future':
      return { workAuthorized: true, needsSponsorship: true };
    case 'not_authorized':
      return { workAuthorized: false, needsSponsorship: true };
    case 'no':
      return { workAuthorized: true, needsSponsorship: false };
    default:
      return {};
  }
}

function experienceBankType(value: string): 'job' | 'project' | 'leadership' | undefined {
  return value === 'job' || value === 'project' || value === 'leadership' ? value : undefined;
}

/**
 * The dated employment entries the resolver may do arithmetic on: the parsed resume's `experience`
 * array (the base resume's when the parse has none), plus every `job` row of the experience bank
 * that carries a date range. Projects and leadership are excluded on all three sources - they are
 * not employment - but by two different tests, because the sources disagree about where the kind is
 * recorded: the bank keeps `type === 'job'`, and the resume paths DROP an explicit project or
 * leadership row while keeping an untyped one. See isNonEmployment for why that asymmetry is
 * required rather than untidy. Undefined when nothing dated is on file, which the resolver refuses on.
 *
 * EACH ENTRY ALSO CARRIES ITS OWN BULLETS, and they are skill evidence, never dates. The role TITLE
 * is deliberately NOT carried: it was, and reading it produced false claims, because titles are
 * Title Case by convention and every case-based signal is inverted on that field. See
 * experienceEvidencing.
 * skillScopedExperienceAnswer answers "how many years of hands on experience do you have with X"
 * by summing only the roles whose own words name X, so the span and the words it belongs to have to
 * arrive together. Nothing in the tenure arithmetic reads either field (see ExperiencePeriod), so
 * carrying them cannot move a total that this function already produced. The bullets are joined
 * into one string rather than kept as an array because every reader of them asks the same question,
 * "is this skill named anywhere in this role", and one string is the honest shape for that.
 *
 * The bank rows deliberately contribute no evidence text: a bank row is an organisation, a title
 * and a date range with no bullets, and a title alone is not where a tool gets named. They still
 * count toward total tenure exactly as before.
 *
 * WHAT THE PROSE IS AND IS NOT ALLOWED TO PROVE is decided downstream by skillEvidencedIn, not here.
 * This function's job is to carry her words across unchanged; judging whether "excel at reporting"
 * names a spreadsheet is that function's, and putting any of that judgement here would split one
 * rule across two modules.
 *
 * Pure, and exported for the loader test: loadApplicationProfileLike itself needs a database.
 */
export function experiencePeriodsFromSources(
  parsed: Record<string, unknown>,
  base: Record<string, unknown>,
  bankRows: readonly { type?: string | null; date_range?: string | null }[],
): ExperiencePeriod[] | undefined {
  const dateText = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  /* Every shape the parse and the resume spec write their prose in: a single `description`, a
   * `summary`, or the `bullets`/`highlights` arrays the resume spec uses. Non-string members are
   * dropped rather than stringified, so an object never reaches the matcher as "[object Object]". */
  const evidenceText = (entry: Record<string, unknown>): string | undefined => {
    const parts: string[] = [];
    for (const key of ['description', 'summary', 'bullets', 'highlights', 'responsibilities']) {
      const value = entry[key];
      if (typeof value === 'string') parts.push(value);
      else if (Array.isArray(value)) parts.push(...value.filter((item): item is string => typeof item === 'string'));
    }
    const joined = parts.map((part) => part.trim()).filter(Boolean).join(' ');
    return joined || undefined;
  };
  /* A NON-EMPLOYMENT ROW IS DROPPED HERE, and this filter is not optional decoration.
   *
   * `base` is `profileRow.base_resume_json`, a ResumeSpec, and ITS `experience[]` is one array
   * holding all three kinds with a `type: 'job' | 'project' | 'leadership'` discriminator beside
   * `date_range` and `bullets` (src/llm/resumeSpec.ts). `parsed_json` is shaped differently: its
   * `experience` is employment only, with leadership in a separate top-level array, which is why
   * this path had no filter and looked correct. It is not correct for the base resume, and
   * fromResume(base) runs whenever the parse carries no experience array at all. Measured: a
   * personal `Trading bot` project whose bullets say "Built a Python backtester" answered "how
   * many years of hands on experience do you have with Python" with 1-2 years, and a club
   * presidency answered the same question about Kubernetes, for an applicant whose only
   * employment there was two months of unrelated operations work.
   *
   * THE TEST IS NEGATIVE, AND THE ASYMMETRY WITH THE BANK FILTER BELOW IS DELIBERATE. The bank
   * requires `type === 'job'` because every bank row carries a type. A parsed resume entry
   * routinely carries NO type at all, so requiring 'job' here would silently drop every parsed
   * role and zero out the total tenure that yearsOfExperienceAnswer already ships. Only an
   * EXPLICIT project or leadership row is excluded; an untyped row is employment, as it always was.
   * Do not "harmonize" these two filters. */
  const isNonEmployment = (entry: Record<string, unknown>): boolean => {
    const type = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
    return type === 'project' || type === 'leadership';
  };
  const fromResume = (source: Record<string, unknown>): ExperiencePeriod[] | undefined => {
    const experience = source.experience;
    if (!Array.isArray(experience)) return undefined;
    const periods: ExperiencePeriod[] = [];
    for (const item of experience) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      if (isNonEmployment(entry)) continue;
      const start = dateText(entry.start ?? entry.start_date ?? entry.startDate ?? entry.from);
      const end = dateText(entry.end ?? entry.end_date ?? entry.endDate ?? entry.to);
      const date_range = dateText(entry.date_range ?? entry.dates);
      const description = evidenceText(entry);
      if (start || end || date_range) periods.push({ start, end, date_range, description });
    }
    return periods;
  };
  const resumePeriods = fromResume(parsed) ?? fromResume(base) ?? [];
  const bankPeriods = bankRows
    .filter((row) => row.type === 'job' && dateText(row.date_range))
    .map((row) => ({ date_range: dateText(row.date_range) }));
  const periods = [...resumePeriods, ...bankPeriods];
  return periods.length > 0 ? periods : undefined;
}

/* The user row this resolver reads: the sponsorship declaration, and the standing permission to
 * accept employer consent acknowledgements.
 *
 * TOLERANT FOR THE SAME REASON selectApplicationProfileRow IS. Drizzle compiles a projection to an
 * explicit column list, so naming a column the database has not got fails the WHOLE read with
 * 42703, not just the new field - and this read is on the submission hot path. Merging this repo is
 * a production deploy and the migration is run by hand, so the two can land in either order.
 *
 * The fallback is not a degraded mystery state: the permission reads as never granted, which is
 * precisely main's behaviour, and every consent goes back to the applicant exactly as it does
 * today. See scripts/apply-consent-acceptance-schema.mjs, which must still run before the merge.
 */
type ResolverUserRow = {
  sponsorship_answer: typeof users.$inferSelect['sponsorship_answer'];
  automatic_consent_acceptance_enabled?: boolean | null;
  automatic_consent_acceptance_consented_at?: Date | null;
  automatic_consent_acceptance_consent_version?: string | null;
  automatic_conduct_acceptance_enabled?: boolean | null;
  automatic_conduct_acceptance_consented_at?: Date | null;
  automatic_conduct_acceptance_consent_version?: string | null;
};

async function selectResolverUserRow(
  userId: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<ResolverUserRow[]> {
  try {
    return await executor.select({
      sponsorship_answer: users.sponsorship_answer,
      automatic_consent_acceptance_enabled: users.automatic_consent_acceptance_enabled,
      automatic_consent_acceptance_consented_at: users.automatic_consent_acceptance_consented_at,
      automatic_consent_acceptance_consent_version: users.automatic_consent_acceptance_consent_version,
      automatic_conduct_acceptance_enabled: users.automatic_conduct_acceptance_enabled,
      automatic_conduct_acceptance_consented_at: users.automatic_conduct_acceptance_consented_at,
      automatic_conduct_acceptance_consent_version: users.automatic_conduct_acceptance_consent_version,
    }).from(users).where(eq(users.id, userId)).limit(1);
  } catch (error) {
    if (!isUndefinedColumnError(error)) throw error;
    return executor.select({
      sponsorship_answer: users.sponsorship_answer,
    }).from(users).where(eq(users.id, userId)).limit(1);
  }
}

/**
 * The standing consent-acceptance licence for one account, derived EXACTLY as the resolver's
 * profile view derives it: the tolerant user-row read, the version check in
 * consentAcceptanceGranted, and the grantedAnswerReplay trust gate, all through the same
 * acknowledgementPermissionsFor call loadApplicationProfileLike uses. One derivation, two readers,
 * so the submit gate in routes/submissionRunner.ts and the packet's own profile cannot disagree
 * about whether the grant is live.
 *
 * Null means "behave as today": never granted, revoked, stale version, unmigrated database, or the
 * runner-trust gate closed. Exists for the call sites that need the answer BEFORE buildPacket has
 * loaded the full profile (the per-portal submit gate runs ahead of the packet on purpose, so a
 * stopped application pays for nothing).
 */
export async function loadUnattendedConsentGrant(
  userId: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<{ granted_at?: string; version: string } | null> {
  const [userRow] = await selectResolverUserRow(userId, executor);
  return acknowledgementPermissionsFor(userRow, {
    consent: consentAcceptanceGranted,
    conduct: conductAcceptanceGranted,
    consentVersion: AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
    conductVersion: AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION,
  }).consent_acknowledgement_permission ?? null;
}

export async function loadApplicationProfileLike(
  userId: string,
  executor: Pick<typeof db, 'select' | 'insert'> = db,
): Promise<ApplicationProfileLike> {
  const [appRow, [profileRow], [userRow], bankRows, submittedCompanies] = await Promise.all([
    // Tolerant read, see lib/applicationFacts.ts. This is the resolver's own profile read, so a
    // 42703 here would stall every in-flight submission, not just the new questions.
    selectApplicationProfileRow(userId, executor),
    executor.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1),
    selectResolverUserRow(userId, executor),
    /* The experience bank, read the one way it is allowed to be read (db/experienceBank.ts), the
     * same call coverLetterService and the submission runner already make. The resolver needs it
     * because a question about her employment history has to be answered by checking her
     * employment history, and `employer_history` is not that: it is scraped out of
     * parsed_json.experience and held 4 of the owner's 9 organisations on 2026-08-09.
     *
     * The catch is not defensive noise. An unreadable bank must reach the resolver as an EMPTY
     * one, because empty is the case the resolver already refuses on: "we could not read your
     * experience" and "you never worked anywhere" must not become the same input. Throwing here
     * would instead stall every submission over a question that is allowed to be left blank. */
    readExperienceBankOrSeedFromBaseResume(userId, executor).catch(() => []),
    /* Litos' own record of what it has already sent for this user, which is the ONLY thing that may
     * stand down the default "No" to "have you applied to us before?".
     *
     * The catch returns undefined, NOT an empty list, and the difference is the whole safety of the
     * rule. An empty list says "Litos looked and has sent nothing", which licenses the answer; a
     * failed read that arrived as an empty list would license the same answer having checked
     * nothing, and could tell an employer she has never applied on a day the database was down.
     * undefined reaches the resolver as "not read" and it holds the question, which is what it does
     * today. Same shape as the experience-bank catch above, opposite value, for opposite reasons. */
    submittedApplicationCompanies(userId, executor).catch(() => undefined),
  ]);
  const app = appRow ? (decryptRow(appRow) as Record<string, unknown>) : {};
  const parsed = (profileRow?.parsed_json && typeof profileRow.parsed_json === 'object'
    ? profileRow.parsed_json
    : {}) as Record<string, unknown>;
  const base = (profileRow?.base_resume_json && typeof profileRow.base_resume_json === 'object'
    ? profileRow.base_resume_json
    : {}) as Record<string, unknown>;
  const str = (key: string): string | undefined => (typeof app[key] === 'string' ? (app[key] as string) : undefined);
  const appBoolean = (key: string): boolean | undefined => (typeof app[key] === 'boolean' ? (app[key] as boolean) : undefined);
  const strings = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const out = value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
    return out.length > 0 ? [...new Set(out)] : undefined;
  };
  const academicStr = (key: string): string | undefined => {
    const parsedValue = parsed[key];
    if (typeof parsedValue === 'string' && parsedValue.trim()) return parsedValue;
    const baseValue = base[key];
    return typeof baseValue === 'string' && baseValue.trim() ? baseValue : undefined;
  };
  const academicNum = (key: string): number | undefined => {
    const parsedValue = parsed[key];
    if (typeof parsedValue === 'number' && parsedValue > 0) return parsedValue;
    const baseValue = base[key];
    return typeof baseValue === 'number' && baseValue > 0 ? baseValue : undefined;
  };
  const academicBoolean = (key: string): boolean | undefined => {
    const parsedValue = parsed[key];
    if (typeof parsedValue === 'boolean') return parsedValue;
    const baseValue = base[key];
    return typeof baseValue === 'boolean' ? baseValue : undefined;
  };
  const employerCompany = (entry: Record<string, unknown>): string | undefined => {
    const company = entry.company ?? entry.org;
    return typeof company === 'string' && company.trim() ? company.trim() : undefined;
  };
  const experienceEmployers = (value: Record<string, unknown>, predicate: (entry: Record<string, unknown>) => boolean): string[] => {
    const experience = value.experience;
    if (!Array.isArray(experience)) return [];
    const employers: string[] = [];
    for (const item of experience) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      if (!predicate(entry)) continue;
      const company = employerCompany(entry);
      if (company) employers.push(company);
    }
    return employers;
  };
  const experienceEmployer = (value: Record<string, unknown>, predicate: (entry: Record<string, unknown>) => boolean): string | undefined => {
    return experienceEmployers(value, predicate)[0];
  };
  const mostRecentEmployer = (): string | undefined => {
    return experienceEmployer(parsed, () => true) ?? experienceEmployer(base, () => true);
  };
  const employerHistory = (): string[] | undefined => {
    const employers = [...experienceEmployers(parsed, () => true), ...experienceEmployers(base, () => true)];
    const unique = [...new Set(employers)];
    return unique.length ? unique : undefined;
  };
  const currentEmployer = (): string | undefined => {
    const currentExperience = (entry: Record<string, unknown>): boolean => {
      const end = entry.end_date ?? entry.endDate ?? entry.end ?? entry.to ?? entry.date_range ?? entry.dates;
      return typeof end === 'string' && /\b(?:present|current|now|ongoing)\b/i.test(end);
    };
    return str('current_employer') ?? experienceEmployer(parsed, currentExperience) ?? experienceEmployer(base, currentExperience);
  };
  /* When the applicant STARTED their current programme. Employer education blocks ask for this and
   * it must never be answered from availability_date.
   *
   * The DECLARED fact wins, and it is read first. Routing this to the parsed education history was
   * correct as far as it went and answered nothing: measured on the owner's production profile on
   * 2026-08-09, parsed_json carries no `education` array at all and no education_start_date, so the
   * resolver refused the field on every run and "Start date month" led the 2026-08-08 blockers with
   * 7 of the 22 stops. It is now an onboarding fact (application_profile.education_start_date), for
   * the reason written against that column: nothing on file can derive it without inventing it.
   *
   * The parse remains underneath. A resume that does carry a start date should not need asking. */
  const educationStartDate = (): string | undefined => {
    const declared = factString(appRow, 'education_start_date');
    if (declared) return declared;
    const direct = academicStr('education_start_date');
    if (direct) return direct;
    for (const source of [parsed, base]) {
      const education = source.education;
      if (!Array.isArray(education)) continue;
      for (const item of education) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const entry = item as Record<string, unknown>;
        const start = entry.start ?? entry.start_date ?? entry.startDate ?? entry.from;
        if (typeof start === 'string' && start.trim()) return start.trim();
      }
    }
    return undefined;
  };
  const onboardingEligibility = workEligibilityFromSponsorshipAnswer(userRow?.sponsorship_answer);
  const scopedEligibility = eligibilityFromLoadedApplicationProfile(app, {
    work_authorized: appBoolean('work_authorized'),
    needs_sponsorship: appBoolean('needs_sponsorship'),
    sponsorship_answer: userRow?.sponsorship_answer,
  });
  return {
    full_name: academicStr('full_name'),
    phone: str('phone'),
    address_city: str('address_city'),
    address_state: str('address_state'),
    address_zip: str('address_zip'),
    address_country: str('address_country'),
    linkedin_url: str('linkedin_url'),
    github_url: str('github_url'),
    portfolio_url: str('portfolio_url'),
    citizenship: str('citizenship'),
    work_authorized: appBoolean('work_authorized') ?? onboardingEligibility.workAuthorized,
    needs_sponsorship: appBoolean('needs_sponsorship') ?? onboardingEligibility.needsSponsorship,
    work_eligibility_by_country: scopedEligibility,
    date_of_birth: str('date_of_birth'),
    availability_date: str('availability_date'),
    availability_term: str('availability_term'),
    current_employer: currentEmployer(),
    most_recent_employer: mostRecentEmployer(),
    employer_history: employerHistory(),
    experience_bank: bankRows
      .map((entry) => ({
        type: experienceBankType(entry.type),
        org: (entry.org ?? '').trim(),
        title: entry.title?.trim() || undefined,
      }))
      .filter((entry) => entry.org),
    // The dated roles behind "years of experience"; see experiencePeriodsFromSources.
    experience_periods: experiencePeriodsFromSources(parsed, base, bankRows),
    /* THE SAME FUNCTION THAT PRODUCES `_contact.email`, called on the same row, so the resolver and
     * the packet cannot disagree about the applicant's address of record. resumeEmailOfRecord reads
     * `profiles.parsed_json.resume_email` and validates the shape; it returns undefined when there
     * is none, which academicEmailAnswer treats as "hold", not as "no university address". */
    contact_email: resumeEmailOfRecord(profileRow?.parsed_json),
    school: academicStr('school'),
    degree: academicStr('degree'),
    education_start_date: educationStartDate(),
    grad_date: academicStr('grad_date'),
    grad_year: academicNum('grad_year'),
    currently_enrolled: academicBoolean('currently_enrolled'),
    desired_salary: str('desired_salary'),
    desired_salary_currency: str('desired_salary_currency'),
    gpa: str('gpa'),
    gpa_scale: str('gpa_scale'),
    major: str('major'),
    languages: strings(app.languages),
    skills: strings(profileRow?.skills) ?? strings(parsed.skills) ?? strings(base.skills),
    eeo_prefs: app.eeo_prefs && typeof app.eeo_prefs === 'object'
      ? app.eeo_prefs as Record<string, string>
      : undefined,
    referral_source_default: str('referral_source_default'),

    /* ---- application facts asked once in onboarding ----
     *
     * Read off `appRow`, the RAW row, not off `app` (the decrypted view). None of these is in
     * ENCRYPTED_FIELDS, so decryptRow passes them through untouched and either source would work
     * today - but reading the raw row keeps that true if one of them is ever encrypted, and the
     * fact* helpers are the single place that decides what counts as "answered".
     *
     * undefined reaches the resolver as "never asked", which is what makes it leave the question
     * for the applicant instead of inventing an answer. That is also what the caller sees during
     * the window where this code is deployed and the migration has not run: selectApplicationProfileRow
     * returns the row without these columns, and every one of them reads undefined.
     */
    pronouns: factString(appRow, 'pronouns'),
    legal_first_name: factString(appRow, 'legal_first_name'),
    preferred_first_name: factString(appRow, 'preferred_first_name'),
    high_school_grad_date: factString(appRow, 'high_school_grad_date'),
    prior_application_employers: factStringList(appRow, 'prior_application_employers'),
    // Not an onboarding fact and not a declaration: Litos' own send history, read above.
    submitted_application_companies: submittedCompanies,
    has_outstanding_offers: factBoolean(appRow, 'has_outstanding_offers'),
    outstanding_offer_details: factString(appRow, 'outstanding_offer_details'),
    military_service: factString(appRow, 'military_service'),
    politically_exposed: factString(appRow, 'politically_exposed'),
    politically_exposed_family: factString(appRow, 'politically_exposed_family'),
    restrictive_agreements: factString(appRow, 'restrictive_agreements'),
    advanced_study_plan: advancedStudyPlan(factString(appRow, 'advanced_study_plan')),
    attest_truthful_information: factBoolean(appRow, 'attest_truthful_information'),
    accept_privacy_notices: factBoolean(appRow, 'accept_privacy_notices'),

    /* The standing permission, VERSION-CHECKED HERE so no resolver has to know the rule. Set only
     * when consentAcceptanceGranted is satisfied; left undefined for never-granted, revoked, a
     * stale consent version, and a database whose migration has not run. All four hold.
     *
     * AND A FIFTH STATE, which is why the gate stands in front of both: granted, current, and
     * held anyway, because the runner cannot yet be trusted to put the acceptance on the control it
     * was asked about rather than on a neighbouring one. See lib/grantedAnswerReplay.ts, which
     * carries the measurement. Suppressed HERE, at the single point where a granted column becomes
     * a licence, so that the resolver, the Apply screen's pre-script, the packet audit and the
     * consent trail cannot disagree about it: with the licence absent they all behave exactly as
     * they did before PR 502, which is the behaviour that was safe.
     *
     * The applicant's decision, its date and its version are untouched in the database and are
     * still reported by /onboarding/state. Only the acting on it is held. */
    ...acknowledgementPermissionsFor(userRow, {
      consent: consentAcceptanceGranted,
      conduct: conductAcceptanceGranted,
      consentVersion: AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
      conductVersion: AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION,
    }),
    onsite_commitment: onsiteCommitment(factString(appRow, 'onsite_commitment')),
    onsite_locations: factStringList(appRow, 'onsite_locations'),
    relocation_willingness: yesNo(factString(appRow, 'relocation_willingness')),

    /* The scoped availability window, read raw and passed through unvalidated ON PURPOSE. Whether
     * these four amount to a declaration that may answer a given posting is one decision and it
     * lives in one place, lib/availabilityWindow.ts, next to the reasoning for every rejection.
     * Narrowing here as well would put half the rule in a loader, which is how the two copies of
     * the classification regexes drifted. A missing column reads undefined, and undefined is
     * "never asked", which the resolver answers by leaving the question for the student. */
    availability_window_start: factString(appRow, 'availability_window_start'),
    availability_window_end: factString(appRow, 'availability_window_end'),
    availability_cycle: factString(appRow, 'availability_cycle'),
    availability_valid_through: factString(appRow, 'availability_valid_through'),
  };
}

/** Narrows the stored text to the three commitments the resolver knows how to act on. */
function onsiteCommitment(value: string | undefined): 'anywhere' | 'listed_locations' | 'no' | undefined {
  return value === 'anywhere' || value === 'listed_locations' || value === 'no' ? value : undefined;
}

/**
 * A stored yes/no declaration.
 *
 * Anything else, including an empty string and a stray "maybe", reads as undefined - never asked -
 * so the resolver refuses rather than guessing which way a malformed value was meant to point.
 */
function yesNo(value: string | undefined): 'yes' | 'no' | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'yes' || normalized === 'no' ? normalized : undefined;
}

/** Narrows the stored text to the three answers the resolver knows how to act on. */
function advancedStudyPlan(value: string | undefined): 'no' | 'considering' | 'committed' | undefined {
  return value === 'no' || value === 'considering' || value === 'committed' ? value : undefined;
}
