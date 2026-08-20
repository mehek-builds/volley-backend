import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../db/schema';

/* THE PARTS OF THIS FEATURE THAT ONLY A DATABASE CAN PROVE.
 *
 * The one-a-day limiter is a UNIQUE INDEX, not a branch, and that was a deliberate design decision
 * (see lib/notificationSend.ts: two overlapping cron runs both read zero rows and both send). A
 * unit test with a stubbed store would happily pass against a read-then-send implementation, which
 * is the exact implementation the index exists to rule out. So the limiter, the repeat guard, and
 * the release-on-failure are all exercised against real Postgres semantics here.
 *
 * Mail goes through the real sendEmail into the controlled QA capture route that already exists in
 * lib/email.ts, rather than through a stub, so the payload asserted below is the payload Resend
 * would have been handed.
 */

const JWT_SECRET = 'notification-db-test-secret-32-chars';
const CAPTURE_TOKEN = 'notification-db-test-capture-token-0123456789';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-notifications-'));
const savedEnv = { ...process.env };

const STUDENT = '6d58c1f5-e885-41f7-a16a-dac37f98ab17';
const STRANGER = '9610648e-7750-4931-9a74-8aef5ebf00c0';

let database: PGlite;
let server: PGLiteSocketServer;
let capture: Server;
let app: FastifyInstance;
let backendPool: { end(): Promise<void> };
let sent: Array<{ to: string[]; subject: string; text: string; headers?: Record<string, string> }>;
let mintUnsubscribeToken: typeof import('../lib/notificationUnsubscribe').mintUnsubscribeToken;
let sendNotification: typeof import('../lib/notificationSend').sendNotification;
let runStrongMatchSweep: typeof import('./notifications').runStrongMatchSweep;

