/* THE RESTORE ITSELF, AGAINST A REAL DATABASE, BECAUSE THE DECISION IS NOT THE BUG.
 *
 * A correct rule about acknowledgements that is not wired to the write would leave the defect
 * exactly where it was, and this area has already shipped one bug that a source-text test watched
 * happen without noticing. So this file runs the real restoreExpiredPacketResume over a real row:
 * a real re-render, the real createAndPersistPacketAudit, real UPDATEs, and then the real send gate
 * over whatever the restore left behind.
 *
 * Small seams are injected and none is the subject: the blob write, so no network store is needed,
 * the PDF read, so the audit can see the bytes the restore just produced, and selected interleaving
 * hooks that let the database mutate at a precise compare-and-swap boundary. Everything the test
 * asserts on - the acknowledgement, the audit, the object key, the verdict - is production code's
 * own output.
 *
 * Fixture is PGlite over a unix socket with the production db module, and the DDL is generated from
 * db/schema.ts at run time so it cannot drift.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { verifyStoredPacketAuditAcknowledgement } from './packetAudit';

const ENCRYPTION_KEY = 'packet-restore-acknowledgement-key';
const JWT_SIGNING_SECRET = 'packet-restore-acknowledgement-secret';
const RESUME_EMAIL = 'restore-student@example.test';
const JD_TEXT = [
  'Qualifications',
  '- Experience with TypeScript.',
  '- Experience building reliable backend systems.',
].join('\n');
const OLD_BYTES = Buffer.from('%PDF-1.7\nRestore Student\nBasic Information\nAcme');
const EMPLOYER_DELIVERY_BINDING = {
  version: 'employer_delivery_v1',
  mode: 'browser',
  sha256: 'c'.repeat(64),
} as const;

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
};

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let schema: typeof import('../db/schema');
let db: typeof import('../db/index')['db'];
let pool: typeof import('../db/index')['pool'];
let drizzle: typeof import('drizzle-orm');
let restoreExpiredPacketResume: typeof import('./packetResumeRestore')['restoreExpiredPacketResume'];
let createAndPersistPacketAudit: typeof import('./packetAuditService')['createAndPersistPacketAudit'];
let currentAcknowledgedPacketAudit: typeof import('./packetAuditService')['currentAcknowledgedPacketAudit'];
let createPdfGenerationBinding: typeof import('./pdfGenerationBinding')['createPdfGenerationBinding'];
let readApplicationReview: typeof import('./applicationReview')['readApplicationReview'];
let userId = '';
let applicantEmail = '';

function packetSpec(objectKey: string) {
  const spec: Record<string, unknown> = {
    target_role: 'Engineer',
    school: 'University of Southern California',
    degree: 'Bachelor of Science in Computer Science',
    grad_date: 'May 2028',
    gpa: '',
    school_location: 'Los Angeles, CA',
    coursework: '',
    skills: ['TypeScript'],
    experience: [{
      type: 'job',
      org: 'Acme',
      title: 'Engineer',
      location: 'Remote',
      date_range: 'Jan 2025 - Present',
      bullets: ['Built and operated reliable backend systems for a student product'],
    }],
    _contact: { full_name: 'Restore Student', email: RESUME_EMAIL, phone: '+1 555 0100' },
    _applicant_email: {
      address: applicantEmail, source: 'litos_alias', reason: 'deliverable', tracked: true,
      decided_at: '2026-07-10T00:00:00.000Z',
    },
    _application_email: {
      alias: applicantEmail, forwards_to: RESUME_EMAIL, mode: 'litos_application_alias',
    },
    _review: {
      jd_text: JD_TEXT,
      role: 'Engineer',
      questions: [],
      edited_terms: [],
      skipped_reasons: [],
      status: 'ready_for_final_approval',
      updated_at: '2026-07-10T00:00:00.000Z',
      applicant_email: {
        address: applicantEmail, source: 'litos_alias', reason: 'deliverable', tracked: true,
        decided_at: '2026-07-10T00:00:00.000Z',
      },
      applicant_snapshot: {
        profile: { email: applicantEmail, experience: [], skills: ['TypeScript'], school: 'University of Southern California', grad_year: 2028 },
        application_profile: {},
      },
      employer_delivery_bindings: EMPLOYER_DELIVERY_BINDING,
    },
  };
  spec._quality = { pdfGenerationBinding: createPdfGenerationBinding(spec, objectKey, OLD_BYTES, RESUME_EMAIL) };
  return spec;
}

async function rowById(id: string) {
  const [row] = await db.select().from(schema.generated_resumes)
    .where(drizzle.eq(schema.generated_resumes.id, id)).limit(1);
  return row;
}

/**
 * A packet whose file is about to be found missing, audited exactly as production audits it, and
 * acknowledged by the applicant only when the scenario says she did.
 */
