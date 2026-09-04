import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

/* THE SIX BOARDS THAT SAID THEY HAD NO RESUME WHILE HOLDING ONE.
 *
 * Measured 2026-09-03 across the ten boards Mehek was applying to. Six were stored with a real,
 * owned, resume-kind artifact in selected_resume_artifact_id and (resume_attached false,
 * resume_source 'none') beside it: DSI Innovations, Blueprint Hires, Prediktive, xolife,
 * Confluence Technologies and TixTrack. Each had a PASSED packet audit binding an exact PDF.
 *
 * A forward-only code fix leaves all six stuck, so this migration repairs them and only then
 * tightens the constraint. The order is not a preference: with the broken rows present the ALTER
 * TABLE fails outright.
 *
 * These tests run the SHIPPED script against a real PostgreSQL and assert on the rows it leaves
 * behind and on what the database will accept afterwards. Nothing matches on script source text.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const LIVE_ARTIFACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const DELETED_ARTIFACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const COVER_LETTER_ARTIFACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const FOREIGN_ARTIFACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';

const DSI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const DELETED_DOC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const NOT_A_RESUME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
const SOMEONE_ELSES = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4';
const ALREADY_ATTACHED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5';
const BASE_RESUME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6';
const GENUINELY_DETACHED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7';
const BASE_RESUME_WITH_POINTER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8';

const ATTACHED_LONG_AGO = '2026-08-01T09:00:00.000Z';
const ROW_LAST_TOUCHED = '2026-08-20T09:00:00.000Z';

/* The schema as it stood BEFORE this migration, including the loose constraint whose first arm let
 * the broken shape through. Building it this way is what makes the test able to insert the rows the
 * repair exists for; against the tightened schema they are unstorable, which is the point. */
const SCHEMA_BEFORE = `
  create table users (id uuid primary key);
  create table artifacts (
    id uuid primary key,
    user_id uuid not null references users(id) on delete cascade,
    kind text not null,
    deleted_at timestamptz
  );
  create table applications (
    id uuid primary key,
    user_id uuid not null references users(id) on delete cascade,
    selected_resume_artifact_id uuid references artifacts(id),
    resume_attached boolean not null default false,
    resume_source text not null default 'none',
    resume_attached_at timestamptz,
    updated_at timestamptz not null default now(),
    constraint applications_resume_attachment_state_check check (
      (resume_attached = false and resume_source = 'none')
      or (resume_attached = true and resume_source = 'artifact' and selected_resume_artifact_id is not null)
      or (resume_attached = true and resume_source = 'base_resume')
    )
  );
  create table application_artifacts (
    application_id uuid not null references applications(id) on delete cascade,
    artifact_id uuid not null references artifacts(id) on delete cascade,
    purpose text not null,
    attached_at timestamptz,
    primary key (application_id, artifact_id, purpose)
  );
  insert into users (id) values ('${USER}'), ('${OTHER_USER}');
  insert into artifacts (id, user_id, kind, deleted_at) values
    ('${LIVE_ARTIFACT}', '${USER}', 'tailored_resume', null),
    ('${DELETED_ARTIFACT}', '${USER}', 'tailored_resume', now()),
    ('${COVER_LETTER_ARTIFACT}', '${USER}', 'cover_letter', null),
    ('${FOREIGN_ARTIFACT}', '${OTHER_USER}', 'resume', null);
  insert into applications (id, user_id, selected_resume_artifact_id, resume_attached, resume_source, resume_attached_at, updated_at) values
    ('${DSI}', '${USER}', '${LIVE_ARTIFACT}', false, 'none', null, '${ROW_LAST_TOUCHED}'),
    ('${DELETED_DOC}', '${USER}', '${DELETED_ARTIFACT}', false, 'none', null, '${ROW_LAST_TOUCHED}'),
    ('${NOT_A_RESUME}', '${USER}', '${COVER_LETTER_ARTIFACT}', false, 'none', null, '${ROW_LAST_TOUCHED}'),
    ('${SOMEONE_ELSES}', '${USER}', '${FOREIGN_ARTIFACT}', false, 'none', null, '${ROW_LAST_TOUCHED}'),
    ('${ALREADY_ATTACHED}', '${USER}', '${LIVE_ARTIFACT}', true, 'artifact', '${ATTACHED_LONG_AGO}', '${ROW_LAST_TOUCHED}'),
    ('${BASE_RESUME}', '${USER}', null, true, 'base_resume', '${ATTACHED_LONG_AGO}', '${ROW_LAST_TOUCHED}'),
    ('${GENUINELY_DETACHED}', '${USER}', null, false, 'none', null, '${ROW_LAST_TOUCHED}'),
    ('${BASE_RESUME_WITH_POINTER}', '${USER}', '${LIVE_ARTIFACT}', true, 'base_resume', '${ATTACHED_LONG_AGO}', '${ROW_LAST_TOUCHED}');
  insert into application_artifacts (application_id, artifact_id, purpose, attached_at) values
    ('${DSI}', '${LIVE_ARTIFACT}', 'resume', null),
    ('${ALREADY_ATTACHED}', '${LIVE_ARTIFACT}', 'resume', '${ATTACHED_LONG_AGO}');
`;

