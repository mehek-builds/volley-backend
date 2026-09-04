import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sanitizeControlCharactersInJsonStrings,
  unescapeDoubleEncodedHtml,
  jobPostingCandidatesFromHtml,
  jobPostingMatchesRequestedUrl,
  selectJobPostingForUrl,
  fetchJsonLdJobDescription,
  type JsonLdJobPostingCandidate,
} from './jsonLdJobDescription';
import { MAX_HTML_BYTES } from './jobSourceLogoVerification';
import { leadRequirementCandidates } from '../engine/leadAlignment';

// A fixed, always-public-looking DNS answer, exactly like jobSourceLogoVerification.test.ts's own
// `publicDns` - fetchJsonLdJobDescription now routes through that file's fetchPublic (2026-09-04
// review round 1, finding 1), which resolves and IP-checks a hostname before ever calling the
// injected fetch spy, so every test below that expects its spy to be reached must also supply this
// (or a test-specific resolver) or the real system DNS resolver would run in its place.
const publicDns = async () => ['93.184.216.34'];

/* Fixture below is a REAL, LIVE, PUBLIC Teamtailor posting - SendSafely's "Software Development
 * Internship" - fetched 2026-09-04 via plain `curl` (no auth, no application action) against:
 *   https://sendsafely.teamtailor.com/jobs/1593900-software-development-internship
 *
 * This is the exact URL measured live on trylitos.com's dashboard hitting the identical guard
 * sentence Recruitee's own posting hit ("Litos could not find a stated requirement on that page"),
 * which is what motivated generalizing recruiteeJobDescription.ts's approach in the first place.
 *
 * The fixture stores the FULL raw page HTML, byte for byte as fetched, with exactly one redaction:
 * the page's per-request Rails `csrf-token` meta value (session plumbing with zero bearing on the
 * posting, never read by this feature) is replaced with a fixed placeholder - see the fixture's own
 * `note` field for the exact wording. Nothing about the posting itself - title, description,
 * company, or the JobPosting JSON-LD block - is altered.
 *
 * That JSON-LD block is deliberately NOT normalized into a clean fixture object the way
 * recruiteeJobDescription.test.ts's JSON_LD_FIXTURE is: it is not valid JSON on its own (see
 * jsonLdJobDescription.ts's header - a raw, unescaped control character sits inside its
 * `description` string, and that string is itself HTML-escaped on top of the real HTML). Re-
 * serializing it through JSON.stringify to store a "clean" fixture object would erase the exact
 * defect this module's sanitizer exists to fix. Storing the full raw page and letting the SAME
 * regex this module uses in production find and extract the script block is what lets these tests
 * prove the sanitizer against real bytes, not a hand-typed approximation of them.
 */
const TEAMTAILOR_FIXTURE = JSON.parse(
  readFileSync('src/lib/fixtures/teamtailor-sendsafely-internship.json', 'utf8'),
) as { sourceUrl: string; fetchedAt: string; html: string };

function htmlWithJsonLd(jsonLd: unknown): string {
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body><div>rendered content, irrelevant to this path</div></body></html>`;
}

function htmlWithTwoJsonLdBlocks(first: unknown, second: unknown): string {
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(first)}</script><script type="application/ld+json">${JSON.stringify(second)}</script></head><body></body></html>`;
}

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

// A small, ordinary, well-formed JobPosting - Recruitee's own shape (raw HTML in `description`,
// a real `url`) - used wherever a test needs a clean second data point rather than the real,
// malformed-on-purpose Teamtailor fixture.
const SAMPLE_JOB_POSTING = {
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Backend Engineer',
  description: '<p>Build things.</p><ul><li>3+ years of experience with distributed systems</li><li>Comfortable with an on-call rotation</li></ul>',
  url: 'https://example.com/jobs/backend-engineer',
  hiringOrganization: { '@type': 'Organization', name: 'Example Co' },
};