async function seedPacket(options: { acknowledged: boolean }) {
  const [inserted] = await db.insert(schema.generated_resumes).values({
    user_id: userId,
    job_context: { company: 'Acme', role: 'Engineer' },
    spec: {},
    resume_object_key: `users/${userId}/resumes/${crypto.randomUUID()}.pdf`,
  }).returning({ id: schema.generated_resumes.id });
  await db.update(schema.generated_resumes)
    .set({ spec: packetSpec((await rowById(inserted.id)).resume_object_key) })
    .where(drizzle.eq(schema.generated_resumes.id, inserted.id));

  const { audit } = await createAndPersistPacketAudit(await rowById(inserted.id), {
    loadPdf: async () => ({ bytes: OLD_BYTES, contentType: 'application/pdf' }),
    validateApplicantEmail: async () => {},
  });
  if (options.acknowledged) {
    const row = await rowById(inserted.id);
    const review = readApplicationReview(row.spec)!;
    await db.update(schema.generated_resumes).set({
      spec: {
        ...(row.spec as Record<string, unknown>),
        _review: {
          ...review,
          packet_audit_acknowledgement: {
            ownerSha256: audit.bindings.ownerSha256,
            applicationId: audit.bindings.applicationId,
            audit_digest: audit.audit_digest,
            packet_version: audit.packet_version,
            pdfSha256: audit.bindings.pdf.sha256,
            pdfSizeBytes: audit.bindings.pdf.sizeBytes,
            acknowledged_at: '2026-07-11T09:00:00.000Z',
          },
        },
      },
    }).where(drizzle.eq(schema.generated_resumes.id, inserted.id));
  }
  return rowById(inserted.id);
}

/** The real restore, with the file gone, the blob write captured, and nothing else replaced. */
async function restoreWith(
  row: Awaited<ReturnType<typeof rowById>>,
  authority: 'authorizing_send' | 'review_only',
  options: {
    rerenderResume?: Parameters<typeof restoreExpiredPacketResume>[1]['rerenderResume'];
    persistAudit?: Parameters<typeof restoreExpiredPacketResume>[1]['persistAudit'];
    beforeAcknowledgementCarry?: () => Promise<void>;
  } = {},
) {
  const written: { bytes: Buffer } = { bytes: Buffer.alloc(0) };
  const loadPdf = async () => ({ bytes: written.bytes, contentType: 'application/pdf' });
  const outcome = await restoreExpiredPacketResume(row, {
    authority,
    // The file aged out of the 30-day window: it resolves to nothing.
    resolveObjectUrl: async () => null,
    putObject: async (key: string, bytes: Buffer) => {
      written.bytes = bytes;
      return { pathname: key };
    },
    rerenderResume: options.rerenderResume,
    beforeAcknowledgementCarry: options.beforeAcknowledgementCarry,
    persistAudit: options.persistAudit ?? ((target) => createAndPersistPacketAudit(target, {
      loadPdf,
      validateApplicantEmail: async () => {},
    })),
  });
  return { outcome, loadPdf };
}

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-restore-ack-'));
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

  schema = await import('../db/schema');
  const dbModule = await import('../db/index');
  db = dbModule.db;
  pool = dbModule.pool;
  drizzle = await import('drizzle-orm');
  ({ restoreExpiredPacketResume } = await import('./packetResumeRestore'));
  ({ createAndPersistPacketAudit, currentAcknowledgedPacketAudit } = await import('./packetAuditService'));
  ({ createPdfGenerationBinding } = await import('./pdfGenerationBinding'));
  ({ readApplicationReview } = await import('./applicationReview'));

  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await pglite.exec(statement);

  const [account] = await db.insert(schema.users).values({ email: 'restore-ack@example.test' }).returning();
  userId = account.id;
  applicantEmail = `app-${userId.replace(/-/g, '').slice(0, 12)}@apply.trylitos.com`;
});

