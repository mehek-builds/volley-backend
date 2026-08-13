/* WHAT THE PACKET AUDIT COSTS TO ANSWER, MEASURED ON PRODUCTION.
 *
 * POST /applications/:id/packet-audit calls currentPacketAudit on every request, the dashboard polls
 * it every 2.5 seconds while a packet is open, and the loader had no cache of any kind: 1,440 calls
 * an hour per open packet, each one downloading the same 31.7 KB file, roughly 45 MB of blob egress
 * an hour. None of it metered, because LIMITS.perHour.packetAudit is charged only when the current
 * audit comes back INVALID, so the expensive path was the unmetered one and the limit never fired.
 *
 * The stored PDF is immutable for a given resume_object_key, so the read is avoidable. These tests
 * hold that it IS avoided, and that avoiding it changes nothing else: the hash check still runs on
 * whatever bytes are used, a row whose recorded file moved is never served the previous one, and the
 * refusals and the rate limiter read exactly as they did.
 *
 * Deliberately written against currentPacketAudit alone, with no reference to the cache module: the
 * property is about how many times this gate reads the stored file, and a test that could only fail
 * by naming a new symbol would prove nothing about that. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPacketAudit } from './packetAudit';
import { currentPacketAudit } from './packetAuditService';
import { createPdfGenerationBinding } from './pdfGenerationBinding';

const RESUME_EMAIL = 'student@example.com';
const APPLICANT_EMAIL = 'app-owner@apply.trylitos.com';
const JD_TEXT = 'Build reliable systems.';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const skipEmailCheck = async () => {};

/** A packet exactly as production stores one: audited, bound to its file, ready to be looked at. */
function packetRow(options: { objectKey: string; pdfBytes: Buffer }) {
  const spec = {
    target_role: 'Engineer',
    school: '',
    degree: '',
    grad_date: '',
    gpa: '',
    school_location: '',
    coursework: '',
    experience: [],
    skills: [],
    _contact: { email: RESUME_EMAIL },
    _applicant_email: {
      address: APPLICANT_EMAIL,
      source: 'litos_alias',
      reason: 'deliverable',
      tracked: true,
      decided_at: '2026-08-11T00:00:00.000Z',
    },
    _application_email: {
      alias: APPLICANT_EMAIL,
      forwards_to: RESUME_EMAIL,
      mode: 'litos_application_alias',
    },
    _review: {
      jd_text: JD_TEXT,
      questions: [],
      status: 'ready_for_final_approval',
      applicant_email: {
        address: APPLICANT_EMAIL,
        source: 'litos_alias',
        reason: 'deliverable',
        tracked: true,
        decided_at: '2026-08-11T00:00:00.000Z',
      },
      applicant_snapshot: {
        profile: { email: APPLICANT_EMAIL, experience: [], skills: [], school: '', grad_year: 0 },
        application_profile: {},
      },
    },
  };
  const jobContext = { company: 'Acme', role: 'Engineer' };
  const audit = createPacketAudit({
    ownerId: 'owner-1',
    applicationId: 'application-1',
    jdText: JD_TEXT,
    spec,
    jobContext,
    questions: [],
    applicantSnapshot: spec._review.applicant_snapshot,
    resumeEmail: RESUME_EMAIL,
    applicantEmail: APPLICANT_EMAIL,
    pdfObjectKey: options.objectKey,
    pdfBytes: options.pdfBytes,
    editedTerms: [],
    rejected: [],
    degraded: false,
    clauses: [{ text: JD_TEXT, start: 0, end: JD_TEXT.length, verdict: 'missing' as const }],
    terms: { covered: [], missing: [], edited: [] },
  });
  return {
    id: 'application-1',
    user_id: 'owner-1',
    resume_object_key: options.objectKey,
    job_context: jobContext,
    spec: {
      ...spec,
      _review: { ...spec._review, packet_audit: audit },
      _quality: {
        pdfGenerationBinding: createPdfGenerationBinding(spec, options.objectKey, options.pdfBytes, RESUME_EMAIL),
      },
    },
  };
}

/** The stored file, as a loader that records every read the way the blob store would bill them. */
function recordingLoader(files: Record<string, Buffer>) {
  const reads: string[] = [];
  return {
    reads,
    loadPdf: async (objectKey: string) => {
      reads.push(objectKey);
      const bytes = files[objectKey];
      if (!bytes) throw new Error('The stored resume PDF is unavailable');
      return { bytes, contentType: 'application/pdf' };
    },
  };
}

