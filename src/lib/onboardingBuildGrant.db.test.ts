import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../db/schema';

/* THE FREE TAILORED BUILDS (two per account since 2026-09-01), and what must stay true about them.
 *
 * A DATABASE TEST BECAUSE THE RULE IS A WHERE CLAUSE. Both conditions - not already spent, and the
 * account is still in setup - live in the WHERE of a conditional UPDATE precisely so there is no
 * window between checking and taking. A unit test with a mocked db would assert the shape of a
 * query and prove nothing about the thing the query exists to guarantee, which is that two
 * concurrent builds cannot both take the same grant.
 */

const JWT_SECRET = 'onboarding-build-grant-db-test-secret';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-build-grant-'));
const savedEnv = { ...process.env };
const STUDENT = '7c2e5a10-9b31-4f6d-8a02-5d4413ee7791';

let database: PGlite;
let server: PGLiteSocketServer;
let backendPool: { end(): Promise<void> };
let claimOnboardingBuildGrant: (userId: string) => Promise<boolean>;
let releaseOnboardingBuildGrant: (userId: string) => Promise<void>;

before(async () => {
  database = await PGlite.create();
  const initial = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of initial) await database.exec(statement);
  server = new PGLiteSocketServer({ db: database, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();

  process.env.VERCEL = '1';
  process.env.LOG_LEVEL = 'silent';
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  process.env.JWT_SIGNING_SECRET = JWT_SECRET;
  process.env.ENCRYPTION_KEY = 'onboarding-build-grant-db-test-encryption-key';

  ({ pool: backendPool } = await import('../db'));
  ({ claimOnboardingBuildGrant, releaseOnboardingBuildGrant } = await import('./onboardingBuildGrant'));
});

after(async () => {
  await backendPool?.end();
  await server?.stop();
  await database.close();
  rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

beforeEach(async () => {
  await database.exec(`delete from "users"`);
});

async function seed({ completed }: { completed: boolean }) {
  await database.exec(`
    insert into "users" ("id", "email", "email_verified", "is_guest"${completed ? ', "onboarding_completed_at"' : ''})
    values ('${STUDENT}', 'candidate@example.edu', true, false${completed ? ", now()" : ''})
  `);
}

const stampOf = async () => {
  const rows = await database.query<{ onboarding_build_granted_at: string | null }>(
    `select "onboarding_build_granted_at" from "users" where "id" = '${STUDENT}'`,
  );
  return rows.rows[0]?.onboarding_build_granted_at ?? null;
};

test('a student still in setup gets two, and never a third', async () => {
  await seed({ completed: false });

  assert.equal(await claimOnboardingBuildGrant(STUDENT), true, 'the first build was refused the grant');
  assert.ok(await stampOf(), 'the grant was allowed without being recorded');

  /* The second is the point of the 2026-09-01 change: a student who goes back and uploads a
     better resume gets the rebuild free instead of hitting the paywall three screens in. */
  assert.equal(await claimOnboardingBuildGrant(STUDENT), true, 'the rebuild was refused the grant');

  // And a third is an ordinary paid request: the grant funds seeing it work, not a free tier.
  assert.equal(await claimOnboardingBuildGrant(STUDENT), false, 'the grant was handed out a third time');
});

test('concurrent builds cannot take more than the limit between them', async () => {
  await seed({ completed: false });

  /* The race the WHERE clause exists for. A read-then-write would let all three see claims left
     and all three proceed, which is three free generations for an account entitled to two. The
     conditional UPDATE serializes on the row, so exactly two of these can win. */
  const outcomes = await Promise.all([
    claimOnboardingBuildGrant(STUDENT),
    claimOnboardingBuildGrant(STUDENT),
    claimOnboardingBuildGrant(STUDENT),
  ]);

  assert.equal(outcomes.filter(Boolean).length, 2, `the concurrent claims took ${outcomes.filter(Boolean).length} grants: ${outcomes.join(' ')}`);
});

test('a finished account is refused, because the grant is for setup and not a free tier', async () => {
  await seed({ completed: true });

  assert.equal(await claimOnboardingBuildGrant(STUDENT), false, 'a completed account was handed a free build');
  assert.equal(await stampOf(), null, 'a refused claim still wrote a stamp');
});

test('a build that produced nothing gives the grant back', async () => {
  await seed({ completed: false });
  assert.equal(await claimOnboardingBuildGrant(STUDENT), true);

  await releaseOnboardingBuildGrant(STUDENT);
  assert.equal(await stampOf(), null, 'the stamp survived the release');

  // And it is genuinely usable again, which is the point of releasing rather than just clearing.
  assert.equal(await claimOnboardingBuildGrant(STUDENT), true, 'the released grant could not be reclaimed');
});

test('releasing one of two claims keeps the stamp, because a free build is still outstanding', async () => {
  await seed({ completed: false });
  assert.equal(await claimOnboardingBuildGrant(STUDENT), true);
  assert.equal(await claimOnboardingBuildGrant(STUDENT), true);

  await releaseOnboardingBuildGrant(STUDENT);

  /* One claim remains spent, so the stamp must survive: it reads "when was a free build last
     outstanding", and one still is. Clearing it here would make the old column lie to whatever
     reads it next. */
  assert.ok(await stampOf(), 'releasing the second claim erased the record of the first');

  // And the released claim is genuinely usable again.
  assert.equal(await claimOnboardingBuildGrant(STUDENT), true, 'the released claim could not be retaken');
  assert.equal(await claimOnboardingBuildGrant(STUDENT), false, 'the limit stopped holding after a release');
});

test('the release cannot refund a build an account already finished setup on', async () => {
  await seed({ completed: false });
  await claimOnboardingBuildGrant(STUDENT);
  await database.exec(`update "users" set "onboarding_completed_at" = now() where "id" = '${STUDENT}'`);

  await releaseOnboardingBuildGrant(STUDENT);

  assert.ok(await stampOf(), 'a finished account had its spent grant refunded');
});
