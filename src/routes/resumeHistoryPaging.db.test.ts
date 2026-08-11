import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { SignJWT } from 'jose';

/* WHY THIS ROUTE IS TESTED AGAINST A REAL DATABASE.
 *
 * GET /resume/history pages with a keyset cursor over (created_at desc, id desc). Everything that
 * can go wrong with a keyset goes wrong INSIDE POSTGRES, at boundaries no assertion on generated
 * SQL can reach:
 *
 *   1. TIMESTAMP PRECISION. Postgres stores timestamptz to microseconds; node-postgres parses it
 *      into a JavaScript Date, which holds milliseconds. The first version of this cursor carried
 *      that Date, so a row stored at ...755123Z produced a boundary of ...755000Z and the strict
 *      descending compare skipped every row in between. It was found by review, not by the suite,
 *      because the suite only ever looked at the SQL string.
 *   2. TIES. Two resumes written in the same prewarm batch can share a created_at to the
 *      microsecond, and the tie is then broken by id alone. Whether that actually holds depends on
 *      how Postgres orders and compares a row tuple, which is exactly the thing worth testing.
 *
 * Measured on production on 2026-08-11, neither condition is live: the owner's 158 rows share no
 * millisecond (closest pair 1972.142 ms apart) and across all 416 rows the closest pair is 89.984
 * ms apart. The fixture manufactures both conditions on purpose, because the dashboard prewarms up
 * to 30 resumes a day and a bulk run is what produces them.
 *
 * The fixture is PGlite speaking the real wire protocol over a unix socket, so the production `db`
 * module connects with the production driver, and the DDL is generated from db/schema.ts at run
 * time so it cannot drift from the real schema. Same shape as jobFacetsCounts.test.ts.
 */

const ENCRYPTION_KEY = 'resume-history-paging-test-key';
const JWT_SIGNING_SECRET = 'resume-history-paging-test-secret';

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
};

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let pool: typeof import('../db/index')['pool'];
let token: string;
let otherToken: string;

/** Every id seeded for the student under test, newest first. The expected reading order. */
const seeded: string[] = [];
let strangerPacketId = '';

/* A packet the tracker would count as reviewable. `questions` and `skipped_reasons` are present
   and empty rather than absent: the route refreshes known answers on the way out and maps over the
   list, so an absent one is a 500, and a fixture that cannot survive the real route is not a
   fixture for it. */
const REVIEWABLE_SPEC = {
  _review: {
    status: 'needs_attention',
    questions: [],
    skipped_reasons: [],
    updated_at: '2026-08-10T09:00:00.000Z',
  },
};

const uuid = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;

/**
 * The corpus, newest first, which is exactly the order the route must deliver it in.
 *
 * TIMESTAMPS ARE TEXT AND CAST IN SQL. Handing the driver a JS Date would truncate the fixture
 * itself, and a test that cannot express the failing input cannot detect the failure.
 *
 * THE IDS ARE CHOSEN, NOT SEQUENTIAL, AND THAT IS LOAD-BEARING. The first draft of this fixture
 * numbered the ids downward alongside the timestamps, and every truncation test passed against the
 * broken cursor: the tuple compare fell through to the id, the older row's id happened to be lower
 * than the boundary's, and the row was let through for the wrong reason. A fixture that passes for
 * the wrong reason is worse than no fixture. So the two sub-millisecond pairs below give the OLDER
 * row the HIGHER id, which is the only arrangement where a millisecond-truncated boundary actually
 * loses the row: the truncated timestamp compares strictly greater, the id cannot rescue it, and
 * the row disappears.
 *
 * Three hazards are seeded:
 *   - ONE MICROSECOND APART, older id higher (indexes 1 and 2).
 *   - SAME MILLISECOND, 23 microseconds apart, older id higher (indexes 3 and 4).
 *   - IDENTICAL created_at (indexes 5 and 6), separable by id alone, with a page boundary placed
 *     between them.
 */
