/* HUDSON RIVER TRADING, PACKET 4a79eec1, MEASURED LIVE 2026-09-04.
 *
 * Pressing Send stopped immediately: "The generated packet has no owned canonical application
 * binding." The canonical row (f10ece44) carried `legacy_generated_resume_id: 4a79eec1` - the
 * pointer was there - and `applications_legacy_resume_unique` guarantees at most one row can ever
 * hold that pointer, so the query behind canonicalApplicationForNewPacketAttempt had exactly one
 * candidate. The only way oneExactCandidate still throws CANONICAL_PACKET_BINDING_MISSING against
 * a single candidate is a posting-identity mismatch: the canonical row's stored company_name /
 * role / job_id / portal_url disagree with the packet's OWN live posting identity.
 *
 * applicationPortalRepair.ts:keepUsedPortal documents the live mechanism, against this exact
 * packet, two days earlier: repairReviewPortalFromMonitoredJob restores the packet's stored
 * `_review.portal_url` from `monitored_jobs.apply_url` on every prepare, and that apply URL can
 * carry a different ATS board token than whatever was true when the canonical row was created -
 * Hudson River Trading's Greenhouse board answers to `wehrtyou`, not to a token guessed from the
 * company name. atsPostingKey encodes that token, and frozenPostingIdentitiesMatch requires an
 * EXACT postingKey match once one is present. No writer in canonicalApplicationSync.ts ever
 * refreshes the canonical row's own company_name/role/job_id/portal_url after the row is created,
 * so a canonical row can silently go stale the moment a later prepare corrects the packet's own
 * portal_url.
 *
 * These tests pin the repair added to canonicalApplicationForNewPacketAttempt: a CURRENT pointer
 * (proven by the unique pointer plus user_id) whose posting label has merely gone stale is healed
 * toward the packet's own live identity and re-checked, rather than refused. Ownership and the
 * pointer requirement are exercised as unchanged: a pointer for a different user, and a packet with
 * no pointer at all, still refuse exactly as before.
 */
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
const socketDir = mkdtempSync(join(tmpdir(), 'litos-canonical-packet-binding-'));
let database: PGlite;
let server: PGLiteSocketServer;
let backendDb: any;
let backendPool: { end(): Promise<void> };
let canonicalApplicationForNewPacketAttempt:
  typeof import('./canonicalPacketBinding').canonicalApplicationForNewPacketAttempt;
let CanonicalPacketBindingError: typeof import('./canonicalPacketBinding').CanonicalPacketBindingError;
let canonicalApplicationMatchesFrozenPosting:
  typeof import('./canonicalPacketBinding').canonicalApplicationMatchesFrozenPosting;
let freezePostingIdentity: typeof import('./submissionAttemptLedger').freezePostingIdentity;

before(async () => {
  database = await PGlite.create();
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await database.exec(statement);
  server = new PGLiteSocketServer({
    db: database,
    path: join(socketDir, '.s.PGSQL.5432'),
    maxConnections: 10,
  });
  await server.start();
  process.env.NODE_ENV = 'test';
  process.env.VERCEL = '1';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  ({ db: backendDb, pool: backendPool } = await import('../db'));
  ({
    canonicalApplicationForNewPacketAttempt,
    CanonicalPacketBindingError,
    canonicalApplicationMatchesFrozenPosting,
  } = await import('./canonicalPacketBinding'));
  ({ freezePostingIdentity } = await import('./submissionAttemptLedger'));
});

