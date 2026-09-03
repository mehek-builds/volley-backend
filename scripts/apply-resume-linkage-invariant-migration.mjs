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
 * is a precondition of the constraint rather than a nicety beside it. This script asserts zero
 * violations between the two and refuses to continue if any remain.
 *
 * Idempotent. Re-running it repairs nothing (there is nothing left to repair) and re-installs the
 * same constraint definition.
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
  try {
    await client.query("set lock_timeout = '2min'");
    await client.query("set statement_timeout = '5min'");
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1, $2)', MIGRATION_LOCK);
    await assertPrerequisiteTables(client);

    /* REPAIR ONE: the document is real, so the row was always attached and only said otherwise.
     * resume_attached_at takes the row's own updated_at rather than now(), because that is when
     * the write that bound the pointer happened; stamping today would date every one of these to
     * the migration and lose the only evidence of when the resume was actually attached. */
    const promoted = await client.query(`
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
    const linkStamps = await client.query(`
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
    const cleared = await client.query(`
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
    const baseResumePointers = await client.query(`
      update applications a set selected_resume_artifact_id = null
      where a.resume_attached = true
        and a.resume_source = 'base_resume'
        and a.selected_resume_artifact_id is not null
      returning a.id
    `);

    /* Written out rather than derived from CONSTRAINT_DEFINITION by string substitution: this is
     * the assertion that decides whether the ALTER TABLE below can succeed, and a clever rewrite
     * that silently matched the wrong identifier would turn it into a check of nothing. */
    const violations = await client.query(`
      select count(*)::int as count from applications
      where not (
        (resume_attached = false and resume_source = 'none' and selected_resume_artifact_id is null)
        or (resume_attached = true and resume_source = 'artifact' and selected_resume_artifact_id is not null)
        or (resume_attached = true and resume_source = 'base_resume' and selected_resume_artifact_id is null)
      )
    `);
    if (violations.rows[0].count !== 0) {
      throw new Error(
        `${violations.rows[0].count} application row(s) still violate the resume linkage invariant after repair; `
        + 'refusing to install a constraint that would fail. Investigate before retrying.',
      );
    }

    if (!dryRun) {
      await client.query(`alter table applications drop constraint if exists ${CONSTRAINT}`);
      await client.query(`alter table applications add constraint ${CONSTRAINT} check (${CONSTRAINT_DEFINITION})`);
    }

    await client.query(dryRun ? 'rollback' : 'commit');
    console.log(JSON.stringify({
      event: dryRun ? 'resume_linkage_invariant_dry_run' : 'resume_linkage_invariant_applied',
      schemaVersion: SCHEMA_VERSION,
      dryRun,
      promoted: promoted.rowCount,
      linkStampsCompleted: linkStamps.rowCount,
      cleared: cleared.rowCount,
      baseResumePointersCleared: baseResumePointers.rowCount,
      // Ids only on a dry run, so the applied line stays the same shape it always was and carries
      // nothing per-row into the logs.
      ...(dryRun ? {
        promotedApplicationIds: promoted.rows.map((row) => row.id),
        clearedApplicationIds: cleared.rows.map((row) => row.id),
        baseResumePointerApplicationIds: baseResumePointers.rows.map((row) => row.id),
      } : {}),
    }));
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
