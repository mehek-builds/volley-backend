import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../db/schema';

/* THE HALF OF THE DIGEST THAT ONLY POSTGRES CAN PROVE.
 *
 * Every timestamp this feature depends on lives inside a JSON column as TEXT: _review.submitted_at
 * and _review.updated_at. There are no columns for them, because nothing ever wrote
 * application_submission_events (zero rows in production, ever). So the entire delta rests on
 * casting strings inside SQL, which a unit test with a fake store cannot exercise at all, and which
 * fails in two ways that both look like success:
 *
 *   - a packet whose date does not cast takes the WHOLE statement down, so one malformed row would
 *     silence the digest for that student permanently;
 *   - a comparison written against text rather than a timestamp sorts lexically, which happens to
 *     agree with chronological order for same-format ISO strings and disagrees the moment one row
 *     carries an offset or a different precision.
 *
 * Both are exercised here against a real database.
 */

const socketDir = mkdtempSync(join(tmpdir(), 'litos-digest-'));
const savedEnv = { ...process.env };
const STUDENT = '7c2d5a11-9f38-42b0-8c74-6de1a2f45b30';
const OTHER = 'b8e41f02-3a67-4d19-9e55-1c7a83d0e6f2';

let database: PGlite;
let server: PGLiteSocketServer;
let backendPool: { end(): Promise<void> };
let activityDigestFor: typeof import('./activityDigest').activityDigestFor;
let lastDigestAt: typeof import('./activityDigest').lastDigestAt;
let runDigestSweep: typeof import('./digestSweep').runDigestSweep;

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
  ({ pool: backendPool } = await import('../db'));
  ({ activityDigestFor, lastDigestAt } = await import('./activityDigest'));
  ({ runDigestSweep } = await import('./digestSweep'));
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
  for (const t of ['notification_sends', 'push_subscriptions', 'application_email_messages', 'application_email_aliases', 'generated_resumes', 'users']) {
    await database.exec(`delete from "${t}"`);
  }
  await database.exec(`
    insert into "users" ("id", "email", "email_verified", "is_guest", "notify_activity_digest_enabled")
    values ('${STUDENT}', 'student@example.edu', true, false, true),
           ('${OTHER}',   'other@example.edu',   true, false, true)
  `);
});

