/* A PACKET'S RESUME HEADER FOLLOWS THE PROFILE, WITHOUT A NEW BUILD.
 *
 * MEASURED live on trylitos.com 2026-09-04: every packet built before the applicant moved (Pony.ai
 * fdcf4ccb, Belvedere Trading c4413bff/6fda0404/4de84885, Transparent Hiring 6f8524ca, among
 * others) still attaches its exact resume PDF with the header printed at generation time - "Dubai,
 * Dubai | +971 567417451" - while application_profile now reads "Los Angeles, California" and
 * "+1 213 574 6270", and the managed form fills the NEW pair live from that same row. The form and
 * its own attachment disagree. POST /applications/:id/resume/contact-refresh re-renders the frozen
 * spec with a recomputed header and nothing else; this file proves the three things that mechanism
 * has to get right: the write actually happens (a new object, the old one left alone, no content
 * touched), any acknowledgement she already gave is void afterwards (the audit gate now answers
 * packet_stale), and a packet already matching her current profile costs nothing at all.
 *
 * WHY A REAL ROUTE, A REAL DATABASE, AND A REAL PDF RENDER - same reasoning as
 * reviewAnswerSave.test.ts: what matters is the row the database holds afterwards, and only reading
 * it back can tell a route that wrote nothing from one that did. Fixture is PGlite over a unix
 * socket with the production db module, the production routes and the production auth middleware,
 * DDL generated from db/schema.ts at run time.
 *
 * PUT/DELETE OBJECT STORAGE IS A REAL S3-SHAPED HTTP ENDPOINT TOO, deliberately not a module fake.
 * lib/objectStorage.ts talks to whatever OBJECT_STORAGE_ENDPOINT names via the real AWS SDK S3
 * client when Railway-style credentials are configured, so this file starts a tiny local HTTP
 * server that answers PutObject and DeleteObjects the way S3 would and points the app at it. The
 * route under test, putObject, and renderResumePdf all run completely unmodified; nothing about the
 * mechanism under test is stubbed, only the network edge the real object store would otherwise sit
 * behind.
 *
 * THE AUDIT-VOIDING PROOF DELIBERATELY CALLS verifyCurrentPacketAudit DIRECTLY rather than the
 * higher-level currentPacketAudit/currentAcknowledgedPacketAudit the send gate uses: those also
 * fetch the stored PDF's bytes over HTTP, which is a real thing this file could stand up a second
 * fake endpoint for, but the claim under test - "the stored audit's pdf binding no longer matches
 * the row's current one" - is exactly what verifyCurrentPacketAudit itself checks, as a pure
 * function, and currentPacketAudit is a thin wrapper around precisely this comparison (see
 * lib/packetAuditService.ts). Testing the comparison directly is the more targeted claim, not a
 * weaker one.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import type { ApplicationReviewState } from '../lib/applicationReview';
import type { ResumeSpec } from '../llm/resumeSpec';
import {
  createPacketAudit,
  verifyCurrentPacketAudit,
  type CreatePacketAuditInput,
} from '../lib/packetAudit';

const JWT_SIGNING_SECRET = 'contact-refresh-route-test-secret';
const ENCRYPTION_KEY = 'contact-refresh-route-test-key-0123456789ab';

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
  OBJECT_STORAGE_BUCKET: process.env.OBJECT_STORAGE_BUCKET,
  OBJECT_STORAGE_ACCESS_KEY_ID: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
  OBJECT_STORAGE_SECRET_ACCESS_KEY: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
  OBJECT_STORAGE_ENDPOINT: process.env.OBJECT_STORAGE_ENDPOINT,
  OBJECT_STORAGE_URL_STYLE: process.env.OBJECT_STORAGE_URL_STYLE,
  OBJECT_STORAGE_PUBLIC_BASE_URL: process.env.OBJECT_STORAGE_PUBLIC_BASE_URL,
};

let socketDir: string;
let pglite: PGlite;
let pgSocket: PGLiteSocketServer;
let fakeObjectStore: Server;
let pool: typeof import('../db/index')['pool'];
let app: FastifyInstance;
let schema: typeof import('../db/schema');
let db: typeof import('../db/index')['db'];
let userId = '';
let token = '';

const JD_TEXT = 'A posting that asks for TypeScript service experience.';

/* Content that renders and audits cleanly on its own, with nothing in it that depends on the
 * JD-matching pipeline: createPacketAudit's own clauses/terms are supplied pre-scored (see
 * packetAudit.test.ts's validInput), so a single unscoreable clause is enough here. */
