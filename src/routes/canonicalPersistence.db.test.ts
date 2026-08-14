import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';

const JWT_SECRET = 'canonical-persistence-test-secret-32-chars';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-canonical-persistence-'));
const savedEnv = { ...process.env };
let database: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let backendPool: { end(): Promise<void> };
let backendDb: any;
let appendEditedResumeArtifactVersion: typeof import('../lib/resumeArtifactVersions').appendEditedResumeArtifactVersion;
let linkGeneratedPacketToCanonicalApplication: typeof import('../lib/resumeArtifactVersions').linkGeneratedPacketToCanonicalApplication;
let findOwnedDownloadSource: typeof import('../lib/downloadDocumentRecovery').findOwnedDownloadSource;
let recoverOwnedGeneratedDocument: typeof import('../lib/downloadDocumentRecovery').recoverOwnedGeneratedDocument;
let immutableDocumentContentHash: typeof import('../lib/immutableDocumentHash').immutableDocumentContentHash;
let resolveOwnedCoverLetterTarget: typeof import('./coverLetter').resolveOwnedCoverLetterTarget;
let updateCanonicalApplicationAfterFill: typeof import('./canonicalApplications').updateCanonicalApplicationAfterFill;
let upsertCanonicalApplicationForUser: typeof import('./canonicalApplications').upsertCanonicalApplicationForUser;
let reuseCanonicalCoverLetter: typeof import('../lib/canonicalCoverLetterService').reuseCanonicalCoverLetter;
let listCanonicalStoredCoverLetters: typeof import('../lib/canonicalCoverLetterService').listCanonicalStoredCoverLetters;
let deleteCanonicalCoverLetters: typeof import('../lib/canonicalCoverLetterService').deleteCanonicalCoverLetters;
let canonicalDraftContext: typeof import('./draft').canonicalDraftContext;
let deleteUnreferencedManualContacts: typeof import('./account').deleteUnreferencedManualContacts;

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
  server = new PGLiteSocketServer({
    db: database,
    path: join(socketDir, '.s.PGSQL.5432'),
    maxConnections: 10,
  });
  await server.start();
  process.env.VERCEL = '1';
  process.env.LOG_LEVEL = 'silent';
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  process.env.JWT_SIGNING_SECRET = JWT_SECRET;
  ({ db: backendDb, pool: backendPool } = await import('../db'));
  ({ appendEditedResumeArtifactVersion, linkGeneratedPacketToCanonicalApplication } = await import('../lib/resumeArtifactVersions'));
  ({ findOwnedDownloadSource, recoverOwnedGeneratedDocument } = await import('../lib/downloadDocumentRecovery'));
  ({ immutableDocumentContentHash } = await import('../lib/immutableDocumentHash'));
  ({ resolveOwnedCoverLetterTarget } = await import('./coverLetter'));
  ({
    reuseCanonicalCoverLetter,
    listCanonicalStoredCoverLetters,
    deleteCanonicalCoverLetters,
  } = await import('../lib/canonicalCoverLetterService'));
  const { canonicalDraftContext: canonicalizeDraft, draftRoutes } = await import('./draft');
  canonicalDraftContext = canonicalizeDraft;
  const {
    canonicalApplicationRoutes,
    updateCanonicalApplicationAfterFill: updateAfterFill,
    upsertCanonicalApplicationForUser: upsertApplication,
  } = await import('./canonicalApplications');
  updateCanonicalApplicationAfterFill = updateAfterFill;
  upsertCanonicalApplicationForUser = upsertApplication;
  app = Fastify({ logger: false });
  await app.register(canonicalApplicationRoutes);
  await app.register(draftRoutes);
  const { applicationAnswerRoutes } = await import('./applicationAnswer');
  await app.register(applicationAnswerRoutes);
  const { billingV2Routes } = await import('./billingV2');
  await app.register(billingV2Routes);
  const { accountRoutes, deleteUnreferencedManualContacts: deleteManualContacts } = await import('./account');
  deleteUnreferencedManualContacts = deleteManualContacts;
  await app.register(accountRoutes);
  await app.ready();
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