function runMigration(databaseUrl: string, args: string[] = []): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/apply-resume-linkage-invariant-migration.mjs', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

type Row = {
  id: string;
  selected_resume_artifact_id: string | null;
  resume_attached: boolean;
  resume_source: string;
  resume_attached_at: string | null;
};

async function rows(database: PGlite): Promise<Map<string, Row>> {
  const result = await database.query<Row>(`
    select id, selected_resume_artifact_id, resume_attached, resume_source,
           to_char(resume_attached_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as resume_attached_at
    from applications
  `);
  return new Map(result.rows.map((row) => [row.id, row]));
}

test('the migration repairs every broken linkage shape and then makes it unstorable', { timeout: 60_000 }, async () => {
  const socketDir = mkdtempSync(join(tmpdir(), 'resume-linkage-invariant-'));
  const database = await PGlite.create();
  let server: PGLiteSocketServer | null = null;
  try {
    await database.exec(SCHEMA_BEFORE);
    server = new PGLiteSocketServer({
      db: database,
      path: join(socketDir, '.s.PGSQL.5432'),
      maxConnections: 8,
    });
    await server.start();
    const databaseUrl = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

    /* THE DRY RUN FIRST, because which bucket a row falls into is the operator's decision to see
     * before it is taken. A pointer whose document has been deleted is CLEARED rather than
     * promoted, and an operator expecting an attachment should learn that beforehand. */
    const preview = await runMigration(databaseUrl, ['--dry-run']);
    assert.equal(preview.code, 0, preview.stderr || preview.stdout);
    const previewReport = JSON.parse(preview.stdout.trim().split('\n').pop()!);
    assert.equal(previewReport.event, 'resume_linkage_invariant_dry_run');
    assert.deepEqual(previewReport.promotedApplicationIds, [DSI]);
    assert.deepEqual(previewReport.clearedApplicationIds.sort(), [DELETED_DOC, NOT_A_RESUME, SOMEONE_ELSES].sort());
    assert.deepEqual(previewReport.baseResumePointerApplicationIds, [BASE_RESUME_WITH_POINTER]);
    // Nothing left unaccounted for, so a real run would go on to install the constraint.
    assert.equal(previewReport.remainingViolations, 0);
    assert.equal(previewReport.constraintTightened, true);
    // And it changed nothing: the row it named is still broken.
    assert.equal((await rows(database)).get(DSI)!.resume_attached, false);

    const first = await runMigration(databaseUrl);
    assert.equal(first.code, 0, first.stderr || first.stdout);
    const report = JSON.parse(first.stdout.trim().split('\n').pop()!);
    assert.equal(report.event, 'resume_linkage_invariant_applied');
    // One promoted (the live artifact), three cleared (deleted, wrong kind, another user's), one
    // base-resume pointer dropped.
    assert.equal(report.promoted, 1);
    assert.equal(report.cleared, 3);
    assert.equal(report.baseResumePointersCleared, 1);
    assert.equal(report.linkStampsCompleted, 1);
    // Every row was accounted for, so the constraint actually went on this time.
    assert.equal(report.remainingViolations, 0);
    assert.equal(report.constraintTightened, true);
    assert.equal(report.constraintSkippedReason, undefined);

    /* THE LINK STAMP IS PART OF THE SAME ATTACHMENT. application_artifacts.attached_at is read by
     * the authoritative submission projection, which refuses an exact link whose stamp is null, and
     * the only thing that ever completed it was submissionConfirmationRepair's pre-ledger block,
     * which fires on the shape repair one has just removed. Completing it here is what stops this
     * migration trading one incomplete record for another. */
    const links = await database.query<{ application_id: string; attached_at: string | null }>(`
      select application_id,
             to_char(attached_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as attached_at
      from application_artifacts order by application_id
    `);
    assert.deepEqual(links.rows, [
      { application_id: DSI, attached_at: ROW_LAST_TOUCHED },
      { application_id: ALREADY_ATTACHED, attached_at: ATTACHED_LONG_AGO },
    ]);

    const after = await rows(database);

    /* THE DSI SHAPE. The document is real, owned and a resume kind, so the row was always attached
     * and only ever said otherwise. It keeps its pointer and gains the pair. */
    assert.deepEqual(after.get(DSI), {
      id: DSI,
      selected_resume_artifact_id: LIVE_ARTIFACT,
      resume_attached: true,
      resume_source: 'artifact',
      // Its own updated_at, not the migration's clock: that is when the write that bound the
      // pointer happened, and stamping today would lose the only evidence of when it attached.
      resume_attached_at: ROW_LAST_TOUCHED,
    });

    /* A POINTER THAT NAMES NOTHING SENDABLE is cleared rather than asserted. All three failures of
     * the live-document test, which is the same test the fill route applies before it will accept
     * an artifact id at all. */
    for (const id of [DELETED_DOC, NOT_A_RESUME, SOMEONE_ELSES]) {
      assert.deepEqual(after.get(id), {
        id,
        selected_resume_artifact_id: null,
        resume_attached: false,
        resume_source: 'none',
        resume_attached_at: null,
      }, id);
    }

    // A row that was already right is not touched, and above all its attach time is not rewritten.
    assert.deepEqual(after.get(ALREADY_ATTACHED), {
      id: ALREADY_ATTACHED,
      selected_resume_artifact_id: LIVE_ARTIFACT,
      resume_attached: true,
      resume_source: 'artifact',
      resume_attached_at: ATTACHED_LONG_AGO,
    });
    assert.deepEqual(after.get(BASE_RESUME), {
      id: BASE_RESUME,
      selected_resume_artifact_id: null,
      resume_attached: true,
      resume_source: 'base_resume',
      resume_attached_at: ATTACHED_LONG_AGO,
    });
    assert.deepEqual(after.get(GENUINELY_DETACHED), {
      id: GENUINELY_DETACHED,
      selected_resume_artifact_id: null,
      resume_attached: false,
      resume_source: 'none',
      resume_attached_at: null,
    });

    // The main resume is not a document row, so the pointer beside it goes; the attachment stays.
    assert.deepEqual(after.get(BASE_RESUME_WITH_POINTER), {
      id: BASE_RESUME_WITH_POINTER,
      selected_resume_artifact_id: null,
      resume_attached: true,
      resume_source: 'base_resume',
      resume_attached_at: ATTACHED_LONG_AGO,
    });

    /* AND THE SHAPE IS NOW UNSTORABLE. This is the half a code fix cannot give: whatever writes to
     * this table next, from this repository or any other, the database refuses it. */
    await assert.rejects(
      database.exec(`
        insert into applications (id, user_id, selected_resume_artifact_id, resume_attached, resume_source)
        values ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', '${USER}', '${LIVE_ARTIFACT}', false, 'none')
      `),
      /applications_resume_attachment_state_check/,
      'a pointer beside "no resume attached" must be refused by the database',
    );
    await assert.rejects(
      database.exec(`
        update applications set resume_attached = false, resume_source = 'none' where id = '${DSI}'
      `),
      /applications_resume_attachment_state_check/,
      'detaching without clearing the pointer must be refused too',
    );
    await assert.rejects(
      database.exec(`
        insert into applications (id, user_id, selected_resume_artifact_id, resume_attached, resume_source)
        values ('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', '${USER}', '${LIVE_ARTIFACT}', true, 'base_resume')
      `),
      /applications_resume_attachment_state_check/,
      'the main resume never names a document row',
    );

    // The three legitimate shapes are all still storable.
    await database.exec(`
      insert into applications (id, user_id, selected_resume_artifact_id, resume_attached, resume_source, resume_attached_at) values
        ('cccccccc-cccc-4ccc-8ccc-ccccccccccc3', '${USER}', '${LIVE_ARTIFACT}', true, 'artifact', now()),
        ('cccccccc-cccc-4ccc-8ccc-ccccccccccc4', '${USER}', null, true, 'base_resume', now()),
        ('cccccccc-cccc-4ccc-8ccc-ccccccccccc5', '${USER}', null, false, 'none', null)
    `);

    // Idempotent: a second run repairs nothing and installs the same constraint.
    const second = await runMigration(databaseUrl);
    assert.equal(second.code, 0, second.stderr || second.stdout);
    const secondReport = JSON.parse(second.stdout.trim().split('\n').pop()!);
    assert.deepEqual(
      {
        promoted: secondReport.promoted,
        cleared: secondReport.cleared,
        baseResumePointersCleared: secondReport.baseResumePointersCleared,
        linkStampsCompleted: secondReport.linkStampsCompleted,
        remainingViolations: secondReport.remainingViolations,
        constraintTightened: secondReport.constraintTightened,
      },
      {
        promoted: 0, cleared: 0, baseResumePointersCleared: 0, linkStampsCompleted: 0,
        remainingViolations: 0, constraintTightened: true,
      },
    );
  } finally {
    await server?.stop();
    await database.close();
    rmSync(socketDir, { recursive: true, force: true });
  }
});

