import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../db/schema';

/* AN APPLICATION THAT HOLDS A RESUME AND SAYS IT HAS NONE.
 *
 * Measured 2026-09-03 across the ten boards Mehek was applying to. Six of them, DSI Innovations,
 * Blueprint Hires, Prediktive, xolife, Confluence Technologies and TixTrack, were stored with a
 * real owned resume artifact in selected_resume_artifact_id and (resume_attached false,
 * resume_source 'none') beside it. Each had a PASSED packet audit binding an exact PDF. So the
 * packet believed it had a resume, the audit bound the file, and the linkage row said there was
 * none, and nothing anywhere would ever have corrected it.
 *
 * Four write sites could produce that row, and the fix is one shared spelling of the fact rather
 * than four patches. Every test here drives the REAL route or the REAL library function against a
 * real PostgreSQL and asserts on the row that comes out. Nothing matches on source text.
 *
 * The tightened check constraint is live in this database too, because the schema is built from
 * schema.ts, so a writer that regressed would not merely store a wrong row: it would fail.
 */

const JWT_SECRET = 'resume-linkage-invariant-test-secret-32ch';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-resume-linkage-'));
const savedEnv = { ...process.env };
let database: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let backendPool: { end(): Promise<void> };
let backendDb: any;
let linkGeneratedPacketToCanonicalApplication: typeof import('../lib/resumeArtifactVersions').linkGeneratedPacketToCanonicalApplication;
let appendEditedResumeArtifactVersion: typeof import('../lib/resumeArtifactVersions').appendEditedResumeArtifactVersion;
let updateCanonicalApplicationAfterFill: typeof import('./canonicalApplications').updateCanonicalApplicationAfterFill;

const USER = '3a7e2b10-1111-4111-8111-111111111111';

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
  ({ linkGeneratedPacketToCanonicalApplication, appendEditedResumeArtifactVersion } = await import('../lib/resumeArtifactVersions'));
  const { canonicalApplicationRoutes, updateCanonicalApplicationAfterFill: updateAfterFill } = await import('./canonicalApplications');
  updateCanonicalApplicationAfterFill = updateAfterFill;
  app = Fastify({ logger: false });
  await app.register(canonicalApplicationRoutes);
  await app.ready();
  await backendDb.insert(schema.users).values({ id: USER, email: 'resume-linkage@example.test' });
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

let sequence = 0;
async function application(overrides: Record<string, unknown> = {}) {
  sequence += 1;
  const id = `4a7e2b10-2222-4222-8222-${String(sequence).padStart(12, '0')}`;
  await backendDb.insert(schema.applications).values({
    id,
    user_id: USER,
    company_scope_key: `scope-${sequence}`,
    company_name: `Company ${sequence}`,
    role: 'Engineer',
    application_fingerprint: `fingerprint-${sequence}`,
    source_surface: 'dashboard',
    ...overrides,
  });
  return id;
}

async function artifact(kind: 'resume' | 'tailored_resume' | 'cover_letter' = 'tailored_resume') {
  sequence += 1;
  const id = `5a7e2b10-3333-4333-8333-${String(sequence).padStart(12, '0')}`;
  await backendDb.insert(schema.artifacts).values({
    id,
    user_id: USER,
    kind,
    structured_content: { summary: 'Tailored' },
    source: 'ai_tailored',
  });
  return id;
}

type Linkage = {
  selected_resume_artifact_id: string | null;
  resume_attached: boolean;
  resume_source: string;
  attached_at_present: boolean;
};

async function linkage(applicationId: string): Promise<Linkage> {
  const result = await database.query<Linkage>(`
    select selected_resume_artifact_id, resume_attached, resume_source,
           (resume_attached_at is not null) as attached_at_present
    from applications where id = '${applicationId}'
  `);
  return result.rows[0];
}

