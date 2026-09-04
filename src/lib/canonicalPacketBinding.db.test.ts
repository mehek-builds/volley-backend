/* The chain the review of the first attempt at this fix (volley #934) proved broken: a URL-less
   canonical row bound at attempt-open, then rejected by attempt projection after the press. Same
   PGlite harness as src/routes/submissionBoundaryAuthorization.db.test.ts. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';

const savedEnv = { ...process.env };
const socketDir = mkdtempSync(join(tmpdir(), 'litos-packet-binding-'));
let database: PGlite;
let server: PGLiteSocketServer;
let backendDb: any;
let backendPool: { end(): Promise<void> };
let binding: typeof import('./canonicalPacketBinding');
let ledger: typeof import('./submissionAttemptLedger');

before(async () => {
  database = await PGlite.create();
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await database.exec(statement);
  server = new PGLiteSocketServer({ db: database, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();
  process.env.NODE_ENV = 'test';
  process.env.VERCEL = '1';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  ({ db: backendDb, pool: backendPool } = await import('../db'));
  binding = await import('./canonicalPacketBinding');
  ledger = await import('./submissionAttemptLedger');
});

after(async () => {
  await backendPool?.end();
  await server?.stop();
  await database.close();
  rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

/* Hudson River Trading packet 4a79eec1 / canonical row f10ece44, measured on Railway prod
   2026-09-04: job id set, portal_url null, first landed run on the current Greenhouse host. */
const HRT = {
  company: 'Hudson River Trading',
  role: 'Software Engineering Internship (C++ or Python) - Summer 2027',
};
const LANDED_URL = 'https://job-boards.greenhouse.io/embed/job_app?for=wehrtyou&token=8052083';
const DESCRIPTION = 'A complete role description with responsibilities, requirements and qualifications long enough for ingestion.';

let sourceId: string | null = null;

async function seedMonitoredJob(applyUrl: string): Promise<string> {
  if (!sourceId) {
    const [source] = await backendDb.insert(schema.career_page_sources).values({
      company_name: HRT.company,
      ats_name: 'greenhouse',
      board_token: 'wehrtyou',
      career_url: 'https://job-boards.greenhouse.io/wehrtyou',
      enabled: true,
    }).returning({ id: schema.career_page_sources.id });
    sourceId = source.id;
  }
  const [job] = await backendDb.insert(schema.monitored_jobs).values({
    source_id: sourceId,
    external_id: `hrt-${randomUUID()}`,
    company_name: HRT.company,
    title: HRT.role,
    description: DESCRIPTION,
    ingest_eligible: true,
    apply_url: applyUrl,
    posting_url: applyUrl,
    last_seen_at: new Date(),
    is_active: true,
  }).returning({ id: schema.monitored_jobs.id });
  return job.id;
}

async function seedCanonicalRow(input: { jobId: string; portalUrl: string | null; company?: string }) {
  const userId = randomUUID();
  const packetId = randomUUID();
  const applicationId = randomUUID();
  const jobContext = { ...HRT, job_id: input.jobId };
  await backendDb.insert(schema.users).values({ id: userId, email: `binding-${userId}@example.test` });
  await backendDb.insert(schema.generated_resumes).values({
    id: packetId, user_id: userId, job_context: jobContext, spec: {}, resume_object_key: `k/${packetId}`,
  });
  await backendDb.insert(schema.applications).values({
    id: applicationId, user_id: userId, legacy_generated_resume_id: packetId, job_id: input.jobId,
    company_scope_key: 'scope:hrt', company_name: input.company ?? HRT.company, role: HRT.role, portal_url: input.portalUrl,
    source_surface: 'dashboard', tracker_state: 'applying', review_state: 'ready',
    selected_resume_artifact_id: null, application_fingerprint: `legacy:${packetId}`,
  });
  return { userId, packetId, applicationId, jobContext };
}

async function readRow(applicationId: string) {
  const [row] = await backendDb.select().from(schema.applications).where(eq(schema.applications.id, applicationId));
  return row;
}

async function openAttempt(userId: string, packetId: string, applicationId: string, frozen: ReturnType<typeof ledger.freezePostingIdentity>) {
  const attemptId = randomUUID();
  return ledger.appendSubmissionAttemptEvent({
    attemptId, userId, packetId, applicationId, source: 'managed_browser', operation: 'initial_submission',
    postingIdentity: frozen, submissionRunId: randomUUID(), submissionClaimId: attemptId, packetVersion: 'packet-v1',
    eventId: ledger.submissionAttemptEventId(attemptId, 'attempt_opened', 'reservation'),
    eventKind: 'attempt_opened', evidenceCode: 'atomic_claim_reserved',
  });
}

function rejectsWith(code: string) {
  return (error: unknown) => error instanceof binding.CanonicalPacketBindingError && error.code === code;
}