/* THE SHARED FIXTURE FOR BOTH TESTS BELOW: everything SCHEMA_BEFORE already seeds, plus one row no
 * repair rule targets. resume_attached true with source 'none' is a shape the PRE-migration
 * constraint also forbade, so it can only have arrived from outside this schema; it is what "a row
 * this script did not anticipate" looks like in a test. The constraint is loosened to `check (true)`
 * only so the fixture can be inserted at all, exactly as the schema-drift test above does. */
async function seedUnrepairableViolation(database: PGlite): Promise<void> {
  await database.exec(SCHEMA_BEFORE.replace(/constraint applications_resume_attachment_state_check check \([\s\S]*?\n    \)/, 'check (true)'));
  await database.exec(`
    insert into applications (id, user_id, selected_resume_artifact_id, resume_attached, resume_source)
    values ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1', '${USER}', null, true, 'none')
  `);
}

test('a residual violation this script cannot explain does not undo the repairs it already made', { timeout: 60_000 }, async () => {
  /* The migration used to treat ANY leftover violation as a reason to roll back the whole
   * transaction, including rows it had just correctly repaired: one row nobody anticipated, found
   * live and not reasoned about in this script, would hand DSI's row straight back to
   * (false, 'none') and exit non-zero. Repair now commits on its own before the constraint is even
   * attempted, so it survives a row like this one that only the constraint step has to skip. */
  // Short prefix, deliberately: the full path grows a Unix-socket filename below it, and macOS
  // caps sun_path around 104 bytes. See the sibling test's prefix for the one that found this.
  const socketDir = mkdtempSync(join(tmpdir(), 'rli-partial-'));
  const database = await PGlite.create();
  let server: PGLiteSocketServer | null = null;
  try {
    await seedUnrepairableViolation(database);
    server = new PGLiteSocketServer({
      db: database,
      path: join(socketDir, '.s.PGSQL.5432'),
      maxConnections: 8,
    });
    await server.start();
    const databaseUrl = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

    const result = await runMigration(databaseUrl);
    // Not a failure: every row this script knows how to explain was repaired. Nothing watching this
    // exit code should be told otherwise.
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout.trim().split('\n').pop()!);
    assert.equal(report.event, 'resume_linkage_invariant_applied');
    assert.equal(report.remainingViolations, 1);
    assert.equal(report.constraintTightened, false);
    assert.match(report.constraintSkippedReason, /1 application row\(s\) still violate/);

    // THE REPAIRABLE ROW IS REPAIRED, not held hostage by the one row nothing here can explain.
    assert.equal(report.promoted, 1);
    const after = await rows(database);
    assert.deepEqual(after.get(DSI), {
      id: DSI,
      selected_resume_artifact_id: LIVE_ARTIFACT,
      resume_attached: true,
      resume_source: 'artifact',
      resume_attached_at: ROW_LAST_TOUCHED,
    });

    // AND A ROW THAT WAS ALREADY RIGHT stays right and is not touched by any of this.
    assert.deepEqual(after.get(ALREADY_ATTACHED), {
      id: ALREADY_ATTACHED,
      selected_resume_artifact_id: LIVE_ARTIFACT,
      resume_attached: true,
      resume_source: 'artifact',
      resume_attached_at: ATTACHED_LONG_AGO,
    });

    // AND THE CONSTRAINT IS STILL THE OLD, LOOSE ONE, proven behaviourally rather than merely
    // claimed in the JSON summary: a shape the tightened constraint would refuse is still accepted.
    await database.exec(`
      insert into applications (id, user_id, selected_resume_artifact_id, resume_attached, resume_source)
      values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', '${USER}', '${LIVE_ARTIFACT}', false, 'none')
    `);
  } finally {
    await server?.stop();
    await database.close();
    rmSync(socketDir, { recursive: true, force: true });
  }
});

