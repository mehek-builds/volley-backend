import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { ApplicationReviewState } from '../lib/applicationReview';

/* THE MEASURED DEFECT, live on trylitos.com 2026-09-04, account mehekmandal05@gmail.com.
 *
 * Applications -> "Fill application" -> Job URL
 * https://covenanthouseinternational.na.teamtailor.com/jobs/686133-intern-finance -> "Read job" ->
 * "Tailor resume first" built a fresh packet (c24e48a2-06b1-4a01-989f-b6c2c5719f18) and the dashboard
 * navigated to it successfully. Every read after that measured:
 *
 *   - GET /applications/:id/submission            -> 500 {"error":"Internal server error"} (repeatable)
 *   - GET /applications/:id/submission/channels    -> 200, review_status "ready_to_submit",
 *                                                      channels [{provider:"teamtailor", status:"unavailable"}]
 *   - GET /applications/:id/fill-data              -> 404 {"error":"Application not found"}
 *   - GET /applications?limit=200                  -> 201 total rows, this one absent
 *
 * ROOT CAUSE: POST /resume/generate stores a fresh packet's job_context.company/role plus a
 * generated_resumes.id ("the packet id") DISTINCT from the canonical applications.id it also
 * creates in the same transaction (see resumeId vs canonicalApplicationId, routes/resume.ts). GET
 * /applications/:id/submission and its /submission/channels sibling both resolve :id against
 * generated_resumes (ownedResume); GET /applications/:id/fill-data resolves it against applications
 * (ownedApplication) - a DIFFERENT id space. Probing fill-data with the packet id therefore 404s by
 * design, not by defect (see the fill-data tests below), and the packet's OWN row is not "missing"
 * from GET /applications - it is filed under its canonical id, which this file never named.
 *
 * The real defect is the /submission 500 itself. covenanthouseinternational.na.teamtailor.com is a
 * REGIONAL Teamtailor tenant: HOSTS.teamtailor in lib/portalSubmission.ts matches only a single
 * label before ".teamtailor.com" ("fully.teamtailor.com", "flanks.teamtailor.com"), so this
 * two-label host matches no HOSTS entry and lib/portalSubmission.ts's detectPortal throws for it -
 * correctly, by isPortalSupported's own header, for a browser runner. POST /resume/generate already
 * guards this with isPortalSupported and stores portal_supported: false without ever calling
 * detectPortal on this exact URL, so creation succeeds. But GET /submission's
 * resolvePacketAuditQuestionFixpoint (routes/submissionRunner.ts) called
 * normalizedPacketAuditQuestions on every read whenever portal_url was set, with NO
 * isPortalSupported guard, so detectPortal's throw went uncaught straight out of the route handler -
 * toPublicError (src/index.ts) has no case for a bare Error and downgrades it to exactly the
 * generic 500 measured in production. The fix adds the same isPortalSupported-shaped guard
 * GET /resume/history's refreshedHistorySpec (routes/resume.ts) already carries for its own
 * equivalent call - see submissionRunner.test.ts for the function-level pin of that fix.
 *
 * ROUND 2, 2026-09-05: HOSTS.teamtailor now recognises exactly this regional shape
 * ("<tenant>.<region>.teamtailor.com" - see that map's own comment in lib/portalSubmission.ts), so
 * detectPortal no longer throws for this URL at all and isPortalSupported(PORTAL_URL) is true. The
 * ROOT CAUSE paragraph above stays as it was measured - host recognition is what was missing that
 * day - but the first test below now exercises the SECOND half of the fix instead of the guard: the
 * packet was generated (and its row seeded here) BEFORE the host-recognition fix, so it still
 * carries the stale portal_supported: false POST /resume/generate wrote before HOSTS.teamtailor
 * knew this shape. That stale value has to heal on its own the moment the account reopens the
 * dashboard, without a resume rebuild - see readApplicationReview in lib/applicationReview.ts,
 * which now recomputes portal_supported from the current detector whenever the stored value is not
 * already `true`. A THIRD test below reseeds the same packet on a host that genuinely still cannot
 * be classified, so the route's "never 500, whatever detectPortal does" guarantee - the reason this
 * file exists in the first place - stays covered by a fixture that actually exercises it.
 *
 * This file pins the fix at the route the dashboard actually calls: seed a packet/application pair
 * shaped exactly like POST /resume/generate's own transaction produces for this scenario, then call
 * the real GET handlers with fastify.inject.
 */

