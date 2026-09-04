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
import { pdfGenerationBindingIsCurrent } from '../lib/pdfGenerationBinding';
import { readObject } from '../lib/objectStorage';

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
 * packetAudit.test.ts's validInput), so a single unscoreable clause is enough here.
 *
 * Three bullets, not one: validatePdfLayout's ATS-readability floor (resumeValidate.ts, extracted
 * text under 400 characters) is now part of what this route's own post-render checks run (review
 * finding 2), and a one-bullet resume never clears it - this fixture does, comfortably, for both
 * STALE_CONTACT and REFRESHED_CONTACT, with no trimming and no layout issues either way. */
const RESUME_SPEC: ResumeSpec = {
  school: 'Example University',
  degree: 'Bachelor of Science in Computer Science',
  grad_date: '2026',
  coursework: 'Distributed Systems, Operating Systems, Algorithms',
  experience: [{
    type: 'job',
    org: 'Northwind Labs',
    title: 'Software Engineer',
    // Present and empty, not absent: normalizeSpec (llm/resumeSpec.ts) always produces this key on
    // every entry, and rendered.spec is now what gets stored (review finding 2) - so the "content
    // untouched" comparison below has to compare against the shape normalizeSpec actually produces,
    // the same way a hand-typed fixture without it would fail against any other normalized read.
    location: '',
    date_range: '2024 - Present',
    bullets: [
      'Built TypeScript services for operations teams and reduced response time by 30 percent',
      'Designed and shipped a caching layer that cut database load during peak traffic hours',
      'Mentored two incoming interns on the team codebase, testing practices and review process',
    ],
  }],
  skills: ['TypeScript', 'React', 'Node.js', 'PostgreSQL', 'AWS'],
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

/* THE FIXTURE FOR THE SPEC-BINDING REGRESSION (review finding 2). A resume dense enough that
 * planResumeLayout's fit loop is doing real work: four entries at the three-bullet ceiling, with
 * enough skills text that adding the widened header's extra lines (a spelled-out state, three
 * links) tips the compact-design fit estimate over the one-page ceiling where the bare stored
 * header did not. Measured directly against renderResumePdf while building this fixture -
 * TRIM_STORED_CONTACT keeps all twelve bullets and clears every layout check with room to spare,
 * TRIM_REFRESHED_CONTACT trims exactly one bullet and still clears every layout check - so this is
 * pinned behaviour, not a hope that some header is "probably long enough". */
const TRIM_BULLET = (n: number) =>
  `Led cross functional initiative ${n} that measurably improved throughput and reliability for `
  + 'the whole organization across every single quarter that was carefully measured over the past year';

const TRIM_RESUME_SPEC: ResumeSpec = {
  school: 'Example University',
  degree: 'Bachelor of Science in Computer Science',
  grad_date: '2026',
  coursework: 'Distributed Systems, Operating Systems, Algorithms and Data Structures, Machine '
    + 'Learning, Computer Networks, Database Systems, Software Engineering Principles, Computer '
    + 'Architecture, Discrete Mathematics, Probability and Statistics',
  experience: [
    { type: 'job', org: 'Northwind Labs', title: 'Software Engineer Intern', date_range: 'Summer 2025',
      bullets: [TRIM_BULLET(1), TRIM_BULLET(2), TRIM_BULLET(3)] },
    { type: 'job', org: 'Acme Corp', title: 'Software Engineer Intern', date_range: 'Summer 2024',
      bullets: [TRIM_BULLET(4), TRIM_BULLET(5), TRIM_BULLET(6)] },
    { type: 'job', org: 'Globex Inc', title: 'Teaching Assistant', date_range: 'Fall 2024 - Spring 2025',
      bullets: [TRIM_BULLET(7), TRIM_BULLET(8), TRIM_BULLET(9)] },
    { type: 'job', org: 'Initech', title: 'Research Assistant', date_range: 'Fall 2023 - Spring 2024',
      bullets: [TRIM_BULLET(10), TRIM_BULLET(11), TRIM_BULLET(12)] },
  ],
  skills: [
    'TypeScript and Modern Asynchronous JavaScript', 'Python for Scalable Backend Services',
    'Go for High Performance Systems Programming', 'React and Reusable Component Architecture',
    'Node.js Microservice Development', 'Distributed Systems Design and Architecture',
    'PostgreSQL Schema Design and Query Tuning', 'MySQL Replication and Query Optimization',
    'MongoDB Document Modeling and Indexing', 'Redis Caching and Pub/Sub Strategies',
    'Amazon Web Services (AWS) Cloud Infrastructure', 'Google Cloud Platform (GCP) Deployment',
    'Microsoft Azure Fundamentals and Deployment', 'Docker Containerization and Image Builds',
    'Kubernetes Cluster Operations and Scaling', 'Terraform Infrastructure as Code Modules',
    'GraphQL API Design and Schema Federation', 'RESTful API Development and Versioning',
    'Apache Kafka Event Streaming Pipelines', 'Jenkins Continuous Integration Pipelines',
    'Elasticsearch Full Text Search and Indexing', 'Nginx Reverse Proxy Configuration',
    'Linux Systems Administration and Scripting', 'Automated Test Driven Development Practices',
    'Continuous Delivery and Release Engineering', 'Site Reliability Engineering Fundamentals',
    'Object Oriented Design Patterns and Practices', 'Functional Programming Concepts in Practice',
    'Agile Software Development Methodologies', 'Cross Functional Team Collaboration Skills',
  ],
};

/** Bare enough that the packet, as originally built, never had to trim anything. */
const TRIM_STORED_CONTACT = {
  full_name: 'Trim Applicant',
  email: 'trim-resume@example.test',
};

/** What the profile below produces: every mutable field moves, and the header grows by three
 * links and a spelled-out city/state - the exact shape that costs a bullet at render time. */
const TRIM_REFRESHED_CONTACT = {
  full_name: 'Trim Applicant',
  email: 'trim-resume@example.test',
  phone: '+1 213 574 6270',
  location: 'Los Angeles, California',
  linkedin_url: 'https://www.linkedin.com/in/test-applicant-example',
  github_url: 'https://github.com/test-applicant-example',
  portfolio_url: 'https://test-applicant-example-portfolio.dev',
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

// Keyed by request path (bucket + key, since OBJECT_STORAGE_URL_STYLE is 'path'), so a GET for a
// key a PUT never wrote still 404s the way real S3 would. Module-scoped rather than per-test: the
// object store itself is one long-lived fake server for the whole file, exactly like the real one.
const fakeObjectStoreBytes = new Map<string, Buffer>();

function startFakeObjectStore(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        // The AWS SDK tags every request with its own `?x-id=PutObject` / `?x-id=GetObject` query
        // parameter, so the same key's PUT and GET otherwise never share a map entry - only the
        // path (bucket + key) identifies the object, exactly as S3 itself keys it.
        const path = (req.url ?? '').split('?')[0];
        // PutObjectCommand -> PUT <bucket>/<key>. Most callers never read these bytes back (an
        // empty 200 is a faithful enough stand-in for what S3 itself returns), but the bytes are
        // kept anyway so a GET issued later in the same test - readObject, proving a stored
        // generation binding is current against the ACTUAL rendered PDF - has something real to
        // read rather than a second, unrelated render.
        if (req.method === 'PUT') {
          fakeObjectStoreBytes.set(path, body);
          res.writeHead(200, { etag: '"fake-etag"' });
          res.end();
          return;
        }
        // GetObjectCommand -> GET <bucket>/<key>.
        if (req.method === 'GET') {
          const bytes = fakeObjectStoreBytes.get(path);
          if (!bytes) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(bytes.length) });
          res.end(bytes);
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

/* THE STATE THE MEASURED DEFECT ACTUALLY SITS IN. Pony.ai, Belvedere Trading and the rest (see the
 * route's own comment) are filled and unclaimed, waiting on her final look - reviewAnswerSaveDisposition
 * refuses that status unconditionally, which is why this route now asks resumeContactRefreshDisposition
 * instead. Proves both halves finding 1 asked for: the refresh actually lands (200, a voided
 * acknowledgement) and the review status leaves the approval screen the same way PATCH
 * /applications/:id/resume leaves it from every status it starts an edit from. */
test('an unclaimed final-approval packet refreshes: acknowledgement voided, status leaves final approval', async () => {
  const { id, objectKey: oldKey } = await applicationWith(STALE_CONTACT, baseReview({
    status: 'ready_for_final_approval',
  }));

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
  assert.equal(verifyCurrentPacketAudit({ ...auditInput, audit }).valid, true, 'baseline audit must be valid before any refresh');

  const response = await refreshContact(id);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.deepEqual(body.contact.before, STALE_CONTACT);
  assert.deepEqual(body.contact.after, REFRESHED_CONTACT);
  // No questions on this fixture, so PATCH /applications/:id/resume's own status move
  // (questions.length > 0 ? 'questions_ready' : 'ready_to_submit') lands here.
  assert.equal(body.review.status, 'ready_to_submit');

  const row = await storedRow(id);
  assert.notEqual(row.resume_object_key, oldKey);
  const spec = row.spec as Record<string, unknown>;
  assert.equal((spec._review as { status: string }).status, 'ready_to_submit');

  const after = verifyCurrentPacketAudit({ ...auditInput, pdfObjectKey: row.resume_object_key, audit });
  assert.equal(after.valid, false);
  assert.equal(after.reason, 'packet_stale');
});

test('a claimed final-approval packet still refuses - the run holding it may already have shown it to the employer', async () => {
  const { id, objectKey } = await applicationWith(STALE_CONTACT, baseReview({
    status: 'ready_for_final_approval',
    submission_claimed_at: '2026-08-20T10:00:00.000Z',
  }));

  const response = await refreshContact(id);
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'CONTACT_REFRESH_NOT_AVAILABLE');

  const row = await storedRow(id);
  assert.equal(row.resume_object_key, objectKey, 'nothing was written while the packet is claimed');
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

/* REVIEW FINDING 2. renderResumePdf's returned spec is what actually produced the PDF bytes; the
 * pre-render content spec is not, whenever a header this much longer makes planResumeLayout trim
 * a bullet to keep the page at one. Storing the wrong one of those two while binding the OTHER to
 * the rendered bytes is how a packet nothing is wrong with fails closed as PACKET_PDF_INVALID
 * ("Generate it again") the next time anything reads pdfGenerationBindingIsCurrent. A second,
 * dedicated user/profile: this fixture needs LinkedIn, GitHub and portfolio links on the profile,
 * and adding those to the shared fixture's profile would leak links into every other test in this
 * file that asserts what resumeContactStaleness does and does not report. */
test('a header long enough to trim a bullet still yields a current PDF generation binding', async () => {
  const [account] = await db.insert(schema.users).values({ email: 'contact-refresh-trim@example.test' }).returning();
  const trimUserId = account.id;
  await db.insert(schema.profiles).values({
    user_id: trimUserId,
    parsed_json: { resume_email: TRIM_STORED_CONTACT.email },
  });
  await db.insert(schema.application_profile).values({
    user_id: trimUserId,
    phone: TRIM_REFRESHED_CONTACT.phone,
    address_city: 'Los Angeles',
    address_state: 'California',
    linkedin_url: TRIM_REFRESHED_CONTACT.linkedin_url,
    github_url: TRIM_REFRESHED_CONTACT.github_url,
    portfolio_url: TRIM_REFRESHED_CONTACT.portfolio_url,
  });
  const trimToken = await new SignJWT({
    userId: trimUserId,
    email: 'contact-refresh-trim@example.test',
    isGuest: false,
    authMethod: 'password',
    sessionVersion: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SIGNING_SECRET));

  const objectKey = `users/${trimUserId}/resumes/${crypto.randomUUID()}.pdf`;
  const [row] = await db.insert(schema.generated_resumes).values({
    user_id: trimUserId,
    job_context: { company: 'Northwind Labs', role: 'Software Engineer' },
    spec: { ...TRIM_RESUME_SPEC, _contact: TRIM_STORED_CONTACT, _review: baseReview() },
    resume_object_key: objectKey,
  }).returning({ id: schema.generated_resumes.id });

  const response = await app.inject({
    method: 'POST',
    url: `/applications/${row.id}/resume/contact-refresh`,
    headers: { authorization: `Bearer ${trimToken}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().contact.after, TRIM_REFRESHED_CONTACT);

  const stored = await storedRow(row.id);
  assert.notEqual(stored.resume_object_key, objectKey);
  const spec = stored.spec as Record<string, unknown>;

  // THE TRIM ACTUALLY HAPPENED - otherwise this fixture proves nothing about the bug it targets.
  const totalBullets = (spec.experience as Array<{ bullets: string[] }>)
    .reduce((total, entry) => total + entry.bullets.length, 0);
  assert.equal(totalBullets, 11, 'the longer header must have cost exactly one bullet, or this fixture is not exercising the layout trim');

  // THE FIX ITSELF: a binding computed from the bytes actually on the row, checked against the
  // spec actually stored beside it - the same comparison pdfGenerationBindingIsCurrent runs on
  // every later packet-audit or send-gate read of this row.
  const pdfBytes = await readObject(stored.resume_object_key);
  assert.ok(pdfBytes, 'the refreshed PDF must be readable back from storage');
  const binding = (spec._quality as Record<string, unknown> | undefined)?.pdfGenerationBinding;
  assert.ok(
    pdfGenerationBindingIsCurrent(binding, stored.spec, stored.resume_object_key, pdfBytes!, TRIM_REFRESHED_CONTACT.email),
    'the stored spec must be the one the PDF was actually rendered from, or a valid packet fails closed as PACKET_PDF_INVALID',
  );
});
