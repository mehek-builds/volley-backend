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
let userId: string;
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
  userId = user.id;
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

/* THE ORDINARY ATS LAYOUT, driven through the live path with a code window open.
 *
 * This is how the classifier and the reader were caught disagreeing: the code sits on its own line,
 * which the reader flattens away and the classifier could not cross, so the message classified
 * account_registration, a class with no in-flight gate, and forwarded while the runner could still
 * read the very same code out of the very same row. Measured before the fix at forwarded=true,
 * sends=1 for all three shapes. */
test('a code on its own line is withheld, because that is the layout employers actually use', async () => {
  const layouts = [
    ['race-security', 'Your security code', 'Hi Mehek,\n\nplease enter the code below to continue:\n\n483920\n\nThanks'],
    ['race-verification', 'Confirm your email address', 'To confirm your email address, use this verification code:\n\n739104'],
    ['race-confirmation', 'Complete your sign in', 'Your confirmation is required.\n\n204815\n\nEnter it on the page you left open.'],
  ] as const;
  for (const [id, subject, text] of layouts) {
    captureSends();
    const result = await service.processInboundApplicationEmail({
      provider: 'resend',
      providerMessageId: id,
      from: 'no-reply@us.greenhouse-mail.io',
      to: [ALIAS],
      subject,
      text,
      receivedAt: new Date(),
    });
    assert.equal(result.classification, 'verification_code', id);
    assert.equal(result.forwarded, false, id);
    assert.equal(result.reason, 'security_code_in_flight', id);
    assert.equal(sends.length, 0, `${id} must not race the runner for the code it carries`);
    assert.equal((await messageByProviderId(id))?.forward_decision, 'withheld:security_code_in_flight', id);
  }
});

/* And the mail that finishes a registration still goes out during that same window, because a
 * one-time LINK is a door rather than a credential. */
test('a one-time activation link is forwarded even while a code is in flight', async () => {
  captureSends();
  const result = await service.processInboundApplicationEmail({
    provider: 'resend',
    providerMessageId: 'link-activate',
    from: 'no-reply@myworkday.com',
    to: [ALIAS],
    subject: 'Activate your candidate account',
    text: 'Use your one-time activation link to finish setting up your account:\nhttps://acme.example.com/activate?t=abc',
    receivedAt: new Date(),
  });
  assert.equal(result.classification, 'account_registration');
  assert.equal(result.forwarded, true, 'withholding this is refusing the one message that passes the wall');
  assert.equal(sends.length, 1);
});

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

/* THE SPOOFED OFFER. An employer message never reached routeInboundApplicationEmail's authentication
 * check, because it returns at `sender !== forwardTo` first, so widening the forwarding policy would
 * have relayed DMARC-failing mail onward from Litos's own verified sending identity. The gate is in
 * the forwarding decision rather than at the door, so the message is still written down. */
test('a DMARC-failing employer message is stored, withheld, and never sent anywhere', async () => {
  captureSends();
  const result = await service.processInboundApplicationEmail({
    provider: 'resend',
    providerMessageId: 'spoofed-offer-1',
    from: 'people@acme.com',
    to: [ALIAS],
    subject: 'Your offer from Acme',
    text: 'Congratulations. Open the attached offer and confirm your bank details.',
    authentication: { spf: 'pass', dkim: 'fail', dmarc: 'fail' },
    receivedAt: new Date(),
  });
  assert.equal(result.accepted, true);
  assert.equal(result.forwarded, false);
  assert.equal(result.reason, 'sender_authentication_failed');
  assert.equal(sends.length, 0, 'nothing may leave Litos on behalf of a sender the provider rejected');

  const row = await messageByProviderId('spoofed-offer-1');
  assert.ok(row, 'a suspected forgery is evidence, and evidence is kept');
  assert.equal(row.direction, 'inbound');
  assert.equal(row.forwarded_at, null);
  assert.equal(row.forward_decision, 'withheld:sender_authentication_failed');
});

/* The same message with the same words and an ordinary set of verdicts. Without this the test above
 * would pass on a system that had simply stopped forwarding. */
test('the identical message with passing authentication is forwarded', async () => {
  captureSends();
  const result = await service.processInboundApplicationEmail({
    provider: 'resend',
    providerMessageId: 'genuine-offer-1',
    from: 'people@acme.com',
    to: [ALIAS],
    subject: 'Your offer from Acme',
    text: 'Congratulations. Open the attached offer and confirm your bank details.',
    authentication: { spf: 'softfail', dkim: 'pass', dmarc: 'pass' },
    receivedAt: new Date(),
  });
  assert.equal(result.forwarded, true, 'an SPF softfail is what ordinary forwarded mail looks like');
  assert.equal(sends.length, 1);
  const row = await messageByProviderId('genuine-offer-1');
  assert.equal(row?.forward_decision, 'forward');
});

/* THE REPLAY, END TO END. The same provider message delivered twice: refused on the first, and on
 * the second arriving with no Authentication-Results at all. The dedupe key makes it one row, so
 * the second delivery re-reads what the first decided.
 *
 * Measured before the stored decision was read back: delivery two forwarded the message AND
 * overwrote the annotation to 'forward', so the ledger afterwards said Litos had chosen to send a
 * message it had already judged forged. */