describe('sanitizeControlCharactersInJsonStrings', () => {
  test('escapes a raw newline found inside a string literal', () => {
    const raw = '{"description":"line one\nline two"}';
    assert.throws(() => JSON.parse(raw), /control character/i);
    assert.deepEqual(JSON.parse(sanitizeControlCharactersInJsonStrings(raw)), { description: 'line one\nline two' });
  });

  test('leaves ordinary formatting whitespace between tokens untouched', () => {
    const raw = '{\n  "a": "b",\n  "c": "d"\n}';
    assert.equal(sanitizeControlCharactersInJsonStrings(raw), raw);
  });

  test('does not mistake an escaped quote inside a string for the string\'s end', () => {
    const raw = '{"description":"she said \\"hi\\"\nand left"}';
    const parsed = JSON.parse(sanitizeControlCharactersInJsonStrings(raw)) as { description: string };
    assert.equal(parsed.description, 'she said "hi"\nand left');
  });

  test('repairs the exact raw Teamtailor JSON-LD block (measured live) that native JSON.parse rejects', () => {
    const match = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i
      .exec(TEAMTAILOR_FIXTURE.html);
    assert.ok(match, 'expected a JSON-LD script block in the live fixture');
    // The unrepaired block is not valid JSON at all - confirms this fixture actually exercises the
    // defect, not just a hypothetical one.
    assert.throws(() => JSON.parse(match![1]), /control character/i);
    const parsed = JSON.parse(sanitizeControlCharactersInJsonStrings(match![1])) as Record<string, unknown>;
    assert.equal(parsed['@type'], 'JobPosting');
    assert.equal(parsed.title, 'Software Development Internship');
  });
});

describe('unescapeDoubleEncodedHtml', () => {
  test('leaves already-raw HTML untouched (Recruitee\'s own JSON-LD shape)', () => {
    assert.equal(
      unescapeDoubleEncodedHtml('<p>Hello <strong>world</strong></p>'),
      '<p>Hello <strong>world</strong></p>',
    );
  });

  test('decodes an HTML-escaped description into real HTML (Teamtailor\'s own shape, measured live)', () => {
    assert.equal(
      unescapeDoubleEncodedHtml('&lt;p&gt;Hello&lt;/p&gt;&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;/ul&gt;'),
      '<p>Hello</p><ul><li>One</li></ul>',
    );
  });

  test('leaves plain text with no markup at all untouched', () => {
    assert.equal(
      unescapeDoubleEncodedHtml('Just plain text, nothing HTML about it.'),
      'Just plain text, nothing HTML about it.',
    );
  });

  /* Review round 1, finding 2: the reviewer's teaching-prose case. This sentence merely MENTIONS
   * escaped tags mid-string - it is not a description that was itself HTML-escaped, and the earlier
   * unanchored pattern could not tell the two apart. Unescaping it would have turned "div" and "span"
   * into live tags that htmlToText's tag-stripping regexes then delete, corrupting a sentence that
   * was never markup at all - so the whole sentence, escaped entities included, must survive intact. */
  test('leaves teaching prose that merely mentions escaped tags untouched, rather than corrupting it (finding 2)', () => {
    const sentence = 'In HTML, &lt;div&gt; is a block container while &lt;span&gt; is inline.';
    assert.equal(unescapeDoubleEncodedHtml(sentence), sentence);
  });

  test('still decodes when the SAME kind of mention opens the description (starts with an escaped tag)', () => {
    // The one shape that must still decode: an escaped tag at the very start is the signal a
    // genuinely-escaped fragment gives (Teamtailor's own shape, tested above) - a leading tag mention
    // in otherwise-plain prose is indistinguishable from that at this function's altitude, and this
    // pins that this is a deliberate, narrow trade-off rather than an oversight.
    assert.equal(
      unescapeDoubleEncodedHtml('&lt;div&gt; is a block container.'),
      '<div> is a block container.',
    );
  });
});