test('the dashboard poll reads the stored packet PDF once, not once per request', async () => {
  const objectKey = 'users/owner-1/resumes/application-1-poll.pdf';
  const pdfBytes = Buffer.from('%PDF-1.7\nthe packet she has open');
  const row = packetRow({ objectKey, pdfBytes });
  const { reads, loadPdf } = recordingLoader({ [objectKey]: pdfBytes });

  const first = await currentPacketAudit(row as never, { loadPdf, validateApplicantEmail: skipEmailCheck });
  assert.equal(first.valid, true, first.valid ? '' : first.reason);
  assert.equal(reads.length, 1, 'the first audit reads the stored file');

  const second = await currentPacketAudit(row as never, { loadPdf, validateApplicantEmail: skipEmailCheck });
  assert.equal(second.valid, true, second.valid ? '' : second.reason);
  assert.deepEqual(
    reads,
    [objectKey],
    'the second poll of an unchanged packet must not download the same immutable file again',
  );
  assert.equal(
    second.valid && second.pdfBytes.equals(pdfBytes),
    true,
    'and it must audit the stored bytes, not something a cache invented',
  );
});

/* THE CHECK STILL RUNS ON WHATEVER BYTES ARE USED.
 *
 * Production cannot reach this today: every writer mints a fresh key and put() appends its own
 * random suffix, so a key is written once and never rewritten. This holds the property that makes
 * a cached read safe if that ever stops being true. A row that records a different file at a key
 * already read is answered from the real file, and the stale copy is dropped rather than the
 * request failing on its account. */
test('a file already read is not reused for a row whose recorded sha256 no longer matches it', async () => {
  const objectKey = 'users/owner-1/resumes/application-1-rewritten.pdf';
  const before = Buffer.from('%PDF-1.7\nthe file the row used to record');
  const after = Buffer.from('%PDF-1.7\nthe file the row records now');
  assert.notEqual(sha256(before), sha256(after));
  const files: Record<string, Buffer> = { [objectKey]: before };
  const { reads, loadPdf } = recordingLoader(files);

  const rowBefore = packetRow({ objectKey, pdfBytes: before });
  const opened = await currentPacketAudit(rowBefore as never, { loadPdf, validateApplicantEmail: skipEmailCheck });
  assert.equal(opened.valid, true, opened.valid ? '' : opened.reason);
  await currentPacketAudit(rowBefore as never, { loadPdf, validateApplicantEmail: skipEmailCheck });
  assert.deepEqual(reads, [objectKey], 'the packet as it stood costs one read no matter how often it is polled');

  files[objectKey] = after;
  const rowAfter = packetRow({ objectKey, pdfBytes: after });
  const verdict = await currentPacketAudit(rowAfter as never, { loadPdf, validateApplicantEmail: skipEmailCheck });
  assert.equal(reads.length, 2, 'a row recording a different file must re-read it rather than be handed the old one');
  assert.equal(verdict.valid, true, verdict.valid ? '' : verdict.reason);
  assert.equal(
    verdict.valid && verdict.pdfBytes.equals(after),
    true,
    'and the bytes it audits are the ones the row now records',
  );
});

test('a restored packet is audited from its own file, never from the key it replaced', async () => {
  // The shapes restoreExpiredPacketResume and the generator actually write: never the same key twice.
  const expiredKey = 'users/owner-1/resumes/application-1-1754800000000.pdf';
  const restoredKey = 'users/owner-1/resumes/application-1-restored-6f7f2f0c-2f2a-4f0a-9f7a-1c2d3e4f5a6b.pdf';
  const expiredBytes = Buffer.from('%PDF-1.7\nthe file that aged out');
  const restoredBytes = Buffer.from('%PDF-1.7\nthe file rebuilt from the frozen spec');
  const { reads, loadPdf } = recordingLoader({ [expiredKey]: expiredBytes, [restoredKey]: restoredBytes });

  const expiredRow = packetRow({ objectKey: expiredKey, pdfBytes: expiredBytes });
  await currentPacketAudit(expiredRow as never, { loadPdf, validateApplicantEmail: skipEmailCheck });
  await currentPacketAudit(expiredRow as never, { loadPdf, validateApplicantEmail: skipEmailCheck });
  assert.deepEqual(reads, [expiredKey], 'the packet before the restore costs one read');

  const restoredRow = packetRow({ objectKey: restoredKey, pdfBytes: restoredBytes });
  const verdict = await currentPacketAudit(restoredRow as never, { loadPdf, validateApplicantEmail: skipEmailCheck });
  assert.deepEqual(reads, [expiredKey, restoredKey], 'the rebuilt file is read on its own account');
  assert.equal(verdict.valid, true, verdict.valid ? '' : verdict.reason);
  assert.equal(verdict.valid && verdict.pdfBytes.equals(restoredBytes), true);
});

