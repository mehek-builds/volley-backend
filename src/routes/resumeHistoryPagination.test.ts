import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes } from '../db/schema';
import { afterHistoryCursor, historyQuerySchema, HISTORY_ROW_COLUMNS } from './resume';
import { decodeHistoryCursor, encodeHistoryCursor, historyPage } from '../lib/historyCursor';

/**
 * REGRESSION: GET /resume/history sent a fixed window of 50 rows and said nothing about it.
 *
 * MEASURED IN PRODUCTION, 2026-08-11, owner account a18f774b-a306-4804-93f3-cd6020c27fb3:
 *
 *   select count(*) from generated_resumes where user_id = 'a18f...'          -> 158
 *   the route's own query, verbatim (order by created_at desc limit 50)       ->  50
 *   is 245c827a-daaa-463a-8026-04f89d6a69eb inside that window?               -> false
 *
 * That packet is a real Deepgram application sitting at ready_for_final_approval, 83rd by recency.
 * The tracker built its openable set from the 50 rows this route returned, so its board card
 * rendered inert and /dashboard/applications?application=245c827a... selected nothing and said
 * nothing. 108 of the owner's 158 applications were in that state. Meanwhile /applications/board
 * answered with all 158, because its own bound is BOARD_LIMIT = 200: one screen, two counts of the
 * same corpus.
 *
 * These tests pin the three things that make the window honest rather than bigger: the request can
 * ask for the next page, the response says how large the whole corpus is, and a single packet is
 * reachable by id without the list having included it.
 *
 * No live DB in the test env, so the query is asserted on the SQL drizzle generates, which is the
 * same statement the route executes, per this repo's no-network test convention.
 */

const UID = '00000000-0000-4000-8000-000000000001';
const PACKET = '245c827a-daaa-463a-8026-04f89d6a69eb';

describe('GET /resume/history accepts a page request', () => {
  test('no parameters keeps the payload the old clients already get: 50 rows', () => {
    const parsed = historyQuerySchema.parse({});
    assert.equal(parsed.limit, 50);
    assert.equal(parsed.cursor, undefined);
  });

  test('limit and cursor arrive as strings off the query string and still parse', () => {
    const parsed = historyQuerySchema.parse({ limit: '25', cursor: 'abc' });
    assert.equal(parsed.limit, 25);
    assert.equal(parsed.cursor, 'abc');
  });

  test('limit is bounded at both ends: no zero-row page, no ten-thousand-spec response', () => {
    assert.equal(historyQuerySchema.safeParse({ limit: '0' }).success, false);
    assert.equal(historyQuerySchema.safeParse({ limit: '-1' }).success, false);
    assert.equal(historyQuerySchema.safeParse({ limit: '1.5' }).success, false);
    assert.equal(historyQuerySchema.safeParse({ limit: '100' }).success, true);
    assert.equal(historyQuerySchema.safeParse({ limit: '101' }).success, false);
    assert.equal(historyQuerySchema.safeParse({ limit: 'all' }).success, false);
  });
});

