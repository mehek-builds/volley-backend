import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import {
  DOCX_SAFETY_LIMITS,
  extractDocxText,
  inspectDocxArchive,
  inspectResumeUpload,
  ResumeUploadError,
} from './resumeUpload';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function validDocx(
  text = 'Jordan Lee\nSoftware Engineer',
  extraEntries = 0,
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  );
  zip.folder('_rels')!.file(
    '.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  const paragraphs = text
    .split('\n')
    .map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`)
    .join('');
  zip.folder('word')!.file(
    'document.xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${paragraphs}<w:sectPr/></w:body></w:document>`,
  );
  for (let index = 0; index < extraEntries; index += 1) {
    zip.file(`item-${index}.xml`, `<item>${index}</item>`);
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}

function understateEntrySize(buffer: Buffer, entryName: string, declaredBytes: number): Buffer {
  const altered = Buffer.from(buffer);
  const name = Buffer.from(entryName);
  const nameOffset = altered.lastIndexOf(name);
  const centralHeaderOffset = nameOffset - 46;
  assert.ok(nameOffset > 46, `missing central directory entry for ${entryName}`);
  assert.equal(altered.readUInt32LE(centralHeaderOffset), 0x02014b50);
  const localHeaderOffset = altered.readUInt32LE(centralHeaderOffset + 42);
  assert.equal(altered.readUInt32LE(localHeaderOffset), 0x04034b50);
  altered.writeUInt32LE(declaredBytes, centralHeaderOffset + 24);
  altered.writeUInt32LE(declaredBytes, localHeaderOffset + 22);
  return altered;
}

test('accepts and extracts a genuine DOCX resume', async () => {
  const buffer = await validDocx();

  assert.equal(
    inspectResumeUpload(buffer, { filename: 'resume.docx', mimetype: DOCX_MIME }),
    'docx',
  );
  assert.match(await extractDocxText(buffer), /Jordan Lee\s+Software Engineer/);
  const inspection = await inspectDocxArchive(buffer);
  assert.ok(inspection.entryCount < DOCX_SAFETY_LIMITS.entryCount);
  assert.ok(inspection.totalUncompressedBytes < DOCX_SAFETY_LIMITS.totalUncompressedBytes);
  assert.ok(inspection.documentXmlBytes < DOCX_SAFETY_LIMITS.documentXmlBytes);
});

test('accepts a genuine PDF when a browser sends a generic MIME type', () => {
  const buffer = Buffer.from('%PDF-1.7\nsynthetic test content');
  assert.equal(
    inspectResumeUpload(buffer, { filename: 'resume.PDF', mimetype: 'application/octet-stream' }),
    'pdf',
  );
});

test('rejects plain text renamed as DOCX', () => {
  assert.throws(
    () => inspectResumeUpload(Buffer.from('Jordan Lee resume'), {
      filename: 'resume.docx',
      mimetype: DOCX_MIME,
    }),
    (err: unknown) => err instanceof ResumeUploadError && /not a valid DOCX/.test(err.message),
  );
});

test('rejects a PDF mislabeled as DOCX', () => {
  assert.throws(
    () => inspectResumeUpload(Buffer.from('%PDF-1.7\n'), {
      filename: 'resume.docx',
      mimetype: DOCX_MIME,
    }),
    (err: unknown) => err instanceof ResumeUploadError && /not a valid DOCX/.test(err.message),
  );
});

test('rejects conflicting recognized filename and MIME declarations', async () => {
  const buffer = await validDocx();
  assert.throws(
    () => inspectResumeUpload(buffer, { filename: 'resume.docx', mimetype: 'application/pdf' }),
    (err: unknown) => err instanceof ResumeUploadError && /disagree/.test(err.message),
  );
});

test('rejects unsupported upload types', () => {
  assert.throws(
    () => inspectResumeUpload(Buffer.from('plain text'), {
      filename: 'resume.txt',
      mimetype: 'text/plain',
    }),
    (err: unknown) => err instanceof ResumeUploadError && /Unsupported resume file type/.test(err.message),
  );
});