const ROWS: { at: string; id: string }[] = [
  { at: '2026-08-10T09:00:00.000000Z', id: uuid('0a') },
  { at: '2026-08-09T12:00:00.500001Z', id: uuid('0b') },
  { at: '2026-08-09T12:00:00.500000Z', id: uuid('0c') },
  { at: '2026-08-08T10:28:59.755123Z', id: uuid('0d') },
  { at: '2026-08-08T10:28:59.755100Z', id: uuid('0f') },
  { at: '2026-08-07T08:00:00.250000Z', id: uuid('09') },
  { at: '2026-08-07T08:00:00.250000Z', id: uuid('08') },
  { at: '2026-08-06T07:00:00.000000Z', id: uuid('07') },
  { at: '2026-08-05T06:00:00.000000Z', id: uuid('06') },
];

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-history-'));
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

  const schema = await import('../db/schema');
  const dbModule = await import('../db/index');
  const db = dbModule.db;
  pool = dbModule.pool;

  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await pglite.exec(statement);

  const { users } = schema;
  const [user] = await db.insert(users).values({ email: 'student@example.com' }).returning();
  const [stranger] = await db.insert(users).values({ email: 'someone-else@example.com' }).returning();

  /* Inserted through raw SQL rather than drizzle so created_at arrives as a timestamptz literal at
     full precision. Going through the ORM would hand the driver a JS Date and truncate the fixture
     to milliseconds, which is the very thing under test. */
  for (const [index, row] of ROWS.entries()) {
    await pglite.query(
      `insert into generated_resumes (id, user_id, job_context, spec, resume_object_key, created_at)
       values ($1::uuid, $2::uuid, $3::jsonb, $4::jsonb, $5, $6::timestamptz)`,
      [row.id, user.id, JSON.stringify({ company: `Co ${index}`, role: 'Engineer' }), JSON.stringify(REVIEWABLE_SPEC), `key-${index}`, row.at],
    );
    seeded.push(row.id);
  }

  strangerPacketId = '00000000-0000-4000-8000-0000000000ff';
  await pglite.query(
    `insert into generated_resumes (id, user_id, job_context, spec, resume_object_key, created_at)
     values ($1::uuid, $2::uuid, $3::jsonb, $4::jsonb, $5, now())`,
    [strangerPacketId, stranger.id, JSON.stringify({ company: 'Not Yours', role: 'Engineer' }), JSON.stringify(REVIEWABLE_SPEC), 'key-stranger'],
  );

  const sign = (userId: string) => new SignJWT({ userId, isGuest: false, sessionVersion: 0, authMethod: 'email_code' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(JWT_SIGNING_SECRET));
  token = await sign(user.id);
  otherToken = await sign(stranger.id);

  const { resumeRoutes } = await import('./resume');
  app = Fastify({ logger: false });
  await app.register(resumeRoutes);
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

type HistoryBody = {
  resumes: { id: string; created_at: string }[];
  total: number;
  reviewable_total: number;
  next_cursor: string | null;
};

async function page(limit: number, cursor?: string | null): Promise<HistoryBody> {
  const query = cursor ? `?limit=${limit}&cursor=${encodeURIComponent(cursor)}` : `?limit=${limit}`;
  const res = await app.inject({
    method: 'GET',
    url: `/resume/history${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

/** Every row the student can reach by paging at this size, in the order the pages delivered them. */
async function walk(limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let guard = 0;
  do {
    const body: HistoryBody = await page(limit, cursor);
    assert.ok(body.resumes.length <= limit, 'a page must never exceed the limit it was asked for');
    for (const row of body.resumes) ids.push(row.id);
    cursor = body.next_cursor;
    assert.ok((guard += 1) < 50, 'paging did not terminate');
  } while (cursor);
  return ids;
}

test('a page of one walks the whole corpus with no duplicate and no skip', async () => {
  /* The smallest page size puts a boundary between EVERY adjacent pair, including the pair that
     shares a created_at to the microsecond and the pair that differs by a single microsecond. If
     the cursor loses precision or cannot break a tie, this is where it shows. */
  const ids = await walk(1);
  assert.deepEqual(ids, seeded, 'every row, exactly once, in recency order');
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  assert.equal(ids.length, ROWS.length, 'no skips');
});

test('every page size from 1 to the whole corpus reads the same rows, once each', async () => {
  /* The boundary has to be correct wherever it lands, not only where this file happened to put it.
     Sweeping the page size moves it across all three seeded hazards in turn. */
  for (let limit = 1; limit <= ROWS.length + 1; limit++) {
    const ids = await walk(limit);
    assert.deepEqual(ids, seeded, `limit=${limit} must read the whole corpus in order`);
    assert.equal(new Set(ids).size, ROWS.length, `limit=${limit} must not duplicate or skip`);
  }
});

test('a boundary landing between two rows that share a created_at loses neither', async () => {
  // Rows 5 and 6 (zero-based) carry the identical timestamp 2026-08-07T08:00:00.250000Z. A page of
  // three ends exactly on the first of them, so the next page has to resume mid-tie on id alone.
  const first = await page(6);
  assert.equal(first.resumes.length, 6);
  assert.equal(first.resumes[5].id, seeded[5]);
  assert.ok(first.next_cursor);

  const second = await page(6, first.next_cursor);
  const walked = [...first.resumes, ...second.resumes].map((row) => row.id);
  assert.deepEqual(walked, seeded);
  assert.equal(second.resumes[0].id, seeded[6], 'the twin of the boundary row must be first on the next page');
});

test('a boundary between two rows one microsecond apart does not swallow the older one', async () => {
  /* Rows 1 and 2 are ...500001Z and ...500000Z, and row 2 carries the HIGHER id. A cursor built
     from a JavaScript Date names ...500000Z, row 2's own timestamp is not strictly less than that,
     and its id cannot rescue it because the id compare only runs on a tie it loses. The row
     vanishes. This is the exact defect PR 471 was blocked on. */
  const first = await page(2);
  assert.deepEqual(first.resumes.map((row) => row.id), seeded.slice(0, 2));

  const second = await page(2, first.next_cursor);
  assert.equal(second.resumes[0].id, seeded[2], 'the row one microsecond older must survive the boundary');
});

test('a boundary inside a millisecond does not swallow the rest of that millisecond', async () => {
  // Rows 3 and 4 are ...755123Z and ...755100Z: the same millisecond, 23 microseconds apart, older
  // id higher. Truncation puts the boundary at ...755000Z and loses row 4.
  const first = await page(4);
  assert.equal(first.resumes[3].id, seeded[3]);

  const second = await page(4, first.next_cursor);
  assert.equal(second.resumes[0].id, seeded[4], 'the row 23 microseconds older must survive the boundary');
});

test('the cursor carries the timestamp Postgres holds, not the one the driver could parse', async () => {
  const first = await page(4);
  const decoded = Buffer.from(first.next_cursor!, 'base64url').toString('utf8');
  const [at] = decoded.split('|');
  assert.equal(at, ROWS[3].at, 'the boundary must be the stored value, to the microsecond');
  assert.notEqual(new Date(at).toISOString(), at, 'and it must be a value a JS Date cannot round-trip');
});

test('total and reviewable_total describe the corpus, not the page', async () => {
  const first = await page(2);
  assert.equal(first.resumes.length, 2);
  assert.equal(first.total, ROWS.length);
  assert.equal(first.reviewable_total, ROWS.length);
  // And they must not count the other student's row.
  assert.ok(!first.resumes.some((row) => row.id === strangerPacketId));
});

test('the last page ends the walk rather than offering one more that finds nothing', async () => {
  // A page size that divides the corpus exactly. Inferring "there is more" from a full page would
  // hand the student a Load more here that returns zero rows.
  const first = await page(ROWS.length);
  assert.equal(first.resumes.length, ROWS.length);
  assert.equal(first.next_cursor, null);
});

test('a cursor this route did not mint yields the first page, not an error', async () => {
  const body = await page(3, Buffer.from('banana|not-a-uuid').toString('base64url'));
  assert.deepEqual(body.resumes.map((row) => row.id), seeded.slice(0, 3));
});

test('a limit outside the bounds is refused rather than silently clamped', async () => {
  for (const limit of ['0', '101', 'all', '2.5']) {
    const res = await app.inject({
      method: 'GET',
      url: `/resume/history?limit=${limit}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 400, `limit=${limit}`);
  }
});