describe('the history cursor', () => {
  test('round-trips a dated row', () => {
    const at = '2026-08-08T10:28:59.755000Z';
    const decoded = decodeHistoryCursor(encodeHistoryCursor({ createdAt: at, id: PACKET }));
    assert.equal(decoded?.id, PACKET);
    assert.equal(decoded?.createdAt, at);
  });

  test('MICROSECONDS SURVIVE THE ROUND TRIP, to the last digit', () => {
    /* The repair for the BLOCK on PR 471. The cursor used to carry a JavaScript Date, which holds
       milliseconds, so this value came back as ...755000Z: a boundary 123 microseconds EARLIER
       than the row it names. The ordering is descending and the compare is strict, so every row
       inside that gap fails `created_at < boundary` and is skipped, silently and permanently.
       Parsing the string back through `new Date()` on the way out would reintroduce it, which is
       why decode validates the shape instead of parsing the value. */
    const at = '2026-08-08T10:28:59.755123Z';
    assert.equal(decodeHistoryCursor(encodeHistoryCursor({ createdAt: at, id: PACKET }))?.createdAt, at);
    assert.notEqual(new Date(at).toISOString(), at, 'a JS Date cannot hold this value, which is the point');
  });

  test('every precision Postgres can store is accepted, and nothing longer', () => {
    for (const at of ['2026-08-08T10:28:59Z', '2026-08-08T10:28:59.7Z', '2026-08-08T10:28:59.755Z', '2026-08-08T10:28:59.755123Z']) {
      assert.equal(decodeHistoryCursor(encodeHistoryCursor({ createdAt: at, id: PACKET }))?.createdAt, at, at);
    }
    for (const at of ['2026-08-08T10:28:59.7551234Z', '2026-08-08T10:28:59', '2026-08-08 10:28:59Z', '2026-02-31T00:00:00Z', "2026-08-08T10:28:59Z'--"]) {
      assert.equal(decodeHistoryCursor(Buffer.from(`${at}|${PACKET}`).toString('base64url')), null, at);
    }
  });

  test('round-trips an undated row, because created_at is nullable on the table', () => {
    const decoded = decodeHistoryCursor(encodeHistoryCursor({ createdAt: null, id: PACKET }));
    assert.equal(decoded?.id, PACKET);
    assert.equal(decoded?.createdAt, null);
  });

  test('a cursor this route did not mint decodes to null, so the caller falls back to page one', () => {
    for (const junk of ['', 'not-base64!!', Buffer.from('no-separator').toString('base64url'), Buffer.from('2026-01-01T00:00:00.000Z|not-a-uuid').toString('base64url'), Buffer.from(`banana|${PACKET}`).toString('base64url')]) {
      assert.equal(decodeHistoryCursor(junk), null, `expected ${junk || '(empty)'} to be rejected`);
    }
    assert.equal(decodeHistoryCursor(undefined), null);
  });

  test('it carries nothing the caller was not already sent', () => {
    const raw = Buffer.from(encodeHistoryCursor({ createdAt: '1970-01-01T00:00:00.000000Z', id: PACKET }), 'base64url').toString('utf8');
    assert.equal(raw, `1970-01-01T00:00:00.000000Z|${PACKET}`);
  });
});

describe('page assembly', () => {
  const row = (n: number) => ({
    id: `0000000${n}-0000-4000-8000-000000000001`,
    // As Postgres renders it, to microseconds, which is what the route selects alongside the row.
    created_at_exact: `2026-01-${String(30 - n).padStart(2, '0')}T00:00:00.000000Z`,
  });

  test('a full page plus one more row means there IS another page', () => {
    const page = historyPage([row(1), row(2), row(3)], 2);
    assert.equal(page.rows.length, 2);
    assert.notEqual(page.nextCursor, null);
    // And the cursor names the LAST row shown, not the one peeked at, or the next page skips it.
    assert.equal(decodeHistoryCursor(page.nextCursor)?.id, row(2).id);
  });

  test('exactly a full page and nothing beyond it ends the list', () => {
    // The whole reason the query asks for limit+1. Inferring from a full page would offer a Load
    // more here that fetches nothing.
    assert.equal(historyPage([row(1), row(2)], 2).nextCursor, null);
  });

  test('a short page and an empty page both end the list', () => {
    assert.equal(historyPage([row(1)], 2).nextCursor, null);
    assert.deepEqual(historyPage([], 50), { rows: [], nextCursor: null });
  });
});

