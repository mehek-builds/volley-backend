import mammoth from 'mammoth';
import JSZip from 'jszip';

export type ResumeSourceFormat = 'pdf' | 'docx';

export interface ResumeUploadMetadata {
  filename?: string;
  mimetype?: string;
}

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const DOCX_SAFETY_LIMITS = {
  compressedArchiveBytes: 10 * 1024 * 1024,
  entryCount: 512,
  totalUncompressedBytes: 50 * 1024 * 1024,
  entryUncompressedBytes: 20 * 1024 * 1024,
  documentXmlBytes: 5 * 1024 * 1024,
  entryCompressionRatio: 200,
  aggregateCompressionRatio: 100,
  ratioCheckMinimumBytes: 64 * 1024,
  aggregateRatioCheckMinimumBytes: 1024 * 1024,
} as const;

interface JSZipEntryData {
  compressedSize: number;
  uncompressedSize: number;
}

interface JSZipEntryWithData extends JSZip.JSZipObject {
  _data?: JSZipEntryData;
}

export interface DocxArchiveInspection {
  entryCount: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  documentXmlBytes: number;
}

interface PreparedDocxArchive {
  inspection: DocxArchiveInspection;
  sanitizedBuffer: Buffer;
}

export class ResumeUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeUploadError';
  }
}

function formatFromFilename(filename: string | undefined): ResumeSourceFormat | undefined {
  const normalized = (filename ?? '').trim().toLowerCase();
  if (normalized.endsWith('.pdf')) return 'pdf';
  if (normalized.endsWith('.docx')) return 'docx';
  return undefined;
}

function formatFromMime(mimetype: string | undefined): ResumeSourceFormat | undefined {
  const normalized = (mimetype ?? '').split(';', 1)[0].trim().toLowerCase();
  if (normalized === PDF_MIME) return 'pdf';
  if (normalized === DOCX_MIME) return 'docx';
  return undefined;
}

function formatFromSignature(buffer: Buffer): ResumeSourceFormat | undefined {
  // ISO 32000 permits a PDF header anywhere in the first 1024 bytes.
  if (buffer.subarray(0, 1024).indexOf('%PDF-') >= 0) return 'pdf';
  // DOCX is an OOXML ZIP container. Mammoth validates the required Word parts during extraction.
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return 'docx';
  }
  return undefined;
}

/**
 * Resolve the resume format from user-visible metadata, then verify it against the bytes.
 * Filename and MIME are advisory independently, but a direct conflict between two recognized
 * declarations is rejected. This prevents a renamed PDF from entering the DOCX parser and vice
 * versa, while still allowing browsers that submit an empty or generic MIME type.
 */
export function inspectResumeUpload(buffer: Buffer, metadata: ResumeUploadMetadata): ResumeSourceFormat {
  const filenameFormat = formatFromFilename(metadata.filename);
  const mimeFormat = formatFromMime(metadata.mimetype);

  if (filenameFormat && mimeFormat && filenameFormat !== mimeFormat) {
    throw new ResumeUploadError('The file name and content type disagree. Upload a genuine PDF or DOCX file.');
  }

  const declaredFormat = filenameFormat ?? mimeFormat;
  if (!declaredFormat) {
    throw new ResumeUploadError('Unsupported resume file type. Upload a PDF or DOCX file.');
  }

  const signatureFormat = formatFromSignature(buffer);
  if (signatureFormat !== declaredFormat) {
    throw new ResumeUploadError(
      `The uploaded file is not a valid ${declaredFormat === 'pdf' ? 'PDF' : 'DOCX'} file.`,
    );
  }

  return declaredFormat;
}

function safeArchiveSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSymlink(entry: JSZip.JSZipObject): boolean {
  const rawMode = entry.unixPermissions;
  const mode = typeof rawMode === 'string' ? Number.parseInt(rawMode, 8) : rawMode;
  return typeof mode === 'number' && Number.isFinite(mode) && (mode & 0o170000) === 0o120000;
}