test('the HRT shape: attempt-open completes the URL-less row with the landed URL, and the opening then projects back onto it', async () => {
  const jobId = await seedMonitoredJob('https://boards.greenhouse.io/wehrtyou/jobs/8052083');
  const { userId, packetId, applicationId, jobContext } = await seedCanonicalRow({ jobId, portalUrl: null });
  const frozen = ledger.freezePostingIdentity(jobContext, LANDED_URL);
  const bound = await backendDb.transaction((tx: any) =>
    binding.canonicalApplicationForNewPacketAttempt(tx, { userId, packetId, postingIdentity: frozen }));
  assert.equal(bound.id, applicationId);
  assert.equal(bound.portal_url, LANDED_URL);
  const row = await readRow(applicationId);
  assert.equal(row.portal_url, LANDED_URL);
  assert.equal(row.job_id, jobId);
  // The exact chain submissionRunner.ts runs after a press.
  const opened = await openAttempt(userId, packetId, bound.id, frozen);
  assert.equal(opened.event.portal_identity, 'https://job-boards.greenhouse.io');
  const projected = await binding.canonicalApplicationForAttemptProjection(
    backendDb, ledger.submissionAttemptBindingFromEvent(opened.event),
  );
  assert.equal(projected.id, applicationId);
  assert.equal(binding.canonicalApplicationMatchesFrozenPosting(row, ledger.frozenPostingIdentityFromEvent(opened.event)), true);
  // A second open finds the exact row through the strict tier; nothing is written again.
  const again = await binding.canonicalApplicationForNewPacketAttempt(backendDb, { userId, packetId, postingIdentity: frozen });
  assert.equal(again.id, applicationId);
  assert.equal((await readRow(applicationId)).updated_at.toISOString(), row.updated_at.toISOString());
});

test('a landed URL naming a different posting than the monitored job stays unbindable, and the row stays untouched', async () => {
  const jobId = await seedMonitoredJob('https://boards.greenhouse.io/wehrtyou/jobs/8052083');
  const { userId, packetId, applicationId, jobContext } = await seedCanonicalRow({ jobId, portalUrl: null });
  const edited = ledger.freezePostingIdentity(jobContext, 'https://job-boards.greenhouse.io/embed/job_app?for=wehrtyou&token=999');
  await assert.rejects(
    () => binding.canonicalApplicationForNewPacketAttempt(backendDb, { userId, packetId, postingIdentity: edited }),
    rejectsWith('CANONICAL_PACKET_BINDING_MISSING'),
  );
  assert.equal((await readRow(applicationId)).portal_url, null);
});

test('no monitored job, or a landed URL without a provider key, means no completion', async () => {
  const orphanJobId = randomUUID();
  const orphan = await seedCanonicalRow({ jobId: orphanJobId, portalUrl: null });
  await assert.rejects(
    () => binding.canonicalApplicationForNewPacketAttempt(backendDb, {
      userId: orphan.userId, packetId: orphan.packetId,
      postingIdentity: ledger.freezePostingIdentity(orphan.jobContext, LANDED_URL),
    }),
    rejectsWith('CANONICAL_PACKET_BINDING_MISSING'),
  );
  assert.equal((await readRow(orphan.applicationId)).portal_url, null);

  const jobId = await seedMonitoredJob('https://boards.greenhouse.io/wehrtyou/jobs/8052083');
  const keyless = await seedCanonicalRow({ jobId, portalUrl: null });
  await assert.rejects(
    () => binding.canonicalApplicationForNewPacketAttempt(backendDb, {
      userId: keyless.userId, packetId: keyless.packetId,
      postingIdentity: ledger.freezePostingIdentity(keyless.jobContext, 'https://careers.example.com/apply/8052083'),
    }),
    rejectsWith('CANONICAL_PACKET_BINDING_MISSING'),
  );
  assert.equal((await readRow(keyless.applicationId)).portal_url, null);
});

test('a row that holds any URL is never rewritten', async () => {
  const jobId = await seedMonitoredJob('https://boards.greenhouse.io/wehrtyou/jobs/8052083');
  const other = 'https://job-boards.greenhouse.io/embed/job_app?for=janestreet&token=1';
  const { userId, packetId, applicationId, jobContext } = await seedCanonicalRow({ jobId, portalUrl: other });
  await assert.rejects(
    () => binding.canonicalApplicationForNewPacketAttempt(backendDb, {
      userId, packetId, postingIdentity: ledger.freezePostingIdentity(jobContext, LANDED_URL),
    }),
    rejectsWith('CANONICAL_PACKET_BINDING_MISSING'),
  );
  assert.equal((await readRow(applicationId)).portal_url, other);
});

test('the company-and-role guard holds for completion exactly as for the strict match', async () => {
  const jobId = await seedMonitoredJob('https://boards.greenhouse.io/wehrtyou/jobs/8052083');
  const { userId, packetId, applicationId, jobContext } = await seedCanonicalRow({ jobId, portalUrl: null, company: 'Jane Street' });
  await assert.rejects(
    () => binding.canonicalApplicationForNewPacketAttempt(backendDb, {
      userId, packetId, postingIdentity: ledger.freezePostingIdentity(jobContext, LANDED_URL),
    }),
    rejectsWith('CANONICAL_PACKET_BINDING_MISSING'),
  );
  assert.equal((await readRow(applicationId)).portal_url, null);
});

test('the Sage shape: a row on the legacy host binds a run landed on the current host with no write at all', async () => {
  const legacy = 'https://boards.greenhouse.io/embed/job_app?for=wehrtyou&token=8052083';
  const jobId = await seedMonitoredJob(legacy);
  const { userId, packetId, applicationId, jobContext } = await seedCanonicalRow({ jobId, portalUrl: legacy });
  const before = await readRow(applicationId);
  const frozen = ledger.freezePostingIdentity(jobContext, LANDED_URL);
  const bound = await binding.canonicalApplicationForNewPacketAttempt(backendDb, { userId, packetId, postingIdentity: frozen });
  assert.equal(bound.id, applicationId);
  const after = await readRow(applicationId);
  assert.equal(after.portal_url, legacy);
  assert.equal(after.updated_at.toISOString(), before.updated_at.toISOString());
  const opened = await openAttempt(userId, packetId, bound.id, frozen);
  const projected = await binding.canonicalApplicationForAttemptProjection(
    backendDb, ledger.submissionAttemptBindingFromEvent(opened.event),
  );
  assert.equal(projected.id, applicationId);
});
