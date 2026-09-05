/* THE 2026-09-02 01:30 UTC PRODUCTION STALL, AS THREE PROPERTIES OF ONE ADVISORY KEY.
 *
 * One managed prepare for one account held `submission-attempt:<userId>` across a stratus call
 * whose deadline is MANAGED_PREPARE_FILL_DEADLINE_MS (280s). A backend sat "idle in transaction"
 * for 47s, two more queued behind it, GET /resume/history did not return in 25s, and /applications,
 * /profile, /me, /billing/state and /resume/base each took 7.7s while the Applications page showed
 * a loading skeleton and the prepare screen showed a raw "Failed to fetch". The fence needs mutual
 * exclusion with account deletion and nothing else; it was buying that with the key every ledger
 * reader and the submission-authority revision trigger also take.
 *
 * WHY THIS FILE RUNS REAL POSTGRESQL RATHER THAN PGlite, unlike the other *.db.test.ts files.
 * Every property here is "B does not wait for A". PGlite is one WASM backend behind a socket
 * server: while any connection holds an open transaction, a bare `select 1` on a second connection
 * blocks too (measured). It cannot tell "blocked on an advisory lock" from "blocked on the single
 * backend", so it cannot express a non-blocking assertion at all. This follows the ephemeral-server
 * precedent in db/submissionAuthorityRevisionMigration.test.ts, including its skip when the local
 * PostgreSQL binaries are absent.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { eq, sql } from 'drizzle-orm';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import pg from 'pg';
import * as schema from '../db/schema';

const JWT_SECRET = 'provider-call-fence-test-secret-32-chars';
const savedEnv = { ...process.env };

function executableIsAvailable(command: string): boolean {
  const probe = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return probe.status === 0 && !probe.error;
}

const postgresAvailable = executableIsAvailable('initdb') && executableIsAvailable('postgres');

let postgresRoot: string | null = null;
let postgresServer: ChildProcess | null = null;
let app: FastifyInstance;
let backendDb: any;
let backendPool: { end(): Promise<void> };
let lockSubmissionAttemptUser:
  typeof import('../lib/submissionAttemptLedger').lockSubmissionAttemptUser;
let lockSubmissionProviderCallUser:
  typeof import('../lib/submissionAttemptLedger').lockSubmissionProviderCallUser;
let SubmissionProviderCallLockTimeoutError:
  typeof import('../lib/submissionAttemptLedger').SubmissionProviderCallLockTimeoutError;
let withProviderCallFence: typeof import('../lib/submissionAccountFence').withProviderCallFence;
let authoritativeSubmissionProjection:
  typeof import('../lib/authoritativeSubmissionProjection').authoritativeSubmissionProjection;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function applyAuthorityRevisionSchema(databaseUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/apply-submission-authority-revision-schema.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`Authority revision migration exited ${code}: ${output}`))));
  });
}

before(async () => {
  if (!postgresAvailable) return;
  /* /tmp, not os.tmpdir(): a Unix-domain socket path has a 103-byte ceiling, and macOS's
   * per-user /var/folders temp directory spends most of it before the socket name. */
  postgresRoot = mkdtempSync(join('/tmp', 'provider-fence-pg-'));
  const dataDir = join(postgresRoot, 'data');
  const socketDir = join(postgresRoot, 'socket');
  mkdirSync(socketDir);
  const initialized = spawnSync('initdb', [
    '-D', dataDir,
    '--auth-local=trust',
    '--auth-host=trust',
    '--encoding=UTF8',
    '--no-locale',
    '--username=postgres',
  ], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, `initdb failed: ${initialized.stderr || initialized.stdout}`);

  postgresServer = spawn('postgres', ['-D', dataDir, '-k', socketDir, '-h', '', '-p', '5432'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  postgresServer.stdout?.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
  postgresServer.stderr?.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });

  const databaseUrl = `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socketDir)}`;
  let admin: pg.Client | null = null;
  for (let attempt = 0; attempt < 200 && !admin; attempt += 1) {
    const candidate = new pg.Client({ connectionString: databaseUrl });
    try {
      await candidate.connect();
      admin = candidate;
    } catch {
      await candidate.end().catch(() => undefined);
      await delay(25);
    }
  }
  assert.ok(admin, `PostgreSQL did not start: ${serverOutput}`);
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await admin.query(statement);
  await admin.end();
  await applyAuthorityRevisionSchema(databaseUrl);

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.JWT_SIGNING_SECRET = JWT_SECRET;
  process.env.ENCRYPTION_KEY = 'provider-call-fence-test-encryption-key-32';
  process.env.DATABASE_URL = databaseUrl;
  /* VERCEL is deliberately unset: it pins the backend pool to one connection (db/index.ts), and
   * every assertion here needs a parked provider call plus a concurrent reader. */
  ({ db: backendDb, pool: backendPool } = await import('../db'));
  ({ lockSubmissionAttemptUser, lockSubmissionProviderCallUser, SubmissionProviderCallLockTimeoutError } =
    await import('../lib/submissionAttemptLedger'));
  ({ withProviderCallFence } = await import('../lib/submissionAccountFence'));
  ({ authoritativeSubmissionProjection } = await import('../lib/authoritativeSubmissionProjection'));
  const { resumeRoutes } = await import('./resume');
  const { applicationRoutes } = await import('./applications');
  // FENCE_TEST_LOG=1 turns the route logger on when a 500 here needs its stack.
  app = Fastify({ logger: process.env.FENCE_TEST_LOG === '1' });
  await app.register(applicationRoutes);
  await app.register(resumeRoutes);
  await app.ready();
});