test('manual outcome route is owner scoped, origin bound, idempotent, and monotonic without entitlements', async () => {
  const ownerId = '6d58c1f5-e885-41f7-a16a-dac37f98ab17';
  const strangerId = '9610648e-7750-4931-9a74-8aef5ebf00c0';
  const applicationId = '0b84c4eb-5c91-43d0-a5a0-62b508d8ce55';
  const eventId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  await database.exec(`
    insert into "users" ("id", "email") values
      ('${ownerId}', 'manual-owner@example.test'),
      ('${strangerId}', 'manual-stranger@example.test');
    insert into "applications" (
      "id", "user_id", "company_scope_key", "company_name", "role", "portal_url",
      "source_surface", "application_fingerprint"
    ) values (
      '${applicationId}', '${ownerId}', 'domain:jobs.example.com', 'Example', 'Engineer',
      'https://jobs.example.com/apply/1', 'extension', 'manual-outcome-test'
    );
  `);
  const ownerToken = await token(ownerId);
  const strangerToken = await token(strangerId);

  const stranger = await app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/manual-submission-outcome`,
    headers: { authorization: `Bearer ${strangerToken}` },
    payload: { event_id: eventId, outcome: 'unknown', final_url: 'https://jobs.example.com/apply/1' },
  });
  assert.equal(stranger.statusCode, 404);

  const wrongOrigin = await app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/manual-submission-outcome`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { event_id: eventId, outcome: 'unknown', final_url: 'https://attacker.example/receipt' },
  });
  assert.equal(wrongOrigin.statusCode, 409);
  assert.equal(wrongOrigin.json().code, 'portal_identity_mismatch');

  const unknown = await app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/manual-submission-outcome`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { event_id: eventId, outcome: 'unknown', final_url: 'https://jobs.example.com/apply/1' },
  });
  assert.equal(unknown.statusCode, 200, unknown.body);
  assert.equal(unknown.json().idempotent, false);
  assert.equal(unknown.json().applied_submission_state, 'needs_attention');
  const [staleBeforeReceipt] = await backendDb.select().from(schema.applications)
    .where(eq(schema.applications.id, applicationId)).limit(1);

  const replay = await app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/manual-submission-outcome`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { event_id: eventId, outcome: 'unknown', final_url: 'https://jobs.example.com/apply/1' },
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().idempotent, true);

  const promoted = await app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/manual-submission-outcome`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: {
      event_id: eventId,
      outcome: 'confirmed',
      final_url: 'https://jobs.example.com/apply/receipt',
      confirmation_text: 'Application received',
    },
  });
  assert.equal(promoted.statusCode, 200, promoted.body);
  assert.equal(promoted.json().outcome, 'confirmed');
  assert.equal(promoted.json().applied_submission_state, 'submitted');

  // Simulate a fill request that read the row before the receipt committed, then reached its UPDATE
  // after the receipt. The UPDATE itself must observe and preserve the now-terminal lifecycle.
  await updateCanonicalApplicationAfterFill(backendDb, {
    applicationId,
    userId: ownerId,
    selectedResumeArtifactId: staleBeforeReceipt.selected_resume_artifact_id,
    resumeAttached: staleBeforeReceipt.resume_attached,
    resumeSource: staleBeforeReceipt.resume_source as 'artifact' | 'base_resume' | 'none',
    resumeAttachedAt: staleBeforeReceipt.resume_attached_at,
  });
  const interleavedState = await database.query<{
    submission_state: string;
    tracker_state: string;
    review_state: string;
  }>(`select "submission_state", "tracker_state", "review_state" from "applications" where "id" = '${applicationId}'`);
  assert.deepEqual(interleavedState.rows[0], {
    submission_state: 'submitted',
    tracker_state: 'applied',
    review_state: 'not_started',
  });

  const delayedFill = await app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/fill`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { resume_attached: false, resume_source: 'none' },
  });
  assert.equal(delayedFill.statusCode, 200, delayedFill.body);
  assert.equal(delayedFill.json().application.tracker_state, 'applied');
  assert.equal(delayedFill.json().application.submission_state, 'submitted');
  assert.notEqual(delayedFill.json().application.review_state, 'filling');

  const flip = await app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/manual-submission-outcome`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: {
      event_id: eventId,
      outcome: 'failed',
      final_url: 'https://jobs.example.com/apply/failure',
    },
  });
  assert.equal(flip.statusCode, 409);
  assert.equal(flip.json().code, 'submission_event_terminal');

  const events = await database.query<{ outcome: string; total: number }>(`
    select min("outcome") as "outcome", count(*)::int as "total"
    from "application_submission_events" where "user_id" = '${ownerId}' and "event_id" = '${eventId}'
  `);
  assert.deepEqual(events.rows[0], { outcome: 'confirmed', total: 1 });
  const state = await database.query<{ submission_state: string; tracker_state: string }>(`
    select "submission_state", "tracker_state" from "applications" where "id" = '${applicationId}'
  `);
  assert.deepEqual(state.rows[0], { submission_state: 'submitted', tracker_state: 'applied' });
});

test('Free fill upgrades one canonical row to a tailored packet that cover letter resolves by canonical id', async () => {
  const userId = 'f25da80c-33ad-4b64-830e-e4a1bd0a8c26';
  const applicationId = '27f0cdde-85d2-40ab-bbcc-526b9ad387b2';
  const packetId = '8fa67ffc-3351-488e-94ca-7a71cb8f1fdb';
  const artifactId = 'ef30d611-04e8-4b26-82a6-8ea6e38df341';
  await database.exec(`
    insert into "users" ("id", "email") values ('${userId}', 'canonical-upgrade@example.test');
    insert into "applications" (
      "id", "user_id", "company_scope_key", "company_name", "role", "portal_url",
      "source_surface", "application_fingerprint"
    ) values (
      '${applicationId}', '${userId}', 'domain:jobs.example.com', 'Example', 'Engineer',
      'https://jobs.example.com/apply/upgrade', 'dashboard', 'canonical-upgrade-test'
    )
  `);
  const auth = await token(userId);
  const fill = await app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/fill`,
    headers: { authorization: `Bearer ${auth}` },
    payload: { resume_attached: false, resume_source: 'none' },
  });
  assert.equal(fill.statusCode, 200, fill.body);
  assert.equal((await resolveOwnedCoverLetterTarget(userId, applicationId)).kind, 'found');
  await database.exec(`
    update "applications" set "submission_state" = 'submitted', "tracker_state" = 'applied',
      "review_state" = 'completed', "resume_attached" = true, "resume_source" = 'base_resume'
      where "id" = '${applicationId}'
  `);

  const spec = { summary: 'Tailored', _review: { jd_text: 'Frozen JD', role: 'Engineer' } };
  await backendDb.transaction(async (tx: any) => {
    await tx.insert(schema.generated_resumes).values({
      id: packetId,
      user_id: userId,
      job_context: { company: 'Example', role: 'Engineer' },
      spec,
      resume_object_key: 'users/canonical-upgrade/tailored.pdf',
    });
    await tx.insert(schema.artifacts).values({
      id: artifactId,
      user_id: userId,
      legacy_generated_resume_id: packetId,
      kind: 'tailored_resume',
      structured_content: spec,
      rendered_object_key: 'users/canonical-upgrade/tailored.pdf',
      rendered_blob_url: 'https://blob.example/canonical-upgrade.pdf',
      source: 'ai_tailored',
    });
    await tx.insert(schema.artifact_versions).values({
      artifact_id: artifactId,
      version_number: 1,
      generation_source: 'ai_tailored',
      job_context: { company: 'Example', role: 'Engineer' },
      content_hash: immutableDocumentContentHash(spec),
      structured_content: spec,
      rendered_object_key: 'users/canonical-upgrade/tailored.pdf',
      rendered_blob_url: 'https://blob.example/canonical-upgrade.pdf',
    });
    await tx.insert(schema.application_artifacts).values({
      application_id: applicationId,
      artifact_id: artifactId,
      purpose: 'resume',
      selected: true,
    });
    await linkGeneratedPacketToCanonicalApplication(tx, {
      userId,
      applicationId,
      generatedResumeId: packetId,
      artifactId,
    });
  });

  const applications = await database.query<{
    total: number;
    legacy_generated_resume_id: string;
    selected_resume_artifact_id: string;
    submission_state: string;
    tracker_state: string;
    review_state: string;
  }>(`select count(*) over ()::int as "total", "legacy_generated_resume_id", "selected_resume_artifact_id",
        "submission_state", "tracker_state", "review_state"
      from "applications" where "user_id" = '${userId}'`);
  assert.deepEqual(applications.rows[0], {
    total: 1,
    legacy_generated_resume_id: packetId,
    selected_resume_artifact_id: artifactId,
    submission_state: 'submitted',
    tracker_state: 'applied',
    review_state: 'completed',
  });
  const coverTarget = await resolveOwnedCoverLetterTarget(userId, applicationId);
  assert.equal(coverTarget.kind, 'found');
  if (coverTarget.kind === 'found') {
    assert.equal(coverTarget.canonicalApplicationId, applicationId);
    assert.equal(coverTarget.row?.id, packetId);
  }
});

