import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../db/schema';

/**
 * GET /applications/board as the dashboard's board loader reads it.
 *
 * role-quick-website (origin/main 9c27017, PR #466) rejects the whole board unless the payload is a
 * complete passive authority collection: top-level `schema_version` and a canonical
 * `submission_authority_revision`, and on EVERY card a `submission_authority` envelope whose
 * `revision` equals the collection's and whose `application_id` and `packet_id` are the card id.
 * Measured in prod 2026-09-02 the payload carried none of this, so the board rendered "Could not
 * load your board" for every user. This pins the contract from the server side so it cannot
 * silently regress to that shape again.
 */

const JWT_SECRET = 'applications-board-authority-test-secret-32';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-board-authority-'));
const savedEnv = { ...process.env };
let database: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let backendPool: { end(): Promise<void> };
let backendDb: any;

const USER_ID = '5f1a0d1e-2b6c-4a7e-9f00-8a1c2d3e4f51';
const OTHER_USER_ID = '9c2f77aa-1111-4222-8333-444455556667';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRICT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let neverAttempted: string;
let held: string;
let heldAttempt: string;
const heldAt = new Date('2026-08-28T08:00:00.000Z');
let legacySent: string;

async function token(userId: string) {
  return new SignJWT({ userId, isGuest: false, sessionVersion: 0, authMethod: 'password' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(JWT_SECRET));
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
  process.env.VERCEL = '1';
  process.env.LOG_LEVEL = 'silent';
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  process.env.JWT_SIGNING_SECRET = JWT_SECRET;
  ({ db: backendDb, pool: backendPool } = await import('../db'));
  const { jdMatchRoutes } = await import('./jdMatch');
  app = Fastify({ logger: false });
  await app.register(jdMatchRoutes);
  await app.ready();
  await backendDb.insert(schema.users).values([
    { id: USER_ID, email: 'board@example.com', password_hash: 'x' },
    { id: OTHER_USER_ID, email: 'other-board@example.com', password_hash: 'x' },
  ]);
  // One packet per projection state the board must publish, plus a foreign packet that must not
  // leak. Seeded in the same hook as the schema so the ordering is explicit.
  neverAttempted = await makePacket();
  held = await makePacket();
  heldAttempt = await openAttempt(held, heldAt);
  legacySent = await makePacket({
    review: { status: 'submitted', submitted_at: '2026-08-20T10:00:00.000Z' },
  });
  await makePacket({ userId: OTHER_USER_ID });
});

