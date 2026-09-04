import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  recruiteeOfferUrlParts,
  recruiteeHtmlToText,
  fetchRecruiteeJobDescription,
} from './recruiteeJobDescription';
import { MAX_HTML_BYTES } from './jobSourceLogoVerification';
import { leadRequirementCandidates } from '../engine/leadAlignment';

// A fixed, always-public-looking DNS answer, exactly like jobSourceLogoVerification.test.ts's own
// `publicDns` - fetchRecruiteeJobDescription now routes through that file's fetchPublic (2026-09-04
// review round 1, finding 1), which resolves and IP-checks a hostname before ever calling the
// injected fetch spy, so every test below that expects its spy to be reached must also supply this.
const publicDns = async () => ['93.184.216.34'];

/* Fixtures below are a REAL, LIVE Recruitee posting - greenflux.recruitee.com's "Senior /
 * Principal Software Engineer" - fetched 2026-09-04 via:
 *   curl https://greenflux.recruitee.com/api/offers/senior-principal-software-engineer
 * and, for the JSON-LD fixture, the `<script type="application/ld+json">` block on
 *   curl https://greenflux.recruitee.com/o/senior-principal-software-engineer
 *
 * NOT the GPR posting the defect was measured against. gpr.recruitee.com now 301s, at both its
 * root and at /o/software-engineer-intern specifically, to Recruitee's own
 * https://recruitee.com/careers_not_hosted - confirmed live 2026-09-04 with plain curl (no bot
 * blocking involved: the redirect comes from Recruitee's own edge, `server: Cowboy`, not a
 * challenge page). That tenant's hosted career page is gone, independent of anything this fix
 * changes, so no real GPR offer JSON is obtainable to fixture. Greenflux is a live, public,
 * currently-open posting fetched read-only with no application action, substituted so these tests
 * exercise the real shape Recruitee serves rather than a hand-written approximation of it. */
const OFFER_API_FIXTURE = JSON.parse(
  readFileSync('src/lib/fixtures/recruitee-offer-greenflux.json', 'utf8'),
) as { offer: Record<string, unknown> };
const JSON_LD_FIXTURE = JSON.parse(
  readFileSync('src/lib/fixtures/recruitee-offer-greenflux-jsonld.json', 'utf8'),
) as Record<string, unknown>;

