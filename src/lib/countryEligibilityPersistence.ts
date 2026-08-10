import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { application_profile, users } from '../db/schema';
import { encryptField } from './fieldCrypto';
import {
  eligibilityForCountry,
  legacyUsProjection,
  type CountryWorkEligibility,
} from './workEligibility';

export function sponsorshipStateForRecords(records: readonly CountryWorkEligibility[]) {
  const us = eligibilityForCountry(records, 'US');
  if (!us) {
    return {
      sponsorship_required_at_onboarding: false,
      sponsorship_answer: null,
      sponsor_only_jobs_enabled: false,
    } as const;
  }
  const answer = us.needs_sponsorship_now
    ? 'needs_now'
    : us.needs_sponsorship_future
      ? 'needs_future'
      : us.authorized_now
        ? 'no'
        : 'not_authorized';
  const required = answer !== 'no';
  return {
    sponsorship_required_at_onboarding: required,
    sponsorship_answer: answer,
    sponsor_only_jobs_enabled: required,
  } as const;
}

/** Save the encrypted profile declaration and every board-filter projection in one transaction. */
export async function persistProfileWithCountryEligibility(
  userId: string,
  profileValues: Record<string, unknown>,
  records: readonly CountryWorkEligibility[],
): Promise<void> {
  const now = new Date();
  const profile = {
    ...profileValues,
    work_eligibility_by_country: encryptField(JSON.stringify(records)),
    ...legacyUsProjection(records),
  };
  await db.transaction(async (tx) => {
    await tx
      .insert(application_profile)
      .values({ user_id: userId, ...profile, updated_at: now })
      .onConflictDoUpdate({
        target: application_profile.user_id,
        set: { ...profile, updated_at: now },
      });
    await tx.update(users).set({
      ...sponsorshipStateForRecords(records),
      sponsorship_declared_at: now,
    }).where(eq(users.id, userId));
  });
}