async function token(userId: string) {
  return new SignJWT({ userId, isGuest: false, sessionVersion: 0, authMethod: 'password' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function testEmail(to: string) {
  return {
    from: 'Litos <hello@trylitos.com>',
    to: [to],
    subject: 'A strong match opened',
    text: 'body',
  };
}

before(async () => {
  database = await PGlite.create();
  const initial = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of initial) await database.exec(statement);
  server = new PGLiteSocketServer({ db: database, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();

  sent = [];
  capture = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (request.headers['x-litos-qa-capture-token'] !== CAPTURE_TOKEN) {
        response.writeHead(401).end('{}');
        return;
      }
      sent.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: `msg_${sent.length}` }));
    });
  });
  await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve));
  const port = (capture.address() as { port: number }).port;

  process.env.VERCEL = '1';
  process.env.LOG_LEVEL = 'silent';
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  process.env.JWT_SIGNING_SECRET = JWT_SECRET;
  process.env.LITOS_NOTIFICATION_UNSUBSCRIBE_SECRET = 'notification-db-test-unsubscribe-secret';
  process.env.PUBLIC_API_BASE = 'https://api.trylitos.test';
  process.env.INTERNAL_CRON_SECRET = 'notification-db-test-cron-secret';
  process.env.LITOS_QA_EMAIL_CAPTURE_ENABLED = 'true';
  process.env.LITOS_QA_EMAIL_CAPTURE_URL = `http://127.0.0.1:${port}/emails`;
  process.env.LITOS_QA_EMAIL_CAPTURE_TOKEN = CAPTURE_TOKEN;

  ({ pool: backendPool } = await import('../db'));
  ({ mintUnsubscribeToken } = await import('../lib/notificationUnsubscribe'));
  ({ sendNotification } = await import('../lib/notificationSend'));
  const { notificationRoutes, runStrongMatchSweep: sweep } = await import('./notifications');
  runStrongMatchSweep = sweep;
  app = Fastify({ logger: false });
  await app.register(notificationRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  await backendPool?.end();
  await new Promise<void>((resolve) => capture?.close(() => resolve()));
  await server?.stop();
  await database.close();
  rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

beforeEach(async () => {
  sent.length = 0;
  await database.exec('delete from "notification_sends"');
  await database.exec('delete from "monitored_jobs"');
  await database.exec('delete from "career_page_sources"');
  await database.exec('delete from "profiles"');
  await database.exec('delete from "users"');
  await database.exec(`
    insert into "users" ("id", "email", "email_verified", "is_guest", "notify_strong_match_enabled", "notify_employer_reply_enabled")
    values
      ('${STUDENT}', 'student@example.edu', true, false, true, true),
      ('${STRANGER}', 'stranger@example.edu', true, false, false, false)
  `);
});

test('one a day is enforced by the database, not by a read', async () => {
  const day = new Date('2026-08-19T09:00:00.000Z');
  const first = await sendNotification({
    userId: STUDENT,
    kind: 'strong_match',
    dedupeKey: 'strong_match:one',
    build: () => testEmail('student@example.edu'),
  }, { now: () => day });
  assert.equal(first.sent, true);

  /* A DIFFERENT posting, later the same UTC day. The repeat guard has nothing to say about it, so
     if anything stops this it is the daily slot, which is the thing under test. */
  const second = await sendNotification({
    userId: STUDENT,
    kind: 'strong_match',
    dedupeKey: 'strong_match:two',
    build: () => testEmail('student@example.edu'),
  }, { now: () => new Date('2026-08-19T21:00:00.000Z') });
  assert.deepEqual(second, { sent: false, reason: 'daily_cap' });
  assert.equal(sent.length, 1, 'the second send never reached the transport');

  // Tomorrow is a new slot.
  const third = await sendNotification({
    userId: STUDENT,
    kind: 'strong_match',
    dedupeKey: 'strong_match:two',
    build: () => testEmail('student@example.edu'),
  }, { now: () => new Date('2026-08-20T09:00:00.000Z') });
  assert.equal(third.sent, true);
  assert.equal(sent.length, 2);
});

test('the cap is per account, so one student cannot use up another student\'s day', async () => {
  const day = new Date('2026-08-19T09:00:00.000Z');
  const mine = await sendNotification({
    userId: STUDENT,
    kind: 'strong_match',
    dedupeKey: 'strong_match:mine',
    build: () => testEmail('student@example.edu'),
  }, { now: () => day });
  const theirs = await sendNotification({
    userId: STRANGER,
    kind: 'strong_match',
    dedupeKey: 'strong_match:theirs',
    build: () => testEmail('stranger@example.edu'),
  }, { now: () => day });
  assert.equal(mine.sent, true);
  assert.equal(theirs.sent, true);
});

test('one thing is announced once, ever, however many days pass', async () => {
  const first = await sendNotification({
    userId: STUDENT,
    kind: 'strong_match',
    dedupeKey: 'strong_match:same-posting',
    build: () => testEmail('student@example.edu'),
  }, { now: () => new Date('2026-08-19T09:00:00.000Z') });
  assert.equal(first.sent, true);

  const later = await sendNotification({
    userId: STUDENT,
    kind: 'strong_match',
    dedupeKey: 'strong_match:same-posting',
    build: () => testEmail('student@example.edu'),
  }, { now: () => new Date('2026-09-19T09:00:00.000Z') });
  assert.deepEqual(later, { sent: false, reason: 'already_notified' });
  assert.equal(sent.length, 1);
});

test('an employer reply is not held back by the match alert, or by another reply', async () => {
  /* The asymmetry is the product decision. A daily cap on "someone replied to your application"
     would be Litos sitting on the student's mail. */
  const day = new Date('2026-08-19T09:00:00.000Z');
  await sendNotification({
    userId: STUDENT,
    kind: 'strong_match',
    dedupeKey: 'strong_match:today',
    build: () => testEmail('student@example.edu'),
  }, { now: () => day });

  for (const messageId of ['a', 'b', 'c']) {
    const outcome = await sendNotification({
      userId: STUDENT,
      kind: 'employer_reply',
      dedupeKey: `employer_reply:${messageId}`,
      build: () => testEmail('student@example.edu'),
    }, { now: () => day });
    assert.equal(outcome.sent, true, `reply ${messageId} must not be capped`);
  }
  assert.equal(sent.length, 4);
});

test('a failed send gives its slot back rather than spending it', async () => {
  const day = new Date('2026-08-19T09:00:00.000Z');
  await assert.rejects(() => sendNotification({
    userId: STUDENT,
    kind: 'strong_match',
    dedupeKey: 'strong_match:retry',
    build: () => testEmail('student@example.edu'),
  }, { now: () => day, send: async () => { throw new Error('Resend is down'); } }));

  const rows = await database.query<{ n: number }>('select count(*)::int as n from "notification_sends"');
  assert.equal(rows.rows[0].n, 0, 'a reservation for a send that never happened must not survive');

  // Same day, same posting: the retry is allowed because neither guard is holding anything.
  const retry = await sendNotification({
    userId: STUDENT,
    kind: 'strong_match',
    dedupeKey: 'strong_match:retry',
    build: () => testEmail('student@example.edu'),
  }, { now: () => day });
  assert.equal(retry.sent, true);
});

test('a successful send is recorded with the provider id and nothing about the message', async () => {
  await sendNotification({
    userId: STUDENT,
    kind: 'strong_match',
    dedupeKey: 'strong_match:recorded',
    build: () => testEmail('student@example.edu'),
  }, { now: () => new Date('2026-08-19T09:00:00.000Z') });
  const rows = await database.query<{ kind: string; daily_slot: string | null; provider_message_id: string | null; sent_at: string | null }>(
    'select kind, daily_slot, provider_message_id, sent_at from "notification_sends"',
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].kind, 'strong_match');
  assert.equal(rows.rows[0].daily_slot, 'strong_match:2026-08-19');
  assert.equal(rows.rows[0].provider_message_id, 'msg_1');
  assert.ok(rows.rows[0].sent_at);
  const columns = Object.keys(schema.notification_sends);
  assert.equal(columns.includes('subject'), false, 'the ledger is not a second copy of the student\'s mail');
  assert.equal(columns.includes('body'), false);
});

