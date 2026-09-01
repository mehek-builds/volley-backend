/* What counts as a servable logo asset, for the coverage check.
 *
 * Split out of check-logo-coverage.mjs the same way logoCoverage.ts was: the script decides how
 * to PROBE, this decides what an answer MEANS, and the meaning is pinned by tests because it is
 * where a wrong call silently moves the verdict.
 *
 * The standard is "what the website's tile can actually render", copied from the logo route in
 * role-quick-website (lib/company-logo-source.ts): a real image content type or recognisable
 * magic bytes, and for an .ico specifically, an embedded PNG. Half of the .ico files in the wild
 * hold raw DIB bitmaps; the route cannot decode those in a request and deliberately drops them,
 * so an evidence URL serving one is a posting that renders a monogram, and this check must say
 * so rather than counting the bytes as a logo. Gensyn's favicon.ico was the live example on
 * 2026-09-01: verified evidence, real bytes, no PNG inside, monogram on the board.
 */

export type EvidenceSource = {
  company_name?: unknown;
  career_url?: unknown;
  company_logo_url?: unknown;
  logo_verification_status?: unknown;
  rows?: unknown;
};

/** Does this .ico container hold an embedded PNG the tile could be handed? */
export function icoContainsPng(buf: Uint8Array): boolean {
  if (buf.length < 6) return false;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) return false;
  const count = view.getUint16(4, true);
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    if (entry + 16 > buf.length) break;
    const size = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    if (offset + size > buf.length) continue;
    const data = buf.subarray(offset, offset + size);
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return true;
  }
  return false;
}

/**
 * The image type this asset would render as, or null when it would not render.
 *
 * The content type is a claim and the bytes are the fact: bot-blocked hosts serve HTML error
 * pages with 200 and image-shaped URLs, and Lever's S3 serves real PNGs as
 * application/octet-stream, so both directions of trusting the header alone are wrong.
 */
export function servableImageType(contentType: string | null, bytes: Uint8Array): string | null {
  const claimed = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const isIcoShaped = bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01
    && bytes[3] === 0x00;
  if (claimed === 'image/x-icon' || claimed === 'image/vnd.microsoft.icon' || isIcoShaped) {
    return icoContainsPng(bytes) ? 'image/png' : null;
  }
  if (claimed.startsWith('image/')) {
    if (claimed.includes('svg')) return 'image/svg+xml';
    return claimed;
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  const head = new TextDecoder().decode(bytes.subarray(0, 300)).trim().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml') && head.includes('<svg')) return 'image/svg+xml';
  return null;
}

/**
 * Why this source cannot be counted from its evidence alone, or null when it can be probed.
 *
 * A missing or unverified evidence row is not the same failure as a dead asset: the backend
 * gates surfacing on the verifier, so a surfaced source without verified evidence means the GATE
 * broke, and the check reports that class by name instead of burying it among fetch failures.
 */
export function evidenceDefect(source: EvidenceSource): string | null {
  if (source.logo_verification_status !== 'verified') {
    return `verification status is ${JSON.stringify(source.logo_verification_status ?? null)}`;
  }
  const url = source.company_logo_url;
  if (typeof url !== 'string' || !url.trim()) return 'no evidence URL';
  try {
    if (new URL(url).protocol !== 'https:') return 'evidence URL is not https';
  } catch {
    return 'evidence URL is unparseable';
  }
  return null;
}