test('bytes that do not match what the row records are refused exactly as before, and never kept', async () => {
  const objectKey = 'users/owner-1/resumes/application-1-signed-out.pdf';
  const recorded = Buffer.from('%PDF-1.7\nthe packet that was generated');
  const row = packetRow({ objectKey, pdfBytes: recorded });

  // A sign-in page where the PDF should be: the store answered, but not with the file.
  const html = recordingLoader({ [objectKey]: Buffer.from('<html>signed out</html>') });
  const first = await currentPacketAudit(row as never, { loadPdf: html.loadPdf, validateApplicantEmail: skipEmailCheck });
  assert.equal(first.valid, false);
  assert.deepEqual(first.valid ? null : first.code, 'PACKET_PDF_INVALID');
  assert.deepEqual(first.valid ? null : first.reason, 'The stored resume is not a verified PDF.');
  const repeat = await currentPacketAudit(row as never, { loadPdf: html.loadPdf, validateApplicantEmail: skipEmailCheck });
  assert.equal(html.reads.length, 2, 'bytes that failed the record are never kept, so the next call re-reads');
  assert.deepEqual(repeat.valid ? null : repeat.reason, 'The stored resume is not a verified PDF.');

  // A real PDF, but not the one this packet is bound to.
  const wrong = recordingLoader({ [objectKey]: Buffer.from('%PDF-1.7\na different generated packet') });
  const unbound = await currentPacketAudit(row as never, { loadPdf: wrong.loadPdf, validateApplicantEmail: skipEmailCheck });
  assert.deepEqual(unbound.valid ? null : unbound.code, 'PACKET_PDF_INVALID');
  assert.deepEqual(
    unbound.valid ? null : unbound.reason,
    'The stored resume PDF is not bound to this exact saved resume. Generate it again.',
  );
  await currentPacketAudit(row as never, { loadPdf: wrong.loadPdf, validateApplicantEmail: skipEmailCheck });
  assert.equal(wrong.reads.length, 2, 'an unbound file is re-read too, so a stale copy can never accumulate');

  // The file is gone. The message the applicant sees is the loader's own, unchanged.
  const gone = await currentPacketAudit(row as never, {
    loadPdf: async () => { throw new Error('The stored resume PDF could not be downloaded'); },
    validateApplicantEmail: skipEmailCheck,
  });
  assert.deepEqual(gone.valid ? null : gone.code, 'PACKET_PDF_INVALID');
  assert.deepEqual(gone.valid ? null : gone.reason, 'The stored resume PDF could not be downloaded');
});

test('a packet with no generation binding is refused as before and nothing about it is kept', async () => {
  const objectKey = 'users/owner-1/resumes/application-1-unbound.pdf';
  const pdfBytes = Buffer.from('%PDF-1.7\nan older packet');
  const row = packetRow({ objectKey, pdfBytes });
  const unbound = { ...row, spec: { ...row.spec, _quality: {} } };
  const { reads, loadPdf } = recordingLoader({ [objectKey]: pdfBytes });

  const first = await currentPacketAudit(unbound as never, { loadPdf, validateApplicantEmail: skipEmailCheck });
  assert.deepEqual(first.valid ? null : first.code, 'PACKET_PDF_INVALID');
  assert.deepEqual(
    first.valid ? null : first.reason,
    'The stored resume PDF is not bound to this exact saved resume. Generate it again.',
  );
  await currentPacketAudit(unbound as never, { loadPdf, validateApplicantEmail: skipEmailCheck });
  assert.equal(reads.length, 2, 'with nothing to prove a copy against, there is nothing to keep');
});

/* The rate limiter is charged on the INVALID path only, which is why the poll never tripped it and
   why the fix had to be a cheaper read rather than a lower limit. Nothing here changed it, and this
   is the assertion that says so out loud. */
test('the packet audit route still charges the hourly limiter only when the current audit is invalid', () => {
  const applications = readFileSync('src/routes/applications.ts', 'utf8');
  const from = applications.indexOf("'/applications/:id/packet-audit'");
  const to = applications.indexOf("'/applications/:id/packet-audit/acknowledge'", from);
  assert.ok(from >= 0 && to > from, 'the packet audit route was not found');
  const route = applications.slice(from, to);
  assert.match(
    route,
    /if \(!cached\.valid\) \{[\s\S]{0,240}allowHourly\(request\.jwtPayload!\.userId, 'packet-audit', LIMITS\.perHour\.packetAudit\)[\s\S]{0,160}rateLimitedReply\(reply\)/,
  );
  assert.match(route, /currentPacketAudit\(row[,)]/);
  assert.match(route, /createAndPersistPacketAudit\(row\)/);
});