const RESUME_SPEC: ResumeSpec = {
  school: 'Example University',
  degree: 'Bachelor of Science in Computer Science',
  grad_date: '2026',
  coursework: 'Distributed Systems',
  experience: [{
    type: 'job',
    org: 'Northwind Labs',
    title: 'Software Engineer',
    date_range: '2024 - Present',
    bullets: ['Built TypeScript services for operations teams and reduced response time by 30 percent'],
  }],
  skills: ['TypeScript'],
};

/* THE MEASURED FIXTURE. A packet built while the account read Dubai/+971, exactly as pinned in
 * resumeContactOfRecord.test.ts - and the application_profile row seeded in before() below reads
 * Los Angeles/+1, the applicant's move. */
const STALE_CONTACT = {
  full_name: 'Test Applicant',
  email: 'resume@example.test',
  phone: '+971 567417451',
  location: 'Dubai, Dubai',
};

/** The header a refresh should produce: name and email held, phone and location moved. */
const REFRESHED_CONTACT = {
  full_name: 'Test Applicant',
  email: 'resume@example.test',
  phone: '+1 213 574 6270',
  location: 'Los Angeles, California',
};

function baseReview(overrides: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return {
    jd_text: JD_TEXT,
    role: 'Software Engineer',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: '2026-08-16T10:00:00.000Z',
    ...overrides,
  };
}

async function applicationWith(
  contact: Record<string, unknown> | undefined,
  review: ApplicationReviewState,
): Promise<{ id: string; objectKey: string }> {
  const objectKey = `users/${userId}/resumes/${crypto.randomUUID()}.pdf`;
  const [row] = await db.insert(schema.generated_resumes).values({
    user_id: userId,
    job_context: { company: 'Northwind Labs', role: 'Software Engineer' },
    spec: { ...RESUME_SPEC, ...(contact ? { _contact: contact } : {}), _review: review },
    resume_object_key: objectKey,
  }).returning({ id: schema.generated_resumes.id });
  return { id: row.id, objectKey };
}

async function storedRow(applicationId: string) {
  const [row] = await db.select().from(schema.generated_resumes)
    .where(eq(schema.generated_resumes.id, applicationId)).limit(1);
  return row;
}

