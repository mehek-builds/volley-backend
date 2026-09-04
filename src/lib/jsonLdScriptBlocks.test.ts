import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsedJsonLdScriptBlocks, MAX_OPEN_TAGS_PER_DOCUMENT } from './jsonLdScriptBlocks';
import { MAX_HTML_BYTES } from './jobSourceLogoVerification';

type JobPostingRecord = { title: string; description: string; [key: string]: unknown };

// A small, ordinary, well-formed JobPosting - the same shape jsonLdJobDescription.test.ts's own
// SAMPLE_JOB_POSTING uses - kept self-contained here rather than imported, since this file tests
// parsedJsonLdScriptBlocks directly rather than going through either reader.
const SAMPLE_JOB_POSTING = {
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Backend Engineer',
  description: '<p>Build things.</p><ul><li>3+ years of experience with distributed systems</li></ul>',
  url: 'https://example.com/jobs/backend-engineer',
  hiringOrganization: { '@type': 'Organization', name: 'Example Co' },
};

/* 2026-09-04 review round 2, THE finding: the round-1 "try every subsequent `</script` occurrence"
 * fallback is unbounded, and JSON.parse-ing (twice) an ever-growing slice at every one of them is
 * worse than quadratic. MEASURED against a single MAX_HTML_BYTES document built from one open tag
 * plus one unterminated JSON string of `</script>` repeats: 50 KB -> 2.9s, 100 KB -> 23s,
 * 200 KB -> 49.7s, synchronous - one request froze the whole Node process. The route this feeds
 * accepts a user-supplied URL, so a hostile page controls the input directly.
 *
 * Both tests below are run against the CURRENT (fixed) jsonLdScriptBlocks.ts. To prove the first one
 * actually exercises the old defect: `git show HEAD:src/lib/jsonLdScriptBlocks.ts` (the pre-round-2
 * head, 8deb8aba) in place of this file's sibling and re-running this one test hangs for tens of
 * seconds and fails the 500ms budget below; restoring the round-2 fix makes it pass in well under a
 * millisecond.
 */
describe('parsedJsonLdScriptBlocks - round 2 performance fix', () => {
  test('a MAX_HTML_BYTES document of one open tag plus an unterminated JSON string full of </script> repeats parses in under 500ms', () => {
    const openTag = '<script type="application/ld+json">';
    // Opens a JSON string ("description"'s value) that never closes - no further `"` appears
    // anywhere in the document, so every `</script>` below is walked through as ordinary in-string
    // content rather than ever being mistaken for the block's end.
    const prefix = `${openTag}{"description":"`;
    const repeat = '</script>';
    const filler = repeat.repeat(Math.ceil((MAX_HTML_BYTES - prefix.length) / repeat.length));
    const html = (prefix + filler).slice(0, MAX_HTML_BYTES);
    assert.equal(html.length, MAX_HTML_BYTES, 'test setup: the adversarial document must be the full MAX_HTML_BYTES size');

    const startedMs = performance.now();
    const result = parsedJsonLdScriptBlocks(html);
    const elapsedMs = performance.now() - startedMs;

    // The honest result: the one JSON string this document ever opens never closes before the
    // document ends, so there is genuinely no valid JSON-LD block to find here.
    assert.deepEqual(result, []);
    assert.ok(elapsedMs < 500, `expected under 500ms, took ${elapsedMs.toFixed(1)}ms`);
  });

  test('a 200 KB document with 500 well-formed tiny JSON-LD blocks parses under 500ms', () => {
    // ~330 bytes of ordinary page markup between each block plus the ~70-byte block itself puts the
    // whole document in the same size class (~200 KB) as the adversarial one above, so this proves
    // the fix is fast on a document that is large because it is BUSY, not just one that is large
    // because it is hostile.
    const padding = `<div class="filler">${'x'.repeat(300)}</div>`;
    const block = (n: number): string => `<script type="application/ld+json">{"@type":"Thing","n":${n}}</script>`;
    let html = '<!doctype html><html><head>';
    for (let i = 0; i < 500; i += 1) html += padding + block(i);
    html += '</head><body></body></html>';

    const startedMs = performance.now();
    const result = parsedJsonLdScriptBlocks(html);
    const elapsedMs = performance.now() - startedMs;

    // Every one of the 500 blocks is well-formed, so the count found is exactly the documented
    // per-document cap (see jsonLdScriptBlocks.ts's header) rather than something the fix silently
    // truncated part-way through for an unrelated reason.
    assert.equal(result.length, MAX_OPEN_TAGS_PER_DOCUMENT);
    assert.ok(elapsedMs < 500, `expected under 500ms, took ${elapsedMs.toFixed(1)}ms`);
  });
});

describe('parsedJsonLdScriptBlocks - a </script> sequence embedded in the block\'s own JSON string', () => {
  test('extracts a JobPosting intact when its description contains a raw </script> sequence', () => {
    const posting = {
      ...SAMPLE_JOB_POSTING,
      description: `${SAMPLE_JOB_POSTING.description}<p>Watch out for a stray </script> tag left in old templates.</p>`,
    };
    const html = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(posting)}</script></head><body></body></html>`;

    const [parsed] = parsedJsonLdScriptBlocks(html) as JobPostingRecord[];

    assert.ok(parsed);
    assert.equal(parsed.title, 'Backend Engineer');
    assert.ok(parsed.description.includes('stray </script> tag'));
  });

  test('extracts a JobPosting intact when its description contains a backslash-escaped <\\/script> sequence', () => {
    // Hand-built JSON text - not JSON.stringify, which never escapes '/' - so the raw bytes inside
    // the <script> block are the backslash-escaped form a security-conscious template might emit to
    // avoid ever writing the literal 8 bytes "</script" into markup it controls. JSON's own grammar
    // treats `\/` as a valid escape for `/`, so a correct JSON.parse of this decodes it straight back
    // to a literal `</script>` in the resulting string.
    const escapedMention = 'Watch out for a stray <\\/script> tag left in old templates.';
    const jsonText = `{"@context":"https://schema.org","@type":"JobPosting","title":"Backend Engineer",`
      + `"description":"${escapedMention}","url":"https://example.com/jobs/backend-engineer"}`;
    const html = `<!doctype html><html><head><script type="application/ld+json">${jsonText}</script></head><body></body></html>`;

    const [parsed] = parsedJsonLdScriptBlocks(html) as JobPostingRecord[];

    assert.ok(parsed);
    assert.equal(parsed.title, 'Backend Engineer');
    assert.ok(parsed.description.includes('stray </script> tag'), 'the backslash-escaped slash must decode to a literal </script>');
  });
});

/* Review round 1, finding 4, case 1 (see jsonLdScriptBlocks.ts's header) - re-asserted here directly
 * against parsedJsonLdScriptBlocks rather than through either caller, since round 1 landed its own
 * coverage of this in jsonLdJobDescription.test.ts and recruiteeJobDescription.test.ts before this
 * file existed (both kept, and re-run by this change - see the PR body). */
describe('parsedJsonLdScriptBlocks - charset-suffixed type attribute (round 1 regression)', () => {
  test('finds a JSON-LD block whose type attribute carries a charset parameter', () => {
    const html = `<!doctype html><html><head><script type="application/ld+json; charset=utf-8">${JSON.stringify(SAMPLE_JOB_POSTING)}</script></head><body></body></html>`;

    const [parsed] = parsedJsonLdScriptBlocks(html) as JobPostingRecord[];

    assert.ok(parsed);
    assert.equal(parsed.title, 'Backend Engineer');
  });
});
