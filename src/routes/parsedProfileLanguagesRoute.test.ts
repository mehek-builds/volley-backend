import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';

/* THE ROUTE, THE REAL SCHEMA, AND A REAL DATABASE.
 *
 * parsedProfilePatch.test.ts pins the `languages` field at the unit level: the Zod schema accepts
 * it and applyParsedProfilePatch normalizes it. Neither of those can see the thing that actually
 * costs students their saves, because both stop short of the handler:
 *
 * 1. The resume editor sends `languages` on EVERY save, empty array included, and the patch schema
 *    is .strict(). A rename or a removal turns every save into a 400 with "Unrecognized key(s) in
 *    object", which is a 400 from the ROUTE - only an injected request proves it does not happen.
 * 2. `languages` corrected here must land in profiles.parsed_json and must NEVER reach
 *    application_profile.languages, which is the student's own fluency declaration from onboarding
 *    (see schema.ts). A pure function cannot prove an absence of a write. A real database can:
 *    seed the declaration, patch the resume languages, read the column back.
 *
 * The fixture is PGlite (Postgres compiled to wasm) speaking the real wire protocol over a unix
 * socket, so the production `db` module connects to it with the production `pg` driver and nothing
 * in src/ is aware it is under test. The DDL is generated from db/schema.ts at run time, so this
 * fixture cannot drift from the schema the way a hand-written CREATE TABLE would. CI's test job
 * needs no database service for any of it.
 */

const ENCRYPTION_KEY = 'parsed-profile-languages-route-test-key';
const JWT_SIGNING_SECRET = 'parsed-profile-languages-route-test-secret';

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
};

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let token: string;
let userId: string;
// Imported dynamically in before(), AFTER DATABASE_URL points at the fixture: db/index.ts reads it
// at module load, so a static import would build a pool against the developer's own database.
let db: typeof import('../db/index')['db'];
let pool: typeof import('../db/index')['pool'];
let schema: typeof import('../db/schema');

const authorizedHeaders = () => ({ authorization: `Bearer ${token}` });

/** The payload the resume editor sends, with whatever the caller is correcting layered on top. */
function editorSave(overrides: Record<string, unknown> = {}) {
  return {
    full_name: 'Mehek Mandal',
    phone: '+1 213 555 0100',
    school: 'University of Southern California',
    degree: 'BS Computer Science and Business Administration',
    grad_date: 'May 2027',
    objective: 'Builder interested in investing and technology.',
    skills: ['Python', 'Financial modeling'],
    languages: [],
    target_roles: [
      'Private Equity Associate',
      'Growth Equity Analyst',
      'Venture Capital Analyst',
      'Investment Banking Analyst',
      'Strategy Associate',
    ],
    ...overrides,
  };
}

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;

  /* A unix socket rather than a TCP port: `node --test` runs test files in parallel, and a fixed
   * port would collide with any other fixture on the machine. node-postgres looks for
   * `<host>/.s.PGSQL.<port>` when host is a directory, so the file has to carry that name. */
  socketDir = mkdtempSync(join(tmpdir(), 'litos-pglite-'));
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({
    db: pglite,
    path: join(socketDir, '.s.PGSQL.5432'),
    // The handler defaults to a single connection; the production pool opens several.
    maxConnections: 10,
  });
  await server.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

  schema = await import('../db/schema');
  const dbModule = await import('../db/index');
  db = dbModule.db;
  pool = dbModule.pool;

  // The whole schema, generated from db/schema.ts itself, one statement at a time because that is
  // what PGlite takes. Deliberately not wrapped in a try: a statement this fixture cannot execute
  // means the tables under test are not the tables in schema.ts, and a silently half-built fixture
  // is worse than a failing one.
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) {
    await pglite.exec(statement);
  }

  const { profiles, users, application_profile } = schema;
  const [user] = await db.insert(users).values({ email: 'student@example.com' }).returning();
  userId = user.id;

  await db.insert(profiles).values({
    user_id: userId,
    parsed_json: { full_name: 'Mehek Mandal', school: 'USC', languages: ['English'] },
    skills: ['Python'],
  });

  /* The fluency declaration, as onboarding writes it. The resume patch below must leave this
   * exact value alone. */
  await db.insert(application_profile).values({
    user_id: userId,
    languages: ['English', 'Hindi'],
  });

  token = await new SignJWT({ userId, isGuest: false, sessionVersion: 0, authMethod: 'email_code' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(JWT_SIGNING_SECRET));

  const { profileRoutes } = await import('./profile');
  app = Fastify({ logger: false });
  await app.register(profileRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  await pool?.end();
  await server?.stop();
  await pglite?.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function readBack() {
  const { profiles, application_profile } = schema;
  const [profile] = await db.select().from(profiles).where(eq(profiles.user_id, userId));
  const [application] = await db
    .select()
    .from(application_profile)
    .where(eq(application_profile.user_id, userId));
  return { profile, application };
}

test('the every-save payload is accepted by the route, languages and all', async () => {
  const response = await app.inject({
    method: 'PATCH',
    url: '/profile/parsed',
    headers: authorizedHeaders(),
    payload: editorSave(),
  });

  assert.equal(response.statusCode, 200);
});

test('a corrected language list is stored on the resume parse', async () => {
  const response = await app.inject({
    method: 'PATCH',
    url: '/profile/parsed',
    headers: authorizedHeaders(),
    payload: editorSave({ languages: [' Hindi ', 'hindi', 'Arabic'] }),
  });

  assert.equal(response.statusCode, 200);
  const { profile } = await readBack();
  assert.deepEqual((profile.parsed_json as Record<string, unknown>).languages, ['Hindi', 'Arabic']);
});

test('the route never writes the resume languages onto the fluency declaration', async () => {
  const response = await app.inject({
    method: 'PATCH',
    url: '/profile/parsed',
    headers: authorizedHeaders(),
    payload: editorSave({ languages: ['Arabic', 'French', 'Punjabi'] }),
  });

  assert.equal(response.statusCode, 200);
  const { application } = await readBack();
  assert.deepEqual(application.languages, ['English', 'Hindi']);
});

test('a languages list past the bound is refused by the route, not stored', async () => {
  // Establish the stored value first so the rejection is measured against a known row rather than
  // against whatever an earlier case in this file happened to leave behind.
  const seeded = await app.inject({
    method: 'PATCH',
    url: '/profile/parsed',
    headers: authorizedHeaders(),
    payload: editorSave({ languages: ['Hindi'] }),
  });
  assert.equal(seeded.statusCode, 200);

  const response = await app.inject({
    method: 'PATCH',
    url: '/profile/parsed',
    headers: authorizedHeaders(),
    payload: editorSave({ languages: Array.from({ length: 31 }, (_, i) => `Language ${i}`) }),
  });

  assert.equal(response.statusCode, 400);
  const { profile } = await readBack();
  assert.deepEqual((profile.parsed_json as Record<string, unknown>).languages, ['Hindi']);
});