test('an edited resume appends an immutable object-key-bound version used after blob expiry', async () => {
  const userId = '57ce74ec-1103-46fb-992d-a618e71bc355';
  const resumeId = 'd31fa5dc-791f-49f2-a97a-0efb09c54e99';
  const artifactId = 'f24df474-a72a-4a22-84de-a612adac83b3';
  const original = { summary: 'Original', _review: { jd_text: 'Frozen JD', role: 'Engineer' } };
  const edited = { summary: 'Edited retained value', _review: { jd_text: 'Frozen JD', role: 'Engineer' } };
  await database.exec(`
    insert into "users" ("id", "email") values ('${userId}', 'edited-resume@example.test');
  `);
  await database.query(`
    insert into "generated_resumes" ("id", "user_id", "job_context", "spec", "resume_object_key")
      values ('${resumeId}', '${userId}', '{"company":"Example","role":"Engineer"}'::jsonb,
        $1::jsonb, 'users/edited/original.pdf')
  `, [JSON.stringify(original)]);
  await database.query(`
    insert into "artifacts" (
      "id", "user_id", "legacy_generated_resume_id", "kind", "structured_content",
      "rendered_object_key", "rendered_blob_url", "source"
    ) values (
      '${artifactId}', '${userId}', '${resumeId}', 'tailored_resume', $1::jsonb,
      'users/edited/original.pdf', 'https://blob.example/original.pdf', 'ai_tailored'
    )
  `, [JSON.stringify(original)]);
  await database.query(`
    insert into "artifact_versions" (
      "artifact_id", "version_number", "generation_source", "job_context", "content_hash",
      "structured_content", "rendered_object_key", "rendered_blob_url"
    ) values (
      '${artifactId}', 1, 'ai_tailored', '{"company":"Example","role":"Engineer"}'::jsonb, $2,
      $1::jsonb, 'users/edited/original.pdf', 'https://blob.example/original.pdf'
    )
  `, [JSON.stringify(original), immutableDocumentContentHash(original)]);

  await backendDb.transaction(async (tx: any) => appendEditedResumeArtifactVersion(tx, {
    userId,
    legacyGeneratedResumeId: resumeId,
    structuredContent: edited,
    jobContext: { company: 'Example', role: 'Engineer' },
    renderedObjectKey: 'users/edited/version-2.pdf',
    renderedBlobUrl: 'https://blob.example/version-2.pdf',
  }));
  await database.exec(`
    update "generated_resumes" set "spec" = '{"summary":"mutable later generated row"}'::jsonb
      where "id" = '${resumeId}';
    update "artifacts" set "structured_content" = '{"summary":"mutable later artifact"}'::jsonb
      where "id" = '${artifactId}'
  `);

  const source = await findOwnedDownloadSource(userId, 'users/edited/version-2.pdf');
  assert.equal(source?.kind, 'resume');
  if (source?.kind === 'resume') assert.deepEqual(source.inputs.spec, edited);
  const recovered = await recoverOwnedGeneratedDocument({
    userId,
    objectKey: 'users/edited/version-2.pdf',
    renderResume: async (inputs) => Buffer.from(JSON.stringify(inputs.spec)),
  });
  assert.equal(recovered.status, 'rendered');
  if (recovered.status === 'rendered') assert.deepEqual(JSON.parse(recovered.buffer.toString()), edited);

  const versions = await database.query<{ version_number: number; rendered_object_key: string }>(`
    select "version_number", "rendered_object_key" from "artifact_versions"
    where "artifact_id" = '${artifactId}' order by "version_number"
  `);
  assert.deepEqual(versions.rows, [
    { version_number: 1, rendered_object_key: 'users/edited/original.pdf' },
    { version_number: 2, rendered_object_key: 'users/edited/version-2.pdf' },
  ]);
});

