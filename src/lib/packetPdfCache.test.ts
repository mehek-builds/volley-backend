/* The bounds on the process cache, tested on the cache itself.
 *
 * The behaviour that matters to an applicant is held in packetAuditPdfReads.test.ts, against
 * currentPacketAudit and nothing else. What is left here is what only this module can be asked:
 * that a long-lived Vercel instance cannot grow without limit, that a copy ages out, and that the
 * record a copy is proven against is really compared. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { clearPacketPdfCache, loadPacketPdf, packetPdfCacheSize } from './packetPdfCache';
import { bindingPdfIdentity, createPdfGenerationBinding } from './pdfGenerationBinding';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('a long-lived instance holds a bounded number of packets', async () => {
  clearPacketPdfCache();
  const bytes = Buffer.from('%PDF-1.7\none stored packet');
  const identity = { sha256: sha256(bytes), sizeBytes: bytes.byteLength };
  let reads = 0;
  const load = async () => { reads += 1; return { bytes }; };

  for (let index = 0; index < 40; index += 1) {
    await loadPacketPdf({ objectKey: `users/owner-1/resumes/bounded-${index}.pdf`, identity, load });
  }
  assert.equal(reads, 40, 'forty distinct packets are forty distinct reads');
  assert.ok(packetPdfCacheSize() <= 24, `the cache grew to ${packetPdfCacheSize()} entries`);
});

test('a copy ages out, and being read again does not extend its life', async () => {
  clearPacketPdfCache();
  const bytes = Buffer.from('%PDF-1.7\nheld briefly');
  const identity = { sha256: sha256(bytes), sizeBytes: bytes.byteLength };
  let reads = 0;
  const load = async () => { reads += 1; return { bytes }; };
  const objectKey = 'users/owner-1/resumes/aging.pdf';
  let clock = 1_000_000;
  const now = () => clock;

  await loadPacketPdf({ objectKey, identity, load, now });
  assert.equal(reads, 1);
  clock += 30_000;
  await loadPacketPdf({ objectKey, identity, load, now });
  assert.equal(reads, 1, 'inside the window the stored file is not read again');
  clock += 30_001;
  await loadPacketPdf({ objectKey, identity, load, now });
  assert.equal(reads, 2, 'the window runs from the read, so nothing can pin a copy indefinitely');
});

test('bytes that do not hash to what the row records are never kept', async () => {
  clearPacketPdfCache();
  const recorded = Buffer.from('%PDF-1.7\nthe generated packet');
  const served = Buffer.from('%PDF-1.7\nsomething else entirely');
  const identity = { sha256: sha256(recorded), sizeBytes: recorded.byteLength };
  let reads = 0;
  const load = async () => { reads += 1; return { bytes: served }; };
  const objectKey = 'users/owner-1/resumes/mismatched.pdf';

  await loadPacketPdf({ objectKey, identity, load });
  await loadPacketPdf({ objectKey, identity, load });
  assert.equal(reads, 2, 'a copy is only kept once it is proven against the record');
  assert.equal(packetPdfCacheSize(), 0);
});

test('a packet with no usable record is read every time', async () => {
  clearPacketPdfCache();
  const bytes = Buffer.from('%PDF-1.7\nno binding on the row');
  let reads = 0;
  const load = async () => { reads += 1; return { bytes }; };
  const objectKey = 'users/owner-1/resumes/unrecorded.pdf';

  await loadPacketPdf({ objectKey, identity: null, load });
  await loadPacketPdf({ objectKey, identity: null, load });
  assert.equal(reads, 2);
  assert.equal(packetPdfCacheSize(), 0);
});

test('the caller cannot corrupt a held copy by writing to the buffer it was handed', async () => {
  clearPacketPdfCache();
  const stored = Buffer.from('%PDF-1.7\nthe stored packet');
  const identity = { sha256: sha256(stored), sizeBytes: stored.byteLength };
  let reads = 0;
  const load = async () => { reads += 1; return { bytes: Buffer.from(stored) }; };
  const objectKey = 'users/owner-1/resumes/mutable.pdf';

  const first = await loadPacketPdf({ objectKey, identity, load });
  first.bytes.fill(0);
  const second = await loadPacketPdf({ objectKey, identity, load });
  assert.equal(reads, 1);
  assert.equal(second.bytes.equals(stored), true, 'the held copy is its own buffer');
});

test('the file identity is read only from a binding written for this exact key', () => {
  const spec = { target_role: 'Engineer', experience: [], skills: [] };
  const objectKey = 'users/owner-1/resumes/identity.pdf';
  const bytes = Buffer.from('%PDF-1.7\nbound');
  const binding = createPdfGenerationBinding(spec, objectKey, bytes, 'student@example.com');

  assert.deepEqual(bindingPdfIdentity(binding, objectKey), {
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
  });
  assert.equal(bindingPdfIdentity(binding, 'users/owner-1/resumes/other.pdf'), null);
  assert.equal(bindingPdfIdentity(binding, ''), null);
  assert.equal(bindingPdfIdentity(null, objectKey), null);
  assert.equal(bindingPdfIdentity({ ...binding, version: 'generated_pdf_v0' }, objectKey), null);
  assert.equal(bindingPdfIdentity({ ...binding, pdfSha256: 'not a digest' }, objectKey), null);
  assert.equal(bindingPdfIdentity({ ...binding, sizeBytes: 0 }, objectKey), null);
  assert.equal(bindingPdfIdentity({ ...binding, sizeBytes: 12.5 }, objectKey), null);
});
