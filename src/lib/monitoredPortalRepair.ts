import { createHash } from 'node:crypto';

const LEGACY_JOB_PREVIEW_CHARS = 600;

export function monitoredDescriptionHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function monitoredJdAgrees(
  expectedHash: string | null | undefined,
  reviewJd: string,
  canonicalDescription: string,
  canonicalHash = monitoredDescriptionHash(canonicalDescription),
): boolean {
  if (expectedHash && canonicalHash === expectedHash) return true;
  if (!expectedHash) return false;
  const legacyBoardPreview = canonicalDescription.slice(0, LEGACY_JOB_PREVIEW_CHARS);
  if (legacyBoardPreview.length === LEGACY_JOB_PREVIEW_CHARS && monitoredDescriptionHash(legacyBoardPreview) === expectedHash) return true;
  const legacyPreview = reviewJd.trim();
  return legacyPreview.length >= 200
    && legacyPreview.length < 2000
    && monitoredDescriptionHash(legacyPreview) === expectedHash
    && canonicalDescription.startsWith(legacyPreview);
}