function refreshContact(applicationId: string) {
  return app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/resume/contact-refresh`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function getSubmission(applicationId: string) {
  return app.inject({
    method: 'GET',
    url: `/applications/${applicationId}/submission`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function startFakeObjectStore(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        // PutObjectCommand -> PUT <bucket>/<key>. The route never reads these bytes back, so an
        // empty 200 is a faithful enough stand-in for what S3 itself returns.
        if (req.method === 'PUT') {
          res.writeHead(200, { etag: '"fake-etag"' });
          res.end();
          return;
        }
        // DeleteObjectsCommand -> POST <bucket>/?delete, expecting an XML DeleteResult body back.
        if (req.method === 'POST') {
          res.writeHead(200, { 'content-type': 'application/xml' });
          res.end('<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>');
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;

  fakeObjectStore = await startFakeObjectStore();
  const address = fakeObjectStore.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  process.env.OBJECT_STORAGE_BUCKET = 'litos-contact-refresh-test-bucket';
  process.env.OBJECT_STORAGE_ACCESS_KEY_ID = 'test-access-key';
  process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = 'test-secret-key';
  process.env.OBJECT_STORAGE_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.OBJECT_STORAGE_URL_STYLE = 'path';
  // Never dereferenced by this test or by the route (the returned blob.url only rides into the
  // artifact-version row); it only has to satisfy objectReadUrl's own HTTPS-or-localhost check.
  process.env.OBJECT_STORAGE_PUBLIC_BASE_URL = `http://127.0.0.1:${port}`;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-contact-refresh-'));
  pglite = await PGlite.create();
  pgSocket = new PGLiteSocketServer({ db: pglite, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await pgSocket.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

  schema = await import('../db/schema');
  const dbModule = await import('../db/index');
  db = dbModule.db;
  pool = dbModule.pool;

  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await pglite.exec(statement);

  const [account] = await db.insert(schema.users).values({ email: 'contact-refresh@example.test' }).returning();
  userId = account.id;

  await db.insert(schema.profiles).values({
    user_id: userId,
    parsed_json: { resume_email: STALE_CONTACT.email },
  });
  /* THE MOVE. ENCRYPTED_FIELDS tolerates plaintext here on purpose: decryptRow treats a value that
   * does not look like its own envelope as legacy plaintext and passes it through, so a route test
   * can seed the row directly with no encryption plumbing (see routes/applicationProfile.ts). */
  await db.insert(schema.application_profile).values({
    user_id: userId,
    phone: REFRESHED_CONTACT.phone,
    address_city: 'Los Angeles',
    address_state: 'California',
  });

  token = await new SignJWT({
    userId,
    email: 'contact-refresh@example.test',
    isGuest: false,
    authMethod: 'password',
    sessionVersion: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SIGNING_SECRET));

  const { applicationRoutes } = await import('./applications');
  app = Fastify({ logger: false });
  await app.register(applicationRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  await pool?.end();
  await pgSocket?.stop();
  await pglite?.close();
  await new Promise((resolve) => fakeObjectStore?.close(() => resolve(undefined)));
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('a moved applicant is refreshed: new object, new header, content and quota untouched', async () => {
  const { id, objectKey: oldKey } = await applicationWith(STALE_CONTACT, baseReview());

  const response = await refreshContact(id);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.application_id, id);
  assert.deepEqual(body.contact.before, STALE_CONTACT);
  assert.deepEqual(body.contact.after, REFRESHED_CONTACT);

  const row = await storedRow(id);
  assert.notEqual(row.resume_object_key, oldKey, 'a new PDF object was written');
  const spec = row.spec as Record<string, unknown>;
  assert.deepEqual(spec._contact, REFRESHED_CONTACT);
  // THE CONTENT NEVER MOVED. No tailoring, no LLM re-selection, no re-fit: the same bullets and
  // skills that went in come back unchanged.
  assert.deepEqual(spec.experience, RESUME_SPEC.experience);
  assert.deepEqual(spec.skills, RESUME_SPEC.skills);
  assert.deepEqual(spec.school, RESUME_SPEC.school);

  const quality = spec._quality as Record<string, unknown> | undefined;
  const binding = quality?.pdfGenerationBinding as Record<string, unknown> | undefined;
  assert.equal(binding?.objectKey, row.resume_object_key,
    'the generation binding must point at the NEW object, or the packet becomes unauditable rather than merely stale');
});

test('the acknowledgement she already gave is void: the audit gate now answers packet_stale', async () => {
  const { id, objectKey: oldKey } = await applicationWith(STALE_CONTACT, baseReview());

  /* A fully valid, submission-ready audit built against the OLD object key - the record
   * POST /applications/:id/packet-audit would have written when she reviewed and acknowledged this
   * exact packet. Pure and synchronous: createPacketAudit takes pre-scored clauses/terms (see
   * packetAudit.test.ts), so this needs no LLM and no network. */
  const auditInput: CreatePacketAuditInput = {
    ownerId: userId,
    applicationId: id,
    jdText: JD_TEXT,
    spec: RESUME_SPEC,
    jobContext: { company: 'Northwind Labs', role: 'Software Engineer' },
    questions: [],
    applicantSnapshot: { profile: { email: STALE_CONTACT.email } },
    resumeEmail: STALE_CONTACT.email,
    applicantEmail: 'app-alias@apply.trylitos.test',
    employerDelivery: {
      version: 'employer_delivery_v1',
      mode: 'browser',
      sha256: '1'.repeat(64),
    },
    pdfObjectKey: oldKey,
    pdfBytes: Buffer.from('%PDF-1.7 the exact bytes she reviewed and acknowledged'),
    editedTerms: [],
    clauses: [{ text: JD_TEXT, start: 0, end: JD_TEXT.length, verdict: 'unscoreable' }],
    rejected: [],
    degraded: false,
    terms: { covered: [], missing: [], edited: [] },
  };
  const audit = createPacketAudit(auditInput);

  // Baseline: valid against the packet exactly as built, before any refresh.
  const before = verifyCurrentPacketAudit({ ...auditInput, audit });
  assert.equal(before.valid, true, before.reason);

  const response = await refreshContact(id);
  assert.equal(response.statusCode, 200, response.body);
  const row = await storedRow(id);
  assert.notEqual(row.resume_object_key, oldKey);

  /* THE EXACT COMPARISON THE SEND GATE MAKES, against the row as it stands after the refresh.
   * currentPacketAudit (lib/packetAuditService.ts) wraps precisely this call around a PDF fetch
   * this test does not need: the object key alone already differs, which is what makes any
   * acknowledgement pinned to `audit` unusable without the applicant re-reviewing. */
  const after = verifyCurrentPacketAudit({
    ...auditInput,
    pdfObjectKey: row.resume_object_key,
    audit,
  });
  assert.equal(after.valid, false);
  assert.equal(after.reason, 'packet_stale');
  assert.ok(after.bindingMismatchKeys?.includes('pdf_object'), after.bindingMismatchKeys?.join(', '));
  // And nothing ELSE about the packet's identity moved - only the file did.
  assert.ok(!after.bindingMismatchKeys?.includes('spec'), 'the resume content did not change');
  assert.ok(!after.bindingMismatchKeys?.includes('resume_email'), 'the resume email did not change');
});

test('a packet already matching the current profile costs nothing: no new object, no change', async () => {
  const { id, objectKey } = await applicationWith(REFRESHED_CONTACT, baseReview());

  const response = await refreshContact(id);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.deepEqual(body.contact.before, REFRESHED_CONTACT);
  assert.deepEqual(body.contact.after, REFRESHED_CONTACT);

  const row = await storedRow(id);
  assert.equal(row.resume_object_key, objectKey, 'no PDF was rendered or uploaded');
});

test('refused while a run holds the row', async () => {
  const { id, objectKey } = await applicationWith(STALE_CONTACT, baseReview({ status: 'filling' }));

  const response = await refreshContact(id);
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'CONTACT_REFRESH_NOT_AVAILABLE');

  const row = await storedRow(id);
  assert.equal(row.resume_object_key, objectKey, 'nothing was written while the run holds the row');
  assert.deepEqual((row.spec as Record<string, unknown>)._contact, STALE_CONTACT);
});

test('refused when the row itself says an employer may already hold this packet', async () => {
  /* needs_attention, unclaimed - reviewAnswerSaveDisposition's own status checks let this shape
   * through, and only employerMayHoldApplication catches it. This is the branch resumeEditDisposition
   * (status + claim boolean alone) would have missed, and it is why this route reuses
   * reviewAnswerSaveDisposition's style rather than that one. */
  const { id, objectKey } = await applicationWith(STALE_CONTACT, baseReview({
    status: 'needs_attention',
    submission_attempted_at: '2026-08-20T10:00:00.000Z',
  }));

  const response = await refreshContact(id);
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'CONTACT_REFRESH_NOT_AVAILABLE');

  const row = await storedRow(id);
  assert.equal(row.resume_object_key, objectKey);
});

test('refused when the packet\'s resume email is no longer the current one', async () => {
  const staleEmailContact = { ...STALE_CONTACT, email: 'an-old-address@example.test' };
  const { id, objectKey } = await applicationWith(staleEmailContact, baseReview());

  const response = await refreshContact(id);
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'resume_email_regeneration_required');

  const row = await storedRow(id);
  assert.equal(row.resume_object_key, objectKey);
});

test('GET /applications/:id/submission signals staleness only when there is drift', async () => {
  const stale = await applicationWith(STALE_CONTACT, baseReview());
  const current = await applicationWith(REFRESHED_CONTACT, baseReview());

  const staleResponse = await getSubmission(stale.id);
  assert.equal(staleResponse.statusCode, 200, staleResponse.body);
  assert.deepEqual(staleResponse.json().resume_contact_stale, {
    stored: STALE_CONTACT,
    current: REFRESHED_CONTACT,
  });

  const currentResponse = await getSubmission(current.id);
  assert.equal(currentResponse.statusCode, 200, currentResponse.body);
  assert.equal(currentResponse.json().resume_contact_stale, undefined,
    'no drift means no signal, so a client offers no button for nothing to do');
});