test('rejects a generic ZIP renamed as DOCX during Word extraction', async () => {
  const zip = new JSZip();
  zip.file('notes.txt', 'not an OOXML Word document');
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  assert.equal(
    inspectResumeUpload(buffer, { filename: 'resume.docx', mimetype: DOCX_MIME }),
    'docx',
  );
  await assert.rejects(
    extractDocxText(buffer),
    (err: unknown) => err instanceof ResumeUploadError && /Failed to parse DOCX/.test(err.message),
  );
});

test('rejects a small compressed DOCX whose document XML expands past the safe limit', async () => {
  const buffer = await validDocx('A'.repeat(DOCX_SAFETY_LIMITS.documentXmlBytes));
  assert.ok(buffer.length < 32 * 1024, 'the regression fixture must remain a small compressed upload');

  assert.equal(
    inspectResumeUpload(buffer, { filename: 'resume.docx', mimetype: DOCX_MIME }),
    'docx',
  );
  await assert.rejects(
    extractDocxText(buffer),
    (err: unknown) => err instanceof ResumeUploadError && /document text is too large/.test(err.message),
  );
});

test('stops inflation when ZIP metadata understates the real expanded size', async () => {
  const honest = await validDocx('A'.repeat(DOCX_SAFETY_LIMITS.ratioCheckMinimumBytes * 2));
  const dishonest = understateEntrySize(honest, 'word/document.xml', 16);

  await assert.rejects(
    extractDocxText(dishonest),
    (err: unknown) => err instanceof ResumeUploadError && /invalid size metadata/.test(err.message),
  );
});

test('allows the entry-count boundary and rejects the first entry beyond it', async () => {
  const base = await validDocx();
  const baseInspection = await inspectDocxArchive(base);
  const entriesToBoundary = DOCX_SAFETY_LIMITS.entryCount - baseInspection.entryCount;

  const atBoundary = await validDocx('Jordan Lee\nSoftware Engineer', entriesToBoundary);
  assert.equal((await inspectDocxArchive(atBoundary)).entryCount, DOCX_SAFETY_LIMITS.entryCount);

  const beyondBoundary = await validDocx('Jordan Lee\nSoftware Engineer', entriesToBoundary + 1);
  await assert.rejects(
    inspectDocxArchive(beyondBoundary),
    (err: unknown) => err instanceof ResumeUploadError && /too many files/.test(err.message),
  );
});

test('rejects a dangerous per-entry compression ratio below the absolute entry-size limit', async () => {
  const zip = new JSZip();
  const normal = await validDocx();
  const loaded = await JSZip.loadAsync(normal);
  for (const [name, entry] of Object.entries(loaded.files)) {
    if (!entry.dir) zip.file(name, await entry.async('nodebuffer'));
  }
  zip.file('custom/repeated.xml', 'Z'.repeat(DOCX_SAFETY_LIMITS.ratioCheckMinimumBytes * 2));
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  await assert.rejects(
    inspectDocxArchive(buffer),
    (err: unknown) => err instanceof ResumeUploadError && /unsafe compression ratio/.test(err.message),
  );
});

test('rejects a dangerous aggregate ratio composed of individually small entries', async () => {
  const normal = await validDocx();
  const zip = await JSZip.loadAsync(normal);
  const smallEntryBytes = DOCX_SAFETY_LIMITS.ratioCheckMinimumBytes / 2;
  const extraEntryCount = Math.ceil(
    DOCX_SAFETY_LIMITS.aggregateRatioCheckMinimumBytes / smallEntryBytes,
  );
  for (let index = 0; index < extraEntryCount; index += 1) {
    zip.file(`aggregate-${index}.xml`, 'Q'.repeat(smallEntryBytes));
  }
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  await assert.rejects(
    inspectDocxArchive(buffer),
    (err: unknown) => err instanceof ResumeUploadError && /unsafe compression ratio/.test(err.message),
  );
});

test('rejects a malformed archive before Mammoth extraction', async () => {
  const malformed = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);
  assert.equal(
    inspectResumeUpload(malformed, { filename: 'resume.docx', mimetype: DOCX_MIME }),
    'docx',
  );
  await assert.rejects(
    extractDocxText(malformed),
    (err: unknown) => err instanceof ResumeUploadError && /encrypted or malformed/.test(err.message),
  );
});