test('a redelivery with no authentication header cannot un-refuse a message', async () => {
  const message = {
    provider: 'resend' as const,
    providerMessageId: 'replay-1',
    from: 'people@acme.com',
    to: [ALIAS],
    subject: 'Your offer from Acme',
    text: 'Congratulations. Confirm your bank details to accept.',
    receivedAt: new Date(),
  };
  captureSends();
  const first = await service.processInboundApplicationEmail({
    ...message,
    authentication: { spf: 'pass', dkim: 'fail', dmarc: 'fail' },
  });
  assert.equal(first.forwarded, false);
  assert.equal(first.reason, 'sender_authentication_failed');
  assert.equal((await messageByProviderId('replay-1'))?.forward_decision, 'withheld:sender_authentication_failed');

  // Same message, redelivered, this time with the header absent entirely.
  const second = await service.processInboundApplicationEmail(message);
  assert.equal(second.forwarded, false, 'silence on a redelivery is not a new verdict');
  assert.equal(second.reason, 'sender_authentication_failed');
  assert.equal(sends.length, 0, 'nothing was mailed on either delivery');
  assert.equal(
    (await messageByProviderId('replay-1'))?.forward_decision,
    'withheld:sender_authentication_failed',
    'and the record of the refusal survives, rather than being overwritten with forward',
  );
});

test('the health probe can see the withheld messages, which last_inbound_message_at cannot', async () => {
  const health = await service.applicationEmailHealth();
  // Three codes on their own line, one code named outright, one spoofed offer, one replay of it.
  assert.equal(health.withheld_messages_recent, 6);
  assert.equal(health.withheld_messages_window_hours, 24);
  // The field that used to be the only message fact here is fresh at the same moment, which is why
  // it could not report the outage.
  assert.ok(health.last_inbound_message_at);
});

/* THE DEPLOY THAT LEADS ITS MIGRATION, measured rather than asserted.
 *
 * On Vercel a merge is a deploy, so this code can be live for as long as it takes somebody to run
 * `npm run db:application-email-forward-decision`. The tolerance is only worth having if it is the
 * real Drizzle error being caught, and the last time this repo trusted a bare `error.code ===
 * '42703'` it was measured to never match, because Drizzle wraps the pg error in a
 * DrizzleQueryError whose own code is undefined. So this drops the column for real and drives the
 * live path through it.
 *
 * LAST IN THE FILE ON PURPOSE: it leaves the fixture without the column.
 */
test('mail is still delivered, and the export still answers, on an unmigrated database', async () => {
  /* The account export read BEFORE the drop, so the assertion after it is about the fallback and
   * not about a helper that never returns the column at all. */
  const migrated = await service.selectApplicationEmailMessagesForUser(userId);
  assert.ok(migrated.length > 0);
  assert.ok(
    migrated.some((row) => typeof row.forward_decision === 'string'),
    'with the column present the export carries the decision',
  );

  await pglite.exec('alter table application_email_messages drop column forward_decision');
  captureSends();
  const result = await service.processInboundApplicationEmail({
    provider: 'resend',
    providerMessageId: 'pre-migration-1',
    from: 'no-reply@myworkday.com',
    to: [ALIAS],
    subject: 'Verify your account',
    text: 'Verify your account to finish your candidate profile.',
    receivedAt: new Date(),
  });
  // The writer swallows the one error that means "the migration has not run", and only that one.
  assert.equal(result.classification, 'account_registration');
  assert.equal(result.forwarded, true, 'a missing annotation column must never cost the applicant her mail');
  assert.equal(sends.length, 1);

  /* GET /account/export was a bare select, which is the form that breaks: the reviewer had Drizzle
   * emit it against production on this branch's head and it answered `column "forward_decision"
   * does not exist`. It is the endpoint backing the promise that she can have everything we hold. */
  const unmigrated = await service.selectApplicationEmailMessagesForUser(userId);
  assert.ok(unmigrated.length > migrated.length, 'the export still returns every message she holds');
  assert.ok(
    unmigrated.every((row) => row.forward_decision === undefined),
    'the annotation is what is dropped, never the messages',
  );

  /* THE RETURN LEG, which the first sweep missed because it looked for bare SELECTs. relayApplicantReply
   * INSERTs, and an insert is the statement Drizzle fills out with every declared column, so on an
   * unmigrated database this threw, the webhook 500d, Resend retried and gave up, and the
   * applicant's answer never reached the employer. */
  captureSends();
  const relayed = await service.processInboundApplicationEmail({
    provider: 'resend',
    providerMessageId: 'pre-migration-reply-1',
    from: FORWARD_TO,
    to: [ALIAS],
    subject: 'Re: Activate your candidate account',
    text: 'Thanks, I have activated the account.',
    receivedAt: new Date(),
  });
  assert.equal(relayed.accepted, true);
  assert.equal(relayed.relayed, true, 'her reply must leave even when the deploy leads its migration');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.from, ALIAS, 'and it leaves as the alias, not from her own mailbox');

  // And the health reader reports "unmeasurable", never "none": those are different answers.
  const health = await service.applicationEmailHealth();
  assert.equal(health.withheld_messages_recent, null);
  assert.ok(health.last_inbound_message_at, 'the rest of the probe still works');
});
