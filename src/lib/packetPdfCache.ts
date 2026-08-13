import { createHash } from 'node:crypto';

/**
 * The stored packet PDF, held in process for a short window so that a dashboard polling the packet
 * audit does not re-download the same immutable file every 2.5 seconds.
 *
 * WHAT MAKES THIS SAFE, AND WHY IT IS NOT "TRUST THE KEY". The file behind a resume_object_key is
 * immutable by construction: every path that writes one mints a fresh key
 * (`...-restored-<uuid>.pdf` in packetResumeRestore, `...-edited-<uuid>.pdf` in the resume edit,
 * `<jdHash>-<epoch>.pdf` on generation) and @vercel/blob's put() appends its own random suffix on
 * top, with the pathname it ACTUALLY assigned being what the row stores. So a key is written once
 * and never rewritten. That is a strong property, but it is a property of four call sites that a
 * fifth could break silently, so the cache does not rest on it.
 *
 * Instead every entry is PROVEN against the row's own record of the file. The generation binding on
 * the row carries the sha256 and byte length of the exact PDF that was rendered for it
 * (pdfGenerationBinding, re-issued by a restore against the rebuilt file), so:
 *   - nothing is STORED unless its bytes hash to what the row records, and
 *   - nothing is SERVED unless the row asking for it records the same digest and length.
 * A row whose record moved therefore misses, and the mismatching entry is dropped rather than
 * handed out: the request re-fetches and answers off the real file rather than failing on the
 * cache's account. Identity is (object key, recorded sha256, recorded byte length), which covers
 * both a new key and a rewritten file at an old one.
 *
 * The bytes are copied in on store and copied out on read, so a caller that mutates the buffer it
 * was handed cannot corrupt the entry behind it, and a later reader cannot see a half-written one.
 * 31.7 KB is the measured average stored packet, so the copy is a memcpy against a network fetch.
 *
 * This is a per-instance cache on Vercel serverless. It will be cold often and that is fine: the
 * win is entirely within one warm instance's poll loop, and a cold instance behaves exactly as the
 * uncached code did. No external cache, deliberately - a shared one would need its own invalidation
 * story and would put a network round trip back in the path this exists to remove.
 */

export type LoadedPdf = { bytes: Buffer; contentType?: string };

/**
 * What the ROW records about the file at this key. Both fields are compared, so a collision would
 * have to match a sha256 and a length at once.
 */
export type StoredPdfIdentity = { sha256: string; sizeBytes: number };

/**
 * One minute. The upper bound on how long a deleted or replaced file could still be answered from
 * memory, which is why it is short rather than as long as the immutability argument would allow:
 * the 30-day retention sweep can remove a blob at any moment, and a shorter window bounds how late
 * the expired-packet restore notices. At the measured 2.5 second dashboard poll it still collapses
 * 1,440 fetches an hour per open packet to 60.
 *
 * The TTL is ABSOLUTE, measured from the fetch, and a hit does not extend it. A packet somebody
 * leaves open all afternoon therefore re-reads the real file once a minute instead of pinning a
 * copy of it forever.
 */
const ENTRY_TTL_MS = 60_000;

/**
 * At 31.7 KB average this caps the cache near 760 KB on an instance, which is nothing against a
 * Vercel function's memory and small enough that a long-lived instance cannot grow without limit.
 * Eviction is oldest-stored-first, which is also least-recently-fetched here because entries are
 * never refreshed in place.
 */
const MAX_ENTRIES = 24;

type CacheEntry = {
  bytes: Buffer;
  contentType?: string;
  sha256: string;
  sizeBytes: number;
  storedAt: number;
};

const entries = new Map<string, CacheEntry>();

/** For tests that need a cold instance. Never called by production code. */
export function clearPacketPdfCache(): void {
  entries.clear();
}

/** For tests that assert the cache stays bounded. */
export function packetPdfCacheSize(): number {
  return entries.size;
}

function prune(now: number): void {
  for (const [key, entry] of entries) {
    if (now - entry.storedAt >= ENTRY_TTL_MS) entries.delete(key);
  }
  while (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/**
 * Load the stored packet PDF for one object key, through the process cache.
 *
 * `identity` is what the row records about this file, or null when the row records nothing usable.
 * Null bypasses the cache in both directions: such a packet cannot pass hasCurrentGenerationBinding
 * anyway, so there is nothing to gain and nothing would be proven by keeping its bytes.
 *
 * `load` is the caller's own loader, so an injected one is cached on exactly the terms a real fetch
 * is. Anything it throws propagates untouched and nothing is stored.
 */
export async function loadPacketPdf(input: {
  objectKey: string;
  identity: StoredPdfIdentity | null;
  load: (objectKey: string) => Promise<LoadedPdf>;
  now?: () => number;
}): Promise<LoadedPdf> {
  const now = (input.now ?? Date.now)();
  const identity = input.identity;
  if (identity) {
    const hit = entries.get(input.objectKey);
    if (hit) {
      if (now - hit.storedAt < ENTRY_TTL_MS
        && hit.sha256 === identity.sha256
        && hit.sizeBytes === identity.sizeBytes) {
        return { bytes: Buffer.from(hit.bytes), contentType: hit.contentType };
      }
      /* Expired, or the row now records a different file under this key. Either way the entry is
         dropped and the request goes to the real file, rather than the request failing because of
         something this cache is holding. */
      entries.delete(input.objectKey);
    }
  }
  const loaded = await input.load(input.objectKey);
  if (identity
    && loaded.bytes.byteLength === identity.sizeBytes
    && createHash('sha256').update(loaded.bytes).digest('hex') === identity.sha256) {
    prune(now);
    entries.set(input.objectKey, {
      bytes: Buffer.from(loaded.bytes),
      contentType: loaded.contentType,
      sha256: identity.sha256,
      sizeBytes: identity.sizeBytes,
      storedAt: now,
    });
  }
  return loaded;
}
