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
  'education_start_date',
  'prior_application_employers',
  'has_outstanding_offers',
  'outstanding_offer_details',
  'military_service',
  'politically_exposed',
  'politically_exposed_family',
  'restrictive_agreements',
  'advanced_study_plan',
  'attest_truthful_information',
  'accept_privacy_notices',
  'application_attestations_consented_at',
  'onsite_commitment',
  'onsite_locations',
  'relocation_willingness',
  /* The scoped, expiring availability window, added by scripts/apply-availability-window-schema.mjs.
     That script HAS since run: verified against the production database 2026-08-10, all columns in
     this list exist there.

     Worth keeping in mind when reading the fallback below, because it is GROUP-WIDE: one missing
     column drops EVERY name in this list from the projection, so an unrun migration does not only
     disable its own feature, it makes every other fact column read undefined too. That is the right
     trade for a read that must not 500, but it means "this list is fully migrated" is a fact worth
     re-checking before relying on any single column, not an assumption. */
  'availability_window_start',
  'availability_window_end',
  'availability_cycle',
  'availability_valid_through',
  // The main-first schema PR migrates this encrypted text column before the feature deploys. Keep
  // the standard undefined-column fallback for staging databases and incomplete local schemas.
  'work_eligibility_by_country',
  // Added by scripts/apply-setup-gaps-asked-schema.mjs. Listed here because the deploy may lead the
  // migration, and this is the column whose ABSENCE has to be distinguishable from NULL: absent
  // suppresses the gaps step entirely (the flow behaves as it does today), null routes to it. See
  // routes/onboarding.ts gapsAskedFrom.
  'setup_gaps_asked_at',
  /* Added by scripts/apply-standardized-test-scores-schema.mjs (2026-08-11). Listed here for the
     same reason as everything above it: the deploy may lead the hand-run migration, and without
     this entry the first read after the deploy would 42703 and take the whole application profile
     down rather than reading these three as "never asked". */
  'standardized_test_type',
  'sat_score',
  'act_score',
] as const;

export type ApplicationFactColumn = (typeof APPLICATION_FACT_COLUMNS)[number];

const FACT_COLUMN_SET: ReadonlySet<string> = new Set(APPLICATION_FACT_COLUMNS);

/* Postgres `undefined_column`. The one error that means "this branch shipped before the migration".
 *
 * READ THE CAUSE CHAIN, NOT JUST THE ERROR. This used to test `error.code` alone, and against the
 * Drizzle version this repo actually runs that is never set: a failed query arrives as a
 * `DrizzleQueryError` whose own `code` is undefined and whose `cause` is the pg error carrying
 * `42703`. So the fallback below could not fire, and the whole tolerance this file was written to
 * provide - the reason a column may be added to APPLICATION_FACT_COLUMNS before its migration has
 * run - silently did nothing.
 *
 * Measured 2026-08-09 against a database with the schema of the moment before the migration:
 * `db.select().from(application_profile)` threw name "Error", constructor DrizzleQueryError, code
 * undefined, cause.code "42703", and selectApplicationProfileRow rethrew it. Every read of the
 * application profile - autofill, onboarding state, and buildPacket for every in-flight submission
 * - would have failed for as long as the deploy led the migration.
 */
export function isUndefinedColumnError(error: unknown): boolean {
  // Bounded: an error whose cause chains into itself must not spin here.
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if ((current as { code?: string }).code === '42703') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
export async function selectApplicationProfileRow(
  userId: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<ApplicationProfileRow | undefined> {
  try {
    const rows = await executor.select().from(application_profile)
      .where(eq(application_profile.user_id, userId)).limit(1);
    return rows[0];
  } catch (error) {
    if (!isUndefinedColumnError(error)) throw error;
    const rows = await executor
      .select(legacyColumns())
      .from(application_profile)
      .where(eq(application_profile.user_id, userId))
      .limit(1);
    return rows[0] as ApplicationProfileRow | undefined;
  }
}

/* ---- THE WRITE PATH HAS NO UNMIGRATED-DATABASE TOLERANCE, AND CANNOT HAVE ONE THIS WAY ----
 *
 * There used to be a retry here. It stripped the fact columns out of the payload OBJECT with a
 * `withoutFactColumns` helper and wrote again, and the comment above it promised that a student's
 * phone number and availability would still save while only the new answers were dropped.
 *
 * THAT RETRY COULD NEVER FIRE, and the promise was false for the whole time it stood. Drizzle's
 * `db.insert(table).values(...)` names EVERY COLUMN DECLARED ON THE TABLE in the emitted INSERT,
 * filling the ones the payload omits with `default`. Removing a key from the payload does not
 * remove the column from the SQL. So the retry emitted a statement naming
 * `standardized_test_type` exactly like the first attempt, Postgres raised the identical 42703, and
 * that second error was thrown from outside the try block and propagated to the caller.
 *
 * Measured by rendering the SQL both ways (see the regression test in applicationFacts.test.ts):
 *   INSERT names standardized_test_type?   true
 *   retry payload after stripping          {"address_city":"Dubai","major":"CS"}
 *   RETRY still names standardized_test_type?   true
 *
 * Two things followed from that, and both were invisible:
 *   - `droppedFactColumns` was NEVER true, so the log line telling an operator to run the migration
 *     could not print. The one signal that would have caught an unmigrated database was dead.
 *   - Deleting the retry changes NOTHING at runtime. It already threw; it just took a second
 *     round trip to the database to do it.
 *
 * WHY THE READ PATH IS DIFFERENT AND IS STILL REAL. selectApplicationProfileRow above builds an
 * EXPLICIT narrowed column list with `db.select(legacyColumns())`, so the fact columns genuinely do
 * not appear in that SQL. A projection can be narrowed; an insert's column list, as this ORM emits
 * it, cannot. That asymmetry is the whole reason one guard works and the other never did.
 *
 * SO THE MIGRATION IS A HARD PREREQUISITE FOR WRITES. Every column added by these migrations is
 * additive and nullable, which is backward compatible with the code already deployed, so the safe
 * order is MIGRATION FIRST, THEN MERGE. Run scripts/apply-application-facts-schema.mjs,
 * apply-availability-window-schema.mjs, apply-setup-gaps-asked-schema.mjs and
 * apply-standardized-test-scores-schema.mjs before the deploy that declares their columns. If a
 * deploy does land first, PUT /profile/application returns 500 until the migration runs. That is
 * the honest failure, and it is loud, which the silent one was not.
 */
export async function upsertApplicationProfile(
  userId: string,
  values: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(application_profile)
    .values({ user_id: userId, ...values, updated_at: new Date() })
    .onConflictDoUpdate({
      target: application_profile.user_id,
      set: { ...values, updated_at: new Date() },
    });
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