test('no unsubscribe link means no send, and no slot is spent finding that out', async () => {
  /* An email a student cannot stop is not one Litos is entitled to put in her inbox, whatever she
     agreed to on screen 08. The check runs BEFORE the reservation so a misconfigured deployment
     does not burn her daily slot discovering it. */
  delete process.env.PUBLIC_API_BASE;
  try {
    const outcome = await sendNotification({
      userId: STUDENT,
      kind: 'strong_match',
      dedupeKey: 'strong_match:no-link',
      build: () => testEmail('student@example.edu'),
    }, { now: () => new Date('2026-08-19T09:00:00.000Z') });
    assert.deepEqual(outcome, { sent: false, reason: 'unsubscribe_unavailable' });
    assert.equal(sent.length, 0);
    const rows = await database.query<{ n: number }>('select count(*)::int as n from "notification_sends"');
    assert.equal(rows.rows[0].n, 0);
  } finally {
    process.env.PUBLIC_API_BASE = 'https://api.trylitos.test';
  }
});

test('the preferences route reports and records the two permissions with their grant dates', async () => {
  const authorization = `Bearer ${await token(STUDENT)}`;

  const before = await app.inject({ method: 'GET', url: '/notifications/preferences', headers: { authorization } });
  assert.equal(before.statusCode, 200);
  assert.equal(before.json().strong_match.enabled, true);
  assert.equal(before.json().strong_match.granted_at, null, 'the fixture set the boolean without a grant date');

  const off = await app.inject({
    method: 'PUT',
    url: '/notifications/preferences',
    headers: { authorization },
    payload: { strong_match: false },
  });
  assert.equal(off.statusCode, 200);
  assert.equal(off.json().strong_match.enabled, false);
  assert.equal(off.json().strong_match.granted_at, null);
  assert.equal(off.json().employer_reply.enabled, true, 'the untouched permission is untouched');

  const on = await app.inject({
    method: 'PUT',
    url: '/notifications/preferences',
    headers: { authorization },
    payload: { strong_match: true },
  });
  assert.equal(on.json().strong_match.enabled, true);
  assert.ok(on.json().strong_match.granted_at, 'a grant is stamped with the moment it was given');
});

test('the preferences route refuses an empty change and an unauthenticated caller', async () => {
  const authorization = `Bearer ${await token(STUDENT)}`;
  const empty = await app.inject({
    method: 'PUT',
    url: '/notifications/preferences',
    headers: { authorization },
    payload: {},
  });
  assert.equal(empty.statusCode, 400);
  const anonymous = await app.inject({ method: 'GET', url: '/notifications/preferences' });
  assert.equal(anonymous.statusCode, 401);
});