describe('jobPostingCandidatesFromHtml', () => {
  test('detects the single JobPosting on the real, live Teamtailor page', () => {
    const candidates = jobPostingCandidatesFromHtml(TEAMTAILOR_FIXTURE.html);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, 'Software Development Internship');
    assert.equal(candidates[0].companyName, 'SendSafely');
    // Measured live: this page's JobPosting carries no `url` field at all - the whole reason
    // selectJobPostingForUrl cannot demand a url/identifier match for a single candidate.
    assert.equal(candidates[0].url, undefined);
    assert.equal(candidates[0].identifierValue, '1593900');
    assert.ok(
      candidates[0].description.includes('&lt;p&gt;'),
      'expected the raw HTML-escaped description text - unescapeDoubleEncodedHtml runs later, not here',
    );
  });

  test('detects a JobPosting from an ordinary, well-formed JSON-LD block', () => {
    const candidates = jobPostingCandidatesFromHtml(htmlWithJsonLd(SAMPLE_JOB_POSTING));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, 'Backend Engineer');
    assert.equal(candidates[0].url, 'https://example.com/jobs/backend-engineer');
  });

  test('flattens a top-level array of JSON-LD entities', () => {
    const html = htmlWithJsonLd([
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [] },
      SAMPLE_JOB_POSTING,
    ]);
    const candidates = jobPostingCandidatesFromHtml(html);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, 'Backend Engineer');
  });

  test('flattens an @graph wrapper', () => {
    const html = htmlWithJsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'Organization', name: 'Example Co' },
        SAMPLE_JOB_POSTING,
      ],
    });
    const candidates = jobPostingCandidatesFromHtml(html);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, 'Backend Engineer');
  });

  test('ignores a JSON-LD block whose @type is not JobPosting', () => {
    const html = htmlWithJsonLd({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Example Co' });
    assert.deepEqual(jobPostingCandidatesFromHtml(html), []);
  });

  test('skips a JobPosting with an empty description rather than returning an unusable candidate', () => {
    const html = htmlWithJsonLd({ ...SAMPLE_JOB_POSTING, description: '   ' });
    assert.deepEqual(jobPostingCandidatesFromHtml(html), []);
  });

  test('collects JobPostings declared in two separate <script> blocks on one page', () => {
    const other = { ...SAMPLE_JOB_POSTING, title: 'Frontend Engineer', url: 'https://example.com/jobs/frontend-engineer' };
    const candidates = jobPostingCandidatesFromHtml(htmlWithTwoJsonLdBlocks(SAMPLE_JOB_POSTING, other));
    assert.deepEqual(candidates.map((c) => c.title).sort(), ['Backend Engineer', 'Frontend Engineer']);
  });

  test('a malformed block does not stop scanning the rest of the page', () => {
    const html = `<!doctype html><html><head>`
      + `<script type="application/ld+json">{not json at all</script>`
      + `<script type="application/ld+json">${JSON.stringify(SAMPLE_JOB_POSTING)}</script>`
      + `</head><body></body></html>`;
    const candidates = jobPostingCandidatesFromHtml(html);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, 'Backend Engineer');
  });

  test('returns an empty list for a page with no JSON-LD at all', () => {
    assert.deepEqual(jobPostingCandidatesFromHtml('<!doctype html><html><body>nothing here</body></html>'), []);
  });

  /* Review round 1, finding 4, case 1: a charset (or any other) parameter on the type attribute.
   * The old exact-string match (["']application\/ld\+json["']) demanded the attribute value end
   * right after "json", so this page's block was previously read as carrying no JSON-LD at all. */
  test('finds a JSON-LD block whose type attribute carries a charset parameter', () => {
    const html = `<!doctype html><html><head><script type="application/ld+json; charset=utf-8">${JSON.stringify(SAMPLE_JOB_POSTING)}</script></head><body></body></html>`;
    const candidates = jobPostingCandidatesFromHtml(html);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, 'Backend Engineer');
  });

  /* Review round 1, finding 4, case 2: a literal `</script` sequence embedded inside the block's own
   * JSON string content (here, inside `description`, which legitimately carries the posting's own
   * HTML and can quote or discuss a <script> tag - note this is the RAW, unescaped byte sequence, not
   * the HTML-escaped "&lt;/script&gt;", which would never confuse a byte-level regex scan in the
   * first place). The old non-greedy capture stopped at this FIRST `</script`, truncating the block
   * before its real end - the truncated prefix is not valid JSON, so a real posting was read as
   * carrying no JobPosting at all. The fix scans every SUBSEQUENT `</script` occurrence as a
   * candidate end position until one actually parses. */
  test('does not truncate a JSON-LD block at a </script sequence embedded inside its own JSON string (finding 4)', () => {
    const postingWithEmbeddedScriptMention = {
      ...SAMPLE_JOB_POSTING,
      description: '<p>Build things.</p><p>Watch out for a stray </script> tag left in old templates.</p>'
        + '<ul><li>3+ years of experience with distributed systems</li></ul>',
    };
    const html = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(postingWithEmbeddedScriptMention)}</script></head><body></body></html>`;
    // Confirms the fixture actually exercises the defect: the OLD non-greedy capture
    // (`[\s\S]*?<\/script>`) would have stopped at the embedded `</script>` above, well short of the
    // block's real closing tag, and that truncated prefix is not valid JSON on its own.
    const naiveMatch = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    assert.ok(naiveMatch, 'expected the naive pattern to find an (incorrectly truncated) match');
    assert.throws(() => JSON.parse(naiveMatch![1]), 'the truncated prefix must not itself be valid JSON');
    const candidates = jobPostingCandidatesFromHtml(html);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, 'Backend Engineer');
    assert.ok(candidates[0].description.includes('stray </script> tag'));
  });
});

describe('jobPostingMatchesRequestedUrl', () => {
  const candidateWithUrl: JsonLdJobPostingCandidate = { description: 'x', url: 'https://example.com/jobs/backend-engineer' };
  const candidateWithIdentifier: JsonLdJobPostingCandidate = { description: 'x', identifierValue: '1593900' };

  test('matches on url, ignoring a trailing slash', () => {
    assert.equal(jobPostingMatchesRequestedUrl(candidateWithUrl, 'https://example.com/jobs/backend-engineer/'), true);
  });

  test('matches on url, ignoring query and hash (the same tracking-state tolerance this route applies elsewhere)', () => {
    assert.equal(
      jobPostingMatchesRequestedUrl(candidateWithUrl, 'https://example.com/jobs/backend-engineer?utm_source=li#apply'),
      true,
    );
  });

  test('does not match a different path on the same host', () => {
    assert.equal(jobPostingMatchesRequestedUrl(candidateWithUrl, 'https://example.com/jobs/frontend-engineer'), false);
  });

  test('does not match the same path on a different host', () => {
    assert.equal(jobPostingMatchesRequestedUrl(candidateWithUrl, 'https://other.example.com/jobs/backend-engineer'), false);
  });

  test('matches on identifierValue appearing in the requested path (Teamtailor\'s own shape, measured live)', () => {
    assert.equal(
      jobPostingMatchesRequestedUrl(
        candidateWithIdentifier,
        'https://sendsafely.teamtailor.com/jobs/1593900-software-development-internship',
      ),
      true,
    );
  });

  test('never trusts an identifier shorter than 3 characters on its own', () => {
    const shortId: JsonLdJobPostingCandidate = { description: 'x', identifierValue: '42' };
    assert.equal(jobPostingMatchesRequestedUrl(shortId, 'https://example.com/jobs/42-anything'), false);
  });

  test('returns false, not a throw, for an unparseable requested URL', () => {
    assert.equal(jobPostingMatchesRequestedUrl(candidateWithUrl, 'not a url'), false);
  });
});

describe('selectJobPostingForUrl (multiple JobPostings on one page)', () => {
  test('a single candidate is returned unconditionally - required for a real page like Teamtailor\'s with no url field to check', () => {
    const onlyCandidate: JsonLdJobPostingCandidate = { description: 'x', title: 'Whatever' };
    assert.equal(selectJobPostingForUrl([onlyCandidate], 'https://example.com/jobs/anything'), onlyCandidate);
  });

  test('multiple candidates: picks the one whose url matches the requested URL', () => {
    const backend: JsonLdJobPostingCandidate = { description: 'x', title: 'Backend', url: 'https://example.com/jobs/backend' };
    const frontend: JsonLdJobPostingCandidate = { description: 'x', title: 'Frontend', url: 'https://example.com/jobs/frontend' };
    assert.equal(selectJobPostingForUrl([backend, frontend], 'https://example.com/jobs/frontend'), frontend);
  });

  test('multiple candidates, none matching the requested URL: refuses rather than guessing', () => {
    const backend: JsonLdJobPostingCandidate = { description: 'x', title: 'Backend', url: 'https://example.com/jobs/backend' };
    const frontend: JsonLdJobPostingCandidate = { description: 'x', title: 'Frontend', url: 'https://example.com/jobs/frontend' };
    assert.equal(selectJobPostingForUrl([backend, frontend], 'https://example.com/jobs/something-else'), undefined);
  });

  test('an empty candidate list is a refusal', () => {
    assert.equal(selectJobPostingForUrl([], 'https://example.com/jobs/anything'), undefined);
  });
});

describe('fetchJsonLdJobDescription', () => {
  test('returns undefined without fetching anything for a non-https URL', async () => {
    const fetchImpl = mock.fn(async () => { throw new Error('should not be called'); });
    const result = await fetchJsonLdJobDescription('http://example.com/jobs/1', fetchImpl as unknown as typeof fetch);
    assert.equal(result, undefined);
    assert.equal(fetchImpl.mock.callCount(), 0);
  });

  test('returns undefined rather than throwing on an unparseable URL', async () => {
    const fetchImpl = mock.fn(async () => { throw new Error('should not be called'); });
    const result = await fetchJsonLdJobDescription('not a url', fetchImpl as unknown as typeof fetch);
    assert.equal(result, undefined);
    assert.equal(fetchImpl.mock.callCount(), 0);
  });

  test('returns undefined when the fetch itself fails', async () => {
    const fetchImpl = mock.fn(async () => { throw new Error('network error'); });
    const result = await fetchJsonLdJobDescription('https://acme.teamtailor.com/jobs/1', fetchImpl as unknown as typeof fetch, publicDns);
    assert.equal(result, undefined);
  });

  test('returns undefined on a non-2xx response', async () => {
    const fetchImpl = mock.fn(async () => new Response('not found', { status: 404 }));
    const result = await fetchJsonLdJobDescription('https://acme.teamtailor.com/jobs/1', fetchImpl as unknown as typeof fetch, publicDns);
    assert.equal(result, undefined);
  });

  test('returns undefined when the page has no JSON-LD at all', async () => {
    const fetchImpl = mock.fn(async () => htmlResponse('<!doctype html><html><body>nothing here</body></html>'));
    const result = await fetchJsonLdJobDescription('https://acme.teamtailor.com/jobs/1', fetchImpl as unknown as typeof fetch, publicDns);
    assert.equal(result, undefined);
  });

  test('reads the real, live SendSafely Teamtailor posting end to end, and its jdText clears the real leadRequirementCandidates guard', async () => {
    const fetchImpl = mock.fn(async (input: string | URL) => {
      assert.equal(input.toString(), TEAMTAILOR_FIXTURE.sourceUrl);
      return htmlResponse(TEAMTAILOR_FIXTURE.html);
    });
    const result = await fetchJsonLdJobDescription(TEAMTAILOR_FIXTURE.sourceUrl, fetchImpl as unknown as typeof fetch, publicDns);
    assert.ok(result, 'expected a structured result from the real Teamtailor posting');
    assert.equal(result!.pageTitle, 'Software Development Internship');
    assert.equal(result!.companyName, 'SendSafely');
    // The double-HTML-escaping must have been undone: real prose, not literal "&lt;p&gt;".
    assert.ok(!result!.jdText.includes('&lt;'), 'expected decoded text, not escaped entities');
    assert.ok(result!.jdText.includes('Working towards a Computer Science degree'));
    const asks = leadRequirementCandidates(result!.jdText);
    assert.ok(asks.length > 0, 'expected the real guard to accept the converted SendSafely description');
    assert.ok(asks.some((ask) => /Java|Javascript/i.test(ask)));
    // Exactly one fetch: this step never re-requests the page once it has read it.
    assert.equal(fetchImpl.mock.callCount(), 1);
  });

  test('reads an array-shaped JSON-LD page end to end', async () => {
    const html = htmlWithJsonLd([
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [] },
      SAMPLE_JOB_POSTING,
    ]);
    const fetchImpl = mock.fn(async () => htmlResponse(html));
    const result = await fetchJsonLdJobDescription('https://acme.teamtailor.com/jobs/backend-engineer', fetchImpl as unknown as typeof fetch, publicDns);
    assert.ok(result);
    assert.equal(result!.pageTitle, 'Backend Engineer');
    assert.ok(leadRequirementCandidates(result!.jdText).length > 0);
  });

  test('reads an @graph-wrapped JSON-LD page end to end', async () => {
    const html = htmlWithJsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'Organization', name: 'Example Co' },
        SAMPLE_JOB_POSTING,
      ],
    });
    const fetchImpl = mock.fn(async () => htmlResponse(html));
    const result = await fetchJsonLdJobDescription('https://acme.teamtailor.com/jobs/backend-engineer', fetchImpl as unknown as typeof fetch, publicDns);
    assert.ok(result);
    assert.equal(result!.companyName, 'Example Co');
  });

  test('refuses an ambiguous page with two JobPostings, neither matching the requested URL', async () => {
    const backend = { ...SAMPLE_JOB_POSTING, url: 'https://acme.teamtailor.com/jobs/backend-engineer' };
    const other = { ...SAMPLE_JOB_POSTING, title: 'Frontend Engineer', url: 'https://acme.teamtailor.com/jobs/frontend-engineer' };
    const html = htmlWithTwoJsonLdBlocks(backend, other);
    const fetchImpl = mock.fn(async () => htmlResponse(html));
    const result = await fetchJsonLdJobDescription('https://acme.teamtailor.com/jobs/something-else-entirely', fetchImpl as unknown as typeof fetch, publicDns);
    assert.equal(result, undefined);
  });

  test('picks the correct one of two JobPostings by url match rather than refusing outright', async () => {
    const backend = { ...SAMPLE_JOB_POSTING, url: 'https://acme.teamtailor.com/jobs/backend-engineer' };
    const other = {
      ...SAMPLE_JOB_POSTING,
      title: 'Frontend Engineer',
      url: 'https://acme.teamtailor.com/jobs/frontend-engineer',
      description: '<p>Frontend work.</p><ul><li>2+ years of React experience</li></ul>',
    };
    const html = htmlWithTwoJsonLdBlocks(backend, other);
    const fetchImpl = mock.fn(async () => htmlResponse(html));
    const result = await fetchJsonLdJobDescription('https://acme.teamtailor.com/jobs/frontend-engineer', fetchImpl as unknown as typeof fetch, publicDns);
    assert.ok(result);
    assert.equal(result!.pageTitle, 'Frontend Engineer');
  });

  /* SSRF (2026-09-04 review round 1, finding 1). Before this fix, this function fetched ANY
   * `https://` URL a caller pasted straight through the global `fetch`, following redirects and
   * reading an unbounded body. A spy fetch proved it would attempt every one of the four requests
   * below, unblocked. */
  describe('SSRF hardening', () => {
    const SPY_PROBE_URLS = [
      'https://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1:6379/',
      'https://localhost:9200/',
      'https://payroll.internal/jobs/1',
    ];

    for (const probeUrl of SPY_PROBE_URLS) {
      test(`never attempts the fetch for ${probeUrl} (measured live as a reachable SSRF target before this fix)`, async () => {
        const fetchImpl = mock.fn(async () => { throw new Error('should not be called'); });
        const result = await fetchJsonLdJobDescription(probeUrl, fetchImpl as unknown as typeof fetch, publicDns);
        assert.equal(result, undefined);
        assert.equal(fetchImpl.mock.callCount(), 0);
      });
    }

    test('refuses a host outside the hosted-ATS allowlist without fetching anything, keeping the managed-browser path for it', async () => {
      const fetchImpl = mock.fn(async () => { throw new Error('should not be called'); });
      const result = await fetchJsonLdJobDescription('https://careers.example.com/jobs/backend-engineer', fetchImpl as unknown as typeof fetch, publicDns);
      assert.equal(result, undefined);
      assert.equal(fetchImpl.mock.callCount(), 0);
    });

    test('fetches an allowlisted hosted-ATS host', async () => {
      const fetchImpl = mock.fn(async () => htmlResponse(htmlWithJsonLd(SAMPLE_JOB_POSTING)));
      const result = await fetchJsonLdJobDescription('https://acme.teamtailor.com/jobs/backend-engineer', fetchImpl as unknown as typeof fetch, publicDns);
      assert.ok(result, 'an allowlisted host must still be read');
      assert.equal(fetchImpl.mock.callCount(), 1);
    });

    test('refuses a redirect from an allowed host to a blocked host, without ever fetching the redirect target', async () => {
      const fetchImpl = mock.fn(async (input: string | URL) => {
        const url = input.toString();
        if (url === 'https://acme.teamtailor.com/jobs/1') {
          return new Response(null, { status: 302, headers: { location: 'https://internal/metadata' } });
        }
        throw new Error(`should not be reached: ${url}`);
      });
      const result = await fetchJsonLdJobDescription('https://acme.teamtailor.com/jobs/1', fetchImpl as unknown as typeof fetch, publicDns);
      assert.equal(result, undefined);
      // Only the first, allowed hop was ever attempted.
      assert.equal(fetchImpl.mock.callCount(), 1);
    });

    test('refuses an oversize response body rather than buffering it in full', async () => {
      const fetchImpl = mock.fn(async () => new Response('x'.repeat(MAX_HTML_BYTES + 1), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }));
      const result = await fetchJsonLdJobDescription('https://acme.teamtailor.com/jobs/1', fetchImpl as unknown as typeof fetch, publicDns);
      assert.equal(result, undefined);
    });

    test('refuses a non-HTML response rather than scanning arbitrary bytes for a script tag', async () => {
      const fetchImpl = mock.fn(async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      const result = await fetchJsonLdJobDescription('https://acme.teamtailor.com/jobs/1', fetchImpl as unknown as typeof fetch, publicDns);
      assert.equal(result, undefined);
    });
  });
});