test('job and portal aliases converge to one canonical application in both creation orders', async () => {
  const portalUrl = 'https://jobs.example.com/apply/canonical-alias';
  const companyScopeKey = 'domain:jobs.example.com';
  const jobId = '50e5760f-1c85-4f58-8100-3a53e52a18f2';
  for (const order of ['job_first', 'portal_first'] as const) {
    const userId = randomUUID();
    await dbInsertUser(userId, `canonical-alias-${order}@example.test`);
    const first = order === 'job_first'
      ? await upsertCanonicalApplicationForUser({
        userId,
        jobId,
        companyScopeKey,
        companyName: 'Example',
        role: 'Engineer',
        portalUrl,
        sourceSurface: 'dashboard',
      })
      : await upsertCanonicalApplicationForUser({
        userId,
        companyScopeKey,
        companyName: 'Example',
        role: 'Engineer',
        portalUrl,
        sourceSurface: 'extension',
      });
    const second = order === 'job_first'
      ? await upsertCanonicalApplicationForUser({
        userId,
        companyScopeKey,
        companyName: 'Example',
        role: 'Engineer',
        portalUrl,
        sourceSurface: 'extension',
      })
      : await upsertCanonicalApplicationForUser({
        userId,
        jobId,
        companyScopeKey,
        companyName: 'Example',
        role: 'Engineer',
        portalUrl,
        sourceSurface: 'dashboard',
      });
    assert.equal(second.application.id, first.application.id);
    const rows = (await backendDb.select().from(schema.applications))
      .filter((row: typeof schema.applications.$inferSelect) => row.user_id === userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].job_id, jobId);
    assert.equal(rows[0].portal_url, portalUrl);
  }
});

test('an owned cover letter can be reused across applications and is deleted only after its final link', async () => {
  const userId = randomUUID();
  const sourceApplicationId = randomUUID();
  const targetApplicationId = randomUUID();
  const artifactId = randomUUID();
  await dbInsertUser(userId, 'cover-letter-reuse@example.test');
  await backendDb.insert(schema.applications).values([
    {
      id: sourceApplicationId,
      user_id: userId,
      company_scope_key: 'domain:source.example',
      company_name: 'Source',
      role: 'Engineer',
      source_surface: 'dashboard',
      application_fingerprint: `test:${sourceApplicationId}`,
    },
    {
      id: targetApplicationId,
      user_id: userId,
      company_scope_key: 'domain:target.example',
      company_name: 'Target',
      role: 'Engineer',
      source_surface: 'dashboard',
      application_fingerprint: `test:${targetApplicationId}`,
    },
  ]);
  const content = {
    body: 'Saved manual cover letter.',
    word_count: 4,
    warnings: [],
    generated_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    file_name: 'cover-letter.pdf',
  };
  await backendDb.insert(schema.artifacts).values({
    id: artifactId,
    user_id: userId,
    kind: 'cover_letter',
    structured_content: content,
    rendered_object_key: 'users/cover-letter-reuse/source.pdf',
    source: 'user_edited_cover_letter',
  });
  await backendDb.insert(schema.artifact_versions).values({
    artifact_id: artifactId,
    version_number: 1,
    generation_source: 'user_edited_cover_letter',
    content_hash: immutableDocumentContentHash(content),
    structured_content: content,
    rendered_object_key: 'users/cover-letter-reuse/source.pdf',
  });
  await backendDb.insert(schema.application_artifacts).values({
    application_id: sourceApplicationId,
    artifact_id: artifactId,
    purpose: 'cover_letter',
    selected: true,
  });

  const reused = await reuseCanonicalCoverLetter({ userId, applicationId: targetApplicationId, artifactId });
  assert.equal(reused?.cover_letter.artifact_id, artifactId);
  let links = (await backendDb.select().from(schema.application_artifacts))
    .filter((row: typeof schema.application_artifacts.$inferSelect) => row.artifact_id === artifactId);
  assert.deepEqual(new Set(links.map((row: typeof schema.application_artifacts.$inferSelect) => row.application_id)),
    new Set([sourceApplicationId, targetApplicationId]));
  assert.equal((await listCanonicalStoredCoverLetters(userId)).length, 2);

  await deleteCanonicalCoverLetters({ userId, applicationId: targetApplicationId });
  let [artifact] = (await backendDb.select().from(schema.artifacts))
    .filter((row: typeof schema.artifacts.$inferSelect) => row.id === artifactId);
  assert.equal(artifact.deleted_at, null);
  links = (await backendDb.select().from(schema.application_artifacts))
    .filter((row: typeof schema.application_artifacts.$inferSelect) => row.artifact_id === artifactId);
  assert.deepEqual(links.map((row: typeof schema.application_artifacts.$inferSelect) => row.application_id), [sourceApplicationId]);

  await deleteCanonicalCoverLetters({ userId, applicationId: sourceApplicationId });
  [artifact] = (await backendDb.select().from(schema.artifacts))
    .filter((row: typeof schema.artifacts.$inferSelect) => row.id === artifactId);
  assert.ok(artifact.deleted_at);
  assert.equal(artifact.structured_content, null);
  assert.equal((await backendDb.select().from(schema.artifact_versions))
    .filter((row: typeof schema.artifact_versions.$inferSelect) => row.artifact_id === artifactId).length, 0);
  assert.equal(await findOwnedDownloadSource(userId, 'users/cover-letter-reuse/source.pdf'), null);
});