test('the artifact-missing repair still clears and commits when an unrelated row skips the constraint', { timeout: 60_000 }, async () => {
  /* The other repair branch, under the same partial-failure condition. A pointer to a document that
   * is gone is cleared, and that clear is just as durable as a promotion when the constraint has to
   * be left off for a row this script cannot explain. */
  // Measured 2026-09-04: 'resume-linkage-invariant-partial-clear-' plus the socket filename below
  // it overran macOS's ~104-byte sun_path limit and PGLiteSocketServer.start() failed with EINVAL.
  // Short prefix, same reason as the sibling test above.
  const socketDir = mkdtempSync(join(tmpdir(), 'rli-clear-'));
  const database = await PGlite.create();
  let server: PGLiteSocketServer | null = null;
  try {
    await seedUnrepairableViolation(database);
    server = new PGLiteSocketServer({
      db: database,
      path: join(socketDir, '.s.PGSQL.5432'),
      maxConnections: 8,
    });
    await server.start();
    const databaseUrl = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

    const result = await runMigration(databaseUrl);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout.trim().split('\n').pop()!);
    // The three pointers whose document is gone (deleted, wrong kind, another user's) still clear.
    assert.equal(report.cleared, 3);
    assert.equal(report.constraintTightened, false);
    assert.equal(report.remainingViolations, 1);

    const after = await rows(database);
    for (const id of [DELETED_DOC, NOT_A_RESUME, SOMEONE_ELSES]) {
      assert.deepEqual(after.get(id), {
        id,
        selected_resume_artifact_id: null,
        resume_attached: false,
        resume_source: 'none',
        resume_attached_at: null,
      }, id);
    }

    // Re-running is still safe: the unresolved row is reported again, not compounded, and nothing
    // that was already repaired is repaired a second time.
    const second = await runMigration(databaseUrl);
    assert.equal(second.code, 0, second.stderr || second.stdout);
    const secondReport = JSON.parse(second.stdout.trim().split('\n').pop()!);
    assert.equal(secondReport.cleared, 0);
    assert.equal(secondReport.remainingViolations, 1);
    assert.equal(secondReport.constraintTightened, false);
  } finally {
    await server?.stop();
    await database.close();
    rmSync(socketDir, { recursive: true, force: true });
  }
});
