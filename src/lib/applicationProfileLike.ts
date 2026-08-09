import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { application_profile, profiles, users } from '../db/schema';
import { decryptRow } from '../routes/applicationProfile';
import { readExperienceBankOrSeedFromBaseResume } from '../db/experienceBank';
import type { ApplicationProfileLike } from './questionDiscovery';
import { selectApplicationProfileRow, factBoolean, factString, factStringList } from './applicationFacts';

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

export async function loadApplicationProfileLike(userId: string): Promise<ApplicationProfileLike> {
  const [appRow, [profileRow], [userRow], bankRows] = await Promise.all([
    // Tolerant read, see lib/applicationFacts.ts. This is the resolver's own profile read, so a
    // 42703 here would stall every in-flight submission, not just the new questions.
    selectApplicationProfileRow(userId),
    db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1),
    db.select({
      sponsorship_answer: users.sponsorship_answer,
    }).from(users).where(eq(users.id, userId)).limit(1),
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
    readExperienceBankOrSeedFromBaseResume(userId).catch(() => []),
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
  return {
    full_name: academicStr('full_name'),
    phone: str('phone'),
    address_city: str('address_city'),
    address_state: str('address_state'),
    address_country: str('address_country'),
    linkedin_url: str('linkedin_url'),
    github_url: str('github_url'),
    portfolio_url: str('portfolio_url'),
    citizenship: str('citizenship'),
    work_authorized: appBoolean('work_authorized') ?? onboardingEligibility.workAuthorized,
    needs_sponsorship: appBoolean('needs_sponsorship') ?? onboardingEligibility.needsSponsorship,
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
    has_outstanding_offers: factBoolean(appRow, 'has_outstanding_offers'),
    outstanding_offer_details: factString(appRow, 'outstanding_offer_details'),
    military_service: factString(appRow, 'military_service'),
    politically_exposed: factString(appRow, 'politically_exposed'),
    politically_exposed_family: factString(appRow, 'politically_exposed_family'),
    advanced_study_plan: advancedStudyPlan(factString(appRow, 'advanced_study_plan')),
    attest_truthful_information: factBoolean(appRow, 'attest_truthful_information'),
    accept_privacy_notices: factBoolean(appRow, 'accept_privacy_notices'),
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