test('manual outreach contacts dedupe by owner identity, export, and delete with the account', async () => {
  const userId = randomUUID();
  const applicationId = randomUUID();
  await dbInsertUser(userId, 'manual-contact-owner@example.test');
  await backendDb.insert(schema.applications).values({
    id: applicationId,
    user_id: userId,
    company_scope_key: 'domain:manual.example',
    company_name: 'Manual',
    role: 'Engineer',
    source_surface: 'dashboard',
    application_fingerprint: `test:${applicationId}`,
  });
  const requestFor = (operationId: string) => ({
    application_id: applicationId,
    operation_id: operationId,
    draft_type: 'first_note' as const,
    contact: {
      full_name: 'Morgan Recruiter',
      title: 'Technical Recruiter',
      persona: 'recruiter',
      company: 'Manual',
      company_domain: 'manual.example',
      school_match: false,
      linkedin_url: 'https://www.linkedin.com/in/morgan-recruiter',
    },
    company: 'Manual',
    company_domain: 'manual.example',
    role: 'Engineer',
    user_profile: { experience: [], skills: [], school: 'Example', grad_year: 2026 },
  });
  const first = await canonicalDraftContext(userId, requestFor(randomUUID()));
  const second = await canonicalDraftContext(userId, requestFor(randomUUID()));
  assert.equal(first.contact.id, second.contact.id);
  const ownedContacts = (await backendDb.select().from(schema.contacts))
    .filter((row: typeof schema.contacts.$inferSelect) => row.id === first.contact.id);
  assert.equal(ownedContacts.length, 1);

  const auth = await token(userId);
  const exported = await app.inject({
    method: 'GET',
    url: '/account/export',
    headers: { authorization: `Bearer ${auth}` },
  });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(exported.json().manual_contacts.length, 1);
  assert.equal(exported.json().manual_contacts[0].id, first.contact.id);
  assert.equal(exported.json().manual_contacts[0].title, 'Technical Recruiter');

  await backendDb.transaction(async (tx: any) => {
    const manualIds = (await tx.select({ contact_id: schema.user_contact_unlocks.contact_id })
      .from(schema.user_contact_unlocks).where(eq(schema.user_contact_unlocks.user_id, userId)))
      .map((row: { contact_id: string }) => row.contact_id);
    await tx.delete(schema.users).where(eq(schema.users.id, userId));
    await deleteUnreferencedManualContacts(tx, manualIds);
  });
  assert.equal((await backendDb.select().from(schema.contacts))
    .filter((row: typeof schema.contacts.$inferSelect) => row.id === first.contact.id).length, 0);
});