const JWT_SECRET = 'fresh-tailored-application-read-test-secret-32';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-fresh-tailored-read-'));
const savedEnv = { ...process.env };
const USER_ID = 'a15c3c1e-3f2b-4a9a-8e2b-7e2f6d6b8a01';

let database: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let backendDb: any;
let backendPool: { end(): Promise<void> };

async function token(userId: string = USER_ID) {
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
  process.env.ENCRYPTION_KEY = 'fresh-tailored-application-read-test-key-32';

  ({ db: backendDb, pool: backendPool } = await import('../db'));
  const { applicationRoutes } = await import('./applications');
  const { canonicalApplicationRoutes } = await import('./canonicalApplications');
  app = Fastify({ logger: false });
  await app.register(applicationRoutes);
  await app.register(canonicalApplicationRoutes);
  await app.ready();

  await backendDb.insert(schema.users).values({
    id: USER_ID,
    email: 'fresh-tailored-read@example.com',
    password_hash: 'x',
  });
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

const PORTAL_URL = 'https://covenanthouseinternational.na.teamtailor.com/jobs/686133-intern-finance';

/** The exact shape POST /resume/generate writes for "Fill application" -> "Tailor resume first"
 * with no application_id and no job_id: a fresh generated_resumes row (the packet) and a fresh,
 * DISTINCT applications row (the canonical Tracker entry) linking back to it via
 * legacy_generated_resume_id - see routes/resume.ts around resumeId / canonicalApplicationId. */
async function seedFreshTailoredPacket(userId: string = USER_ID, overrides: Partial<ApplicationReviewState> = {}) {
  const packetId = randomUUID();
  const canonicalApplicationId = randomUUID();
  const now = new Date().toISOString();
  const review: ApplicationReviewState = {
    jd_text: 'Support the finance team at Covenant House International as a Finance Intern.',
    role: 'Intern, Finance',
    portal_url: PORTAL_URL,
    ats_name: 'teamtailor',
    // DELIBERATELY STALE, matching exactly what POST /resume/generate wrote for this URL before
    // HOSTS.teamtailor recognised the regional shape (this file's header, "ROUND 2"):
    // isPortalSupported(PORTAL_URL) is true today, but the stored value never updates itself, so a
    // packet generated before that fix landed keeps carrying false until something re-derives it.
    // That is exactly what the first test below is for - see readApplicationReview in
    // lib/applicationReview.ts for the read-time heal, and pass `{ portal_url: ... }` in
    // `overrides` for a packet that should stay genuinely unsupported instead.
    portal_supported: false,
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: now,
    ...overrides,
  };
  await backendDb.insert(schema.generated_resumes).values({
    id: packetId,
    user_id: userId,
    job_context: { company: 'Covenant House International', role: 'Intern, Finance' },
    spec: {
      _contact: {
        full_name: 'Test Applicant',
        email: 'applicant@example.com',
        phone: '+1 213 574 6270',
      },
      _review: review,
    },
    resume_object_key: `resumes/${packetId}.pdf`,
  });
  await backendDb.insert(schema.applications).values({
    id: canonicalApplicationId,
    user_id: userId,
    legacy_generated_resume_id: packetId,
    company_scope_key: 'name:covenant-house-international',
    company_name: 'Covenant House International',
    role: 'Intern, Finance',
    portal_url: PORTAL_URL,
    source_surface: 'dashboard',
    tracker_state: 'applying',
    review_state: 'ready',
    application_fingerprint: `legacy:${packetId}`,
  });
  return { packetId, canonicalApplicationId };
}

test('GET /applications/:id/submission returns 200 and heals a stale portal_supported: false once the regional host is recognized', async () => {
  const { packetId } = await seedFreshTailoredPacket();
  const res = await app.inject({
    method: 'GET',
    url: `/applications/${packetId}/submission`,
    headers: { authorization: `Bearer ${await token()}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.application_id, packetId);
  assert.equal(body.review.status, 'ready_to_submit');
  // The row was seeded with the stale portal_supported: false a pre-fix POST /resume/generate
  // wrote (see seedFreshTailoredPacket's own comment). readApplicationReview re-derives it from
  // the current detector on every read because the stored value is not `true`, and HOSTS.teamtailor
  // now recognises this regional tenant - so the dashboard sees `true` on this very next load, with
  // no resume rebuild and no separate repair endpoint.
  assert.equal(body.review.portal_supported, true);
  assert.deepEqual(body.sensitive_questions_requiring_confirmation, []);
});

/* THE GUARD ITSELF, STILL PROVEN, on a host that genuinely is not any recognised family - the
 * property #951 exists for ("a bare Error from detectPortal must not 500 this route") stops being
 * demonstrated by the test above the moment its fixture host is recognised, so it is demonstrated
 * here instead. detectPortal throws for this host today and portal_supported has to stay exactly
 * what was stored, since isPortalSupported agrees with it - nothing to heal, unlike the test above. */
test('GET /applications/:id/submission still returns 200 for a packet on a portal detectPortal genuinely cannot classify', async () => {
  const { packetId } = await seedFreshTailoredPacket(USER_ID, {
    portal_url: 'https://apply.not-a-recognized-ats.example.com/careers/apply',
    ats_name: 'other',
  });
  const res = await app.inject({
    method: 'GET',
    url: `/applications/${packetId}/submission`,
    headers: { authorization: `Bearer ${await token()}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.application_id, packetId);
  assert.equal(body.review.portal_supported, false);
});

test('GET /applications/:id/submission/channels still reports the teamtailor channel as unavailable', async () => {
  const { packetId } = await seedFreshTailoredPacket();
  const res = await app.inject({
    method: 'GET',
    url: `/applications/${packetId}/submission/channels`,
    headers: { authorization: `Bearer ${await token()}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.review_status, 'ready_to_submit');
  assert.equal(body.channels.length, 1);
  assert.equal(body.channels[0].provider, 'teamtailor');
  assert.equal(body.channels[0].status, 'unavailable');
});

test('GET /applications/:id/fill-data 404s on the packet id: fill-data is keyed by the canonical application id, a different id', async () => {
  const { packetId } = await seedFreshTailoredPacket();
  const res = await app.inject({
    method: 'GET',
    url: `/applications/${packetId}/fill-data`,
    headers: { authorization: `Bearer ${await token()}` },
  });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().error, 'Application not found');
});

test('GET /applications/:id/fill-data succeeds on the SAME row addressed by its real canonical application id', async () => {
  const { canonicalApplicationId } = await seedFreshTailoredPacket();
  const res = await app.inject({
    method: 'GET',
    url: `/applications/${canonicalApplicationId}/fill-data`,
    headers: { authorization: `Bearer ${await token()}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().application_id, canonicalApplicationId);
});

test('GET /applications?limit=200 carries the freshest of 201 rows under its own canonical id', async () => {
  // A dedicated user, isolated from every packet the earlier tests in this file seeded for
  // USER_ID, so this account's total is exactly the 201 this test writes - matching the count
  // measured in production - rather than an incidental leftover from test order.
  const listUserId = randomUUID();
  await backendDb.insert(schema.users).values({
    id: listUserId,
    email: `fresh-tailored-read-list-${listUserId}@example.com`,
    password_hash: 'x',
  });
  const { canonicalApplicationId } = await seedFreshTailoredPacket(listUserId);
  // 200 older filler rows, none of them this packet, so the account totals 201 live applications -
  // the exact count measured in production - with this one the most recently updated.
  const fillerWrites = Array.from({ length: 200 }, (_, index) => {
    const id = randomUUID();
    return backendDb.insert(schema.applications).values({
      id,
      user_id: listUserId,
      company_scope_key: `name:filler-${index}`,
      company_name: `Filler Co ${index}`,
      role: 'Some Role',
      source_surface: 'dashboard',
      application_fingerprint: `filler:${id}`,
      updated_at: new Date(Date.now() - (index + 1) * 60_000),
    });
  });
  await Promise.all(fillerWrites);

  const total = await backendDb.select().from(schema.applications).where(eq(schema.applications.user_id, listUserId));
  assert.equal(total.length, 201, 'precondition: the account holds 201 applications');

  const res = await app.inject({
    method: 'GET',
    url: '/applications?limit=200',
    headers: { authorization: `Bearer ${await token(listUserId)}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.applications.length, 200, 'limit=200 against 201 rows returns exactly 200');
  assert.ok(
    body.applications.some((application: { id: string }) => application.id === canonicalApplicationId),
    'the newest row (by updated_at) is always inside the top 200, never the one limit excludes',
  );
});