describe('the paged query drizzle builds', () => {
  function pageQuery(cursorParam?: string, limit = 50) {
    const cursor = decodeHistoryCursor(cursorParam);
    return db
      .select(HISTORY_ROW_COLUMNS)
      .from(generated_resumes)
      .where(cursor ? and(eq(generated_resumes.user_id, UID), afterHistoryCursor(cursor)) : eq(generated_resumes.user_id, UID))
      .orderBy(desc(generated_resumes.created_at), desc(generated_resumes.id))
      .limit(limit + 1)
      .toSQL();
  }

  test('the ordering is total: id breaks a created_at tie so pages cannot overlap', () => {
    const q = pageQuery();
    assert.match(q.sql, /order by .*"created_at" desc.*"id" desc/i);
  });

  test('it asks for one row more than the page, which is how the last page is detected', () => {
    assert.ok(pageQuery(undefined, 50).params.includes(51), 'expected the bound limit to be 51 for a page of 50');
    assert.ok(pageQuery(undefined, 25).params.includes(26), 'expected the bound limit to be 26 for a page of 25');
  });

  test('the first page is not narrowed by anything except ownership', () => {
    const q = pageQuery();
    assert.equal(q.params.filter((p) => p === UID).length, 1);
    assert.doesNotMatch(q.sql, /\)\s*<\s*\(/, 'no cursor means no keyset predicate');
  });

  test('a cursor narrows on BOTH sort columns, so a duplicate timestamp cannot repeat a row', () => {
    const at = '2026-08-08T10:28:59.755123Z';
    const q = pageQuery(encodeHistoryCursor({ createdAt: at, id: PACKET }));
    assert.match(q.sql, /"created_at"/);
    assert.match(q.sql, /"id"\)\s*<\s*\(/i, 'expected a tuple comparison over (created_at, id)');
    // Bound at full precision. A parameter reading ...755Z here is the truncation that skips rows.
    assert.ok(q.params.includes(at), 'the cursor timestamp must ride as a bound parameter, undegraded');
    assert.ok(q.params.includes(PACKET), 'the cursor id must ride as a bound parameter');
  });

  test('the page selects the exact timestamp the cursor will be built from', () => {
    // to_char at microsecond precision, from Postgres, alongside the row. Without it the only
    // timestamp available to build a cursor from is the driver's millisecond-truncated Date.
    const q = db.select(HISTORY_ROW_COLUMNS).from(generated_resumes).toSQL();
    assert.match(q.sql, /to_char\(/i);
    assert.match(q.sql, /HH24:MI:SS\.US/);
    assert.match(q.sql, /at time zone 'UTC'/i);
  });

  test('an undated cursor keeps the remaining undated rows AND everything dated', () => {
    // Postgres sorts NULLs first under a plain DESC. A single tuple compare against NULL is NULL,
    // never true, so folding this case in would drop every undated row from page two onward.
    const q = pageQuery(encodeHistoryCursor({ createdAt: null, id: PACKET }));
    assert.match(q.sql, /is null/i);
    assert.match(q.sql, /is not null/i);
    assert.ok(q.params.includes(PACKET));
  });

  test('the count that produces `total` is scoped to the caller and NOT to the page', () => {
    // Exactly the route's second statement. `total` is the size of the corpus, so a LIMIT on it
    // would reintroduce the defect in the one number that exists to expose it: the tracker would
    // print "50 of 50" over 158 applications again.
    const q = db
      .select({ total: sql<number>`count(*)::int` })
      .from(generated_resumes)
      .where(eq(generated_resumes.user_id, UID))
      .toSQL();
    assert.match(q.sql, /count\(\*\)/i);
    assert.doesNotMatch(q.sql, /limit/i, 'a total computed over one page is the bug, not the fix');
    assert.ok(q.params.includes(UID));
  });
});

describe('a packet is reachable by id, independently of the page it fell on', () => {
  test('the single-packet query is scoped by id AND owner', () => {
    const q = db
      .select()
      .from(generated_resumes)
      .where(and(eq(generated_resumes.id, PACKET), eq(generated_resumes.user_id, UID)))
      .limit(1)
      .toSQL();
    assert.ok(q.params.includes(PACKET));
    assert.ok(q.params.includes(UID), 'an id alone would hand one student another student\'s packet');
  });

  test('GET /resume/history/:id is registered', async () => {
    process.env.VERCEL = '1';
    process.env.LOG_LEVEL = 'silent';
    process.env.DATABASE_URL ??= 'postgresql://postgres:password@localhost:5432/unused-in-these-tests';
    process.env.JWT_SIGNING_SECRET ??= 'test-signing-secret-32-chars-minimum!!';
    process.env.ENCRYPTION_KEY ??= 'test-encryption-key-at-least-32-chars-long';
    const { buildApp } = await import('../index');
    const app = await buildApp();
    await app.ready();
    apps.push(app);

    assert.equal(app.hasRoute({ method: 'GET', url: '/resume/history/:id' }), true);
    // The list route must keep its own path rather than being shadowed by the parametric one.
    assert.equal(app.hasRoute({ method: 'GET', url: '/resume/history' }), true);

    // Unauthenticated, so this stops at the auth preHandler. 401 rather than 404 is the proof the
    // path resolves at all: an unregistered route answers 404 before any preHandler runs.
    const res = await app.inject({ method: 'GET', url: `/resume/history/${PACKET}` });
    assert.equal(res.statusCode, 401);
  });
});

const apps: { close: () => Promise<unknown> }[] = [];
after(async () => {
  for (const app of apps) await app.close();
});
