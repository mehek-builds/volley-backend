import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';

/* WHY THE DROP IS TESTED AGAINST A REAL DATABASE.
 *
 * The bug this file guards was not a wrong answer, it was an invisible one. Between 2026-08-10 and
 * this change, a message the forwarding whitelist refused was written with direction 'inbound',
 * forwarded_at NULL and forward_error NULL, which is byte for byte what an unprocessed message
 * looks like. Nothing in the row said a decision had been taken, so the drop could not be counted,
 * queried, or noticed, and an activation link, a password reset and an offer letter all ended
 * there.
 *
 * That is a claim about the ROW, and no amount of asserting on the return value of a pure function
 * can demonstrate it. So the fixture is PGlite speaking the real wire protocol over a unix socket:
 * the production `db` module connects with the production driver, the DDL is generated from
 * db/schema.ts at run time so it cannot drift, and the assertions read the columns a human or a
 * monitor would read.
 *
 * No mail is sent. globalThis.fetch is replaced for the duration, and the withheld case asserts it
 * was never called at all.
 */

const ENCRYPTION_KEY = 'application-email-forward-decision-test-key';
const JWT_SIGNING_SECRET = 'application-email-forward-decision-test-secret';
const ALIAS = 'app-2222222222-abcdef012345@apply.litos.test';
const FORWARD_TO = 'applicant@example.com';

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
  RESEND_FROM: process.env.RESEND_FROM,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  LITOS_APPLICATION_EMAIL_DOMAIN: process.env.LITOS_APPLICATION_EMAIL_DOMAIN,
};
const previousFetch = globalThis.fetch;

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let db: typeof import('../db/index')['db'];
let pool: typeof import('../db/index')['pool'];
let schema: typeof import('../db/schema');
let service: typeof import('./applicationEmail');
let applicationId: string;
let sends: Array<{ url: string; body: Record<string, unknown> }> = [];

/** Every outbound send, captured. Nothing leaves the process. */
function captureSends(): void {
  sends = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sends.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify({ id: 'email_captured' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;
  process.env.RESEND_FROM = 'applications@litos.test';
  process.env.RESEND_API_KEY = 're_test_never_used';
  // Left unset on purpose: the deliverability probe short-circuits to 'alias_not_configured'
  // without touching DNS or Resend, so applicationEmailHealth here measures only the database.
  delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-forward-decision-'));
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

  schema = await import('../db/schema');
  const dbModule = await import('../db/index');
  db = dbModule.db;
  pool = dbModule.pool;
  service = await import('./applicationEmail');

  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await pglite.exec(statement);

  const [user] = await db.insert(schema.users).values({ email: FORWARD_TO }).returning();
  /* A packet that submitted once and is waiting on an emailed code, with the request timestamped
   * to the minute of the run. This is the one state in which Litos withholds anything. */
  const [application] = await db.insert(schema.generated_resumes).values({
    user_id: user.id,
    job_context: { company: 'Acme', title: 'Software Engineer Intern' },
    resume_object_key: 'fixtures/forward-decision.pdf',
    spec: {
      _review: {
        jd_text: 'fixture',
        status: 'awaiting_security_code',
        security_code: { digits: 8, requested_at: new Date().toISOString(), submit_was_authorized: true },
      },
    },
  }).returning();
  applicationId = application.id;

  await db.insert(schema.application_email_aliases).values({
    alias: ALIAS,
    user_id: user.id,
    generated_resume_id: applicationId,
    forward_to: FORWARD_TO,
    status: 'active',
  });
});

after(async () => {
  globalThis.fetch = previousFetch;
  await pool?.end();
  await server?.stop();
  await pglite?.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function messageByProviderId(providerMessageId: string) {
  const rows = await db
    .select()
    .from(schema.application_email_messages)
    .where(eq(schema.application_email_messages.provider_message_id, providerMessageId))
    .limit(1);
  return rows[0];
}

test('a code withheld from a live run records a machine-readable reason on its own row', async () => {
  captureSends();
  const result = await service.processInboundApplicationEmail({
    provider: 'resend',
    providerMessageId: 'withheld-code-1',
    from: 'no-reply@us.greenhouse-mail.io',
    to: [ALIAS],
    subject: 'Your security code',
    text: 'Copy and paste this code into the security code field on your application: TPHJrFMJ.',
    receivedAt: new Date(),
  });
  assert.equal(result.accepted, true);
  assert.equal(result.classification, 'verification_code');
  assert.equal(result.forwarded, false);
  assert.equal(result.reason, 'security_code_in_flight');

  const row = await messageByProviderId('withheld-code-1');
  assert.ok(row, 'the message is still stored: withholding is not discarding');
  assert.equal(row.direction, 'inbound');
  assert.equal(row.forwarded_at, null);
  assert.equal(row.forward_error, null, 'a policy is not an error, and must not be filed as one');
  /* THE WHOLE POINT. Before this column, the three assertions above were the entire row, and they
   * are exactly what an unprocessed message looks like. */
  assert.equal(row.forward_decision, 'withheld:security_code_in_flight');
  assert.match(row.forward_decision ?? '', /^withheld:[a-z][a-z0-9_]*$/);
  assert.equal(sends.length, 0, 'a withheld message sends nothing');
});

test('an account activation reaches the applicant, and the row says it was meant to', async () => {
  captureSends();
  const result = await service.processInboundApplicationEmail({
    provider: 'resend',
    providerMessageId: 'activation-1',
    from: 'no-reply@myworkday.com',
    to: [ALIAS],
    subject: 'Activate your candidate account',
    text: 'Activate your candidate account: https://acme.wd1.myworkdayjobs.com/activate?t=xyz',
    receivedAt: new Date(),
  });
  assert.equal(result.classification, 'account_registration');
  assert.equal(result.forwarded, true, 'without this, an account-walled portal can never be registered on');

  const row = await messageByProviderId('activation-1');
  assert.ok(row);
  assert.equal(row.direction, 'forwarded');
  assert.ok(row.forwarded_at);
  assert.equal(row.forward_decision, 'forward');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].url, 'https://api.resend.com/emails');
  assert.deepEqual(sends[0].body.to, [FORWARD_TO]);
});

test('an offer letter the classifier cannot name still reaches the person it was addressed to', async () => {
  captureSends();
  const result = await service.processInboundApplicationEmail({
    provider: 'resend',
    providerMessageId: 'offer-1',
    from: 'people@acme.com',
    to: [ALIAS],
    subject: 'Your offer from Acme',
    text: 'We are delighted to extend an offer for the Software Engineer role.',
    receivedAt: new Date(),
  });
  assert.equal(result.classification, 'other');
  assert.equal(result.forwarded, true);
  const row = await messageByProviderId('offer-1');
  assert.equal(row?.forward_decision, 'forward');
  assert.equal(sends.length, 1);
});

test('the health probe can see the withheld message, which last_inbound_message_at cannot', async () => {
  const health = await service.applicationEmailHealth();
  assert.equal(health.withheld_messages_recent, 1);
  assert.equal(health.withheld_messages_window_hours, 24);
  // The field that used to be the only message fact here is fresh at the same moment, which is why
  // it could not report the outage.
  assert.ok(health.last_inbound_message_at);
});
