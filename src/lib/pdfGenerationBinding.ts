import { createHash } from 'node:crypto';
import { normalizeSpec } from '../llm/resumeSpec';
import { packetAuditSha256 } from './packetAudit';

export type PdfGenerationBinding = {
  version: 'generated_pdf_v1';
  objectKey: string;
  specSha256: string;
  resumeContactEmailSha256: string;
  pdfSha256: string;
  sizeBytes: number;
};

export function createPdfGenerationBinding(
  spec: unknown,
  objectKey: string,
  pdfBytes: Uint8Array,
  resumeContactEmail: string,
): PdfGenerationBinding {
  return {
    version: 'generated_pdf_v1',
    objectKey,
    specSha256: packetAuditSha256(normalizeSpec(spec)),
    resumeContactEmailSha256: packetAuditSha256(resumeContactEmail.trim().toLowerCase()),
    pdfSha256: createHash('sha256').update(pdfBytes).digest('hex'),
    sizeBytes: pdfBytes.byteLength,
  };
}

/**
 * What the binding records about the FILE, and only when it records it for this exact key.
 *
 * This is the row's own answer to "which bytes belong at this object key", so it is what a cached
 * copy of those bytes is proven against. Read defensively rather than cast: a binding written by an
 * older shape, or for a key the row has since moved off, yields null and the caller does without a
 * cache rather than trusting a record it cannot check.
 *
 * It deliberately does NOT compare the spec or email digests. Those are facts about the row, not
 * about the file, and pdfGenerationBindingIsCurrent still checks all six on the bytes that are
 * actually used. Widening this to the whole binding would make a spec edit look like a different
 * FILE, which would drop a cache entry that is still exactly right.
 */
export function bindingPdfIdentity(
  candidate: unknown,
  objectKey: string,
): { sha256: string; sizeBytes: number } | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const binding = candidate as Partial<PdfGenerationBinding>;
  if (binding.version !== 'generated_pdf_v1') return null;
  if (!objectKey || binding.objectKey !== objectKey) return null;
  if (typeof binding.pdfSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.pdfSha256)) return null;
  if (typeof binding.sizeBytes !== 'number' || !Number.isInteger(binding.sizeBytes) || binding.sizeBytes <= 0) {
    return null;
  }
  return { sha256: binding.pdfSha256, sizeBytes: binding.sizeBytes };
}

export function pdfGenerationBindingIsCurrent(
  candidate: unknown,
  spec: unknown,
  objectKey: string,
  pdfBytes: Uint8Array,
  resumeContactEmail: string,
): boolean {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const binding = candidate as Partial<PdfGenerationBinding>;
  const expected = createPdfGenerationBinding(spec, objectKey, pdfBytes, resumeContactEmail);
  return binding.version === expected.version
    && binding.objectKey === expected.objectKey
    && binding.specSha256 === expected.specSha256
    && binding.resumeContactEmailSha256 === expected.resumeContactEmailSha256
    && binding.pdfSha256 === expected.pdfSha256
    && binding.sizeBytes === expected.sizeBytes;
}
