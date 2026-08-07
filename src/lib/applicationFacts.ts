/* The application facts asked once in onboarding, and the read/write path that survives the
 * migration not having run yet.
 *
 * WHY THIS FILE EXISTS AT ALL. Both repos auto-deploy to production on merge, and the migration is
 * run by hand, so the two land in either order. Drizzle's `db.select().from(application_profile)`
 * compiles to an EXPLICIT column list built from schema.ts, so the moment schema.ts declares a
 * column the database does not have, every read of the whole table fails with 42703 - not just the
 * new field. That would take the entire application profile down (autofill, onboarding state, the
 * submission runner) for however long the window is. Postgres reports it as `undefined_column`,
 * and the same catch already guards users.application_email_forward_to in lib/applicationEmail.ts;
 * this generalises it to a whole column group.
 *
 * The fallback is not a degraded mystery state: it returns the row with every new field undefined,
 * which is byte-identical to what a migrated database returns for a student who has not answered
 * the onboarding questions yet. Every consumer already has to handle that, so the unmigrated
 * window behaves exactly like an unanswered profile rather than like an error.
 */

import { eq, getTableColumns } from 'drizzle-orm';
import { db } from '../db/index';
import { application_profile } from '../db/schema';

/** Columns added by scripts/apply-application-facts-schema.mjs. Keep in step with that script. */
export const APPLICATION_FACT_COLUMNS = [
  'pronouns',
  'legal_first_name',
  'preferred_first_name',
  'high_school_grad_date',
  'prior_application_employers',
  'has_outstanding_offers',
  'outstanding_offer_details',
  'military_service',
  'politically_exposed',
  'politically_exposed_family',
  'advanced_study_plan',
  'attest_truthful_information',
  'accept_privacy_notices',
  'application_attestations_consented_at',
] as const;

export type ApplicationFactColumn = (typeof APPLICATION_FACT_COLUMNS)[number];

const FACT_COLUMN_SET: ReadonlySet<string> = new Set(APPLICATION_FACT_COLUMNS);

/** Postgres `undefined_column`. The one error that means "this branch shipped before the migration". */
export function isUndefinedColumnError(error: unknown): boolean {
  return (error as { code?: string } | null | undefined)?.code === '42703';
}

/** Every application_profile column except the ones the migration may not have created yet. */
function legacyColumns() {
  const all = getTableColumns(application_profile);
  const out: Record<string, unknown> = {};
  for (const [name, column] of Object.entries(all)) {
    if (!FACT_COLUMN_SET.has(name)) out[name] = column;
  }
  return out as Partial<typeof application_profile._.columns>;
}

/**
 * A row as this codebase must actually treat it: every established column present, every column the
 * facts migration adds merely OPTIONAL. That is precisely the guarantee the fallback below gives,
 * and writing it into the type is what stops a caller from assuming a value that may not be there
 * yet without the compiler noticing.
 */
export type ApplicationProfileRow =
  Omit<typeof application_profile.$inferSelect, ApplicationFactColumn>
  & Partial<Pick<typeof application_profile.$inferSelect, ApplicationFactColumn>>;

/**
 * Read one application_profile row, tolerating a database that has not run the facts migration.
 *
 * Returns undefined when there is no row for this user, which is a real state: /profile/application
 * 404s on it and the resolver treats it as an empty profile.
 */
export async function selectApplicationProfileRow(userId: string): Promise<ApplicationProfileRow | undefined> {
  try {
    const rows = await db.select().from(application_profile).where(eq(application_profile.user_id, userId)).limit(1);
    return rows[0];
  } catch (error) {
    if (!isUndefinedColumnError(error)) throw error;
    const rows = await db
      .select(legacyColumns())
      .from(application_profile)
      .where(eq(application_profile.user_id, userId))
      .limit(1);
    return rows[0] as ApplicationProfileRow | undefined;
  }
}

/** The same values with every not-yet-migrated column removed, for a write that has to get through. */
export function withoutFactColumns<T extends Record<string, unknown>>(values: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!FACT_COLUMN_SET.has(key)) out[key] = value;
  }
  return out as Partial<T>;
}

/**
 * Upsert an application_profile row, retrying without the fact columns if they do not exist yet.
 *
 * The retry DROPS the new answers rather than failing the whole save. That is the right trade for
 * the few minutes the window lasts: the student's phone number and availability still save, and
 * the unsaved fact reads back as "never asked", which is the state it was already in. Failing the
 * write instead would lose every field on the form, not just the new ones.
 */
export async function upsertApplicationProfile(
  userId: string,
  values: Record<string, unknown>,
): Promise<{ droppedFactColumns: boolean }> {
  const write = async (payload: Record<string, unknown>) => {
    await db
      .insert(application_profile)
      .values({ user_id: userId, ...payload, updated_at: new Date() })
      .onConflictDoUpdate({
        target: application_profile.user_id,
        set: { ...payload, updated_at: new Date() },
      });
  };
  try {
    await write(values);
    return { droppedFactColumns: false };
  } catch (error) {
    if (!isUndefinedColumnError(error)) throw error;
    const stripped = withoutFactColumns(values);
    // Nothing left to write means the request was ONLY new answers, so there is no partial save to
    // salvage; let the caller's 500 stand rather than report a success that wrote nothing.
    if (Object.keys(stripped).length === 0) throw error;
    await write(stripped);
    return { droppedFactColumns: true };
  }
}

/* ---- reading the stored values back out, safely ----
 *
 * Everything below returns undefined for "never asked", and undefined is what the resolver needs to
 * see in order to leave a question alone. A blank string, an empty array and a stored "Prefer not
 * to say" are three DIFFERENT answers and none of them is "never asked", so the coercions here are
 * deliberately narrow: they normalise whitespace and nothing else.
 */

export function factString(row: ApplicationProfileRow | undefined, key: ApplicationFactColumn): string | undefined {
  const value = row?.[key as keyof ApplicationProfileRow];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function factBoolean(row: ApplicationProfileRow | undefined, key: ApplicationFactColumn): boolean | undefined {
  const value = row?.[key as keyof ApplicationProfileRow];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * A declared string[] column.
 *
 * An EMPTY array survives as an empty array on purpose. For prior_application_employers that is the
 * student saying "I have not applied anywhere before", which answers No for every employer; folding
 * it to undefined would turn a real declaration back into a blocked question.
 */
export function factStringList(
  row: ApplicationProfileRow | undefined,
  key: ApplicationFactColumn,
): string[] | undefined {
  const value = row?.[key as keyof ApplicationProfileRow];
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}
