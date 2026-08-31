import { createHash } from 'node:crypto';

export const CANONICAL_FREE_DOCUMENT_BINDING_PREFIX = 'canonical-free-document-v1:';
export const CANONICAL_FREE_BASE_RESUME_BINDING_PREFIX =
  `${CANONICAL_FREE_DOCUMENT_BINDING_PREFIX}base_resume:`;
export const CANONICAL_FREE_NONE_BINDING = `${CANONICAL_FREE_DOCUMENT_BINDING_PREFIX}none`;

export type CanonicalFreeVersionedDocumentMode = 'artifact' | 'base_resume';

export type CanonicalFreeVersionedDocumentIdentity = {
  artifactId: string;
  versionId: string;
  versionNumber: number;
  contentHash: string;
  objectKey: string;
  blobUrl: string | null;
  attachedAt: string;
  pdfSha256: string | null;
};

export function canonicalFreeBaseResumeSourceHash(input: {
  baseResume: unknown;
  parsedProfile: unknown;
  contact: unknown;
}): string {
  return createHash('sha256').update(JSON.stringify([
    input.baseResume,
    input.parsedProfile,
    input.contact,
  ])).digest('hex');
}

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const VERSIONED_BINDING = new RegExp(
  `^${CANONICAL_FREE_DOCUMENT_BINDING_PREFIX}(artifact|base_resume):(${UUID_PATTERN}):([1-9][0-9]*):([a-f0-9]{64})$`,
  'i',
);

export function parseCanonicalFreeVersionedDocumentBinding(binding: string | null | undefined): {
  mode: CanonicalFreeVersionedDocumentMode;
  artifactId: string;
  versionNumber: number;
} | null {
  const match = binding?.match(VERSIONED_BINDING);
  if (!match) return null;
  return {
    mode: match[1]!.toLowerCase() as CanonicalFreeVersionedDocumentMode,
    artifactId: match[2]!.toLowerCase(),
    versionNumber: Number(match[3]),
  };
}

export function buildCanonicalFreeVersionedDocumentBinding(
  mode: CanonicalFreeVersionedDocumentMode,
  input: CanonicalFreeVersionedDocumentIdentity,
): string {
  const digest = createHash('sha256').update(JSON.stringify([
    input.artifactId,
    input.versionId,
    input.versionNumber,
    input.contentHash,
    input.objectKey,
    input.blobUrl,
    input.attachedAt,
    input.pdfSha256,
  ])).digest('hex');
  return `${CANONICAL_FREE_DOCUMENT_BINDING_PREFIX}${mode}:${input.artifactId}:${input.versionNumber}:${digest}`;
}
