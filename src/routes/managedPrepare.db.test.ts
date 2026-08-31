import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { and, eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import * as schema from '../db/schema';
import type { ManagedPrepareDependencies } from '../lib/managedPrepare';
import { immutableDocumentContentHash } from '../lib/immutableDocumentHash';
import { verifyCurrentPacketAudit } from '../lib/packetAudit';
import type { SubmissionPacket } from '../lib/portalSubmission';
import type { ResumeRow } from './submissionRunner';

const JWT_SECRET = 'managed-prepare-db-test-secret-at-least-32';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-managed-prepare-'));
const savedEnv = { ...process.env };
const STUDENT = '7bd56988-232b-407f-af56-c1c6b0203011';
const OTHER_STUDENT = 'b38fe125-9327-4943-bda4-8623ee07fa15';
const SOURCE = '2a3f5345-3c82-4a2b-b45a-ff4c4233692b';
const JOB = '1f6b7b0f-1443-43be-9f43-cba76386d859';
const APPLY_URL = 'https://job-boards.greenhouse.io/litosfixture/jobs/12345';
const DESCRIPTION = 'Build dependable services, own production quality, and collaborate with product teams.';

const BASE_RESUME = {
  target_role: 'Software Engineer',
  school: 'Example University',
  degree: 'BSc Computer Science',
  grad_date: 'May 2027',
  coursework: 'Distributed Systems',
  education_position: 'top',
  experience: [{
    type: 'job',
    org: 'Example Lab',
    title: 'Software Engineering Intern',
    date_range: 'May 2026 - August 2026',
    bullets: ['Built a dependable service used by internal teams.'],
  }],
  skills: ['TypeScript', 'PostgreSQL'],
};

let database: PGlite;
let server: PGLiteSocketServer;
let backendPool: {
  end(): Promise<void>;
  options: { max: number; connectionTimeoutMillis?: number };
};
let backendDb: any;
let app: FastifyInstance;
let authorization: string;
let otherAuthorization: string;

const storedDocuments = new Map<string, Buffer>();
let renderCalls = 0;
let storeCalls = 0;
let readCalls = 0;
let packetCalls = 0;
let failNextPacketBuild = false;

function applicantSnapshot(fullName: string, email: string) {
  return {
    profile: {
      full_name: fullName,
      email,
      experience: [],
      skills: ['TypeScript'],
      school: 'Example University',
      grad_year: 2027,
    },
    application_profile: {},
  };
}

const dependencies: Partial<ManagedPrepareDependencies> = {
  now: () => new Date('2026-08-31T12:00:00.000Z'),
  newId: randomUUID,
  loadApplicationProfile: async () => ({}),
  planApplicantEmail: async ({ userId, applicationId, accountEmail }) => {
    const alias = `apply+${userId.slice(0, 8)}-${applicationId}@mail.litos.test`;
    return {
      identity: {
        alias,
        forwards_to: accountEmail ?? `${userId}@example.test`,
        mode: 'litos_application_alias',
      },
      choice: {
        address: alias,
        source: 'litos_alias',
        reason: 'deliverable',
        tracked: true,
        decided_at: '2026-08-31T12:00:00.000Z',
      },
      notice: null,
    };
  },
  renderMainResume: async ({ spec }) => {
    renderCalls += 1;
    return {
      buffer: Buffer.from(`%PDF-1.4\n${spec.target_role}\n%%EOF\n`),
      spec,
    };
  },
  storeResume: async (requestedKey, bytes) => {
    storeCalls += 1;
    storedDocuments.set(requestedKey, Buffer.from(bytes));
    return {
      pathname: requestedKey,
      url: `https://storage.litos.test/${encodeURIComponent(requestedKey)}`,
    };
  },
  readResume: async (objectKey) => {
    readCalls += 1;
    const bytes = storedDocuments.get(objectKey);
    return bytes ? Buffer.from(bytes) : null;
  },
  buildSubmissionPacket: async (row: ResumeRow, pdfBytes: Buffer): Promise<SubmissionPacket> => {
    packetCalls += 1;
    if (failNextPacketBuild) {
      failNextPacketBuild = false;
      throw new Error('controlled packet interruption');
    }
    const stored = row.spec as Record<string, any>;
    const contact = stored._contact as Record<string, string>;
    const email = stored._applicant_email as NonNullable<SubmissionPacket['applicantEmail']>;
    return {
      fullName: contact.full_name,
      email: email.address,
      applicantEmail: email,
      applicantSnapshot: applicantSnapshot(contact.full_name, email.address),
      employerName: String((row.job_context as Record<string, unknown>).company),
      jdText: String(stored._review.jd_text),
      resume: Buffer.from(pdfBytes),
      resumeName: 'main-resume.pdf',
      questions: stored._review.questions,
    };
  },
  browserRuntime: () => ({
    provider: 'stratus-managed',
    apiRoot: 'https://stratus.litos.test',
    projectId: undefined,
  }),
  upsertCanonicalApplication: async (input) => {
    const [existing] = await backendDb.select().from(schema.applications).where(and(
      eq(schema.applications.user_id, input.userId),
      eq(schema.applications.job_id, input.jobId),
    )).limit(1);
    if (existing) return { application: existing };
    const [created] = await backendDb.insert(schema.applications).values({
      user_id: input.userId,
      job_id: input.jobId,
      company_scope_key: input.companyScopeKey,
      company_name: input.companyName,
      role: input.role,
      source_surface: input.sourceSurface,
      application_fingerprint: `managed-test:${input.jobId}`,
    }).returning();
    return { application: created };
  },
};

async function sign(userId: string): Promise<string> {
  const token = await new SignJWT({
    userId,
    isGuest: false,
    sessionVersion: 0,
    authMethod: 'password',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(JWT_SECRET));
  return `Bearer ${token}`;
}

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
  process.env.JWT_SIGNING_SECRET = JWT_SECRET;
  process.env.ENCRYPTION_KEY = 'managed-prepare-db-test-encryption-key';
  process.env.CARD_GATE_FROM = '2020-01-01T00:00:00.000Z';

  ({ db: backendDb, pool: backendPool } = await import('../db'));
  const { managedPrepareRoutes } = await import('./managedPrepare');
  app = Fastify({ logger: false });
  await app.register(managedPrepareRoutes, { dependencies });
  await app.ready();
  authorization = await sign(STUDENT);
  otherAuthorization = await sign(OTHER_STUDENT);
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

async function seedSourceAndJob() {
  await database.query(
    `insert into "career_page_sources"
       ("id", "company_name", "ats_name", "board_token", "career_url", "enabled")
     values ($1, 'Litos Fixture', 'greenhouse', 'litosfixture',
             'https://job-boards.greenhouse.io/litosfixture', true)`,
    [SOURCE],
  );
  await database.query(
    `insert into "monitored_jobs"
       ("id", "source_id", "external_id", "company_name", "title", "description",
        "apply_url", "posting_url", "is_active")
     values ($1, $2, 'fixture-12345', 'Litos Fixture', 'Backend Engineer', $3,
             $4, $4, true)`,
    [JOB, SOURCE, DESCRIPTION, APPLY_URL],
  );
}

async function seedUser(userId: string, email: string, baseResume: unknown = BASE_RESUME) {
  await database.query(
    `insert into "users" ("id", "email", "email_verified", "is_guest", "plan")
     values ($1, $2, true, false, 'free')`,
    [userId, email],
  );
  await database.query(
    `insert into "profiles" ("user_id", "parsed_json", "base_resume_json", "base_resume_built_at")
     values ($1, $2, $3, now())`,
    [userId, JSON.stringify({ full_name: `Applicant ${userId.slice(0, 4)}`, resume_email: email }), JSON.stringify(baseResume)],
  );
}

function prepare(headers: Record<string, string> = { authorization }, body: unknown = {
  job_id: JOB,
  resume_source: 'main_resume',
}) {
  return app.inject({
    method: 'POST',
    url: '/applications/managed-prepare',
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await database.exec('truncate "users", "career_page_sources" cascade');
  storedDocuments.clear();
  renderCalls = 0;
  storeCalls = 0;
  readCalls = 0;
  packetCalls = 0;
  failNextPacketBuild = false;
  await seedSourceAndJob();
});

test('requires normal user authentication and an exact request body before creating state', async () => {
  await seedUser(STUDENT, 'student@example.test');
  assert.equal((await prepare({})).statusCode, 401);
  assert.equal((await prepare({ authorization }, { job_id: JOB })).statusCode, 400);
  assert.equal((await prepare({ authorization }, {
    job_id: JOB,
    resume_source: 'main_resume',
    unexpected: true,
  })).statusCode, 400);

  const counts = await database.query<{ applications: number; packets: number }>(
    `select
       (select count(*)::int from "applications") as applications,
       (select count(*)::int from "generated_resumes") as packets`,
  );
  assert.deepEqual(counts.rows[0], { applications: 0, packets: 0 });
  assert.equal(renderCalls, 0);
  assert.equal(storeCalls, 0);
});

test('prepares one Free-plan packet with an exact canonical, artifact, and review identity chain', async () => {
  await seedUser(STUDENT, 'student@example.test');
  const response = await prepare();
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.headers['cache-control'] ?? '', /no-store/u);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ['application_id', 'packet_id', 'reused', 'review', 'state']);
  assert.equal(body.state, 'ready_for_review');
  assert.equal(body.reused, false);
  assert.equal(body.review.status, 'resume_ready');
  assert.deepEqual(body.review.questions, []);
  assert.deepEqual(body.review.filled_fields, []);
  assert.deepEqual(body.review.skipped_reasons, []);
  assert.equal(body.review.packet_audit.bindings.applicationId, body.packet_id);
  assert.equal(body.review.packet_audit.bindings.employerDelivery.mode, 'browser');
  assert.equal(JSON.stringify(body).includes(APPLY_URL), false);
  assert.equal(JSON.stringify(body).includes('job-boards.greenhouse.io'), false);

  const canonical = await database.query<Record<string, any>>(
    `select * from "applications" where "id" = $1 and "user_id" = $2`,
    [body.application_id, STUDENT],
  );
  assert.equal(canonical.rows.length, 1);
  assert.equal(canonical.rows[0].legacy_generated_resume_id, body.packet_id);
  assert.equal(canonical.rows[0].portal_url, null);
  assert.equal(canonical.rows[0].resume_attached, true);
  assert.equal(canonical.rows[0].resume_source, 'artifact');
  assert.equal(canonical.rows[0].review_state, 'ready');

  const packets = await database.query<Record<string, any>>(
    `select * from "generated_resumes" where "id" = $1 and "user_id" = $2`,
    [body.packet_id, STUDENT],
  );
  assert.equal(packets.rows.length, 1);
  assert.deepEqual(body.review, packets.rows[0].spec._review);
  assert.equal(packets.rows[0].spec.target_role, BASE_RESUME.target_role);
  assert.notEqual(packets.rows[0].spec.target_role, 'Backend Engineer');
  assert.equal(packets.rows[0].spec._managed_prepare.canonical_application_id, body.application_id);
  assert.equal(packets.rows[0].spec._managed_prepare.packet_id, body.packet_id);
  assert.equal(packets.rows[0].spec._managed_prepare.resume_source, 'main_resume');
  const retainedPdf = storedDocuments.get(packets.rows[0].resume_object_key);
  assert.ok(retainedPdf);
  const auditVerification = verifyCurrentPacketAudit({
    audit: body.review.packet_audit,
    ownerId: STUDENT,
    applicationId: body.packet_id,
    jdText: body.review.jd_text,
    spec: packets.rows[0].spec,
    jobContext: packets.rows[0].job_context,
    questions: body.review.questions,
    applicantSnapshot: body.review.applicant_snapshot,
    employerDelivery: body.review.employer_delivery_bindings,
    resumeEmail: packets.rows[0].spec._contact.email,
    applicantEmail: body.review.applicant_email.address,
    pdfObjectKey: packets.rows[0].resume_object_key,
    pdfBytes: retainedPdf,
  });
  assert.equal(auditVerification.valid, true, auditVerification.reason);

  const artifactRows = await database.query<Record<string, any>>(
    `select a.*, v."content_hash", v."structured_content" as version_content,
            v."rendered_object_key" as version_object_key,
            v."rendered_blob_url" as version_blob_url,
            aa."selected"
       from "artifacts" a
       join "artifact_versions" v on v."artifact_id" = a."id" and v."version_number" = 1
       join "application_artifacts" aa on aa."artifact_id" = a."id"
      where a."legacy_generated_resume_id" = $1 and aa."application_id" = $2`,
    [body.packet_id, body.application_id],
  );
  assert.equal(artifactRows.rows.length, 1);
  const artifact = artifactRows.rows[0];
  assert.equal(artifact.id, canonical.rows[0].selected_resume_artifact_id);
  assert.equal(artifact.selected, true);
  assert.deepEqual(artifact.structured_content, packets.rows[0].spec);
  assert.deepEqual(artifact.version_content, packets.rows[0].spec);
  assert.equal(artifact.content_hash, immutableDocumentContentHash(packets.rows[0].spec));
  assert.equal(artifact.rendered_object_key, packets.rows[0].resume_object_key);
  assert.equal(artifact.version_object_key, packets.rows[0].resume_object_key);
  assert.equal(artifact.rendered_blob_url, artifact.version_blob_url);
  assert.match(artifact.rendered_blob_url, /^https:\/\/storage\.litos\.test\//u);

  const freeState = await database.query<Record<string, any>>(
    `select u."plan",
            (select count(*)::int from "entitlement_usage_reservations" where "user_id" = u."id") as reservations,
            (select count(*)::int from "trial_company_usage" where "user_id" = u."id") as trial_usage
       from "users" u where u."id" = $1`,
    [STUDENT],
  );
  assert.deepEqual(freeState.rows[0], { plan: 'free', reservations: 0, trial_usage: 0 });
  assert.equal(renderCalls, 1);
  assert.equal(storeCalls, 1);
  assert.equal(readCalls, 0);
  assert.equal(packetCalls, 1);
});

test('default profile and email DB readers complete with the production one-connection pool', async () => {
  await seedUser(STUDENT, 'student@example.test');
  assert.equal(backendPool.options.max, 1, 'VERCEL must configure the production pool limit');
  const previousConnectionTimeout = backendPool.options.connectionTimeoutMillis;
  backendPool.options.connectionTimeoutMillis = 250;
  try {
    const [{ prepareManagedApplication }, { loadApplicationProfileLike }, { planPacketApplicantEmail }] = await Promise.all([
      import('../lib/managedPrepare'),
      import('../lib/applicationProfileLike'),
      import('../lib/packetApplicantEmail'),
    ]);
    const result = await prepareManagedApplication({ userId: STUDENT, jobId: JOB }, {
      ...dependencies,
      loadApplicationProfile: loadApplicationProfileLike,
      planApplicantEmail: (input, planDependencies) => planPacketApplicantEmail(input, {
        ...planDependencies,
        deliverability: async () => ({
          deliverable: true,
          domain: 'mail.litos.test',
          reason: 'deliverable',
          mx_hosts: ['mx.litos.test'],
          mx_provider: 'resend',
          mx_provider_agrees: true,
          resend_domain_status: 'verified',
          resend_receiving_status: 'enabled',
          inbound_route_configured: true,
          checked_at: '2026-08-31T12:00:00.000Z',
        }),
        aliasFor: (userId, applicationId) =>
          `apply+${userId.slice(0, 8)}-${applicationId}@mail.litos.test`,
      }),
    });
    assert.equal(result.state, 'ready_for_review');
    const seededBank = await database.query<{ total: number }>(
      'select count(*)::int as total from "experience_bank" where "user_id" = $1',
      [STUDENT],
    );
    assert.equal(seededBank.rows[0]?.total, 1);
  } finally {
    if (previousConnectionTimeout === undefined) {
      delete backendPool.options.connectionTimeoutMillis;
    } else {
      backendPool.options.connectionTimeoutMillis = previousConnectionTimeout;
    }
  }
});

test('render and object storage do not hold the production one-connection pool', async () => {
  await seedUser(STUDENT, 'student@example.test');
  assert.equal(backendPool.options.max, 1, 'VERCEL must configure the production pool limit');
  const { prepareManagedApplication } = await import('../lib/managedPrepare');
  let releaseRender!: () => void;
  let reportRenderEntered!: () => void;
  const renderEntered = new Promise<void>((resolve) => { reportRenderEntered = resolve; });
  const renderGate = new Promise<void>((resolve) => { releaseRender = resolve; });
  const preparing = prepareManagedApplication({ userId: STUDENT, jobId: JOB }, {
    ...dependencies,
    renderMainResume: async ({ spec }) => {
      reportRenderEntered();
      await renderGate;
      return { buffer: Buffer.from('%PDF-1.4\nnonblocking\n%%EOF\n'), spec };
    },
  });
  await renderEntered;

  try {
    const competingRead = backendDb.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.id, STUDENT)).limit(1);
    const outcome = await Promise.race([
      competingRead.then((rows: unknown[]) => ({ kind: 'rows' as const, rows })),
      new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 250)),
    ]);
    assert.equal(outcome.kind, 'rows', 'render must not starve unrelated DB work behind the sole pool connection');
    if (outcome.kind === 'rows') assert.equal(outcome.rows.length, 1);
  } finally {
    releaseRender();
  }
  const result = await preparing;
  assert.equal(result.state, 'ready_for_review');
});