test('unsubscribe works without signing in, and the GET does not act on its own', async () => {
  const link = mintUnsubscribeToken(STUDENT, 'strong_match');

  /* CORPORATE MAIL SCANNERS AND LINK PREVIEW BOTS FOLLOW EVERY URL in an incoming message before a
     human sees it. A GET that mutated would silently unsubscribe people who never clicked. */
  const preview = await app.inject({ method: 'GET', url: `/notifications/unsubscribe?token=${link}` });
  assert.equal(preview.statusCode, 200);
  assert.match(preview.headers['content-type'] as string, /text\/html/);
  let row = await database.query<{ on: boolean }>(`select notify_strong_match_enabled as on from "users" where id = '${STUDENT}'`);
  assert.equal(row.rows[0].on, true, 'looking at the page must not unsubscribe anybody');

  const acted = await app.inject({ method: 'POST', url: `/notifications/unsubscribe?token=${link}` });
  assert.equal(acted.statusCode, 200);
  row = await database.query<{ on: boolean }>(`select notify_strong_match_enabled as on from "users" where id = '${STUDENT}'`);
  assert.equal(row.rows[0].on, false);

  // The stream that was not named is untouched: somebody tired of match alerts has said nothing
  // about wanting to miss an employer's reply.
  const other = await database.query<{ on: boolean }>(`select notify_employer_reply_enabled as on from "users" where id = '${STUDENT}'`);
  assert.equal(other.rows[0].on, true);
});

test('a one-click POST with a form body unsubscribes rather than answering 415', async () => {
  /* RFC 8058 one-click posts application/x-www-form-urlencoded, and Fastify answers 415 to a
     content type it has no parser for BEFORE any handler runs. That would make the mail client's
     own Unsubscribe button silently fail. */
  const link = mintUnsubscribeToken(STUDENT, 'employer_reply');
  const response = await app.inject({
    method: 'POST',
    url: `/notifications/unsubscribe?token=${link}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'List-Unsubscribe=One-Click',
  });
  assert.equal(response.statusCode, 200);
  const row = await database.query<{ on: boolean }>(`select notify_employer_reply_enabled as on from "users" where id = '${STUDENT}'`);
  assert.equal(row.rows[0].on, false);
});

test('the all scope turns off every stream, and a forged token turns off nothing', async () => {
  const link = mintUnsubscribeToken(STUDENT, 'strong_match');
  const all = await app.inject({
    method: 'POST',
    url: `/notifications/unsubscribe?token=${link}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'scope=all',
  });
  assert.equal(all.statusCode, 200);
  let row = await database.query<{ a: boolean; b: boolean }>(
    `select notify_strong_match_enabled as a, notify_employer_reply_enabled as b from "users" where id = '${STUDENT}'`,
  );
  assert.deepEqual(row.rows[0], { a: false, b: false });

  const forged = await app.inject({ method: 'POST', url: '/notifications/unsubscribe?token=v1.strong_match.abc.def' });
  assert.equal(forged.statusCode, 400);
});

test('the sweep refuses to run when only PUBLIC_API_BASE is missing', async () => {
  /* REGRESSION, and the reason the test below could not catch it: that one deletes the secret AND
     the base URL together, so it passes against a guard that checks only the secret. A link needs
     both. PUBLIC_API_BASE is optional everywhere else in this codebase, so "secret present, base
     unset" is the default state of a deployment that has never needed one - and under the old
     guard the cron walked every subscriber, failed every send on the same missing origin, and
     answered 200 with sent:0, which is exactly what a quiet day looks like. */
  await seedBoard();
  await seedResume();
  delete process.env.PUBLIC_API_BASE;
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/strong-match-notifications',
      headers: { 'x-internal-secret': 'notification-db-test-cron-secret' },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().missing, 'public_api_base', 'the operator is told which half is missing');
    assert.equal(sent.length, 0);
  } finally {
    process.env.PUBLIC_API_BASE = 'https://api.trylitos.test';
  }
});