async function prepareDocxArchive(buffer: Buffer): Promise<PreparedDocxArchive> {
  if (buffer.length > DOCX_SAFETY_LIMITS.compressedArchiveBytes) {
    throw new ResumeUploadError('The DOCX file is larger than the 10 MB upload limit.');
  }

  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  } catch {
    throw new ResumeUploadError('Failed to parse DOCX. The Word archive is encrypted or malformed.');
  }

  const entries = Object.values(archive.files);
  if (entries.length > DOCX_SAFETY_LIMITS.entryCount) {
    throw new ResumeUploadError('Failed to parse DOCX. The Word archive contains too many files.');
  }

  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;
  let documentXmlBytes = 0;
  let documentEntryFound = false;
  let contentTypesFound = false;
  const sanitizedArchive = new JSZip();

  for (const entry of entries) {
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) {
      throw new ResumeUploadError('Failed to parse DOCX. The Word archive contains an unsafe path.');
    }
    if (isSymlink(entry)) {
      throw new ResumeUploadError('Failed to parse DOCX. The Word archive contains an unsafe link.');
    }
    if (entry.dir) continue;

    const data = (entry as JSZipEntryWithData)._data;
    if (!data || !safeArchiveSize(data.compressedSize) || !safeArchiveSize(data.uncompressedSize)) {
      throw new ResumeUploadError('Failed to parse DOCX. The Word archive has invalid size metadata.');
    }

    const compressedSize = data.compressedSize;
    const declaredUncompressedSize = data.uncompressedSize;
    totalCompressedBytes += compressedSize;

    if (!Number.isSafeInteger(totalCompressedBytes)) {
      throw new ResumeUploadError('Failed to parse DOCX. The Word archive has invalid size metadata.');
    }
    if (declaredUncompressedSize > DOCX_SAFETY_LIMITS.entryUncompressedBytes) {
      throw new ResumeUploadError('Failed to parse DOCX. A file inside the Word archive is too large.');
    }

    if (entry.name === 'word/document.xml') {
      documentEntryFound = true;
      if (declaredUncompressedSize > DOCX_SAFETY_LIMITS.documentXmlBytes) {
        throw new ResumeUploadError('Failed to parse DOCX. The document text is too large to process safely.');
      }
    } else if (entry.name === '[Content_Types].xml') {
      contentTypesFound = true;
    }

    if (
      declaredUncompressedSize >= DOCX_SAFETY_LIMITS.ratioCheckMinimumBytes &&
      declaredUncompressedSize / Math.max(1, compressedSize) > DOCX_SAFETY_LIMITS.entryCompressionRatio
    ) {
      throw new ResumeUploadError('Failed to parse DOCX. The Word archive has an unsafe compression ratio.');
    }

    // Do not trust the central directory's expansion size on its own. Inflate incrementally and
    // stop as soon as either the declared size or an absolute bound is crossed. Rebuilding the
    // archive from these bounded bytes means Mammoth never sees attacker-controlled DEFLATE data.
    const chunks: Buffer[] = [];
    let actualUncompressedSize = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const stream = entry.nodeStream('nodebuffer') as NodeJS.ReadableStream & {
          destroy(error?: Error): void;
        };
        let settled = false;
        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          stream.destroy();
          reject(err);
        };

        stream.on('data', (rawChunk: Buffer | Uint8Array) => {
          if (settled) return;
          try {
            const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
            actualUncompressedSize += chunk.length;
            totalUncompressedBytes += chunk.length;

            if (
              !Number.isSafeInteger(actualUncompressedSize) ||
              !Number.isSafeInteger(totalUncompressedBytes) ||
              actualUncompressedSize > declaredUncompressedSize
            ) {
              throw new ResumeUploadError('Failed to parse DOCX. The Word archive has invalid size metadata.');
            }
            if (actualUncompressedSize > DOCX_SAFETY_LIMITS.entryUncompressedBytes) {
              throw new ResumeUploadError('Failed to parse DOCX. A file inside the Word archive is too large.');
            }
            if (
              entry.name === 'word/document.xml' &&
              actualUncompressedSize > DOCX_SAFETY_LIMITS.documentXmlBytes
            ) {
              throw new ResumeUploadError('Failed to parse DOCX. The document text is too large to process safely.');
            }
            if (totalUncompressedBytes > DOCX_SAFETY_LIMITS.totalUncompressedBytes) {
              throw new ResumeUploadError('Failed to parse DOCX. The expanded Word archive is too large.');
            }
            chunks.push(chunk);
          } catch (err) {
            fail(err instanceof Error ? err : new Error('DOCX decompression failed'));
          }
        });
        stream.on('error', (err: Error) => fail(err));
        stream.on('end', () => {
          if (settled) return;
          settled = true;
          resolve();
        });
      });
    } catch (err) {
      if (err instanceof ResumeUploadError) throw err;
      throw new ResumeUploadError('Failed to parse DOCX. The Word archive is encrypted or malformed.');
    }

    if (actualUncompressedSize !== declaredUncompressedSize) {
      throw new ResumeUploadError('Failed to parse DOCX. The Word archive has invalid size metadata.');
    }
    if (entry.name === 'word/document.xml') documentXmlBytes = actualUncompressedSize;
    sanitizedArchive.file(entry.name, Buffer.concat(chunks, actualUncompressedSize));
  }

  if (!documentEntryFound || !contentTypesFound) {
    throw new ResumeUploadError('Failed to parse DOCX. The archive is not a valid Word document.');
  }
  if (
    totalUncompressedBytes >= DOCX_SAFETY_LIMITS.aggregateRatioCheckMinimumBytes &&
    totalUncompressedBytes / Math.max(1, totalCompressedBytes) >
      DOCX_SAFETY_LIMITS.aggregateCompressionRatio
  ) {
    throw new ResumeUploadError('Failed to parse DOCX. The Word archive has an unsafe compression ratio.');
  }

  let sanitizedBuffer: Buffer;
  try {
    sanitizedBuffer = await sanitizedArchive.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
  } catch {
    throw new ResumeUploadError('Failed to parse DOCX. The Word archive could not be processed safely.');
  }

  return {
    sanitizedBuffer,
    inspection: {
      entryCount: entries.length,
      totalCompressedBytes,
      totalUncompressedBytes,
      documentXmlBytes,
    },
  };
}

/**
 * Validate ZIP metadata and actual inflated bytes before any archive content reaches Mammoth.
 */
export async function inspectDocxArchive(buffer: Buffer): Promise<DocxArchiveInspection> {
  return (await prepareDocxArchive(buffer)).inspection;
}

export async function extractDocxText(buffer: Buffer): Promise<string> {
  try {
    const prepared = await prepareDocxArchive(buffer);
    const result = await mammoth.extractRawText({ buffer: prepared.sanitizedBuffer });
    const text = result.value.trim();
    if (!text) {
      throw new ResumeUploadError(
        'We could not read any text from that DOCX file. Export it from Word or Google Docs and try again.',
      );
    }
    return text;
  } catch (err) {
    if (err instanceof ResumeUploadError) throw err;
    throw new ResumeUploadError(
      'Failed to parse DOCX. Ensure the file is a valid Word document and try again.',
    );
  }
}