test('a failed external render releases only its reservation so an immediate retry can reuse the object identity', async () => {
  await seedUser(STUDENT, 'student@example.test');
  const { prepareManagedApplication } = await import('../lib/managedPrepare');
  await assert.rejects(
    prepareManagedApplication({ userId: STUDENT, jobId: JOB }, {
      ...dependencies,
      renderMainResume: async () => { throw new Error('controlled render failure'); },
    }),
    (error: unknown) => (error as { code?: string }).code === 'main_resume_render_failed',
  );
  const afterFailure = await database.query<{ count: number }>(
    'select count(*)::int as count from "generated_resumes" where "user_id" = $1',
    [STUDENT],
  );
  assert.equal(afterFailure.rows[0]?.count, 0);

  const recovered = await prepareManagedApplication({ userId: STUDENT, jobId: JOB }, dependencies);
  assert.equal(recovered.state, 'ready_for_review');
  const packet = await database.query<{ resume_object_key: string }>(
    'select "resume_object_key" from "generated_resumes" where "id" = $1',
    [recovered.packet_id],
  );
  assert.match(packet.rows[0]?.resume_object_key ?? '', /\/[0-9a-f]{64}\.pdf$/u);
  assert.equal(packet.rows[0]?.resume_object_key.includes(`/${JOB}/`), true);
});