test('a purged posting leaves the record that somebody was emailed standing', async () => {
  /* Postings are HARD DELETED on a schedule (purgeExpiredPostings). Under a cascading foreign key
     that purge silently destroyed the send record a month after the fact, taking with it the only
     evidence an unsubscribe complaint has to look at and resetting the account's place in the
     sweep's longest-waiting-first rotation to "never mailed". */
  await seedBoard();
  await seedResume();
  const summary = await runStrongMatchSweep(new Date());
  assert.equal(sent.length, 1);
  /* seedBoard()'s default first_seen (4h ago) is already past STRONG_FIT_SLA_HOURS (3h), and this
     account's resume is an intentionally strong match for it - a review caught that this makes
     every test using these defaults silently exercise the SLA-breach path, unasserted. Documented
     here rather than left implicit, so a future change to either default has to update this. */
  assert.equal(summary.sla_breaches, 1);

  await database.exec('delete from "monitored_jobs"');
  const rows = await database.query<{ n: number; job: string | null; dedupe_key: string }>(
    'select count(*) over ()::int as n, monitored_job_id as job, dedupe_key from "notification_sends"',
  );
  assert.equal(rows.rows.length, 1, 'the purge must not take the notification with it');
  assert.equal(rows.rows[0].job, null, 'the reference is released');
  assert.match(rows.rows[0].dedupe_key, /^strong_match:/, 'the dedupe key survives, so a repeat is still impossible');
});

test('the sweep is cron authorised and refuses to run without a way to unsubscribe', async () => {
  const unauthorized = await app.inject({ method: 'GET', url: '/internal/strong-match-notifications' });
  assert.equal(unauthorized.statusCode, 401);

  delete process.env.PUBLIC_API_BASE;
  delete process.env.LITOS_NOTIFICATION_UNSUBSCRIBE_SECRET;
  const savedJwt = process.env.JWT_SIGNING_SECRET;
  delete process.env.JWT_SIGNING_SECRET;
  try {
    /* Refused rather than run: every send would fail on the same missing link, and a run reporting
       200 with nothing sent looks exactly like a quiet day. */
    const misconfigured = await app.inject({
      method: 'GET',
      url: '/internal/strong-match-notifications',
      headers: { 'x-internal-secret': 'notification-db-test-cron-secret' },
    });
    assert.equal(misconfigured.statusCode, 503);
  } finally {
    process.env.PUBLIC_API_BASE = 'https://api.trylitos.test';
    process.env.LITOS_NOTIFICATION_UNSUBSCRIBE_SECRET = 'notification-db-test-unsubscribe-secret';
    if (savedJwt) process.env.JWT_SIGNING_SECRET = savedJwt;
  }
});

test('a subscriber with no resume is never told anything is a strong match', async () => {
  /* An unranked posting is not a strong match, it is an unjudged one, and the email would be
     claiming a fit that was never computed. */
  await seedBoard();
  const summary = await runStrongMatchSweep(new Date());
  assert.equal(summary.considered, 1, 'only the subscribed account is considered');
  assert.equal(summary.matched, 0);
  assert.equal(sent.length, 0);
});

test('the sweep mails one posting, above the floor, and never the same one twice', async () => {
  await seedBoard();
  await seedResume();

  const first = await runStrongMatchSweep(new Date());
  assert.equal(first.considered, 1);
  assert.equal(first.failed, 0, 'a thrown account must not be able to pass as a quiet day');
  assert.equal(first.matched, 1);
  assert.equal(first.sent, 1);
  // Same default-fixture note as above: 4h old, scored above VERY_STRONG_FIT_SCORE, so this run
  // is itself a documented SLA breach rather than the clean case (see the two tests below that
  // control first_seen explicitly for the clean-vs-breach comparison).
  assert.equal(first.sla_breaches, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['student@example.edu']);
  assert.equal(sent[0].subject, 'Software Engineer Intern at Ramp');
  /* Found, never Posted, all the way through the real transport payload. */
  assert.doesNotMatch(`${sent[0].subject}\n${sent[0].text}`, /posted/i);
  assert.match(sent[0].text, /Found 4 hours ago/);
  assert.ok(sent[0].headers?.['List-Unsubscribe']);

  /* A second run the same day is stopped by the cap. A run tomorrow would be stopped by the repeat
     guard instead, because the only posting on the board has already been announced: proved here
     by the ledger row rather than by moving the clock, which the sweep reads from `new Date()`. */
  const second = await runStrongMatchSweep(new Date());
  assert.equal(second.sent, 0);
  assert.equal(second.matched, 0, 'the announced posting is excluded before the pool is even chosen');
  assert.equal(sent.length, 1);
});