async function packet(user: string, review: Record<string, unknown>, company = 'Ramp') {
  const spec = JSON.stringify({ _review: review }).replace(/'/g, "''");
  const context = JSON.stringify({ company, role: 'Software Engineer Intern' }).replace(/'/g, "''");
  await database.exec(`
    insert into "generated_resumes" ("user_id", "job_context", "spec", "resume_object_key")
    values ('${user}', '${context}', '${spec}', 'key/${Math.random().toString(36).slice(2)}')
  `);
}

const SINCE = new Date('2026-08-18T00:00:00.000Z');

test('applied counts only packets an employer actually received, dated inside the window', async () => {
  await packet(STUDENT, { status: 'submitted', submitted_at: '2026-08-19T10:00:00.000Z' }, 'Ramp');
  await packet(STUDENT, { status: 'submitted', submitted_at: '2026-08-17T10:00:00.000Z' }, 'Stripe');
  // Prepared but never sent: no submitted_at at all. This is the row that must never be counted.
  await packet(STUDENT, { status: 'ready_to_submit', updated_at: '2026-08-19T10:00:00.000Z' }, 'Notion');

  const digest = await activityDigestFor(STUDENT, SINCE);
  assert.equal(digest.applied, 1, 'only the in-window submission counts');
  assert.deepEqual(digest.applied_companies, ['Ramp']);
  assert.equal(digest.empty, false);
});

test('needs_you counts a state that MOVED in the window, not the standing backlog', async () => {
  /* THE 144 PROBLEM. A production account holds 118 needs_attention packets that have sat there for
     weeks. A digest reporting the backlog reports the same number every day forever; this one must
     report only what changed. */
  for (let i = 0; i < 5; i += 1) {
    await packet(STUDENT, { status: 'needs_attention', updated_at: '2026-07-01T10:00:00.000Z' });
  }
  await packet(STUDENT, { status: 'needs_attention', updated_at: '2026-08-19T09:00:00.000Z' });
  await packet(STUDENT, { status: 'failed', updated_at: '2026-08-19T09:30:00.000Z' });

  const digest = await activityDigestFor(STUDENT, SINCE);
  assert.equal(digest.needs_you, 2, 'the five old ones are backlog, not news');
});

test('a packet with an uncastable date is dropped, and does not take the read down with it', async () => {
  /* Without the regex guard this statement raises 22007 and the student gets NO digest, ever, for
     as long as that one row exists. Quieter is the safe direction; failing is not. */
  await packet(STUDENT, { status: 'submitted', submitted_at: 'not-a-date' });
  await packet(STUDENT, { status: 'needs_attention', updated_at: '' });
  await packet(STUDENT, { status: 'submitted', submitted_at: '2026-08-19T10:00:00.000Z' }, 'Ramp');

  const digest = await activityDigestFor(STUDENT, SINCE);
  assert.equal(digest.applied, 1, 'the good row still counts');
  assert.equal(digest.needs_you, 0);
});

test('the window is compared as time, not as text', async () => {
  /* An ISO string with an offset sorts before one with a Z when compared lexically, so a text
     comparison would silently drop this row even though it is newer than the boundary. */
  await packet(STUDENT, { status: 'submitted', submitted_at: '2026-08-19T02:00:00.000+02:00' }, 'Ramp');
  const digest = await activityDigestFor(STUDENT, SINCE);
  assert.equal(digest.applied, 1, 'an offset timestamp inside the window must count');
});

test('one account never sees another account\'s activity', async () => {
  await packet(OTHER, { status: 'submitted', submitted_at: '2026-08-19T10:00:00.000Z' });
  const digest = await activityDigestFor(STUDENT, SINCE);
  assert.equal(digest.applied, 0);
  assert.equal(digest.empty, true);
});

test('the window starts at the last digest, so a missed run loses nothing', async () => {
  const fallback = new Date('2026-08-19T00:00:00.000Z');
  assert.deepEqual(await lastDigestAt(STUDENT, fallback), fallback, 'never digested: the fallback bounds it');

  await database.exec(`
    insert into "notification_sends" ("user_id", "kind", "daily_slot", "dedupe_key", "created_at", "sent_at")
    values ('${STUDENT}', 'activity_digest', 'activity_digest:2026-08-19', 'activity_digest:${STUDENT}:2026-08-19',
            '2026-08-19T13:30:00.000Z', '2026-08-19T13:30:00.000Z')
  `);
  const since = await lastDigestAt(STUDENT, fallback);
  assert.equal(since.toISOString(), '2026-08-19T13:30:00.000Z');

  /* And a fallback NEWER than the last digest wins, so the first digest after a long silence still
     cannot reach back over the account's whole history. */
  const recent = new Date('2026-08-20T00:00:00.000Z');
  assert.deepEqual(await lastDigestAt(STUDENT, recent), recent);
});

test('a quiet day spends no daily slot, so a later real digest is not suppressed', async () => {
  /* Reserving before checking would burn the cap on an empty digest and silence the real one that
     arrives an hour later. Nothing at all should be written on a quiet day. */
  await database.exec(`
    insert into "push_subscriptions" ("user_id", "endpoint", "p256dh", "auth")
    values ('${STUDENT}', 'https://push.example/one', 'key', 'auth')
  `);
  let pushes = 0;
  const summary = await runDigestSweep(new Date('2026-08-19T13:30:00.000Z'), 50, undefined, {
    push: async () => { pushes += 1; return { delivered: 1, reaped: 0, failed: 0 }; },
  });
  assert.equal(summary.considered, 1);
  assert.equal(summary.had_news, 0);
  assert.equal(summary.sent, 0);
  assert.equal(pushes, 0, 'nothing is pushed on a quiet day');
  const rows = await database.query<{ n: number }>('select count(*)::int as n from "notification_sends"');
  assert.equal(rows.rows[0].n, 0, 'and no slot is spent');
});

test('an account with no device is not considered at all', async () => {
  await packet(STUDENT, { status: 'submitted', submitted_at: new Date().toISOString() });
  const summary = await runDigestSweep(new Date(), 50, undefined, {
    push: async () => ({ delivered: 1, reaped: 0, failed: 0 }),
  });
  assert.equal(summary.considered, 0, 'subscribed is not the same as reachable');
});

test('when every device is dead the slot is given back rather than claimed', async () => {
  /* A ledger row saying a student was notified, when no screen ever lit up, is worse than no row:
     it suppresses tomorrow's attempt on the strength of a notification nobody saw. */
  await database.exec(`
    insert into "push_subscriptions" ("user_id", "endpoint", "p256dh", "auth")
    values ('${STUDENT}', 'https://push.example/dead', 'key', 'auth')
  `);
  await packet(STUDENT, { status: 'submitted', submitted_at: new Date().toISOString() });
  const summary = await runDigestSweep(new Date(), 50, undefined, {
    push: async () => ({ delivered: 0, reaped: 1, failed: 0 }),
  });
  assert.equal(summary.had_news, 1);
  assert.equal(summary.sent, 0);
  assert.equal(summary.suppressed.no_reachable_device, 1);
  const rows = await database.query<{ n: number }>('select count(*)::int as n from "notification_sends"');
  assert.equal(rows.rows[0].n, 0, 'the reservation was released');
});

test('a real digest is delivered once and then capped for the day', async () => {
  await database.exec(`
    insert into "push_subscriptions" ("user_id", "endpoint", "p256dh", "auth")
    values ('${STUDENT}', 'https://push.example/live', 'key', 'auth')
  `);
  await packet(STUDENT, { status: 'submitted', submitted_at: new Date().toISOString() }, 'Ramp');
  const shown: Array<{ title: string; body: string }> = [];
  const push = async (_u: string, p: { title: string; body: string }) => {
    shown.push({ title: p.title, body: p.body });
    return { delivered: 1, reaped: 0, failed: 0 };
  };
  const now = new Date();
  assert.equal((await runDigestSweep(now, 50, undefined, { push })).sent, 1);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Litos applied for you');
  assert.match(shown[0].body, /Applied to Ramp/);

  const second = await runDigestSweep(now, 50, undefined, { push });
  assert.equal(second.sent, 0, 'one a day, enforced by the same index email uses');
  assert.equal(shown.length, 1);
});