test('replays the exact committed result without rendering, storing, or building twice', async () => {
  await seedUser(STUDENT, 'student@example.test');
  const first = await prepare();
  const second = await prepare();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().application_id, first.json().application_id);
  assert.equal(second.json().packet_id, first.json().packet_id);
  assert.deepEqual(second.json().review, first.json().review);
  assert.equal(second.json().reused, true);
  assert.equal(renderCalls, 1);
  assert.equal(storeCalls, 1);
  assert.equal(readCalls, 0);
  assert.equal(packetCalls, 1);

  const counts = await database.query<Record<string, number>>(
    `select
       (select count(*)::int from "applications") as applications,
       (select count(*)::int from "generated_resumes") as packets,
       (select count(*)::int from "artifacts") as artifacts,
       (select count(*)::int from "artifact_versions") as versions,
       (select count(*)::int from "application_artifacts") as links`,
  );
  assert.deepEqual(counts.rows[0], { applications: 1, packets: 1, artifacts: 1, versions: 1, links: 1 });
});

test('scopes idempotency to the authenticated owner even for the same monitored job', async () => {
  await seedUser(STUDENT, 'student@example.test');
  await seedUser(OTHER_STUDENT, 'other@example.test');
  const first = await prepare();
  const second = await prepare({ authorization: otherAuthorization });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.notEqual(first.json().application_id, second.json().application_id);
  assert.notEqual(first.json().packet_id, second.json().packet_id);

  const ownership = await database.query<Record<string, string>>(
    `select a."user_id", a."id" as application_id, g."id" as packet_id
       from "applications" a
       join "generated_resumes" g on g."id" = a."legacy_generated_resume_id"
      order by a."user_id"`,
  );
  assert.equal(ownership.rows.length, 2);
  assert.deepEqual(new Set(ownership.rows.map((row) => row.user_id)), new Set([STUDENT, OTHER_STUDENT]));
});

