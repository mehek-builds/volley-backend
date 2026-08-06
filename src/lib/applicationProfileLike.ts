import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { application_profile, profiles, users } from '../db/schema';
import { decryptRow } from '../routes/applicationProfile';
import type { ApplicationProfileLike } from './questionDiscovery';

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

export async function loadApplicationProfileLike(userId: string): Promise<ApplicationProfileLike> {
  const [[appRow], [profileRow], [userRow]] = await Promise.all([
    db.select().from(application_profile).where(eq(application_profile.user_id, userId)).limit(1),
    db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1),
    db.select({
      sponsorship_answer: users.sponsorship_answer,
    }).from(users).where(eq(users.id, userId)).limit(1),
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
    school: academicStr('school'),
    degree: academicStr('degree'),
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
  };
}
