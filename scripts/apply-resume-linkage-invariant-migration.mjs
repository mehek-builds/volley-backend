#!/usr/bin/env node

/* Makes "a resume artifact is selected" and "a resume is attached" the same fact, in the database.
 *
 * An application row carries selected_resume_artifact_id beside the (resume_attached,
 * resume_source, resume_attached_at) triple. The old check constraint tied only one direction: an
 * attached artifact resume had to name a document. The other direction was free, so this shape
 * satisfied its first arm and was accepted:
 *
 *   selected_resume_artifact_id: <a real, owned, resume-kind artifact>
 *   resume_attached: false
 *   resume_source: 'none'
 *
 * Measured 2026-09-03 across the ten boards Mehek was applying to, SIX were stored exactly like
 * that: DSI Innovations, Blueprint Hires, Prediktive, xolife, Confluence Technologies and TixTrack.
 * Each had a PASSED packet audit binding an exact PDF. The packet believed it had a resume, the
 * audit bound the file, and the linkage row said there was none.
 *
 * This migration does the two halves that a forward-only code fix cannot:
 *
 *   1. It REPAIRS the existing rows. Six of ten boards are in this state right now, and no code
 *      path corrects them. The one repair that exists, submissionConfirmationRepair, is gated on a
 *      legacy attempt id AND a verified receipt, so it only reaches applications that have already
 *      been submitted and confirmed. Five of the six have never been submitted at all, so it
 *      cannot reach them by construction. Repairing here is not a second copy of that repair; it
 *      is the only one that can run for a row that has not been sent.
 *
 *   2. It TIGHTENS the constraint so the shape stops being storable. Adding "is null" to the other
 *      two arms makes the pointer present exactly when the source is 'artifact'.
 *
 * The order is forced: with the broken rows present the ALTER TABLE fails outright, so the repair
 * is a precondition of the constraint. But the two are not one all-or-nothing step. Repair runs and
 * COMMITS in its own transaction; the constraint is only attempted afterward, in a transaction of
 * its own, and only when nothing remains to explain. A row this script did not anticipate - not one
 * of the four shapes above, found live in production rather than reasoned about here - must not cost
 * the six repairs it can already account for. So a residual violation, or the ALTER itself failing
 * (the pre-check racing a concurrent write), is REPORTED, not thrown: the repairs already committed
 * stand, the constraint is left as it was, and the script exits 0. This is what makes it safe to run
 * from anywhere that treats a nonzero exit as a release blocker - nothing this script can encounter
 * takes an already-running litos-api down, and nothing here should be able to either.
 *
 * Idempotent. Re-running it repairs nothing (there is nothing left to repair) and, once no row
 * remains unaccounted for, installs the same constraint definition.
 *
 * Pass --dry-run to see which applications fall into which repair, by id, and roll back without
 * touching anything. Worth doing first: a row whose pointer names a document that has since been
 * deleted is CLEARED rather than promoted, which is the honest reading but is not what an operator
 * expecting an attachment would want to discover afterwards.
 */

import tls from 'node:tls';
import pg from 'pg';

const SCHEMA_VERSION = 'resume-linkage-invariant-v1';
const MIGRATION_LOCK = [1414090051, 20260904];
const CONSTRAINT = 'applications_resume_attachment_state_check';

/* The live-document test, kept identical to the one POST /applications/:id/fill applies before it
 * will accept an artifact id: owned by the same user, not soft deleted, and a resume kind. A
 * pointer that fails it names nothing this application could send. */
const LIVE_ARTIFACT = `
  exists (
    select 1 from artifacts x
    where x.id = a.selected_resume_artifact_id
      and x.user_id = a.user_id
      and x.deleted_at is null
      and x.kind in ('resume', 'tailored_resume')
  )
`;

const CONSTRAINT_DEFINITION = `
  (resume_attached = false and resume_source = 'none' and selected_resume_artifact_id is null)
  or (resume_attached = true and resume_source = 'artifact' and selected_resume_artifact_id is not null)
  or (resume_attached = true and resume_source = 'base_resume' and selected_resume_artifact_id is null)
`;