test('a changed main-resume digest creates a new immutable packet and rebinds the same canonical row', async () => {
  await seedUser(STUDENT, 'student@example.test');
  const first = await prepare();
  assert.equal(first.statusCode, 200, first.body);
  const changed = { ...BASE_RESUME, target_role: 'Platform Engineer', skills: [...BASE_RESUME.skills, 'Kubernetes'] };
  await database.query(
    `update "profiles" set "base_resume_json" = $2, "base_resume_built_at" = now() where "user_id" = $1`,
    [STUDENT, JSON.stringify(changed)],
  );

  const second = await prepare();
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().application_id, first.json().application_id);
  assert.notEqual(second.json().packet_id, first.json().packet_id);
  assert.equal(second.json().reused, false);
  assert.equal(renderCalls, 2);
  assert.equal(storeCalls, 2);
  assert.equal(packetCalls, 2);

  const rows = await database.query<Record<string, any>>(
    `select
       (select count(*)::int from "applications" where "user_id" = $1) as applications,
       (select count(*)::int from "generated_resumes" where "user_id" = $1) as packets,
       (select count(*)::int from "artifacts" where "user_id" = $1) as artifacts,
       (select "legacy_generated_resume_id" from "applications" where "id" = $2) as current_packet,
       (select count(*)::int from "application_artifacts" where "application_id" = $2 and "selected" = true) as selected_links`,
    [STUDENT, first.json().application_id],
  );
  assert.deepEqual(rows.rows[0], {
    applications: 1,
    packets: 2,
    artifacts: 2,
    current_packet: second.json().packet_id,
    selected_links: 1,
  });
});