test('a packet outside the loaded window is still reachable by id', async () => {
  /* The other half of the fix. The last seeded row is 9th by recency, so a first page of 2 does not
     contain it, and before this route existed the tracker had no way to open it at all. */
  const first = await page(2);
  const target = seeded[seeded.length - 1];
  assert.ok(!first.resumes.some((row) => row.id === target), 'the fixture must actually place it outside the page');

  const res = await app.inject({
    method: 'GET',
    url: `/resume/history/${target}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().resume.id, target);
});

test('a packet belonging to another student is a 404, never a leak', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/resume/history/${strangerPacketId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 404);

  // And it is genuinely theirs, so the 404 above is a scoping result and not a missing row.
  const theirs = await app.inject({
    method: 'GET',
    url: `/resume/history/${strangerPacketId}`,
    headers: { authorization: `Bearer ${otherToken}` },
  });
  assert.equal(theirs.statusCode, 200);
});

test('the cursor-only column never reaches the wire', async () => {
  // created_at_exact is how the next page is asked for, not a field of the packet. Leaking it would
  // make it part of the contract and invite a client to parse it.
  const first = await page(3);
  for (const row of first.resumes) {
    assert.equal('created_at_exact' in row, false);
    assert.ok('created_at' in row, 'the real column still ships');
  }
});