test('a very strong fit found within the SLA window sends clean, no breach reported', async () => {
  // Found under three hours ago: the barrier is met, so the run reports zero breaches.
  await seedBoard(undefined, "now() - interval '2 hours'");
  await seedResume();
  const summary = await runStrongMatchSweep(new Date());
  assert.equal(summary.sent, 1);
  assert.equal(summary.sla_breaches, 0);
});

test('a very strong fit found past the SLA window is a reported breach, and the cron answers 500', async () => {
  /* THE HARD BARRIER. Found five hours ago - past STRONG_FIT_SLA_HOURS - so sending it now, however
     correct the send itself is, is the exact failure this exists to surface loudly rather than
     silently. Asserted through the real HTTP route, not runStrongMatchSweep directly, because the
     500 is wired into the route handler and a unit-level call would never prove it fires. */
  await seedBoard(undefined, "now() - interval '5 hours'");
  await seedResume();
  const response = await app.inject({
    method: 'GET',
    url: '/internal/strong-match-notifications',
    headers: { 'x-internal-secret': 'notification-db-test-cron-secret' },
  });
  assert.equal(response.statusCode, 500, 'a cron that always answers 200 is a cron nobody reads');
  const body = response.json();
  assert.equal(body.sla_breaches, 1);
  assert.equal(body.sent, 1, 'the match still goes out - late is not a reason to withhold it');
  assert.match(body.error, /very-strong-fit/);
  assert.equal(sent.length, 1, 'the student is still mailed even though the run reports the breach');
});