after(async () => {
  await pool?.end();
  await server?.stop();
  await pglite?.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('a packet nobody acknowledged comes out of the rebuild unsendable', async () => {
  const seeded = await seedPacket({ acknowledged: false });
  const { outcome, loadPdf } = await restoreWith(seeded, 'authorizing_send');

  // The rebuild itself still happens, on the send path that asked for it: the file is back.
  assert.equal(outcome.restored, true, JSON.stringify(outcome));
  assert.notEqual(outcome.row.resume_object_key, seeded.resume_object_key);

  // And the acknowledgement was NOT invented. This is the defect, asserted on the stored row.
  const stored = readApplicationReview((await rowById(seeded.id)).spec);
  assert.equal(stored?.packet_audit_acknowledgement, undefined,
    'a restore may not write the record that authorizes a send');

  // The gate every send path funnels through refuses it, so the applicant is asked.
  const verdict = await currentAcknowledgedPacketAudit(outcome.row, {
    loadPdf,
    validateApplicantEmail: async () => {},
  });
  assert.equal(verdict.valid ? null : verdict.code, 'PACKET_AUDIT_REQUIRED');
});

test('an acknowledgement she gave before expiry does not authorize different rebuilt PDF bytes', async () => {
  const seeded = await seedPacket({ acknowledged: true });
  const { outcome, loadPdf } = await restoreWith(seeded, 'authorizing_send');

  assert.equal(outcome.restored, true, JSON.stringify(outcome));
  const review = readApplicationReview((await rowById(seeded.id)).spec)!;
  assert.equal(review.packet_audit_acknowledgement, undefined,
    'changed bytes must remove the old acknowledgement before replacement audit persistence');
  assert.equal(review.employer_delivery_bindings, undefined,
    'changed bytes must remove the old employer delivery hash before replacement audit persistence');
  assert.ok(review.packet_audit, 'the restore still creates a packet audit for the replacement PDF');
  assert.deepEqual(
    verifyStoredPacketAuditAcknowledgement({
      audit: review.packet_audit,
      ownerId: seeded.user_id,
      applicationId: seeded.id,
      client: {
        audit_digest: review.packet_audit.audit_digest,
        packet_version: review.packet_audit.packet_version,
        pdf_sha256: review.packet_audit.bindings.pdf.sha256,
        size_bytes: review.packet_audit.bindings.pdf.sizeBytes,
      },
    }),
    { valid: false, reason: 'packet_audit_stale' },
    'the restore-created audit cannot be acknowledged until packet-audit rebuilds delivery identity',
  );

  const verdict = await currentAcknowledgedPacketAudit(outcome.row, {
    loadPdf,
    validateApplicantEmail: async () => {},
  });
  assert.equal(verdict.valid ? null : verdict.code, 'PACKET_AUDIT_REQUIRED');
});

test('the review route rebuilds the file she asked to see and hands it no approval', async () => {
  const seeded = await seedPacket({ acknowledged: true });
  const { outcome, loadPdf } = await restoreWith(seeded, 'review_only');

  assert.equal(outcome.restored, true, JSON.stringify(outcome));
  const stored = readApplicationReview((await rowById(seeded.id)).spec)!;
  assert.equal(stored.packet_audit_acknowledgement, undefined, 'changed bytes retain no old approval');
  assert.equal(stored.employer_delivery_bindings, undefined, 'changed bytes retain no old delivery hash');

  /* It names the deleted file, so it is stale against the re-issued audit and the send gate asks
     her again. A review that quietly restored sendability would be the same defect wearing the
     other authority. */
  const verdict = await currentAcknowledgedPacketAudit(outcome.row, {
    loadPdf,
    validateApplicantEmail: async () => {},
  });
  assert.equal(verdict.valid ? null : verdict.code, 'PACKET_AUDIT_REQUIRED');
});

test('a lost audit persistence CAS never carries acknowledgement onto its transient audit', async () => {
  const seeded = await seedPacket({ acknowledged: true });
  const before = readApplicationReview(seeded.spec)!;
  const { outcome, loadPdf } = await restoreWith(seeded, 'authorizing_send', {
    rerenderResume: async () => OLD_BYTES,
    persistAudit: async (target) => {
      await db.update(schema.generated_resumes).set({
        spec: drizzle.sql`jsonb_set(
          coalesce(${schema.generated_resumes.spec}, '{}'::jsonb),
          '{_review,attention_reason}', '"mutation before audit CAS"'::jsonb, true
        )`,
      }).where(drizzle.eq(schema.generated_resumes.id, seeded.id));
      const result = await createAndPersistPacketAudit(target, {
        loadPdf: async () => ({ bytes: OLD_BYTES, contentType: 'application/pdf' }),
        validateApplicantEmail: async () => {},
      });
      assert.equal(result.persisted, false, 'the concurrent spec mutation must defeat audit persistence CAS');
      return result;
    },
  });

  assert.equal(outcome.restored, true, JSON.stringify(outcome));
  const stored = readApplicationReview((await rowById(seeded.id)).spec)!;
  assert.equal(stored.packet_audit_acknowledgement?.source, undefined,
    'persisted false cannot write an auto-restored acknowledgement');
  assert.deepEqual(stored.packet_audit, before.packet_audit,
    'the transient audit result is not treated as the stored audit');
  assert.equal(stored.attention_reason, 'mutation before audit CAS', 'the concurrent mutation must survive');
  const verdict = await currentAcknowledgedPacketAudit(outcome.row, {
    loadPdf,
    validateApplicantEmail: async () => {},
  });
  assert.equal(verdict.valid, false, 'the old audit and acknowledgement cannot authorize the new object key');
});

test('a concurrent review mutation before acknowledgement carry wins the exact spec CAS', async () => {
  const seeded = await seedPacket({ acknowledged: true });
  const { outcome, loadPdf } = await restoreWith(seeded, 'authorizing_send', {
    rerenderResume: async () => OLD_BYTES,
    beforeAcknowledgementCarry: async () => {
      await db.update(schema.generated_resumes).set({
        spec: drizzle.sql`jsonb_set(
          coalesce(${schema.generated_resumes.spec}, '{}'::jsonb),
          '{_review,attention_reason}', '"concurrent edit"'::jsonb, true
        )`,
      }).where(drizzle.eq(schema.generated_resumes.id, seeded.id));
    },
  });

  assert.equal(outcome.restored, true, JSON.stringify(outcome));
  const storedRow = await rowById(seeded.id);
  const stored = readApplicationReview(storedRow.spec)!;
  assert.equal(stored.attention_reason, 'concurrent edit', 'restore must not overwrite the concurrent review');
  assert.equal(stored.packet_audit_acknowledgement?.source, undefined,
    'a lost acknowledgement CAS writes no auto-restored approval');
  const verdict = await currentAcknowledgedPacketAudit(storedRow, {
    loadPdf,
    validateApplicantEmail: async () => {},
  });
  assert.equal(verdict.valid, false, 'the failed carry leaves the replacement audit fail closed');
});

/* THE OTHER WAY THIS WRITE FAILS, AND THE ONE THAT NEVER REACHED ITS CAS AT ALL.
 *
 * The two tests above stage the exact-spec CAS losing to a committed concurrent write, which
 * `persisted: false` describes correctly. Production hit a different failure on the same statement.
 * Every write to generated_resumes fires the submission-authority revision guard from a BEFORE
 * trigger; the guard takes the per-user advisory lock with pg_try_advisory_xact_lock - TRY, never
 * wait - and RAISES 40001 the moment anything else on the account holds it, which the audit screen's
 * own 2.5-second poll does for a few milliseconds at a time. drizzle wraps that raise in a
 * DrizzleQueryError whose message is `Failed query: <the whole UPDATE>\nparams: <every bound
 * value>`, POST /applications/:id/packet-audit caught it in its blanket handler, and the applicant
 * received a 422 PACKET_AUDIT_FAILED carrying the statement as its authored reason. Measured live
 * 2026-09-04 on Exa packet 73768339, alongside the same statement's 500 out of PUT
 * /review/answers.
 *
 * The raise happens before the row is touched, so nothing was written and the retried statement is
 * byte-identical - exact-spec predicate included - which is why it can only ever land on the packet
 * this audit was built from. The trigger below raises what the shipped guard raises, once, which is
 * the shape a poll produces.
 */
test('an audit the authority revision guard refuses once still persists', async () => {
  const seeded = await seedPacket({ acknowledged: false });
  /* nextval, not a counter table: the raise aborts its own transaction, so a table-backed counter is
     rolled back with it and every attempt would read as the first one. */
  await pglite.exec(`
    CREATE SEQUENCE IF NOT EXISTS litos_audit_guard_attempts;
    ALTER SEQUENCE litos_audit_guard_attempts RESTART WITH 1;
    CREATE OR REPLACE FUNCTION litos_audit_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF nextval('litos_audit_guard_attempts') > 1 THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'submission authority changed concurrently; retry the request'
        USING ERRCODE = '40001';
    END $$;
    DROP TRIGGER IF EXISTS litos_audit_authority_guard ON generated_resumes;
    CREATE TRIGGER litos_audit_authority_guard BEFORE UPDATE ON generated_resumes
      FOR EACH ROW EXECUTE FUNCTION litos_audit_authority_guard();
  `);

  let result;
  try {
    result = await createAndPersistPacketAudit(await rowById(seeded.id), {
      loadPdf: async () => ({ bytes: OLD_BYTES, contentType: 'application/pdf' }),
      validateApplicantEmail: async () => {},
    });
  } finally {
    await pglite.exec('DROP TRIGGER IF EXISTS litos_audit_authority_guard ON generated_resumes');
  }

  assert.equal(result.persisted, true, 'a guard refusal that clears is not a lost CAS and not a failure');
  const stored = readApplicationReview((await rowById(seeded.id)).spec)!;
  assert.equal(stored.packet_audit?.audit_digest, result.audit.audit_digest,
    'and the audit it reports is the audit the row actually holds');
});