async function assertPrerequisiteTables(client) {
  const result = await client.query(`
    select table_name from information_schema.tables
    where table_schema = current_schema() and table_name = any($1::text[])
  `, [['applications', 'artifacts']]);
  const present = new Set(result.rows.map((row) => row.table_name));
  const missing = ['applications', 'artifacts'].filter((table) => !present.has(table));
  if (missing.length) {
    throw new Error(`Resume linkage invariant prerequisites are missing: ${missing.join(', ')}`);
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(2);
  }

  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    // Same TLS posture, for the same reason, as the other migration scripts in this directory:
    // absent without the variable, so the in-container plaintext path over Railway's private
    // network is untouched, and pinned to Railway's private root when run from a CI runner.
    ssl: process.env.SCHEMA_CHECK_DATABASE_SSL_ROOT_CERT?.trim()
        && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
      ? {
          rejectUnauthorized: true,
          ca: `${process.env.SCHEMA_CHECK_DATABASE_SSL_ROOT_CERT.trim().replace(/\\n/g, '\n')}\n`,
          checkServerIdentity: (host, cert) => tls.checkServerIdentity('postgres.railway.internal', cert),
        }
      : undefined,
  });
  await client.connect();
  let lockHeld = false;
  try {
    await client.query("set lock_timeout = '2min'");
    await client.query("set statement_timeout = '5min'");
    /* SESSION-scoped, not transaction-scoped: this run now has two transactions to cover, repair
     * and constraint, and a second invocation of this script must not be able to run its own repair
     * in the gap between this one's repair commit and its constraint attempt. Held for the whole
     * run and released explicitly below, rather than auto-released at the first commit. */
    await client.query('select pg_advisory_lock($1, $2)', MIGRATION_LOCK);
    lockHeld = true;
    await assertPrerequisiteTables(client);

    /* PHASE ONE: repair, and COMMIT the repair on its own terms. Whether the constraint below can
     * be installed today must never decide whether these rows stay fixed; a table-wide check that
     * finds one more row this script did not anticipate is not a reason to hand a repaired row back
     * to (false, 'none'). Errors inside this block are still fatal and still roll back: a query that
     * throws here is a bug in this script, not a residual violation, and the right answer to a bug
     * is to stop, not to commit around it. */
    await client.query('begin');
    let promoted;
    let linkStamps;
    let cleared;
    let baseResumePointers;
    let violations;
    try {
      /* REPAIR ONE: the document is real, so the row was always attached and only said otherwise.
       * resume_attached_at takes the row's own updated_at rather than now(), because that is when
       * the write that bound the pointer happened; stamping today would date every one of these to
       * the migration and lose the only evidence of when the resume was actually attached. */
      promoted = await client.query(`
        update applications a set
          resume_attached = true,
          resume_source = 'artifact',
          resume_attached_at = coalesce(a.resume_attached_at, a.updated_at)
        where a.selected_resume_artifact_id is not null
          and a.resume_attached = false
          and a.resume_source = 'none'
          and ${LIVE_ARTIFACT}
        returning a.id
      `);

      /* REPAIR ONE-B: the same completion on the link row, because the two are one attachment.
       *
       * application_artifacts.attached_at is read by the authoritative submission projection, which
       * refuses an exact link whose stamp is null. Until now the only thing that ever completed it
       * was submissionConfirmationRepair's pre-ledger block, which fires on precisely the shape
       * repair one just removed, so from here that block can no longer run. Completing the link stamp
       * with the SAME value keeps the projection whole rather than trading one incomplete record for
       * another. Only rows repair one promoted, only the selected resume link, only where it is
       * already null. */
      linkStamps = await client.query(`
        update application_artifacts link set attached_at = a.resume_attached_at
        from applications a
        where link.application_id = a.id
          and link.artifact_id = a.selected_resume_artifact_id
          and link.purpose = 'resume'
          and link.attached_at is null
          and a.id = any($1::uuid[])
        returning link.application_id
      `, [promoted.rows.map((row) => row.id)]);

      /* REPAIR TWO: the document is gone, so the pointer names nothing and the row is genuinely
       * detached. Clearing it is the honest reading, and it is the only other way to satisfy the
       * constraint without asserting an attachment that does not exist. Rows that already claim
       * (true, 'artifact') are left alone even if their artifact is missing: that is a different
       * defect, it does not block this constraint, and repairing it here would silently detach a
       * resume from an application that believes it is sending one.
       *
       * Both repairs select the exact broken shape, (false, 'none') with a pointer, rather than
       * "anything that is not (true, 'artifact')". The looser predicate also matched an attached
       * base_resume row that happened to carry a pointer, and promoting one of those would rewrite a
       * main-resume application into an artifact application. Repair three is what those rows want. */
      cleared = await client.query(`
        update applications a set
          selected_resume_artifact_id = null,
          resume_attached = false,
          resume_source = 'none',
          resume_attached_at = null
        where a.selected_resume_artifact_id is not null
          and a.resume_attached = false
          and a.resume_source = 'none'
          and not ${LIVE_ARTIFACT}
        returning a.id
      `);

      /* REPAIR THREE: the main resume is not a document row, so a pointer beside it names a document
       * this application is not sending. The fill route has always cleared it on that path; the
       * duplicate-row merge could put one back. */
      baseResumePointers = await client.query(`
        update applications a set selected_resume_artifact_id = null
        where a.resume_attached = true
          and a.resume_source = 'base_resume'
          and a.selected_resume_artifact_id is not null
        returning a.id
      `);

      /* Written out rather than derived from CONSTRAINT_DEFINITION by string substitution: this is
       * the assertion phase two below reads to decide whether the ALTER TABLE can succeed, and a
       * clever rewrite that silently matched the wrong identifier would turn it into a check of
       * nothing. Computed here, inside the repair transaction, so it reads the post-repair rows by
       * read-your-own-writes rather than a second round trip after commit. */
      violations = await client.query(`
        select count(*)::int as count from applications
        where not (
          (resume_attached = false and resume_source = 'none' and selected_resume_artifact_id is null)
          or (resume_attached = true and resume_source = 'artifact' and selected_resume_artifact_id is not null)
          or (resume_attached = true and resume_source = 'base_resume' and selected_resume_artifact_id is null)
        )
      `);
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    }
    await client.query(dryRun ? 'rollback' : 'commit');
    const violationCount = violations.rows[0].count;

    /* PHASE TWO: tighten the constraint. Attempted only on a real run, and only when phase one left
     * nothing unaccounted for. Either way this cannot touch the repairs above: they already
     * committed (or, on a dry run, were already rolled back on their own terms) before this line
     * runs. A residual violation, or the ALTER itself failing - the pre-check above racing a
     * concurrent write in the gap between the two transactions - is REPORTED and skipped rather than
     * thrown, so this script's exit code never asks anything watching it to treat "every known row
     * repaired, one unexplained row left the constraint off" as the same event as "this script is
     * broken". See the file header for why that distinction is the point of this phase split. */
    let constraintTightened = false;
    let constraintSkippedReason = null;
    if (dryRun) {
      if (violationCount > 0) {
        constraintSkippedReason = `${violationCount} application row(s) would still violate the resume `
          + 'linkage invariant after this repair, so a real run would leave the constraint as it is.';
      }
    } else if (violationCount > 0) {
      constraintSkippedReason = `${violationCount} application row(s) still violate the resume linkage `
        + 'invariant after repair. The repairs above already committed; only the constraint is '
        + 'skipped. A row this script cannot explain is not a reason to undo the ones it repaired. '
        + 'Investigate the remaining row(s); this script is idempotent and installs the constraint '
        + 'once none remain.';
      console.error(constraintSkippedReason);
    } else {
      try {
        await client.query('begin');
        await client.query(`alter table applications drop constraint if exists ${CONSTRAINT}`);
        await client.query(`alter table applications add constraint ${CONSTRAINT} check (${CONSTRAINT_DEFINITION})`);
        await client.query('commit');
        constraintTightened = true;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        constraintSkippedReason = 'the constraint could not be installed even though the repair left no '
          + `known violations, so something changed it first: ${error instanceof Error ? error.message : String(error)}. `
          + 'The repairs above already committed. Re-run to retry the constraint.';
        console.error(constraintSkippedReason);
      }
    }

    /* Same visibility the sources:verify split gives a benign liveness finding: printed on every
     * run, annotated on the pull request or workflow summary where one exists, fatal to nothing. */
    if (constraintSkippedReason && process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::warning title=Resume linkage constraint not installed::${
        constraintSkippedReason.replace(/\s*[\r\n]+\s*/g, ' ')}`);
    }

    console.log(JSON.stringify({
      event: dryRun ? 'resume_linkage_invariant_dry_run' : 'resume_linkage_invariant_applied',
      schemaVersion: SCHEMA_VERSION,
      dryRun,
      promoted: promoted.rowCount,
      linkStampsCompleted: linkStamps.rowCount,
      cleared: cleared.rowCount,
      baseResumePointersCleared: baseResumePointers.rowCount,
      remainingViolations: violationCount,
      constraintTightened: dryRun ? violationCount === 0 : constraintTightened,
      ...(constraintSkippedReason ? { constraintSkippedReason } : {}),
      // Ids only on a dry run, so the applied line stays the same shape it always was and carries
      // nothing per-row into the logs.
      ...(dryRun ? {
        promotedApplicationIds: promoted.rows.map((row) => row.id),
        clearedApplicationIds: cleared.rows.map((row) => row.id),
        baseResumePointerApplicationIds: baseResumePointers.rows.map((row) => row.id),
      } : {}),
    }));
  } finally {
    if (lockHeld) await client.query('select pg_advisory_unlock($1, $2)', MIGRATION_LOCK).catch(() => undefined);
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