function htmlWithJsonLd(jsonLd: unknown): string {
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body><div>rendered content, irrelevant to this path</div></body></html>`;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

describe('recruiteeOfferUrlParts', () => {
  test('reads tenant and slug from the measured defect URL', () => {
    assert.deepEqual(
      recruiteeOfferUrlParts('https://gpr.recruitee.com/o/software-engineer-intern'),
      { tenant: 'gpr', slug: 'software-engineer-intern' },
    );
  });

  test('accepts a trailing slash', () => {
    assert.deepEqual(
      recruiteeOfferUrlParts('https://gpr.recruitee.com/o/software-engineer-intern/'),
      { tenant: 'gpr', slug: 'software-engineer-intern' },
    );
  });

  test('accepts the apply route as the same offer, matching jobDescriptionSourceUrl\'s own rewrite', () => {
    assert.deepEqual(
      recruiteeOfferUrlParts('https://dsiinnovations.recruitee.com/o/junior-automation-engineer/c/new?utm_source=x'),
      { tenant: 'dsiinnovations', slug: 'junior-automation-engineer' },
    );
  });

  test('rejects the vendor marketing, product, and API hosts', () => {
    for (const url of [
      'https://www.recruitee.com/o/software-engineer-intern',
      'https://app.recruitee.com/o/software-engineer-intern',
      'https://api.recruitee.com/o/software-engineer-intern',
    ]) {
      assert.equal(recruiteeOfferUrlParts(url), undefined, url);
    }
  });

  test('rejects a non-Recruitee host', () => {
    assert.equal(recruiteeOfferUrlParts('https://gpr.example.com/o/software-engineer-intern'), undefined);
    assert.equal(recruiteeOfferUrlParts('https://jobs.lever.co/o/software-engineer-intern'), undefined);
  });

  test('rejects a Recruitee host with a path that is not an offer', () => {
    // The tenant's own career-page index, as pinned in jobExtract.test.ts's jobDescriptionSourceUrl
    // suite ("leaves ... a stray path on those hosts untouched").
    assert.equal(recruiteeOfferUrlParts('https://acme.recruitee.com/careers'), undefined);
    assert.equal(recruiteeOfferUrlParts('https://gpr.recruitee.com/'), undefined);
  });

  test('rejects a plaintext URL', () => {
    assert.equal(recruiteeOfferUrlParts('http://gpr.recruitee.com/o/software-engineer-intern'), undefined);
  });

  test('rejects an unparseable URL rather than throwing', () => {
    assert.equal(recruiteeOfferUrlParts('not a url'), undefined);
  });
});

describe('recruiteeHtmlToText', () => {
  test('turns paragraph and list-item boundaries into their own lines', () => {
    const html = '<p>Intro paragraph.</p><ul><li>First requirement bullet</li><li>Second requirement bullet</li></ul>';
    const text = recruiteeHtmlToText(html);
    assert.deepEqual(text.split('\n'), [
      'Intro paragraph.',
      'First requirement bullet',
      'Second requirement bullet',
    ]);
  });

  test('does not depend on a <p> nested inside each <li> to separate bullets', () => {
    // Recruitee's own editor happens to nest <p> inside <li> (see the fixtures below), but nothing
    // guarantees that, and a bare <li> list is a completely ordinary shape for hand-written HTML.
    const html = '<ul><li>Bullet one, no inner paragraph tag</li><li>Bullet two, no inner paragraph tag</li></ul>';
    const text = recruiteeHtmlToText(html);
    assert.deepEqual(text.split('\n'), [
      'Bullet one, no inner paragraph tag',
      'Bullet two, no inner paragraph tag',
    ]);
  });

  test('converts <br> to a line break', () => {
    assert.equal(recruiteeHtmlToText('Line one<br>Line two<br/>Line three'), 'Line one\nLine two\nLine three');
  });

  test('decodes named and numeric entities', () => {
    assert.equal(recruiteeHtmlToText('<p>Cats &amp; Dogs &ndash; a caf&#233;</p>'), 'Cats & Dogs – a café');
  });

  test('normalizes a non-breaking space to a plain space', () => {
    assert.equal(recruiteeHtmlToText('<p>7+&nbsp;years</p>'), '7+ years');
  });

  test('strips inline formatting tags without losing their text', () => {
    assert.equal(
      recruiteeHtmlToText('<p>We use <strong>C#/.Net</strong> and <a href="http://vue.js">Vue.js</a>.</p>'),
      'We use C#/.Net and Vue.js .',
    );
  });

  test('drops empty lines produced by adjacent block boundaries', () => {
    assert.equal(recruiteeHtmlToText('<p>One</p><p></p><p>Two</p>'), 'One\nTwo');
  });

  test('converts the real fixture description into multi-line text', () => {
    const text = recruiteeHtmlToText(OFFER_API_FIXTURE.offer.description as string);
    assert.ok(text.split('\n').length > 3, 'expected multiple lines from a real multi-paragraph description');
    assert.ok(text.includes('GreenFlux'));
  });

  test('converts the real fixture requirements bullets into one line per bullet', () => {
    const text = recruiteeHtmlToText(OFFER_API_FIXTURE.offer.requirements as string);
    const lines = text.split('\n');
    assert.ok(lines.length >= 8, `expected at least 8 requirement lines, got ${lines.length}`);
    assert.ok(lines.some((line) => /7\+ years/.test(line)));
    // Each bullet landed on its own line rather than the whole list collapsing into one - that
    // collapse is exactly the shape leadRequirementCandidates's 300-character cap was written to
    // catch. (A trailing closing paragraph in this real fixture happens to run long on its own,
    // which is a normal paragraph the guard is correctly allowed to drop - not this collapse.)
    const underCap = lines.filter((line) => line.length < 300);
    assert.ok(underCap.length >= 8, `expected at least 8 lines under the 300-char cap, got ${underCap.length}`);
  });
});

describe('leadRequirementCandidates accepts the converted fixture (the guard this fix exists to satisfy)', () => {
  test('description + requirements, converted, yield real requirement candidates', () => {
    const jdText = [
      recruiteeHtmlToText(OFFER_API_FIXTURE.offer.description as string),
      recruiteeHtmlToText(OFFER_API_FIXTURE.offer.requirements as string),
    ].filter(Boolean).join('\n\n');
    const asks = leadRequirementCandidates(jdText);
    assert.ok(asks.length > 0, 'expected at least one accepted requirement candidate');
    assert.ok(asks.some((ask) => /years of experience/i.test(ask)));
  });

  test('the JSON-LD description alone also yields real requirement candidates', () => {
    const jdText = recruiteeHtmlToText(JSON_LD_FIXTURE.description as string);
    const asks = leadRequirementCandidates(jdText);
    assert.ok(asks.length > 0, 'expected at least one accepted requirement candidate from the JSON-LD path');
  });

  test('a naive extraction that loses block-element line breaks reproduces the measured 502 (documents the root cause)', () => {
    const naiveText = (JSON_LD_FIXTURE.description as string).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    assert.equal(leadRequirementCandidates(naiveText).length, 0);
  });
});

describe('fetchRecruiteeJobDescription', () => {
  test('returns undefined without fetching anything for a non-Recruitee URL', async () => {
    const fetchImpl = mock.fn(async () => { throw new Error('should not be called'); });
    const result = await fetchRecruiteeJobDescription('https://jobs.lever.co/acme/abc123', fetchImpl as unknown as typeof fetch);
    assert.equal(result, undefined);
    assert.equal(fetchImpl.mock.callCount(), 0);
  });

  test('prefers the JSON-LD JobPosting on the posting page when present', async () => {
    const fetchImpl = mock.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === 'https://greenflux.recruitee.com/o/senior-principal-software-engineer') {
        return htmlResponse(htmlWithJsonLd(JSON_LD_FIXTURE));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await fetchRecruiteeJobDescription(
      'https://greenflux.recruitee.com/o/senior-principal-software-engineer',
      fetchImpl as unknown as typeof fetch,
      publicDns,
    );
    assert.ok(result);
    assert.equal(result!.pageTitle, 'Senior / Principal Software Engineer');
    assert.equal(result!.companyName, 'GreenFlux');
    assert.ok(leadRequirementCandidates(result!.jdText).length > 0);
    // Only the posting page should have been fetched - the API fallback must not run when JSON-LD
    // already answered.
    assert.equal(fetchImpl.mock.callCount(), 1);
  });

  test('falls back to the public offers API when the page has no JSON-LD', async () => {
    const fetchImpl = mock.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === 'https://greenflux.recruitee.com/o/senior-principal-software-engineer') {
        return htmlResponse('<!doctype html><html><body>no structured data here</body></html>');
      }
      if (url === 'https://greenflux.recruitee.com/api/offers/senior-principal-software-engineer') {
        return jsonResponse(OFFER_API_FIXTURE);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await fetchRecruiteeJobDescription(
      'https://greenflux.recruitee.com/o/senior-principal-software-engineer',
      fetchImpl as unknown as typeof fetch,
      publicDns,
    );
    assert.ok(result);
    assert.equal(result!.pageTitle, 'Senior / Principal Software Engineer');
    assert.equal(result!.companyName, 'GreenFlux');
    assert.ok(leadRequirementCandidates(result!.jdText).length > 0);
    assert.equal(fetchImpl.mock.callCount(), 2);
  });

  test('falls back to the API when the posting page request itself fails', async () => {
    const fetchImpl = mock.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === 'https://greenflux.recruitee.com/o/senior-principal-software-engineer') {
        throw new Error('network error');
      }
      if (url === 'https://greenflux.recruitee.com/api/offers/senior-principal-software-engineer') {
        return jsonResponse(OFFER_API_FIXTURE);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await fetchRecruiteeJobDescription(
      'https://greenflux.recruitee.com/o/senior-principal-software-engineer',
      fetchImpl as unknown as typeof fetch,
      publicDns,
    );
    assert.ok(result);
    assert.ok(leadRequirementCandidates(result!.jdText).length > 0);
  });

  test('returns undefined when neither source is reachable (best-effort, matching findMonitoredJobDescription)', async () => {
    const fetchImpl = mock.fn(async () => new Response('not found', { status: 404 }));
    const result = await fetchRecruiteeJobDescription(
      'https://gpr.recruitee.com/o/software-engineer-intern',
      fetchImpl as unknown as typeof fetch,
      publicDns,
    );
    assert.equal(result, undefined);
  });

  test('reproduces the measured defect: gpr.recruitee.com currently 301s both sources to "not hosted"', async () => {
    // The exact live behavior confirmed 2026-09-04 (see the fixtures comment above): both the
    // posting page and the offers API now redirect this tenant away from any job content. A
    // fetch() that follows the redirect lands on Recruitee's generic explainer page, which has
    // neither a JobPosting JSON-LD block nor an {offer: ...} JSON body, so this resolves to
    // undefined and the caller falls through to the unchanged browser path - not a new failure.
    const notHostedHtml = '<!doctype html><html><body>This career page is no longer hosted here.</body></html>';
    const fetchImpl = mock.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === 'https://gpr.recruitee.com/o/software-engineer-intern') return htmlResponse(notHostedHtml);
      if (url === 'https://gpr.recruitee.com/api/offers/software-engineer-intern') {
        return new Response('not found', { status: 404 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await fetchRecruiteeJobDescription(
      'https://gpr.recruitee.com/o/software-engineer-intern',
      fetchImpl as unknown as typeof fetch,
      publicDns,
    );
    assert.equal(result, undefined);
  });

  test('returns undefined when the API payload has no offer', async () => {
    const fetchImpl = mock.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === 'https://greenflux.recruitee.com/o/senior-principal-software-engineer') {
        return htmlResponse('<!doctype html><html><body>no structured data here</body></html>');
      }
      if (url === 'https://greenflux.recruitee.com/api/offers/senior-principal-software-engineer') {
        return jsonResponse({ error: 'not found' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await fetchRecruiteeJobDescription(
      'https://greenflux.recruitee.com/o/senior-principal-software-engineer',
      fetchImpl as unknown as typeof fetch,
      publicDns,
    );
    assert.equal(result, undefined);
  });

  test('ignores a JSON-LD block whose @type is not JobPosting', async () => {
    const fetchImpl = mock.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === 'https://greenflux.recruitee.com/o/senior-principal-software-engineer') {
        return htmlResponse(htmlWithJsonLd({ '@context': 'https://schema.org', '@type': 'Organization', name: 'GreenFlux' }));
      }
      if (url === 'https://greenflux.recruitee.com/api/offers/senior-principal-software-engineer') {
        return jsonResponse(OFFER_API_FIXTURE);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await fetchRecruiteeJobDescription(
      'https://greenflux.recruitee.com/o/senior-principal-software-engineer',
      fetchImpl as unknown as typeof fetch,
      publicDns,
    );
    // Falls through to the API fixture rather than stopping on the non-JobPosting block.
    assert.ok(result);
    assert.equal(result!.companyName, 'GreenFlux');
  });

  /* SSRF (2026-09-04 review round 1, finding 1): fetchText now routes through
   * jobSourceLogoVerification.ts's fetchPublic instead of the global `fetch` - see this module's own
   * header for why a Recruitee-only host restriction was not protection enough on its own. */
  describe('SSRF hardening', () => {
    test('refuses a redirect from the posting page to a blocked host, without ever fetching the redirect target', async () => {
      const fetchImpl = mock.fn(async (input: string | URL) => {
        const url = input.toString();
        if (url === 'https://greenflux.recruitee.com/o/senior-principal-software-engineer') {
          return new Response(null, { status: 302, headers: { location: 'https://internal/metadata' } });
        }
        if (url === 'https://greenflux.recruitee.com/api/offers/senior-principal-software-engineer') {
          return new Response('not found', { status: 404 });
        }
        // In particular, the blocked redirect target (https://internal/metadata) must never reach
        // here - if it did, this branch is what would catch it.
        throw new Error(`unexpected fetch, must not reach the blocked redirect target: ${url}`);
      });
      const result = await fetchRecruiteeJobDescription(
        'https://greenflux.recruitee.com/o/senior-principal-software-engineer',
        fetchImpl as unknown as typeof fetch,
        publicDns,
      );
      assert.equal(result, undefined);
      // Exactly two calls: the posting page (redirect refused before it could be followed) and the
      // best-effort API fallback that still runs afterward - never a third call to the blocked host.
      assert.equal(fetchImpl.mock.callCount(), 2);
    });

    test('refuses an oversize posting-page response body rather than buffering it in full', async () => {
      const fetchImpl = mock.fn(async (input: string | URL) => {
        const url = input.toString();
        if (url === 'https://greenflux.recruitee.com/o/senior-principal-software-engineer') {
          return new Response('x'.repeat(MAX_HTML_BYTES + 1), { status: 200, headers: { 'content-type': 'text/html' } });
        }
        return new Response('not found', { status: 404 });
      });
      const result = await fetchRecruiteeJobDescription(
        'https://greenflux.recruitee.com/o/senior-principal-software-engineer',
        fetchImpl as unknown as typeof fetch,
        publicDns,
      );
      assert.equal(result, undefined);
    });
  });
});