test('Free manual outreach drafts save idempotently, retain private email, reload, and edit without metering', async () => {
  const userId = randomUUID();
  const strangerId = randomUUID();
  const applicationId = randomUUID();
  const operationId = randomUUID();
  await dbInsertUser(userId, 'manual-draft-owner@example.test');
  await dbInsertUser(strangerId, 'manual-draft-stranger@example.test');
  await backendDb.insert(schema.applications).values({
    id: applicationId,
    user_id: userId,
    company_scope_key: 'domain:manual-draft.example',
    company_name: 'Manual Draft',
    role: 'Product Engineer',
    source_surface: 'dashboard',
    application_fingerprint: `test:${applicationId}`,
  });
  const ownerAuth = await token(userId);
  const strangerAuth = await token(strangerId);
  const payload = {
    application_id: applicationId,
    operation_id: operationId,
    draft_type: 'thank_you',
    contact: {
      full_name: 'Taylor Recruiter',
      title: 'Senior Technical Recruiter',
      persona: 'recruiter',
      company: 'Manual Draft',
      company_domain: 'manual-draft.example',
      email: 'Taylor.Recruiter@Example.Test',
      school_match: false,
    },
    subject: 'Thank you for the conversation',
    body: 'Thank you for sharing more about the product engineering team.',
  };

  const deniedOwner = await app.inject({
    method: 'POST',
    url: '/drafts/manual',
    headers: { authorization: `Bearer ${strangerAuth}` },
    payload,
  });
  assert.equal(deniedOwner.statusCode, 404, deniedOwner.body);

  const created = await app.inject({
    method: 'POST',
    url: '/drafts/manual',
    headers: { authorization: `Bearer ${ownerAuth}` },
    payload,
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().generation_source, 'user_written');
  assert.equal(created.json().application_id, applicationId);
  assert.equal(created.json().draft_type, 'thank_you');
  assert.equal(created.json().contact_email, 'taylor.recruiter@example.test');
  assert.equal(created.json().contact.email, 'taylor.recruiter@example.test');
  const draftId = created.json().draft_id as string;
  const contactId = created.json().contact_id as string;

  const replay = await app.inject({
    method: 'POST',
    url: '/drafts/manual',
    headers: { authorization: `Bearer ${ownerAuth}` },
    payload,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().draft_id, draftId);

  const conflict = await app.inject({
    method: 'POST',
    url: '/drafts/manual',
    headers: { authorization: `Bearer ${ownerAuth}` },
    payload: { ...payload, body: 'Changed content under the same operation id.' },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().code, 'idempotency_conflict');

  const listed = await app.inject({
    method: 'GET',
    url: `/drafts?application_id=${applicationId}`,
    headers: { authorization: `Bearer ${ownerAuth}` },
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().drafts.length, 1);
  assert.equal(listed.json().drafts[0].draft_id, draftId);
  assert.equal(listed.json().drafts[0].contact.email, 'taylor.recruiter@example.test');

  const edited = await app.inject({
    method: 'PATCH',
    url: `/drafts/${draftId}`,
    headers: { authorization: `Bearer ${ownerAuth}` },
    payload: {
      subject: 'Updated thank you',
      body: 'Thank you again. I enjoyed learning about the team.',
      contact_email: 'taylor.updated@example.test',
    },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().draft.subject, 'Updated thank you');
  assert.equal(edited.json().draft.contact.email, 'taylor.updated@example.test');

  const storedDrafts = (await backendDb.select().from(schema.outreach_draft_generations))
    .filter((row: typeof schema.outreach_draft_generations.$inferSelect) => row.user_id === userId);
  assert.equal(storedDrafts.length, 1);
  assert.equal(storedDrafts[0].generation_source, 'user_written');
  assert.equal(storedDrafts[0].original_subject, payload.subject);
  assert.equal(storedDrafts[0].contact_email, 'taylor.updated@example.test');
  assert.equal((await backendDb.select().from(schema.entitlement_usage_reservations))
    .filter((row: typeof schema.entitlement_usage_reservations.$inferSelect) => row.user_id === userId).length, 0);
  assert.equal((await backendDb.select().from(schema.usage_counters))
    .filter((row: typeof schema.usage_counters.$inferSelect) => row.key === userId).length, 0);
  const [contact] = (await backendDb.select().from(schema.contacts))
    .filter((row: typeof schema.contacts.$inferSelect) => row.id === contactId);
  assert.ok(contact);
  assert.equal(Object.prototype.hasOwnProperty.call(contact, 'email'), false);
});

test('pending checkout actions reject an owned contact from another application company', async () => {
  const userId = randomUUID();
  const applicationId = randomUUID();
  const matchingContactId = randomUUID();
  const otherContactId = randomUUID();
  await dbInsertUser(userId, 'pending-scope-owner@example.test');
  await backendDb.insert(schema.companies).values([
    { domain: 'pending-one.example', name: 'Pending One' },
    { domain: 'pending-two.example', name: 'Pending Two' },
  ]);
  await backendDb.insert(schema.applications).values({
    id: applicationId,
    user_id: userId,
    company_scope_key: 'domain:pending-one.example',
    company_name: 'Pending One',
    role: 'Engineer',
    source_surface: 'dashboard',
    application_fingerprint: `test:${applicationId}`,
  });
  await backendDb.insert(schema.contacts).values([
    {
      id: matchingContactId,
      full_name: 'Matching Contact',
      company_domain: 'pending-one.example',
      title: 'Recruiter',
      persona: 'recruiter',
    },
    {
      id: otherContactId,
      full_name: 'Other Contact',
      company_domain: 'pending-two.example',
      title: 'Recruiter',
      persona: 'recruiter',
    },
  ]);
  await backendDb.insert(schema.user_contact_unlocks).values([
    { user_id: userId, contact_id: matchingContactId, company_scope_key: 'domain:pending-one.example', source: 'manual' },
    { user_id: userId, contact_id: otherContactId, company_scope_key: 'domain:pending-two.example', source: 'manual' },
  ]);
  const auth = await token(userId);
  const common = {
    feature_key: 'outreach_email_generation',
    application_id: applicationId,
    return_route: '/dashboard/outreach#draft',
  };
  const mismatched = await app.inject({
    method: 'POST',
    url: '/billing/actions',
    headers: { authorization: `Bearer ${auth}` },
    payload: { ...common, contact_id: otherContactId, idempotency_key: randomUUID() },
  });
  assert.equal(mismatched.statusCode, 409, mismatched.body);
  assert.equal(mismatched.json().code, 'action_context_mismatch');
  assert.equal((await backendDb.select().from(schema.pending_premium_actions))
    .filter((row: typeof schema.pending_premium_actions.$inferSelect) => row.user_id === userId).length, 0);

  const accepted = await app.inject({
    method: 'POST',
    url: '/billing/actions',
    headers: { authorization: `Bearer ${auth}` },
    payload: { ...common, contact_id: matchingContactId, idempotency_key: randomUUID() },
  });
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.equal(accepted.json().application_id, applicationId);
  assert.equal(accepted.json().contact_id, matchingContactId);
});

test('pending action response-loss retry returns the same nonce and row while changed context conflicts', async () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const idempotencyKey = randomUUID();
  await dbInsertUser(userId, 'pending-replay-owner@example.test');
  await dbInsertUser(otherUserId, 'pending-replay-other@example.test');
  const ownerToken = await token(userId);
  const payload = {
    feature_key: 'ai_resume_tailoring',
    return_route: '/dashboard/applications?resume=tailor#review',
    idempotency_key: idempotencyKey,
  };

  const first = await app.inject({
    method: 'POST',
    url: '/billing/actions',
    headers: { authorization: `Bearer ${ownerToken}` },
    payload,
  });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().idempotent, false);
  const firstNonce = first.json().action_nonce as string;
  const [firstRow] = (await backendDb.select().from(schema.pending_premium_actions))
    .filter((row: typeof schema.pending_premium_actions.$inferSelect) => row.user_id === userId);
  assert.ok(firstRow);
  assert.equal(firstRow.idempotency_binding, idempotencyKey);
  assert.notEqual(firstRow.nonce_hash, firstNonce);
  assert.equal(firstRow.nonce_hash, createHash('sha256').update(firstNonce).digest('hex'));

  const replay = await app.inject({
    method: 'POST',
    url: '/billing/actions',
    headers: { authorization: `Bearer ${ownerToken}` },
    payload,
  });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(replay.json().idempotent, true);
  assert.equal(replay.json().action_nonce, firstNonce);
  assert.equal(replay.json().expires_at, first.json().expires_at);
  const replayRows = (await backendDb.select().from(schema.pending_premium_actions))
    .filter((row: typeof schema.pending_premium_actions.$inferSelect) => row.user_id === userId);
  assert.equal(replayRows.length, 1);
  assert.equal(replayRows[0].id, firstRow.id);

  const changedContext = await app.inject({
    method: 'POST',
    url: '/billing/actions',
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { ...payload, return_route: '/dashboard/applications?resume=other#review' },
  });
  assert.equal(changedContext.statusCode, 409, changedContext.body);
  assert.equal(changedContext.json().code, 'action_idempotency_conflict');
  assert.equal((await backendDb.select().from(schema.pending_premium_actions))
    .filter((row: typeof schema.pending_premium_actions.$inferSelect) => row.user_id === userId).length, 1);

  const otherOwner = await app.inject({
    method: 'POST',
    url: '/billing/actions',
    headers: { authorization: `Bearer ${await token(otherUserId)}` },
    payload,
  });
  assert.equal(otherOwner.statusCode, 201, otherOwner.body);
  assert.equal(otherOwner.json().idempotent, false);
  assert.notEqual(otherOwner.json().action_nonce, firstNonce);
});

test('saved outreach drafts reload with contact context and manual edits remain owner scoped', async () => {
  const userId = randomUUID();
  const strangerId = randomUUID();
  const applicationId = randomUUID();
  const contactId = randomUUID();
  const draftId = randomUUID();
  await dbInsertUser(userId, 'draft-reload-owner@example.test');
  await dbInsertUser(strangerId, 'draft-reload-stranger@example.test');
  await backendDb.insert(schema.companies).values({ domain: 'reload.example', name: 'Reload' });
  await backendDb.insert(schema.contacts).values({
    id: contactId,
    full_name: 'Riley Recruiter',
    company_domain: 'reload.example',
    title: 'Senior Recruiter',
    persona: 'recruiter',
  });
  await backendDb.insert(schema.applications).values({
    id: applicationId,
    user_id: userId,
    company_scope_key: 'domain:reload.example',
    company_name: 'Reload',
    role: 'Platform Engineer',
    source_surface: 'dashboard',
    application_fingerprint: `test:${applicationId}`,
  });
  await backendDb.insert(schema.outreach_draft_generations).values({
    id: draftId,
    user_id: userId,
    operation_id: randomUUID(),
    request_hash: 'reload-request-hash',
    contact_id: contactId,
    application_id: applicationId,
    company_scope_key: 'domain:reload.example',
    company_name: 'Reload',
    role: 'Platform Engineer',
    draft_type: 'follow_up',
    original_subject: 'Original subject',
    original_body: 'Original body for the draft.',
    subject: 'Original subject',
    body: 'Original body for the draft.',
    word_count: 5,
    warnings: [],
  });
  const ownerAuth = await token(userId);
  const strangerAuth = await token(strangerId);
  const listed = await app.inject({
    method: 'GET',
    url: `/drafts?application_id=${applicationId}`,
    headers: { authorization: `Bearer ${ownerAuth}` },
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().drafts.length, 1);
  assert.equal(listed.json().drafts[0].company_name, 'Reload');
  assert.equal(listed.json().drafts[0].role, 'Platform Engineer');
  assert.equal(listed.json().drafts[0].contact.full_name, 'Riley Recruiter');
  assert.equal(listed.json().drafts[0].draft_type, 'follow_up');

  const denied = await app.inject({
    method: 'PATCH',
    url: `/drafts/${draftId}`,
    headers: { authorization: `Bearer ${strangerAuth}` },
    payload: { subject: 'Stolen', body: 'This must not update.' },
  });
  assert.equal(denied.statusCode, 404);
  const edited = await app.inject({
    method: 'PATCH',
    url: `/drafts/${draftId}`,
    headers: { authorization: `Bearer ${ownerAuth}` },
    payload: { subject: 'Edited subject', body: 'A carefully edited follow up note.' },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().draft.subject, 'Edited subject');
  assert.equal(edited.json().draft.word_count, 6);
  const [stored] = (await backendDb.select().from(schema.outreach_draft_generations))
    .filter((row: typeof schema.outreach_draft_generations.$inferSelect) => row.id === draftId);
  assert.equal(stored.original_subject, 'Original subject');
  assert.equal(stored.original_body, 'Original body for the draft.');
});

test('application answers require an owned canonical scope while the pre-0.6 adapter remains safe', async () => {
  const ownerId = randomUUID();
  const strangerId = randomUUID();
  const applicationId = randomUUID();
  await backendDb.insert(schema.users).values([
    { id: ownerId, email: 'answer-owner@example.test', email_verified: true },
    { id: strangerId, email: 'answer-stranger@example.test', email_verified: true },
  ]);
  await backendDb.insert(schema.applications).values({
    id: applicationId,
    user_id: ownerId,
    company_scope_key: 'name:answer',
    company_name: 'Answer Corp',
    role: 'Engineer',
    source_surface: 'dashboard',
    application_fingerprint: `test:${applicationId}`,
  });
  const common = {
    question: 'Why are you interested?',
    company: 'Answer Corp',
    role: 'Engineer',
    jd_text: 'Build reliable software.',
    operation_id: randomUUID(),
  };
  const strangerAuth = await token(strangerId);
  const crossAccount = await app.inject({
    method: 'POST',
    url: '/application/answer',
    headers: { authorization: `Bearer ${strangerAuth}`, 'x-litos-client': 'extension', 'x-litos-version': '0.6.0' },
    payload: { ...common, application_id: applicationId },
  });
  assert.equal(crossAccount.statusCode, 404);
  const fakeId = await app.inject({
    method: 'POST',
    url: '/application/answer',
    headers: { authorization: `Bearer ${strangerAuth}`, 'x-litos-client': 'extension', 'x-litos-version': '0.6.0' },
    payload: { ...common, operation_id: randomUUID(), application_id: randomUUID() },
  });
  assert.equal(fakeId.statusCode, 404);
  const missing = await app.inject({
    method: 'POST',
    url: '/application/answer',
    headers: { authorization: `Bearer ${strangerAuth}`, 'x-litos-client': 'extension', 'x-litos-version': '0.6.0' },
    payload: { ...common, operation_id: randomUUID() },
  });
  assert.equal(missing.statusCode, 400);
  const strangerReservations = (await backendDb.select().from(schema.entitlement_usage_reservations))
    .filter((row: typeof schema.entitlement_usage_reservations.$inferSelect) =>
      row.user_id === strangerId && row.usage_kind === 'answer_application');
  assert.equal(strangerReservations.length, 0);

  const legacyId = randomUUID();
  await backendDb.insert(schema.users).values({
    id: legacyId,
    email: 'answer-legacy@example.test',
    email_verified: true,
    plan: 'pro',
  });
  const legacyAuth = await token(legacyId);
  const adapted = await app.inject({
    method: 'POST',
    url: '/application/answer',
    headers: { authorization: `Bearer ${legacyAuth}`, 'x-litos-client': 'extension', 'x-litos-version': '0.5.9' },
    payload: {
      question: common.question,
      company: common.company,
      role: common.role,
      jd_text: common.jd_text,
    },
  });
  assert.equal(adapted.statusCode, 400, adapted.body);
  assert.match(adapted.json().error, /Nothing saved/);
  const legacyApplications = (await backendDb.select().from(schema.applications))
    .filter((row: typeof schema.applications.$inferSelect) => row.user_id === legacyId);
  assert.equal(legacyApplications.length, 1);
  assert.equal(legacyApplications[0].company_name, 'Answer Corp');
});

async function dbInsertUser(id: string, email: string) {
  await backendDb.insert(schema.users).values({ id, email, email_verified: true });
}