async function fill(applicationId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/fill`,
    headers: { authorization: `Bearer ${await token(USER)}` },
    payload,
  });
}

/* ---------------------------------------------------- the fill route, which produced most of six */

test('a fill that names only an artifact attaches it, instead of pointing at a resume it says is absent', async () => {
  const applicationId = await application();
  const artifactId = await artifact();
  assert.deepEqual(await linkage(applicationId), {
    selected_resume_artifact_id: null, resume_attached: false, resume_source: 'none', attached_at_present: false,
  });

  const response = await fill(applicationId, { selected_resume_artifact_id: artifactId });

  assert.equal(response.statusCode, 200, response.body);
  /* THE PRODUCTION DEFECT. This came back {artifactId, false, 'none', null} before the fix: the
   * pointer written through one gate, the pair left at its default behind another. */
  assert.deepEqual(await linkage(applicationId), {
    selected_resume_artifact_id: artifactId, resume_attached: true, resume_source: 'artifact', attached_at_present: true,
  });
  assert.equal(response.json().application.resume_attached, true);
  assert.equal(response.json().application.resume_source, 'artifact');
  /* THE SAME DEFECT, ONE LAYER UP. application.resume_attached above reads the fresh .returning()
   * row and was already correct; these are the TOP-LEVEL fields built from the route's own locals,
   * which a gate keyed on resume_attached/resume_source (both absent from this request) never
   * touched. Before the fix this response said resume_attached: true one line up and
   * resume_attached: false here, in the same JSON payload - and needs_user, "the Free preparation
   * contract consumed by the dashboard and extension" per the route's own comment, still listed
   * 'resume_attachment' for an application that had just attached one. */
  assert.equal(response.json().resume_attached, true);
  assert.equal(response.json().resume_source, 'artifact');
  assert.equal(response.json().selected_resume_artifact_id, artifactId);
  assert.ok(
    !response.json().needs_user.includes('resume_attachment'),
    'needs_user must not ask for a resume this response just attached: ' + JSON.stringify(response.json().needs_user),
  );
});

test('a fill that names only an artifact reports the attachment at the top level too, mirrored by a fill that detaches', async () => {
  // The regression guard for the fix above: the detach path already sent resume_attached and
  // resume_source together, so the gate fired and the top-level fields were never stale for it.
  // This proves the fix did not flip that already-correct path.
  const applicationId = await application();
  const artifactId = await artifact();
  await fill(applicationId, { selected_resume_artifact_id: artifactId });

  const response = await fill(applicationId, { resume_attached: false, resume_source: 'none' });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().resume_attached, false);
  assert.equal(response.json().resume_source, 'none');
  assert.equal(response.json().application.resume_attached, false);
  assert.ok(
    response.json().needs_user.includes('resume_attachment'),
    'needs_user must ask for a resume on an application that just detached: ' + JSON.stringify(response.json().needs_user),
  );
});

test('a fill that detaches takes the pointer with it', async () => {
  // The same inconsistency from the other side, and the regression the fix above could have caused:
  // the pair going to (false, 'none') while the pointer stayed behind.
  const applicationId = await application();
  const artifactId = await artifact();
  await fill(applicationId, { selected_resume_artifact_id: artifactId });

  const response = await fill(applicationId, { resume_attached: false, resume_source: 'none' });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(await linkage(applicationId), {
    selected_resume_artifact_id: null, resume_attached: false, resume_source: 'none', attached_at_present: false,
  });
});

test('a fill that switches to the main resume drops the document pointer', async () => {
  const applicationId = await application();
  const artifactId = await artifact();
  await fill(applicationId, { selected_resume_artifact_id: artifactId });
  await backendDb.insert(schema.profiles).values({ user_id: USER, base_resume_json: { summary: 'Main' } });

  const response = await fill(applicationId, { resume_attached: true, resume_source: 'base_resume' });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(await linkage(applicationId), {
    selected_resume_artifact_id: null, resume_attached: true, resume_source: 'base_resume', attached_at_present: true,
  });
});

test('a fill still refuses to claim an artifact resume it cannot name', async () => {
  // The guard that already existed, and the half of the invariant that was already enforced.
  const applicationId = await application();
  const response = await fill(applicationId, { resume_attached: true, resume_source: 'artifact' });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().code, 'resume_artifact_required');
  assert.deepEqual(await linkage(applicationId), {
    selected_resume_artifact_id: null, resume_attached: false, resume_source: 'none', attached_at_present: false,
  });
});

/* ------------------------------------------------------------------------ the tailor link site */

test('linking a generated packet attaches its resume, not only its pointer', async () => {
  /* This is the path EVERY tailor takes, and it wrote the pointer and none of the three columns
   * that say a resume is attached. An application whose dashboard fill never separately sent the
   * pair stayed in the broken shape from the moment it was tailored. */
  const applicationId = await application();
  const artifactId = await artifact();
  const packetId = `6a7e2b10-4444-4444-8444-${String(++sequence).padStart(12, '0')}`;
  await backendDb.insert(schema.generated_resumes).values({
    id: packetId,
    user_id: USER,
    job_context: { company: 'Example' },
    spec: { summary: 'Tailored' },
    resume_object_key: `users/link-${sequence}/resume.pdf`,
  });

  await backendDb.transaction(async (tx: any) => {
    await linkGeneratedPacketToCanonicalApplication(tx, {
      userId: USER, applicationId, generatedResumeId: packetId, artifactId,
    });
  });

  assert.deepEqual(await linkage(applicationId), {
    selected_resume_artifact_id: artifactId, resume_attached: true, resume_source: 'artifact', attached_at_present: true,
  });
});

test('re-tailoring repoints the document without rewriting when the resume was attached', async () => {
  // A re-tailor is not a re-attach. resume_attached_at answers "when did this application first get
  // a resume", and overwriting it every tailor would make it a second updated_at.
  const applicationId = await application();
  const firstArtifact = await artifact();
  const secondArtifact = await artifact();
  const packetId = `6a7e2b10-4444-4444-8444-${String(++sequence).padStart(12, '0')}`;
  await backendDb.insert(schema.generated_resumes).values({
    id: packetId,
    user_id: USER,
    job_context: { company: 'Example' },
    spec: { summary: 'Tailored' },
    resume_object_key: `users/link-${sequence}/resume.pdf`,
  });
  await backendDb.transaction(async (tx: any) => {
    await linkGeneratedPacketToCanonicalApplication(tx, {
      userId: USER, applicationId, generatedResumeId: packetId, artifactId: firstArtifact,
    });
  });
  const firstStamp = (await database.query<{ at: string }>(
    `select resume_attached_at::text as at from applications where id = '${applicationId}'`,
  )).rows[0].at;

  await backendDb.transaction(async (tx: any) => {
    await linkGeneratedPacketToCanonicalApplication(tx, {
      userId: USER, applicationId, generatedResumeId: packetId, artifactId: secondArtifact,
    });
  });

  const after = await database.query<{ at: string; id: string }>(
    `select resume_attached_at::text as at, selected_resume_artifact_id as id from applications where id = '${applicationId}'`,
  );
  assert.equal(after.rows[0].id, secondArtifact, 'the document pointer moves');
  assert.equal(after.rows[0].at, firstStamp, 'the moment it first attached does not');
});

/* ------------------------------------------------------------------- the first user edit site */

test('a first user edit that mints the canonical artifact also attaches it', async () => {
  const packetId = `7a7e2b10-5555-4555-8555-${String(++sequence).padStart(12, '0')}`;
  await backendDb.insert(schema.generated_resumes).values({
    id: packetId,
    user_id: USER,
    job_context: { company: 'Example' },
    spec: { summary: 'Edited' },
    resume_object_key: `users/edit-${sequence}/resume.pdf`,
  });
  const applicationId = await application({ legacy_generated_resume_id: packetId });

  await backendDb.transaction(async (tx: any) => {
    await appendEditedResumeArtifactVersion(tx, {
      userId: USER,
      legacyGeneratedResumeId: packetId,
      structuredContent: { summary: 'Edited' },
      jobContext: { company: 'Example' },
      renderedObjectKey: `users/edit-${sequence}/resume.pdf`,
      renderedBlobUrl: 'https://blob.example/edited.pdf',
    });
  });

  const stored = await linkage(applicationId);
  assert.ok(stored.selected_resume_artifact_id, 'the edit binds a document');
  assert.equal(stored.resume_attached, true);
  assert.equal(stored.resume_source, 'artifact');
  assert.equal(stored.attached_at_present, true);
});

/* ------------------------------------------------------------------------------ the shared writer */

test('the shared fill writer never stores a pointer beside an unattached resume', async () => {
  /* updateCanonicalApplicationAfterFill is what the route calls, and it used to copy four caller
   * values through verbatim. Handed the inconsistent shape directly, it must now resolve it rather
   * than store it, which is also the only way this call can succeed at all now that the database
   * refuses that row. */
  const applicationId = await application();
  const artifactId = await artifact();

  await updateCanonicalApplicationAfterFill(backendDb, {
    applicationId,
    userId: USER,
    selectedResumeArtifactId: artifactId,
    resumeAttached: false,
    resumeSource: 'none',
    resumeAttachedAt: null,
  });

  assert.deepEqual(await linkage(applicationId), {
    selected_resume_artifact_id: artifactId, resume_attached: true, resume_source: 'artifact', attached_at_present: true,
  });
});

/* ------------------------------------------------------------------------ the duplicate merge */

test('adopting a duplicate keeps one row\'s linkage rather than a pointer from one and a pair from another', async () => {
  /* The merge used to take selected_resume_artifact_id from the first row that had one and the
   * (attached, source, at) triple from the first row that was attached. Those are not necessarily
   * the same row, so it could mint the inconsistent shape out of two rows that were each fine. The
   * two rows here are exactly that: a portal-keyed row attached from its own document, and a
   * job-keyed row attached from the main resume with no document at all. */
  const portalUrl = 'https://jobs.example.com/apply/resume-linkage-merge';
  const companyScopeKey = 'domain:jobs.example.com';
  const jobId = '8a7e2b10-6666-4666-8666-000000000001';
  const artifactId = await artifact();
  const { upsertCanonicalApplicationForUser } = await import('./canonicalApplications');

  const portalRow = await upsertCanonicalApplicationForUser({
    userId: USER, companyScopeKey, companyName: 'Merge Example', role: 'Engineer', portalUrl, sourceSurface: 'extension',
  });
  await fill(portalRow.application.id, { selected_resume_artifact_id: artifactId });

  const jobRow = await upsertCanonicalApplicationForUser({
    userId: USER, jobId, companyScopeKey, companyName: 'Merge Example', role: 'Engineer', portalUrl, sourceSurface: 'dashboard',
  });

  // The two converge onto one canonical row, which is what makes this a merge at all.
  const merged = await linkage(jobRow.application.id);
  assert.ok(
    (merged.resume_attached && merged.resume_source === 'artifact' && merged.selected_resume_artifact_id === artifactId)
    || (!merged.resume_attached && merged.resume_source === 'none' && merged.selected_resume_artifact_id === null),
    'the merged row must carry one row\'s whole linkage: ' + JSON.stringify(merged),
  );
  // And the attached case is the one that matters: the surviving row must not lose the document it
  // had, nor keep the document while claiming to have none.
  assert.deepEqual(merged, {
    selected_resume_artifact_id: artifactId,
    resume_attached: true,
    resume_source: 'artifact',
    attached_at_present: true,
  });
});

/* ------------------------------------------------------------------- and the database itself */

test('the database refuses a pointer beside an unattached resume, whatever writes it', async () => {
  /* The half a code fix cannot give. This schema is built from schema.ts, so these are the live
   * constraint arms, and they hold against any writer in any repository rather than only the four
   * this change fixed. Six of Mehek's ten boards were stored in the first shape on 2026-09-03. */
  const applicationId = await application();
  const artifactId = await artifact();
  await assert.rejects(
    database.exec(`
      update applications set selected_resume_artifact_id = '${artifactId}',
        resume_attached = false, resume_source = 'none' where id = '${applicationId}'
    `),
    /applications_resume_attachment_state_check/,
    'a selected document beside "no resume attached" must be refused',
  );
});

test('the database refuses a document pointer beside the main resume', async () => {
  const applicationId = await application();
  const artifactId = await artifact();
  await assert.rejects(
    database.exec(`
      update applications set selected_resume_artifact_id = '${artifactId}',
        resume_attached = true, resume_source = 'base_resume', resume_attached_at = now()
      where id = '${applicationId}'
    `),
    /applications_resume_attachment_state_check/,
    'the main resume never names a document row',
  );
});

test('the database still accepts all three legitimate shapes', async () => {
  // The constraint has to be a statement about consistency, not a ban on attaching resumes.
  const artifactId = await artifact();
  const fromArtifact = await application();
  const fromBaseResume = await application();
  const detached = await application();
  await database.exec(`
    update applications set selected_resume_artifact_id = '${artifactId}', resume_attached = true,
      resume_source = 'artifact', resume_attached_at = now() where id = '${fromArtifact}';
    update applications set resume_attached = true, resume_source = 'base_resume',
      resume_attached_at = now() where id = '${fromBaseResume}';
    update applications set resume_attached = false, resume_source = 'none' where id = '${detached}';
  `);
  assert.equal((await linkage(fromArtifact)).resume_source, 'artifact');
  assert.equal((await linkage(fromBaseResume)).resume_source, 'base_resume');
  assert.equal((await linkage(detached)).resume_source, 'none');
});

test('adopting a legacy duplicate cannot take a document from one row and a source from another', async () => {
  /* THE MIXING CASE, and it needs two rows that disagree. One is attached from the main resume and
   * names no document; the other is attached from its own document. Picking the pointer from the
   * first row that has one and the (attached, source) pair from the first row that is attached
   * takes them from DIFFERENT rows here, and the row it builds says "attached from the main resume"
   * while naming a document, which is a shape no single row could ever have been in. */
  const portalUrl = 'https://jobs.example.com/apply/resume-linkage-legacy-merge';
  const companyScopeKey = 'domain:jobs.example.com';
  const artifactId = await artifact();
  const { upsertCanonicalApplicationForUser } = await import('./canonicalApplications');

  /* Order matters: the canonical row has to EXIST and hold its document before the legacy row
   * appears, or the first upsert adopts the legacy row while there is nothing to disagree with. */
  const canonical = await upsertCanonicalApplicationForUser({
    userId: USER,
    companyScopeKey,
    companyName: 'Legacy Merge Example',
    role: 'Engineer',
    portalUrl,
    sourceSurface: 'extension',
  });
  await fill(canonical.application.id, { selected_resume_artifact_id: artifactId });

  /* Now the legacy row, attached from the main resume and naming no document, adoptable by
   * identity. It carries a packet, which is what makes it WIN the merge: the winner sort prefers a
   * row with a legacy_generated_resume_id. So the surviving row's source is read from the
   * base_resume row while the only document pointer among the two is on the other one, which is
   * precisely the pair of rows that an independent pick mixes. */
  const legacyPacketId = `9a7e2b10-7777-4777-8777-${String(++sequence).padStart(12, '0')}`;
  await backendDb.insert(schema.generated_resumes).values({
    id: legacyPacketId,
    user_id: USER,
    job_context: { company: 'Legacy Merge Example' },
    spec: { summary: 'Legacy' },
    resume_object_key: `users/legacy-${sequence}/resume.pdf`,
  });
  const legacyId = await application({
    company_scope_key: companyScopeKey,
    company_name: 'Legacy Merge Example',
    role: 'Engineer',
    portal_url: portalUrl,
    legacy_generated_resume_id: legacyPacketId,
    application_fingerprint: `legacy:resume-linkage-${sequence}`,
    resume_attached: true,
    resume_source: 'base_resume',
    resume_attached_at: new Date('2026-08-01T09:00:00.000Z'),
  });

  // The upsert that adopts the legacy row into the canonical one.
  const adopted = await upsertCanonicalApplicationForUser({
    userId: USER,
    companyScopeKey,
    companyName: 'Legacy Merge Example',
    role: 'Engineer',
    portalUrl,
    sourceSurface: 'dashboard',
  });

  assert.equal(adopted.adopted, true, 'the legacy row must actually be adopted for this to test the merge');
  const rowCount = await database.query<{ n: number }>(`
    select count(*)::int as n from applications where company_scope_key = '${companyScopeKey}'
      and role = 'Engineer' and company_name = 'Legacy Merge Example'
  `);
  assert.equal(rowCount.rows[0].n, 1, 'the duplicate must be merged away');
  const merged = await linkage(adopted.application.id);
  const consistent = (merged.resume_attached && merged.resume_source === 'artifact' && merged.selected_resume_artifact_id !== null)
    || (merged.resume_attached && merged.resume_source === 'base_resume' && merged.selected_resume_artifact_id === null)
    || (!merged.resume_attached && merged.resume_source === 'none' && merged.selected_resume_artifact_id === null);
  assert.ok(consistent, 'the adopted row must carry one row\'s whole linkage: ' + JSON.stringify(merged));
  assert.equal(merged.resume_attached, true, 'and it must not lose the resume both rows had');
  void legacyId;
});