test('a very strong fit blocked by the daily cap is still counted as a breach, not silently dropped', async () => {
  /* THE GAP A REVIEW CAUGHT. Before this fix, breachesStrongFitSla was only ever evaluated inside
     sendNotification's success branch, so a very-strong fit that strongMatchForAccount correctly
     picked as the best available posting - but that then lost the day's single send slot to an
     earlier, weaker match - produced zero signal. It would just sit there, unannounced, until it
     aged out of MATCH_LOOKBACK_HOURS with sla_breaches staying 0 and the route answering 200 the
     whole time. This proves the fix: the daily cap suppresses the SEND, but not the BREACH report. */
  await seedBoard(undefined, "now() - interval '1 hour'");
  await seedResume();
  const first = await runStrongMatchSweep(new Date());
  assert.equal(first.sent, 1);
  assert.equal(first.sla_breaches, 0, 'the first posting was found recently, so sending it is not a breach');

  // A second, distinct posting on the same board, already well past the SLA window. Same
  // description text as seedBoard's default, so it scores just as strongly against the same resume.
  const description = [
    'About the role',
    'We are a small team shipping quickly.',
    '',
    'Requirements',
    '- Strong TypeScript and React experience\n- Familiarity with Next.js and Tailwind CSS\n- Comfort with PostgreSQL and REST APIs\n- Experience with CI/CD and Git',
    '',
    'Benefits',
    'Unlimited vacation, great coffee, a passionate team.',
  ].join('\n').replace(/'/g, "''");
  await database.exec(`
    insert into "monitored_jobs"
      ("source_id", "external_id", "company_name", "title", "location", "description", "description_digest", "apply_url", "posting_url", "posted_at", "first_seen_at")
    values (
      'c4f0e4a2-7c1f-4a4c-9c53-9c2b7f1a2b3c', 'job-2', 'Ramp', 'Senior Software Engineer Intern', 'New York, NY',
      '${description}', '${description}',
      'https://job-boards.greenhouse.io/ramp/jobs/2', 'https://job-boards.greenhouse.io/ramp/jobs/2',
      now() - interval '6 hours', now() - interval '6 hours'
    )
  `);

  const second = await runStrongMatchSweep(new Date());
  assert.equal(second.sent, 0, 'the daily cap already spent by the first send blocks this one');
  assert.equal(second.suppressed.daily_cap, 1);
  assert.equal(
    second.sla_breaches,
    1,
    'the very-strong fit that could not be sent is still counted as a breach, not dropped silently',
  );
  assert.equal(sent.length, 1, 'only the first email actually went out');
});

test('a stale very strong fit that loses the single-slot pick to a fresher one, same run, is still a counted breach', async () => {
  /* A NARROWER version of the same gap, caught by a second review pass. strongMatchForAccount only
     ever RETURNS the single best-ranked candidate - rankByFit sorts strictly by score, so a second
     eligible very-strong fit in the SAME run, that lost the pick to a higher (or tied-and-fresher)
     one, used to never even reach sweepAccount. Not sent, not suppressed-and-counted, not checked
     against the SLA at all - it would just silently age out of MATCH_LOOKBACK_HOURS. This is
     distinct from the daily-cap test above: here both postings are live in ONE sweep call, and
     neither the daily cap nor a second sweep run is what strands the older one - losing the ranked
     pick alone does. */
  await seedBoard(undefined, "now() - interval '1 hour'"); // job-1: fresh, wins the tie on index.
  await seedResume();

  // job-2: identical description (so an identical score - a genuine tie, not just "also above the
  // floor"), found 6 hours ago - past STRONG_FIT_SLA_HOURS on its own. Query order is oldest-last
  // (first_seen_at desc), so job-1 sorts first into the pool and wins the score tie by index,
  // leaving job-2 eligible, tied, and stranded in the same ranked list.
  const description = [
    'About the role',
    'We are a small team shipping quickly.',
    '',
    'Requirements',
    '- Strong TypeScript and React experience\n- Familiarity with Next.js and Tailwind CSS\n- Comfort with PostgreSQL and REST APIs\n- Experience with CI/CD and Git',
    '',
    'Benefits',
    'Unlimited vacation, great coffee, a passionate team.',
  ].join('\n').replace(/'/g, "''");
  await database.exec(`
    insert into "monitored_jobs"
      ("source_id", "external_id", "company_name", "title", "location", "description", "description_digest", "apply_url", "posting_url", "posted_at", "first_seen_at")
    values (
      'c4f0e4a2-7c1f-4a4c-9c53-9c2b7f1a2b3c', 'job-2', 'Ramp', 'Software Engineer Intern', 'New York, NY',
      '${description}', '${description}',
      'https://job-boards.greenhouse.io/ramp/jobs/2', 'https://job-boards.greenhouse.io/ramp/jobs/2',
      now() - interval '6 hours', now() - interval '6 hours'
    )
  `);

  const summary = await runStrongMatchSweep(new Date());
  assert.equal(summary.sent, 1, 'only the picked candidate is sent');
  assert.deepEqual(sent[0]?.to, ['student@example.edu']);
  assert.match(sent[0]?.text ?? '', /job-boards\.greenhouse\.io\/ramp\/jobs\/1/, 'the fresher posting is the one actually sent');
  assert.equal(
    summary.sla_breaches,
    1,
    'the stranded sibling is counted as a breach even though it was never sent or suppressed-and-counted',
  );
});

test('a posting below the floor is not called a strong match', async () => {
  /* The floor is MIN_RANKED_MATCH_SCORE, the SAME number the board hides rows under. A second
     definition of "strong" would mean the email and the board disagreed about the same posting,
     and at that point the score is copy rather than a measurement. */
  await seedBoard('- Deep Kubernetes and Terraform experience\n- Production Go and gRPC services\n- Kafka and Cassandra at scale\n- Prometheus and Grafana in anger');
  await seedResume();
  const summary = await runStrongMatchSweep(new Date());
  assert.equal(summary.failed, 0);
  assert.equal(summary.matched, 0);
  assert.equal(sent.length, 0);
});

test('a posting older than the lookback window is not an opening', async () => {
  // "Tell me when a strong match OPENS". A posting first seen three weeks ago did not open, and
  // sweeping it up would turn the alert into the backlog digest this feature exists instead of.
  await seedBoard(undefined, "now() - interval '20 days'");
  await seedResume();
  const summary = await runStrongMatchSweep(new Date());
  assert.equal(summary.failed, 0);
  assert.equal(summary.matched, 0);
  assert.equal(sent.length, 0);
});

test('an employer-reply row in the ledger does not suppress every match', async () => {
  /* THE NOT IN NULL FOOTGUN, pinned. The already-announced exclusion is `id not in (select
     monitored_job_id from notification_sends ...)`, and employer_reply rows carry a NULL there.
     SQL's NOT IN over a set containing NULL is NULL for EVERY row, so without the `is not null`
     guard in that subquery a single reply notification would silently switch match alerts off for
     that account, permanently, with no error anywhere. */
  await seedBoard();
  await seedResume();
  await database.exec(`
    insert into "notification_sends" ("user_id", "kind", "daily_slot", "dedupe_key", "sent_at")
    values ('${STUDENT}', 'employer_reply', null, 'employer_reply:some-message', now())
  `);
  const summary = await runStrongMatchSweep(new Date());
  assert.equal(summary.failed, 0);
  assert.equal(summary.sent, 1, 'a reply row must not hide the whole board');
  // Same default-fixture note as the other tests above.
  assert.equal(summary.sla_breaches, 1);
});

test('an unsubscribed account is not even considered', async () => {
  await seedBoard();
  await database.exec(`update "users" set notify_strong_match_enabled = false where id = '${STUDENT}'`);
  const summary = await runStrongMatchSweep(new Date());
  assert.equal(summary.considered, 0);
  assert.equal(sent.length, 0);
});

test('a guest and an unverified address are never mailed, whatever the toggle says', async () => {
  /* The toggle is necessary and not sufficient. A guest has no address at all, and an unverified
     one is an address nobody has proved they can read: mailing either buys the sending domain a
     bounce rate, which is charged to every student's application mail. */
  await seedBoard();
  await database.exec(`update "users" set email_verified = false where id = '${STUDENT}'`);
  assert.equal((await runStrongMatchSweep(new Date())).considered, 0);

  await database.exec(`update "users" set email_verified = true, is_guest = true where id = '${STUDENT}'`);
  assert.equal((await runStrongMatchSweep(new Date())).considered, 0);
  assert.equal(sent.length, 0);
});

/** A live greenhouse source with one posting on it, fresh unless told otherwise. */
async function seedBoard(
  requirements = '- Strong TypeScript and React experience\n- Familiarity with Next.js and Tailwind CSS\n- Comfort with PostgreSQL and REST APIs\n- Experience with CI/CD and Git',
  firstSeen = "now() - interval '4 hours'",
) {
  const sourceId = 'c4f0e4a2-7c1f-4a4c-9c53-9c2b7f1a2b3c';
  const description = [
    'About the role',
    'We are a small team shipping quickly.',
    '',
    'Requirements',
    requirements,
    '',
    'Benefits',
    'Unlimited vacation, great coffee, a passionate team.',
  ].join('\n').replace(/'/g, "''");
  await database.exec(`
    insert into "career_page_sources" ("id", "company_name", "ats_name", "board_token", "career_url", "enabled")
    values ('${sourceId}', 'Ramp', 'greenhouse', 'ramp', 'https://ramp.com/careers', true)
  `);
  await database.exec(`
    insert into "monitored_jobs"
      ("source_id", "external_id", "company_name", "title", "location", "description", "description_digest", "apply_url", "posting_url", "posted_at", "first_seen_at")
    values (
      '${sourceId}', 'job-1', 'Ramp', 'Software Engineer Intern', 'New York, NY',
      '${description}', '${description}',
      'https://job-boards.greenhouse.io/ramp/jobs/1', 'https://job-boards.greenhouse.io/ramp/jobs/1',
      now() - interval '4 hours', ${firstSeen}
    )
  `);
}

/** A base resume whose text the scorer can actually read, in the shape resumeSpecText walks. */
async function seedResume() {
  const spec = {
    school: 'University of Southern California',
    degree: 'BS Computer Science',
    grad_date: 'May 2027',
    coursework: 'Data Structures, Databases, Web Development',
    experience: [{
      org: 'Campus Lab',
      title: 'Software Engineering Intern',
      date_range: 'Summer 2026',
      bullets: [
        'Built a dashboard in TypeScript and React on Next.js with Tailwind CSS.',
        'Designed the PostgreSQL schema and the REST API behind it.',
        'Owned the CI/CD pipeline and the Git workflow for a team of six.',
      ],
    }],
    skills: ['TypeScript', 'React', 'Next.js', 'Tailwind CSS', 'PostgreSQL', 'REST APIs', 'CI/CD', 'Git'],
  };
  await database.exec(`
    insert into "profiles" ("user_id", "base_resume_json")
    values ('${STUDENT}', '${JSON.stringify(spec).replace(/'/g, "''")}')
  `);
}
