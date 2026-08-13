/* THE RESTORE ITSELF, AGAINST A REAL DATABASE, BECAUSE THE DECISION IS NOT THE BUG.
 *
 * A correct rule about acknowledgements that is not wired to the write would leave the defect
 * exactly where it was, and this area has already shipped one bug that a source-text test watched
 * happen without noticing. So this file runs the real restoreExpiredPacketResume over a real row:
 * a real re-render, the real createAndPersistPacketAudit, real UPDATEs, and then the real send gate
 * over whatever the restore left behind.
 *
 * Two seams are injected and neither is the subject: the blob write, so no network store is needed,
 * and the PDF read, so the audit can see the bytes the restore just produced. Everything the test
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

const ENCRYPTION_KEY = 'packet-restore-acknowledgement-key';
const JWT_SIGNING_SECRET = 'packet-restore-acknowledgement-secret';
const RESUME_EMAIL = 'restore-student@example.test';
const JD_TEXT = [
  'Qualifications',
  '- Experience with TypeScript.',
  '- Experience building reliable backend systems.',
].join('\n');
const OLD_BYTES = Buffer.from('%PDF-1.7\nRestore Student\nBasic Information\nAcme');

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
async function restoreWith(row: Awaited<ReturnType<typeof rowById>>, authority: 'authorizing_send' | 'review_only') {
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
    persistAudit: (target) => createAndPersistPacketAudit(target, {
      loadPdf,
      validateApplicantEmail: async () => {},
    }),
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
  assert.equal(verdict.valid ? null : verdict.code, 'PACKET_AUDIT_ACK_REQUIRED');
});

test('an acknowledgement she gave before the file expired carries onto the rebuilt file', async () => {
  const seeded = await seedPacket({ acknowledged: true });
  const before = readApplicationReview(seeded.spec)!.packet_audit_acknowledgement!;
  const { outcome, loadPdf } = await restoreWith(seeded, 'authorizing_send');

  assert.equal(outcome.restored, true, JSON.stringify(outcome));
  const carried = readApplicationReview((await rowById(seeded.id)).spec)?.packet_audit_acknowledgement;
  assert.ok(carried, 'her approval of unchanged content survives the rebuild');
  assert.equal(carried.source, 'auto_restored', 'and the corpus can still tell who looked');
  assert.notEqual(carried.pdfSha256, before.pdfSha256, 'bound to the file that now exists');

  const verdict = await currentAcknowledgedPacketAudit(outcome.row, {
    loadPdf,
    validateApplicantEmail: async () => {},
  });
  assert.equal(verdict.valid, true, verdict.valid ? '' : verdict.reason);
});

test('the review route rebuilds the file she asked to see and hands it no approval', async () => {
  const seeded = await seedPacket({ acknowledged: true });
  const before = readApplicationReview(seeded.spec)!.packet_audit_acknowledgement!;
  const { outcome, loadPdf } = await restoreWith(seeded, 'review_only');

  assert.equal(outcome.restored, true, JSON.stringify(outcome));
  const untouched = readApplicationReview((await rowById(seeded.id)).spec)?.packet_audit_acknowledgement;
  assert.deepEqual(untouched, before, 'a look writes no acknowledgement, old or new');

  /* It names the deleted file, so it is stale against the re-issued audit and the send gate asks
     her again. A review that quietly restored sendability would be the same defect wearing the
     other authority. */
  const verdict = await currentAcknowledgedPacketAudit(outcome.row, {
    loadPdf,
    validateApplicantEmail: async () => {},
  });
  assert.equal(verdict.valid ? null : verdict.code, 'PACKET_AUDIT_ACK_REQUIRED');
});
