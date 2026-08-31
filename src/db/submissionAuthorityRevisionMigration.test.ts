import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import {
  bumpSubmissionAuthorityRevision,
  readSubmissionAuthorityRevision,
  submissionAuthorityRevisionReadiness,
  type SubmissionAuthorityRevisionExecutor,
} from '../lib/submissionAuthorityRevision';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const USER_C = '33333333-3333-4333-8333-333333333333';
const USER_D = '44444444-4444-4444-8444-444444444444';
const PACKET_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const APPLICATION_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const ARTIFACT_A = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const VERSION_A = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';

function runMigration(databaseUrl: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/apply-submission-authority-revision-schema.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Migration exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function revision(database: PGlite, userId: string): Promise<bigint | null> {
  const result = await database.query<{ revision: string }>(`
    select revision::text as revision
    from submission_authority_revisions
    where user_id = $1
  `, [userId]);
  return result.rows[0] ? BigInt(result.rows[0].revision) : null;
}

async function assertNextRevision(
  database: PGlite,
  userId: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  const before = await revision(database, userId);
  assert.notEqual(before, null);
  await operation();
  assert.equal(await revision(database, userId), before! + 1n);
}

async function assertNextRevisions(
  database: PGlite,
  userIds: readonly string[],
  operation: () => Promise<unknown>,
): Promise<void> {
  const before = new Map(await Promise.all(userIds.map(async (userId) => [
    userId,
    await revision(database, userId),
  ] as const)));
  await operation();
  for (const userId of userIds) {
    assert.equal(await revision(database, userId), before.get(userId)! + 1n);
  }
}

async function minimalAuthoritySchema(database: PGlite): Promise<void> {
  await database.exec(`
    create table users (id uuid primary key);
    create table generated_resumes (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      payload text
    );
    create table applications (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      payload text
    );
    create table artifacts (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      payload text
    );
    create table artifact_versions (
      id uuid primary key,
      artifact_id uuid not null references artifacts(id) on delete cascade,
      payload text
    );
    create table application_artifacts (
      application_id uuid not null references applications(id) on delete cascade,
      artifact_id uuid not null references artifacts(id) on delete cascade,
      payload text,
      primary key (application_id, artifact_id)
    );
    create table application_submission_attempt_events (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      payload text
    );
    create table application_submission_events (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      payload text
    );
    create table application_email_aliases (
      alias text primary key,
      user_id uuid not null references users(id) on delete cascade,
      payload text
    );
    insert into users (id) values
      ('${USER_A}'), ('${USER_B}');
  `);
}

test('submission authority revision migration is atomic, owner-safe, and idempotent', { timeout: 30_000 }, async () => {
  const socketDir = mkdtempSync(join(tmpdir(), 'submission-authority-revision-'));
  const database = await PGlite.create();
  let server: PGLiteSocketServer | null = null;
  const clients: pg.Client[] = [];
  try {
    await minimalAuthoritySchema(database);
    server = new PGLiteSocketServer({
      db: database,
      path: join(socketDir, '.s.PGSQL.5432'),
      maxConnections: 8,
    });
    await server.start();
    const databaseUrl = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
    const helperClient = new pg.Client({ connectionString: databaseUrl });
    clients.push(helperClient);
    await helperClient.connect();
    const helperDb = drizzle(helperClient);

    const first = await runMigration(databaseUrl);
    assert.match(first.stdout, /submission-authority-v1/);
    assert.deepEqual(
      await submissionAuthorityRevisionReadiness(
        helperDb as unknown as SubmissionAuthorityRevisionExecutor,
        5_000,
      ),
      { ready: true, reason: 'schema_ready' },
    );
    assert.equal(await revision(database, USER_A), 0n);
    assert.equal(await revision(database, USER_B), 0n);

    const second = await runMigration(databaseUrl);
    assert.match(second.stdout, /submission-authority-v1/);
    assert.equal(await revision(database, USER_A), 0n, 'an idempotent rerun does not invent a write');

    await assertNextRevision(database, USER_A, () => database.exec(`
      insert into generated_resumes (id, user_id, payload)
      values ('${PACKET_A}', '${USER_A}', 'packet');
    `));
    await assertNextRevision(database, USER_A, () => database.exec(`
      update generated_resumes set payload = 'packet-updated' where id = '${PACKET_A}';
    `));
    await assertNextRevision(database, USER_A, () => database.exec(`
      insert into applications (id, user_id, payload)
      values ('${APPLICATION_A}', '${USER_A}', 'canonical');
    `));
    await assertNextRevision(database, USER_A, () => database.exec(`
      insert into artifacts (id, user_id, payload)
      values ('${ARTIFACT_A}', '${USER_A}', 'artifact');
    `));
    await assertNextRevision(database, USER_A, () => database.exec(`
      insert into artifact_versions (id, artifact_id, payload)
      values ('${VERSION_A}', '${ARTIFACT_A}', 'version');
    `));
    await assertNextRevision(database, USER_A, () => database.exec(`
      insert into application_artifacts (application_id, artifact_id, payload)
      values ('${APPLICATION_A}', '${ARTIFACT_A}', 'link');
    `));
    await assertNextRevision(database, USER_A, () => database.exec(`
      insert into application_submission_attempt_events (id, user_id, payload)
      values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', '${USER_A}', 'attempt');
    `));
    await assertNextRevision(database, USER_A, () => database.exec(`
      insert into application_submission_events (id, user_id, payload)
      values ('ffffffff-ffff-4fff-8fff-fffffffffff1', '${USER_A}', 'receipt');
    `));
    await assertNextRevision(database, USER_A, () => database.exec(`
      insert into application_email_aliases (alias, user_id, payload)
      values ('app-a@example.test', '${USER_A}', 'alias');
    `));
    for (const update of [
      `update applications set payload = 'canonical-updated' where id = '${APPLICATION_A}'`,
      `update artifacts set payload = 'artifact-updated' where id = '${ARTIFACT_A}'`,
      `update artifact_versions set payload = 'version-updated' where id = '${VERSION_A}'`,
      `update application_artifacts set payload = 'link-updated'
        where application_id = '${APPLICATION_A}' and artifact_id = '${ARTIFACT_A}'`,
      `update application_submission_attempt_events set payload = 'attempt-updated'
        where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'`,
      `update application_submission_events set payload = 'receipt-updated'
        where id = 'ffffffff-ffff-4fff-8fff-fffffffffff1'`,
      `update application_email_aliases set payload = 'alias-updated'
        where alias = 'app-a@example.test'`,
    ]) {
      await assertNextRevision(database, USER_A, () => database.exec(update));
    }

    const beforeNoop = await revision(database, USER_A);
    await database.exec(`
      insert into application_email_aliases (alias, user_id, payload)
      values ('app-a@example.test', '${USER_A}', 'ignored')
      on conflict (alias) do nothing;
    `);
    assert.equal(await revision(database, USER_A), beforeNoop, 'a conflict with no row write does not bump');

    const beforeRollback = await revision(database, USER_A);
    await database.exec('begin');
    await database.exec(`update generated_resumes set payload = 'rolled-back' where id = '${PACKET_A}'`);
    assert.equal(await revision(database, USER_A), beforeRollback! + 1n);
    await database.exec('rollback');
    assert.equal(await revision(database, USER_A), beforeRollback, 'rollback removes the row and revision write');

    const artifactB = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
    await database.exec(`
      insert into artifacts (id, user_id, payload)
      values ('${artifactB}', '${USER_B}', 'foreign-artifact');
    `);
    const beforeCrossA = await revision(database, USER_A);
    const beforeCrossB = await revision(database, USER_B);
    await assert.rejects(
      database.exec(`
        insert into application_artifacts (application_id, artifact_id, payload)
        values ('${APPLICATION_A}', '${artifactB}', 'cross-owner');
      `),
      /application artifact ownership mismatch/i,
    );
    assert.equal(await revision(database, USER_A), beforeCrossA);
    assert.equal(await revision(database, USER_B), beforeCrossB);

    const applicationB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
    await assertNextRevision(database, USER_B, () => database.exec(`
      insert into applications (id, user_id, payload)
      values ('${applicationB}', '${USER_B}', 'foreign-canonical')
    `));
    await assertNextRevisions(database, [USER_A, USER_B], () => database.exec(`
      update application_artifacts
      set application_id = '${applicationB}', artifact_id = '${artifactB}'
      where application_id = '${APPLICATION_A}' and artifact_id = '${ARTIFACT_A}'
    `));
    await assertNextRevisions(database, [USER_A, USER_B], () => database.exec(`
      update artifact_versions set artifact_id = '${artifactB}' where id = '${VERSION_A}'
    `));

    const moveBeforeA = (await revision(database, USER_A))!;
    const moveBeforeB = (await revision(database, USER_B))!;
    await database.exec('begin');
    await database.query(
      'update generated_resumes set user_id = $1 where id = $2',
      [USER_B, PACKET_A],
    );
    const heldBeforeParityCheck = await database.query<{ count: number }>(`
      select count(*)::integer as count
      from pg_locks
      where locktype = 'advisory'
        and mode = 'ExclusiveLock'
        and granted
    `);
    assert.equal(Number(heldBeforeParityCheck.rows[0]?.count), 2, 'the owner move locks old and new users');
    for (const userId of [USER_A, USER_B]) {
      await database.query(`
        select pg_advisory_xact_lock(
          hashtextextended('submission-attempt:' || $1::uuid::text, 0::bigint)
        )
      `, [userId]);
    }
    const heldAfterParityCheck = await database.query<{ count: number }>(`
      select count(*)::integer as count
      from pg_locks
      where locktype = 'advisory'
        and mode = 'ExclusiveLock'
        and granted
    `);
    assert.equal(
      Number(heldAfterParityCheck.rows[0]?.count),
      2,
      'the trigger keys are exactly the existing submission-attempt advisory keys',
    );
    await database.exec('commit');
    assert.equal(await revision(database, USER_A), moveBeforeA + 1n);
    assert.equal(await revision(database, USER_B), moveBeforeB + 1n);

    for (const deletion of [
      `delete from application_submission_attempt_events
        where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'`,
      `delete from application_submission_events
        where id = 'ffffffff-ffff-4fff-8fff-fffffffffff1'`,
      `delete from application_email_aliases where alias = 'app-a@example.test'`,
      `delete from applications where id = '${APPLICATION_A}'`,
      `delete from artifacts where id = '${ARTIFACT_A}'`,
    ]) {
      await assertNextRevision(database, USER_A, () => database.exec(deletion));
    }
    for (const deletion of [
      `delete from application_artifacts
        where application_id = '${applicationB}' and artifact_id = '${artifactB}'`,
      `delete from artifact_versions where id = '${VERSION_A}'`,
      `delete from applications where id = '${applicationB}'`,
    ]) {
      await assertNextRevision(database, USER_B, () => database.exec(deletion));
    }
    await assertNextRevision(database, USER_B, () => database.exec(`
      delete from generated_resumes where id = '${PACKET_A}'
    `));
    await assertNextRevision(database, USER_B, () => database.exec(`
      delete from artifacts where id = '${artifactB}'
    `));

    await database.exec(`
      insert into users (id) values ('${USER_C}');
      insert into generated_resumes (id, user_id, payload)
      values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '${USER_C}', 'cascade-packet');
      insert into applications (id, user_id, payload)
      values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', '${USER_C}', 'cascade-app');
      insert into artifacts (id, user_id, payload)
      values ('cccccccc-cccc-4ccc-8ccc-ccccccccccc3', '${USER_C}', 'cascade-artifact');
      insert into artifact_versions (id, artifact_id, payload)
      values (
        'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
        'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
        'cascade-version'
      );
      insert into application_artifacts (application_id, artifact_id, payload)
      values (
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
        'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
        'cascade-link'
      );
      insert into application_email_aliases (alias, user_id, payload)
      values ('cascade@example.test', '${USER_C}', 'cascade-alias');
    `);
    assert.notEqual(await revision(database, USER_C), null);
    await database.exec(`delete from users where id = '${USER_C}'`);
    assert.equal(await revision(database, USER_C), null, 'account deletion cascades without recreating revision state');

    await database.exec(`
      alter table submission_authority_revisions
        drop constraint submission_authority_revisions_nonnegative_check;
      alter table submission_authority_revisions
        add constraint submission_authority_revisions_nonnegative_check check (revision >= -1);
      create or replace function bump_submission_authority_revision(p_user_id uuid)
      returns bigint language sql as $wrong$ select 7::bigint $wrong$;
      drop trigger aa_submission_authority_revision_lock on application_email_aliases;
      create trigger aa_submission_authority_revision_lock
      before insert on application_email_aliases
      for each row execute function submission_authority_revision_row_trigger('direct', 'bump');
    `);
    assert.deepEqual(
      await submissionAuthorityRevisionReadiness(
        helperDb as unknown as SubmissionAuthorityRevisionExecutor,
        5_000,
      ),
      { ready: false, reason: 'catalog_incomplete' },
    );
    await runMigration(databaseUrl);
    assert.deepEqual(
      await submissionAuthorityRevisionReadiness(
        helperDb as unknown as SubmissionAuthorityRevisionExecutor,
        5_000,
      ),
      { ready: true, reason: 'schema_ready' },
    );
    const repairedConstraint = await database.query<{ definition: string }>(`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'submission_authority_revisions'::regclass
        and conname = 'submission_authority_revisions_nonnegative_check'
    `);
    assert.match(repairedConstraint.rows[0]!.definition, /revision >= 0/);
    const repairedFunction = await database.query<{ definition: string }>(`
      select pg_get_functiondef(oid) as definition
      from pg_proc
      where proname = 'bump_submission_authority_revision'
        and pronamespace = current_schema()::regnamespace
    `);
    assert.match(repairedFunction.rows[0]!.definition, /revision \+ 1/);

    await database.exec(`insert into users (id) values ('${USER_D}')`);
    const initial = await helperDb.transaction((tx) => readSubmissionAuthorityRevision(
      USER_D,
      tx as unknown as SubmissionAuthorityRevisionExecutor,
    ));
    assert.equal(initial, '0');
    await database.exec(`
      update submission_authority_revisions
      set revision = 9007199254740993
      where user_id = '${USER_D}'
    `);
    const exact = await helperDb.transaction((tx) => readSubmissionAuthorityRevision(
      USER_D,
      tx as unknown as SubmissionAuthorityRevisionExecutor,
    ));
    assert.equal(exact, '9007199254740993');
    const bumped = await helperDb.transaction((tx) => bumpSubmissionAuthorityRevision(
      USER_D,
      tx as unknown as SubmissionAuthorityRevisionExecutor,
    ));
    assert.equal(bumped, '9007199254740994');
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => undefined);
    if (server) await server.stop().catch(() => undefined);
    await database.close().catch(() => undefined);
    rmSync(socketDir, { recursive: true, force: true });
  }
});

test('package catalog exposes the additive migration without production side effects', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts?.['db:submission-authority-revision'],
    'node scripts/apply-submission-authority-revision-schema.mjs',
  );
  assert.equal(
    packageJson.scripts?.['test:submission-authority-revision-migration'],
    'node --import tsx --test src/db/submissionAuthorityRevisionMigration.test.ts',
  );
});
