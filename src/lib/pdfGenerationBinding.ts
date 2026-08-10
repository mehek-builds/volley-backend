import { createHash } from 'node:crypto';
import { normalizeSpec } from '../llm/resumeSpec';
import { packetAuditSha256 } from './packetAudit';

export type PdfGenerationBinding = {
  version: 'generated_pdf_v1';
  objectKey: string;
  specSha256: string;
  pdfSha256: string;
  sizeBytes: number;
};

export function createPdfGenerationBinding(
  spec: unknown,
  objectKey: string,
  pdfBytes: Uint8Array,
): PdfGenerationBinding {
  return {
    version: 'generated_pdf_v1',
    objectKey,
    specSha256: packetAuditSha256(normalizeSpec(spec)),
    pdfSha256: createHash('sha256').update(pdfBytes).digest('hex'),
    sizeBytes: pdfBytes.byteLength,
  };
}

export function pdfGenerationBindingIsCurrent(
  candidate: unknown,
  spec: unknown,
  objectKey: string,
  pdfBytes: Uint8Array,
): boolean {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const binding = candidate as Partial<PdfGenerationBinding>;
  const expected = createPdfGenerationBinding(spec, objectKey, pdfBytes);
  return binding.version === expected.version
    && binding.objectKey === expected.objectKey
    && binding.specSha256 === expected.specSha256
    && binding.pdfSha256 === expected.pdfSha256
    && binding.sizeBytes === expected.sizeBytes;
}