test('recovers an interrupted preliminary packet without a second render or object-store write', async () => {
  await seedUser(STUDENT, 'student@example.test');
  failNextPacketBuild = true;
  const interrupted = await prepare();
  assert.equal(interrupted.statusCode, 500, interrupted.body);
  const preliminary = await database.query<Record<string, any>>(
    `select g."id", g."spec", g."resume_object_key",
            (select count(*)::int from "artifacts" where "legacy_generated_resume_id" = g."id") as artifacts
       from "generated_resumes" g where g."user_id" = $1`,
    [STUDENT],
  );
  assert.equal(preliminary.rows.length, 1);
  assert.equal(preliminary.rows[0].artifacts, 0);
  assert.equal(preliminary.rows[0].spec._review.packet_audit, undefined);

  const recovered = await prepare();
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().packet_id, preliminary.rows[0].id);
  assert.equal(recovered.json().reused, true);
  assert.equal(renderCalls, 1);
  assert.equal(storeCalls, 1);
  assert.equal(readCalls, 1);
  assert.equal(packetCalls, 2);

  const artifact = await database.query<Record<string, any>>(
    `select "rendered_blob_url" from "artifacts" where "legacy_generated_resume_id" = $1`,
    [preliminary.rows[0].id],
  );
  assert.equal(artifact.rows.length, 1);
  assert.equal(artifact.rows[0].rendered_blob_url, preliminary.rows[0].spec._managed_prepare.rendered_blob_url);
});