after(async () => {
  await app?.close().catch(() => undefined);
  await backendPool?.end().catch(() => undefined);
  if (postgresServer) {
    postgresServer.kill('SIGQUIT');
    await new Promise<void>((resolve) => { postgresServer!.on('close', () => resolve()); });
  }
  if (postgresRoot) rmSync(postgresRoot, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

/** Hold the provider-call fence open until the returned release is called. */
async function parkedProviderCall(userId: string): Promise<{ release: () => void; finished: Promise<void> }> {
  let reportInside!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((resolve) => { reportInside = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const finished = withProviderCallFence(userId, async () => {
    reportInside();
    await gate;
  });
  await inside;
  return { release, finished };
}

/** Assert `work` settles inside `budgetMs`, the way a dashboard read has to. */
async function settlesWhileFenced<T>(label: string, work: Promise<T>, budgetMs = 250): Promise<T> {
  let settled = false;
  const tracked = work.then(
    (value) => { settled = true; return value; },
    (error) => { settled = true; throw error; },
  );
  tracked.catch(() => { /* a late failure is the assertion below, not an unhandled rejection */ });
  await delay(budgetMs);
  assert.ok(settled, `${label} was still blocked ${budgetMs}ms into an in-flight provider call`);
  return tracked;
}

async function fencedUserWithPacket(): Promise<{ userId: string; packetId: string; bearer: string }> {
  const userId = randomUUID();
  await backendDb.insert(schema.users).values({
    id: userId,
    email: `provider-fence-${userId}@example.test`,
    password_hash: 'x',
  });
  const packetId = randomUUID();
  await backendDb.insert(schema.generated_resumes).values({
    id: packetId,
    user_id: userId,
    job_context: { company: 'Example Company', role: 'Example Role' },
    spec: { _review: { status: 'ready', questions: [], updated_at: new Date().toISOString() } },
    resume_object_key: `resumes/${packetId}.pdf`,
  });
  const bearer = await new SignJWT({ userId, isGuest: false, sessionVersion: 0, authMethod: 'password' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(JWT_SECRET));
  return { userId, packetId, bearer };
}

test('dashboard reads do not wait behind an in-flight provider call', { timeout: 120_000 }, async (context) => {
  if (!postgresAvailable) return context.skip('local PostgreSQL binaries are unavailable');
  const { userId, packetId, bearer } = await fencedUserWithPacket();
  const parked = await parkedProviderCall(userId);
  try {
    // The passive projection path, which every first-send envelope read pays for.
    await settlesWhileFenced(
      'authoritativeSubmissionProjection',
      authoritativeSubmissionProjection({ userId, packetIds: [] }),
    );
    const history = await settlesWhileFenced('GET /resume/history', app.inject({
      method: 'GET',
      url: '/resume/history',
      headers: { authorization: `Bearer ${bearer}` },
    }));
    assert.equal(history.statusCode, 200, history.body);
    // The 2.5s dashboard poll, which ran repairExpiredAttendedHandoffClaim unconditionally.
    const submission = await settlesWhileFenced(`GET /applications/${packetId}/submission`, app.inject({
      method: 'GET',
      url: `/applications/${packetId}/submission`,
      headers: { authorization: `Bearer ${bearer}` },
    }));
    assert.equal(submission.statusCode, 200, submission.body);
  } finally {
    parked.release();
    await parked.finished;
  }
});

test('a ledger writer is not 40001-ed by an in-flight provider call', { timeout: 120_000 }, async (context) => {
  if (!postgresAvailable) return context.skip('local PostgreSQL binaries are unavailable');
  const { userId, packetId } = await fencedUserWithPacket();
  const parked = await parkedProviderCall(userId);
  try {
    /* generated_resumes carries the submission-authority revision trigger, which try-locks the
     * LEDGER key and raises 40001 when it cannot have it. index.ts maps that to a 503 "This
     * account changed at the same time", so while the fence held that key every single-statement
     * write to this user's generated_resumes, applications or artifacts 503-ed for the whole fill. */
    const written = await settlesWhileFenced<{ id: string }[]>('generated_resumes update', backendDb
      .update(schema.generated_resumes)
      .set({ pipeline_stage: 'applied' })
      .where(eq(schema.generated_resumes.id, packetId))
      .returning({ id: schema.generated_resumes.id }));
    assert.equal(written.length, 1);
  } finally {
    parked.release();
    await parked.finished;
  }
});

test('an account deletion drain waits for an in-flight provider call and then fences it', { timeout: 120_000 }, async (context) => {
  if (!postgresAvailable) return context.skip('local PostgreSQL binaries are unavailable');
  const { userId } = await fencedUserWithPacket();
  const parked = await parkedProviderCall(userId);
  let drained = false;
  /* The exact two-lock order account.ts takes, ledger key first and provider-call key second. That
   * the route itself takes them in that order is pinned in submissionRunner.test.ts. */
  const deletion = backendDb.transaction(async (tx: any) => {
    await lockSubmissionAttemptUser(tx, userId);
    await lockSubmissionProviderCallUser(tx, userId);
    await tx.insert(schema.managed_submission_account_deletion_drains).values({ user_id: userId });
  }).then(() => { drained = true; });
  deletion.catch(() => { /* asserted below */ });

  await new Promise<void>((resolve) => { setImmediate(resolve); });
  await delay(250);
  assert.equal(drained, false, 'a drain must not commit while a provider call for that user is in flight');

  parked.release();
  await parked.finished;
  await deletion;
  assert.equal(drained, true);

  await assert.rejects(
    withProviderCallFence(userId, async () => 'unreachable'),
    (error: unknown) => typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'SUBMISSION_ACCOUNT_DELETION_DRAINING',
  );
});

/* THE 2026-09-05 UNBOUNDED-WAIT INVESTIGATION, AGAINST A REAL CONTENDED LOCK.
 *
 * lockSubmissionProviderCallUser's acquire has no timeout of its own; a holder that never releases
 * `submission-provider-call:<userId>` queued out every later call for that account forever, with no
 * error and no way to tell "busy" from "wedged" - see submissionAccountFence.ts's
 * PROVIDER_CALL_LOCK_TIMEOUT_MS for the full incident reasoning. submissionProviderCallLockTimeout.
 * test.ts already pins the exact statement sequence and the 55P03 classification against a fake
 * executor; what only a real server can prove is that SET LOCAL lock_timeout actually turns a
 * contended pg_advisory_xact_lock into that error, on the wall clock, without disturbing the holder.
 */
test('a bounded acquire on a genuinely contended lock times out, and the holder is unaffected', { timeout: 120_000 }, async (context) => {
  if (!postgresAvailable) return context.skip('local PostgreSQL binaries are unavailable');
  const { userId } = await fencedUserWithPacket();
  const parked = await parkedProviderCall(userId);
  try {
    const startedAt = Date.now();
    await assert.rejects(
      backendDb.transaction((tx: any) => lockSubmissionProviderCallUser(tx, userId, { lockTimeoutMs: 300 })),
      (error: unknown) => {
        assert.ok(error instanceof SubmissionProviderCallLockTimeoutError);
        assert.equal((error as { code: string }).code, 'SUBMISSION_PROVIDER_CALL_LOCK_TIMEOUT');
        return true;
      },
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 300, `expected the wait to last the full requested 300ms, took ${elapsedMs}ms`);
    // Generous ceiling: this proves the wait was BOUNDED, not that it was fast. A real hang before
    // this fix would have left this assertion waiting for the outer 120s test timeout instead.
    assert.ok(elapsedMs < 30_000, `expected the timeout to fire near 300ms, took ${elapsedMs}ms`);
  } finally {
    // THE INVARIANT THIS FIX MUST NOT TOUCH: the timed-out waiter above must not have disturbed the
    // holder's own lock in any way. If it had, releasing here would find nothing to release, or the
    // parked call's own `withProviderCallFence` would already have rejected.
    parked.release();
    await parked.finished;
  }
});

test('withProviderCallFence itself surfaces the typed timeout end to end, before the callback runs', { timeout: 120_000 }, async (context) => {
  if (!postgresAvailable) return context.skip('local PostgreSQL binaries are unavailable');
  const { userId } = await fencedUserWithPacket();
  const parked = await parkedProviderCall(userId);
  let callbackRan = false;
  try {
    await assert.rejects(
      withProviderCallFence(userId, async () => { callbackRan = true; }, { lockTimeoutMs: 300 }),
      SubmissionProviderCallLockTimeoutError,
    );
    assert.equal(callbackRan, false, 'the fenced callback must never run when the lock wait itself times out');
  } finally {
    parked.release();
    await parked.finished;
  }
});

test('an uncontended bounded acquire succeeds immediately and resets lock_timeout before returning', { timeout: 120_000 }, async (context) => {
  if (!postgresAvailable) return context.skip('local PostgreSQL binaries are unavailable');
  const { userId } = await fencedUserWithPacket();
  await backendDb.transaction(async (tx: any) => {
    const startedAt = Date.now();
    await lockSubmissionProviderCallUser(tx, userId, { lockTimeoutMs: 300 });
    assert.ok(Date.now() - startedAt < 300, 'an uncontended acquire must not wait anywhere near the timeout');
    // Proves the reset actually reaches PostgreSQL, not only that this file's own code calls it: a
    // lock_timeout left live here would silently bound whatever this same transaction does next.
    const setting = await tx.execute(sql`show lock_timeout`);
    assert.equal(setting.rows[0].lock_timeout, '0', 'lock_timeout must be back to its default (off) after a successful acquire');
  });
});