after(async () => {
  await app?.close();
  await backendPool?.end();
  await server?.stop();
  await database.close();
  rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

async function makePacket(overrides: { userId?: string; review?: Record<string, unknown>; pipelineStage?: string } = {}) {
  const id = randomUUID();
  await backendDb.insert(schema.generated_resumes).values({
    id,
    user_id: overrides.userId ?? USER_ID,
    job_context: { company: 'Example Company', role: 'Example Role' },
    spec: overrides.review ? { _review: overrides.review } : {},
    resume_object_key: `users/${USER_ID}/resumes/${id}.pdf`,
    pipeline_stage: overrides.pipelineStage ?? null,
  });
  return id;
}

async function openAttempt(packetId: string, observedAt: Date) {
  const attemptId = randomUUID();
  await backendDb.insert(schema.application_submission_attempt_events).values({
    user_id: USER_ID,
    application_id: null,
    packet_id: packetId,
    event_id: randomUUID(),
    attempt_id: attemptId,
    parent_attempt_id: null,
    event_kind: 'attempt_opened',
    source: 'managed_browser',
    operation: 'initial_submission',
    submission_run_id: randomUUID(),
    submission_claim_id: attemptId,
    packet_version: 'f'.repeat(64),
    company_role: 'example company::example role',
    company_name: 'Example Company',
    role: 'Example Role',
    portal_url: 'https://job-boards.greenhouse.io/example/jobs/1',
    evidence_code: 'atomic_claim_reserved',
    observed_at: observedAt,
    created_at: observedAt,
  });
  return attemptId;
}

async function board(userId = USER_ID) {
  const res = await app.inject({
    method: 'GET',
    url: '/applications/board',
    headers: { authorization: `Bearer ${await token(userId)}` },
  });
  assert.equal(res.statusCode, 200);
  return res.json() as {
    stages: string[];
    limit: number;
    revision: string | null;
    schema_version?: string;
    submission_authority_revision?: string;
    cards: Array<Record<string, any>>;
  };
}

test('regression: the payload is a complete authority collection, which origin/main never sent', async () => {
  const payload = await board();
  // The measured 2026-09-02 prod shape was exactly [stages, limit, revision, cards], and every
  // card lacked submission_authority. Each of these fails on that shape.
  assert.equal(payload.schema_version, 'submission-authority-v1');
  assert.match(payload.submission_authority_revision ?? '', /^(?:0|[1-9][0-9]*)$/);
  assert.equal(payload.cards.length, 3, 'only this user\'s packets');
  for (const card of payload.cards) {
    assert.ok('submission_authority' in card, `card ${card.id} carries an envelope`);
  }
  // The pre-existing fields survive beside the collection fields.
  assert.deepEqual(payload.stages, ['saved', 'applied', 'interview', 'offer', 'closed']);
  assert.equal(payload.limit, 200);
  assert.ok('revision' in payload, 'the build revision stays on the payload');
});

test('every card envelope carries the collection revision and binds both ids to the card', async () => {
  const payload = await board();
  const revision = payload.submission_authority_revision!;
  for (const card of payload.cards) {
    const authority = card.submission_authority;
    assert.equal(authority.schema_version, 'submission-authority-v1');
    assert.equal(authority.revision, revision, `card ${card.id} matches the collection revision`);
    assert.equal(authority.application_id, card.id);
    assert.equal(authority.packet_id, card.id);
    assert.equal(authority.state, authority.projection.state);
    assert.deepEqual(Object.keys(authority).sort(), [
      'application_id', 'packet_id', 'projection', 'retry_safety', 'revision', 'schema_version', 'state',
    ]);
    // The card must not carry the sibling keys the client cross-checks against the envelope.
    for (const key of ['requested_application_id', 'canonical_application_id', 'application_id', 'packet_id', 'submission_projection', 'retry_safety']) {
      assert.equal(key in card, false, `card must not carry ${key}`);
    }
  }
});

test('a never-attempted packet projects none with no evidence', async () => {
  const payload = await board();
  const card = payload.cards.find((candidate) => candidate.id === neverAttempted)!;
  assert.deepEqual(card.submission_authority, {
    schema_version: 'submission-authority-v1',
    revision: payload.submission_authority_revision,
    state: 'none',
    application_id: neverAttempted,
    packet_id: neverAttempted,
    projection: { state: 'none' },
    retry_safety: { kind: 'no_evidence' },
  });
  // The row's own fields are left for the client to interpret.
  assert.equal(card.stage, 'saved');
  assert.equal(card.submission_status, null);
});

test('a held attempt projects unverified, with the retry verdict describing that attempt', async () => {
  const payload = await board();
  const card = payload.cards.find((candidate) => candidate.id === held)!;
  const authority = card.submission_authority;
  assert.equal(authority.state, 'unverified');
  assert.deepEqual(authority.projection, {
    state: 'unverified',
    attempt_id: heldAttempt,
    observed_at: heldAt.toISOString(),
    reason: 'opened',
  });
  assert.deepEqual(authority.retry_safety, {
    kind: 'blocked_unverified',
    attemptId: heldAttempt,
    at: heldAt.toISOString(),
    reason: 'opened',
  });
  assert.match(authority.projection.attempt_id, UUID);
  assert.match(authority.retry_safety.at, STRICT_TIMESTAMP);
});

test('a legacy sent packet with no ledger evidence projects repair_required with a null verdict', async () => {
  const payload = await board();
  const card = payload.cards.find((candidate) => candidate.id === legacySent)!;
  assert.deepEqual(card.submission_authority, {
    schema_version: 'submission-authority-v1',
    revision: payload.submission_authority_revision,
    state: 'repair_required',
    application_id: legacySent,
    packet_id: legacySent,
    projection: {
      state: 'repair_required',
      reasons: ['mutable_sent_without_confirmation'],
      packet_id: legacySent,
    },
    retry_safety: null,
  });
  // The server still derives applied from the mutable status; the client demotes it from the
  // envelope. Changing the stage here would make the two surfaces disagree about the derivation.
  assert.equal(card.stage, 'applied');
  assert.equal(card.submission_status, 'submitted');
});

test('an empty board is still a complete collection', async () => {
  const fresh = randomUUID();
  await backendDb.insert(schema.users).values({ id: fresh, email: `${fresh}@example.com`, password_hash: 'x' });
  const payload = await board(fresh);
  assert.equal(payload.schema_version, 'submission-authority-v1');
  assert.equal(payload.submission_authority_revision, '0');
  assert.deepEqual(payload.cards, []);
});