test('refuses a missing main resume without creating a canonical application or contacting storage', async () => {
  await seedUser(STUDENT, 'student@example.test', null);
  const response = await prepare();
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'main_resume_missing');
  assert.equal(renderCalls, 0);
  assert.equal(storeCalls, 0);
  assert.equal(packetCalls, 0);
  const count = await database.query<{ count: number }>('select count(*)::int as count from "applications"');
  assert.equal(count.rows[0].count, 0);
});

test('the endpoint has no employer browser, form, fetch, tailoring, or entitlement action seam', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/managedPrepare.ts'), 'utf8');
  const indexSource = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
  for (const forbidden of [
    'runManagedBrowser',
    'runBrowserbase',
    '.goto(',
    '.click(',
    'fetch(',
    'generateResumeSpec',
    'generateOpenAIText',
    'reserveEntitledUsage',
    'commitEntitledUsage',
  ]) {
    assert.equal(source.includes(forbidden), false, `managed prepare must not contain ${forbidden}`);
  }
  assert.match(source, /renderResumePdf\(spec, contact\)/u);
  assert.match(source, /sourceSurface: 'dashboard'/u);
  assert.equal(source.includes("'preparing'"), false);
  assert.match(indexSource, /import \{ managedPrepareRoutes \} from '\.\/routes\/managedPrepare';/u);
  assert.match(indexSource, /register\(managedPrepareRoutes\)/u);
});
