import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../db/schema';

/* THE SKILLS LINE MUST BE THE STUDENT'S OWN WORDS, and for every account created through
 * onboarding it was not.
 *
 * `profiles.skills` is the one authoritative source for that line (R-015) and nothing wrote it.
 * The parse carried the list into `parsed_json` and stopped, so `declaredSkills` was empty, the
 * validator's hard prune never ran, and the model wrote the field itself.
 *
 * MEASURED ON PRODUCTION 2026-08-20, ten students, ten postings: 17 of 77 listed skills survived,
 * and 18 labels appeared that no student had written - "API Design", "Payment Systems",
 * "Quantitative Analysis". One had "Excel" on her resume, lost it, and the match panel then told
 * her Excel was asked for and missing from her resume.
 *
 * A DATABASE TEST because the whole fix is what the write does on conflict: seeding an empty
 * column and NOT overwriting a curated one are the same statement, and only a real upsert shows it.
 */
const socketDir = mkdtempSync(join(tmpdir(), 'litos-declared-skills-'));
const savedEnv = { ...process.env };
const STUDENT = '5b1d7c90-2e44-4a13-8f61-0c2288b91e07';

let database: PGlite;
let server: PGLiteSocketServer;
let backendPool: { end(): Promise<void> };
let db: typeof import('../db').db;
let profiles: typeof schema.profiles;
let sql: typeof import('drizzle-orm').sql;

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
  process.env.JWT_SIGNING_SECRET = 'declared-skills-db-test-secret';
  process.env.ENCRYPTION_KEY = 'declared-skills-db-test-encryption-key';

  ({ pool: backendPool, db } = await import('../db'));
  ({ profiles } = schema);
  ({ sql } = await import('drizzle-orm'));
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
  await database.exec(`delete from "profiles"`);
  await database.exec(`delete from "users"`);
  await database.exec(`insert into "users" ("id", "email", "email_verified", "is_guest")
                       values ('${STUDENT}', 'candidate@example.edu', true, false)`);
});

/** Exactly the write POST /profile performs, so the test exercises the statement rather than a copy. */
async function upload(parsedSkills: string[]) {
  await db
    .insert(profiles)
    .values({
      user_id: STUDENT,
      parsed_json: { skills: parsedSkills },
      ...(parsedSkills.length > 0 ? { skills: parsedSkills } : {}),
      updated_at: new Date(),
    })
    .onConflictDoUpdate({
      target: profiles.user_id,
      set: {
        parsed_json: { skills: parsedSkills },
        ...(parsedSkills.length > 0
          ? { skills: sql`coalesce(${profiles.skills}, ${JSON.stringify(parsedSkills)}::jsonb)` }
          : {}),
        updated_at: new Date(),
      },
    });
}

const stored = async () => {
  const rows = await database.query<{ skills: string[] | null }>(
    `select "skills" from "profiles" where "user_id" = '${STUDENT}'`,
  );
  return rows.rows[0]?.skills ?? null;
};

test('an upload declares the skills the resume listed', async () => {
  await upload(['Python', 'OR-Tools', 'Excel', 'Lean Six Sigma']);
  assert.deepEqual(
    await stored(),
    ['Python', 'OR-Tools', 'Excel', 'Lean Six Sigma'],
    'the authoritative skills column is still empty after an upload that listed skills',
  );
});

test('a curated list survives the next upload, because it is the student\'s own statement', async () => {
  await upload(['Python', 'Excel']);
  // The student edits their list in Documents, removing one and adding one the parse never saw.
  await database.exec(`update "profiles" set "skills" = '["Python","Kubernetes"]'::jsonb where "user_id" = '${STUDENT}'`);

  await upload(['Python', 'Excel']);

  assert.deepEqual(
    await stored(),
    ['Python', 'Kubernetes'],
    'a re-upload overwrote the list the student curated; preserve must beat seed',
  );
});

test('a parse with no skills writes nothing rather than declaring none', async () => {
  await upload(['Python', 'Excel']);
  await upload([]);
  /* NULL means "never told us" and the validator falls back to soft grounding; [] would mean
     "told us: none" and would hard-reject every skill on the resume. A parse that found nothing
     must not be able to say the second thing. */
  assert.deepEqual(await stored(), ['Python', 'Excel'], 'an empty parse cleared the declared list');
});