after(async () => {
  await backendPool?.end();
  await server?.stop();
  await database.close();
  rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

const HRT_JOB_ID = randomUUID();
/* The company name's own guess at a board token. Real value stored on the canonical row when it
   was first added, before Litos had ever driven a fill against the employer's actual form. */
const STALE_PORTAL_URL = 'https://job-boards.greenhouse.io/hudsonrivertrading/jobs/24680';
/* The board token a managed fill actually used - restored onto the PACKET's own review by
   repairReviewPortalFromMonitoredJob, per applicationPortalRepair.ts:keepUsedPortal. Same numeric
   job id, different tenant, which is exactly what makes atsPostingKey disagree. */
const LIVE_PORTAL_URL = 'https://job-boards.greenhouse.io/wehrtyou/jobs/24680';

async function seedUser(): Promise<string> {
  const userId = randomUUID();
  await backendDb.insert(schema.users).values({ id: userId, email: `hrt-${userId}@example.test` });
  return userId;
}

async function seedPacket(input: {
  userId: string;
  packetId: string;
  company: string;
  role: string;
  jobId?: string;
  portalUrl: string;
}) {
  await backendDb.insert(schema.generated_resumes).values({
    id: input.packetId,
    user_id: input.userId,
    job_context: { company: input.company, role: input.role, job_id: input.jobId },
    spec: { _review: { status: 'submitting', portal_url: input.portalUrl } },
    resume_object_key: `users/${input.userId}/resumes/${input.packetId}.pdf`,
  });
}

async function seedCanonicalRow(input: {
  userId: string;
  applicationId: string;
  packetId: string | null;
  company: string;
  role: string;
  jobId?: string | null;
  portalUrl: string | null;
}) {
  await backendDb.insert(schema.applications).values({
    id: input.applicationId,
    user_id: input.userId,
    legacy_generated_resume_id: input.packetId,
    job_id: input.jobId ?? null,
    company_scope_key: `scope:${input.company.toLowerCase()}`,
    company_name: input.company,
    role: input.role,
    portal_url: input.portalUrl,
    source_surface: 'dashboard',
    application_fingerprint: `fp-${input.applicationId}`,
  });
}

async function storedApplication(applicationId: string) {
  const [row] = await backendDb.select().from(schema.applications)
    .where(eq(schema.applications.id, applicationId)).limit(1);
  return row;
}

test('a stale board-token label on the current pointer is healed and the send proceeds', async () => {
  const userId = await seedUser();
  const packetId = randomUUID();
  const applicationId = randomUUID();
  await seedPacket({
    userId, packetId, company: 'Hudson River Trading', role: 'Software Engineer',
    jobId: HRT_JOB_ID, portalUrl: LIVE_PORTAL_URL,
  });
  await seedCanonicalRow({
    userId, applicationId, packetId, company: 'Hudson River Trading', role: 'Software Engineer',
    jobId: HRT_JOB_ID, portalUrl: STALE_PORTAL_URL,
  });
  const frozen = freezePostingIdentity(
    { company: 'Hudson River Trading', role: 'Software Engineer', job_id: HRT_JOB_ID },
    LIVE_PORTAL_URL,
  );

  const resolved = await backendDb.transaction((tx: any) => canonicalApplicationForNewPacketAttempt(tx, {
    userId, packetId, postingIdentity: frozen,
  }));

  assert.equal(resolved.id, applicationId);
  assert.equal(resolved.portal_url, LIVE_PORTAL_URL);
  assert.ok(canonicalApplicationMatchesFrozenPosting(resolved, frozen));

  const stored = await storedApplication(applicationId);
  assert.equal(stored.portal_url, LIVE_PORTAL_URL, 'the heal must be durable, not just returned in memory');

  // A second, independent resolve (a fresh press of Send) must succeed with no further healing -
  // the row is now honestly in sync, not merely patched over for one call.
  const resolvedAgain = await backendDb.transaction((tx: any) => canonicalApplicationForNewPacketAttempt(tx, {
    userId, packetId, postingIdentity: frozen,
  }));
  assert.equal(resolvedAgain.id, applicationId);
});

test('a stale company/role label on the current pointer is healed the same way', async () => {
  const userId = await seedUser();
  const packetId = randomUUID();
  const applicationId = randomUUID();
  await seedPacket({
    userId, packetId, company: 'Hudson River Trading LLC', role: 'Software Engineer II',
    portalUrl: LIVE_PORTAL_URL,
  });
  await seedCanonicalRow({
    userId, applicationId, packetId, company: 'Hudson River Trading', role: 'Software Engineer',
    portalUrl: LIVE_PORTAL_URL,
  });
  const frozen = freezePostingIdentity(
    { company: 'Hudson River Trading LLC', role: 'Software Engineer II' },
    LIVE_PORTAL_URL,
  );

  const resolved = await backendDb.transaction((tx: any) => canonicalApplicationForNewPacketAttempt(tx, {
    userId, packetId, postingIdentity: frozen,
  }));
  assert.equal(resolved.id, applicationId);

  const stored = await storedApplication(applicationId);
  assert.equal(stored.company_name, 'Hudson River Trading LLC');
  assert.equal(stored.role, 'Software Engineer II');
});

test('ownership is not weakened: a pointer belonging to another user is never returned or healed', async () => {
  const owner = await seedUser();
  const attacker = await seedUser();
  const packetId = randomUUID();
  const applicationId = randomUUID();
  await seedPacket({
    userId: owner, packetId, company: 'Hudson River Trading', role: 'Software Engineer',
    portalUrl: LIVE_PORTAL_URL,
  });
  await seedCanonicalRow({
    userId: owner, applicationId, packetId, company: 'Hudson River Trading', role: 'Software Engineer',
    portalUrl: STALE_PORTAL_URL,
  });
  const frozen = freezePostingIdentity(
    { company: 'Hudson River Trading', role: 'Software Engineer' },
    LIVE_PORTAL_URL,
  );

  await assert.rejects(
    () => backendDb.transaction((tx: any) => canonicalApplicationForNewPacketAttempt(tx, {
      userId: attacker, packetId, postingIdentity: frozen,
    })),
    (error: unknown) => error instanceof CanonicalPacketBindingError
      && error.code === 'CANONICAL_PACKET_BINDING_MISSING',
  );

  // The owner's row must be untouched by the attacker's failed attempt - no cross-account write.
  const stored = await storedApplication(applicationId);
  assert.equal(stored.portal_url, STALE_PORTAL_URL);
  assert.equal(stored.user_id, owner);
});

test('a genuinely missing pointer is still refused, never fabricated', async () => {
  const userId = await seedUser();
  const packetId = randomUUID();
  await seedPacket({
    userId, packetId, company: 'Hudson River Trading', role: 'Software Engineer',
    portalUrl: LIVE_PORTAL_URL,
  });
  // No canonical row points at this packet at all.
  const frozen = freezePostingIdentity(
    { company: 'Hudson River Trading', role: 'Software Engineer' },
    LIVE_PORTAL_URL,
  );

  await assert.rejects(
    () => backendDb.transaction((tx: any) => canonicalApplicationForNewPacketAttempt(tx, {
      userId, packetId, postingIdentity: frozen,
    })),
    (error: unknown) => error instanceof CanonicalPacketBindingError
      && error.code === 'CANONICAL_PACKET_BINDING_MISSING',
  );
});

test('a mismatch the packet cannot itself resolve stays refused', async () => {
  const userId = await seedUser();
  const packetId = randomUUID();
  const applicationId = randomUUID();
  // The packet's own review never got a portal_url at all - nothing for the heal to reconcile
  // toward - while the canonical row has one on file from an earlier pass.
  await seedPacket({
    userId, packetId, company: 'Hudson River Trading', role: 'Software Engineer', portalUrl: '',
  });
  await seedCanonicalRow({
    userId, applicationId, packetId, company: 'Hudson River Trading', role: 'Software Engineer',
    portalUrl: STALE_PORTAL_URL,
  });
  const frozen = freezePostingIdentity(
    { company: 'Hudson River Trading', role: 'Software Engineer' },
    null,
  );
  assert.equal(frozen.portalUrl, null, 'test setup sanity: the frozen identity must carry no URL at all');

  // A refusal with nothing reconcilable must not even attempt a write. The error alone cannot prove
  // that - a heal that skips the "is there anything to fix" check still throws here too, since the
  // mismatch is real either way and an empty patch changes nothing the match check reads - so this
  // counts UPDATE calls on the executor directly rather than trusting updated_at, which two writes
  // issued back to back in-process can carry the same millisecond and make a real write invisible.
  let updateCalls = 0;
  await assert.rejects(
    () => backendDb.transaction((tx: any) => canonicalApplicationForNewPacketAttempt({
      select: tx.select.bind(tx),
      update: (...args: unknown[]) => {
        updateCalls += 1;
        return (tx.update as (...a: unknown[]) => unknown)(...args);
      },
    } as any, {
      userId, packetId, postingIdentity: frozen,
    })),
    (error: unknown) => error instanceof CanonicalPacketBindingError
      && error.code === 'CANONICAL_PACKET_BINDING_MISSING',
  );
  assert.equal(updateCalls, 0, 'nothing was reconcilable, so no write should have been attempted at all');

  const stored = await storedApplication(applicationId);
  assert.equal(stored.portal_url, STALE_PORTAL_URL, 'a field the packet does not itself know must never be erased');
});

test('a heal is re-verified, never trusted blindly: a field it cannot safely adopt still refuses', async () => {
  const userId = await seedUser();
  const packetId = randomUUID();
  const applicationId = randomUUID();
  const canonicalJobId = randomUUID();
  // A non-UUID job token - some ATS-native id, never a monitored_jobs row - which
  // reconcileCurrentPointerPostingIdentity deliberately will not write into the uuid `job_id`
  // column. Company, role AND portal_url all disagree too, so the heal has real, writable work to
  // do; job_id is the one disagreement it must leave alone.
  await seedPacket({
    userId, packetId, company: 'New Co', role: 'New Role', jobId: 'greenhouse-native-9981',
    portalUrl: LIVE_PORTAL_URL,
  });
  await seedCanonicalRow({
    userId, applicationId, packetId, company: 'Old Co', role: 'Old Role', jobId: canonicalJobId,
    portalUrl: STALE_PORTAL_URL,
  });
  const frozen = freezePostingIdentity(
    { company: 'New Co', role: 'New Role', job_id: 'greenhouse-native-9981' },
    LIVE_PORTAL_URL,
  );
  assert.equal(frozen.jobId, 'greenhouse-native-9981');

  // The heal can and does correct company/role/portal_url in place, but the row it hands back
  // still disagrees on job_id - a field it was never entitled to touch - so the call must still
  // refuse. A version that trusted the heal without re-checking would wrongly return here.
  await assert.rejects(
    () => backendDb.transaction((tx: any) => canonicalApplicationForNewPacketAttempt(tx, {
      userId, packetId, postingIdentity: frozen,
    })),
    (error: unknown) => error instanceof CanonicalPacketBindingError
      && error.code === 'CANONICAL_PACKET_BINDING_MISSING',
  );

  // The whole call ran inside one transaction and that transaction threw, so Postgres rolls the
  // partial heal back with everything else - a refused attempt must leave no partial trace.
  const stored = await storedApplication(applicationId);
  assert.equal(stored.company_name, 'Old Co');
  assert.equal(stored.role, 'Old Role');
  assert.equal(stored.portal_url, STALE_PORTAL_URL);
  assert.equal(stored.job_id, canonicalJobId);
});

test('a matching pointer needs no heal and is returned unchanged', async () => {
  const userId = await seedUser();
  const packetId = randomUUID();
  const applicationId = randomUUID();
  await seedPacket({
    userId, packetId, company: 'Hudson River Trading', role: 'Software Engineer',
    portalUrl: LIVE_PORTAL_URL,
  });
  await seedCanonicalRow({
    userId, applicationId, packetId, company: 'Hudson River Trading', role: 'Software Engineer',
    portalUrl: LIVE_PORTAL_URL,
  });
  const before = await storedApplication(applicationId);
  const frozen = freezePostingIdentity(
    { company: 'Hudson River Trading', role: 'Software Engineer' },
    LIVE_PORTAL_URL,
  );

  const resolved = await backendDb.transaction((tx: any) => canonicalApplicationForNewPacketAttempt(tx, {
    userId, packetId, postingIdentity: frozen,
  }));
  assert.equal(resolved.id, applicationId);

  const after = await storedApplication(applicationId);
  assert.deepEqual(after.updated_at, before.updated_at, 'an already-matching row must not be written to');
});
