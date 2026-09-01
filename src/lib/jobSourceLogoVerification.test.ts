import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyCatalogSourceLogo, VERIFIED_HOMEPAGE_LOGO_METHOD } from './jobSourceLogoVerification';

const publicDns = async () => ['93.184.216.34'];
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('verifies matching homepage identity plus a real icon image', async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/favicon.png')) return new Response(png, { headers: { 'content-type': 'image/png' } });
    return new Response('<html><head><title>Acme Careers</title><link rel="icon" href="/favicon.png"></head></html>', {
      headers: { 'content-type': 'text/html' },
    });
  };
  const result = await verifyCatalogSourceLogo(
    { company_name: 'Acme, Inc.', company_domain: 'acme.example' },
    { fetcher: fetcher as typeof fetch, resolveHost: publicDns },
  );
  assert.deepEqual(result, {
    verified: true,
    company_logo_url: 'https://acme.example/favicon.png',
    method: VERIFIED_HOMEPAGE_LOGO_METHOD,
  });
});

test('rejects a reachable lookalike whose homepage identity disagrees', async () => {
  const result = await verifyCatalogSourceLogo(
    { company_name: 'Acme', company_domain: 'acme.example' },
    {
      resolveHost: publicDns,
      fetcher: async () => new Response('<title>Another Company</title>') as never,
    },
  );
  assert.deepEqual(result, { verified: false, reason: 'identity_mismatch' });
});

test('rejects prefix lookalikes such as Ramp on rampart.com', async () => {
  const result = await verifyCatalogSourceLogo(
    { company_name: 'Ramp', company_domain: 'rampart.com' },
    {
      resolveHost: publicDns,
      fetcher: async () => new Response('<title>Rampart</title>') as never,
    },
  );
  assert.deepEqual(result, { verified: false, reason: 'identity_mismatch' });
});

test('rejects private DNS before making a request', async () => {
  let fetches = 0;
  const result = await verifyCatalogSourceLogo(
    { company_name: 'Acme', company_domain: 'acme.example' },
    {
      resolveHost: async () => ['127.0.0.1'],
      fetcher: async () => { fetches += 1; return new Response('<title>Acme</title>') as never; },
    },
  );
  assert.equal(fetches, 0);
  assert.deepEqual(result, { verified: false, reason: 'homepage_unreachable' });
});

test('rejects HTML masquerading as the favicon', async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('favicon.ico')) return new Response('<html>not an image</html>', { headers: { 'content-type': 'text/html' } });
    return new Response('<title>Acme</title>');
  };
  const result = await verifyCatalogSourceLogo(
    { company_name: 'Acme', company_domain: 'acme.example' },
    { fetcher: fetcher as typeof fetch, resolveHost: publicDns },
  );
  assert.deepEqual(result, { verified: false, reason: 'logo_missing' });
});

test('preserves transient homepage and icon status reasons for the retry lane', async () => {
  const homepagePressure = await verifyCatalogSourceLogo(
    { company_name: 'Acme', company_domain: 'acme.example' },
    {
      resolveHost: publicDns,
      fetcher: async () => new Response(null, { status: 429 }),
    },
  );
  assert.deepEqual(homepagePressure, { verified: false, reason: 'http_429' });

  const iconPressure = await verifyCatalogSourceLogo(
    { company_name: 'Acme', company_domain: 'acme.example' },
    {
      resolveHost: publicDns,
      fetcher: async (input) => String(input).endsWith('favicon.ico')
        ? new Response(null, { status: 503 })
        : new Response('<title>Acme</title>'),
    },
  );
  assert.deepEqual(iconPressure, { verified: false, reason: 'http_503' });
});

test('an aggregate verifier deadline stops a DNS lookup that never resolves', async () => {
  const controller = new AbortController();
  let lookupStarted = false;
  const verification = verifyCatalogSourceLogo(
    { company_name: 'Acme', company_domain: 'acme.example' },
    {
      signal: controller.signal,
      resolveHost: async () => {
        lookupStarted = true;
        return new Promise<string[]>(() => undefined);
      },
    },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new DOMException('request budget elapsed', 'TimeoutError'));

  assert.equal(lookupStarted, true);
  assert.deepEqual(await verification, { verified: false, reason: 'timeout' });
});

test('verifies a brand that trails its homepage title behind a separator', async () => {
  /* anthropic.com's exact shape on 2026-08-31: <title>Home \ Anthropic</title>, no og:site_name.
     The lead-only title split left 1,896 sources failed on identity_mismatch for this. The domain
     label still has to equal the company name, so this stays a two-signal check. */
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/favicon.png')) return new Response(png, { headers: { 'content-type': 'image/png' } });
    return new Response('<html><head><title>Home \\ Anthropic</title><link rel="icon" href="/favicon.png"></head></html>', {
      headers: { 'content-type': 'text/html' },
    });
  };
  const result = await verifyCatalogSourceLogo(
    { company_name: 'Anthropic', company_domain: 'anthropic.example' },
    { fetcher: fetcher as typeof fetch, resolveHost: publicDns },
  );
  assert.deepEqual(result, {
    verified: true,
    company_logo_url: 'https://anthropic.example/favicon.png',
    method: VERIFIED_HOMEPAGE_LOGO_METHOD,
  });
});

test('a mid-title brand mention on a lookalike host still fails on the host signal', async () => {
  const result = await verifyCatalogSourceLogo(
    { company_name: 'Acme', company_domain: 'acmeportal.example' },
    {
      resolveHost: publicDns,
      fetcher: async () => new Response('<title>Store | Acme | Deals</title>') as never,
    },
  );
  assert.deepEqual(result, { verified: false, reason: 'identity_mismatch' });
});

test('hyphenated brand names are not split into title segments', async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/favicon.png')) return new Response(png, { headers: { 'content-type': 'image/png' } });
    return new Response('<html><head><title>Rent-A-Center</title><link rel="icon" href="/favicon.png"></head></html>', {
      headers: { 'content-type': 'text/html' },
    });
  };
  const result = await verifyCatalogSourceLogo(
    { company_name: 'Rent-A-Center', company_domain: 'rent-a-center.example' },
    { fetcher: fetcher as typeof fetch, resolveHost: publicDns },
  );
  assert.equal(result.verified, true);
});

test('the careers suffix is stripped from an edge segment, not only the whole title', async () => {
  /* "Home | Acme Careers": the brand trails, wearing the noise word. Stripping the suffix only
     from the full title left exactly this shape failing while "Home | Acme" passed
     (review finding 2026-09-01). */
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/favicon.png')) return new Response(png, { headers: { 'content-type': 'image/png' } });
    return new Response('<html><head><title>Home | Acme Careers</title><link rel="icon" href="/favicon.png"></head></html>', {
      headers: { 'content-type': 'text/html' },
    });
  };
  const result = await verifyCatalogSourceLogo(
    { company_name: 'Acme', company_domain: 'acme.example' },
    { fetcher: fetcher as typeof fetch, resolveHost: publicDns },
  );
  assert.equal(result.verified, true);
});

test('a middle-segment brand mention does not complete identity', async () => {
  /* The expired-domain marketplace lander (review finding 2026-09-01): the host signal AGREES,
     because the label of the dead domain matches the company, and the title names the brand in
     its middle segment and the domain itself in its lead. Neither may complete the check: the
     middle is where boilerplate lives, and a domain-shaped segment is the page naming the
     domain, not the employer, normalizeName's suffix stripping notwithstanding. */
  const result = await verifyCatalogSourceLogo(
    { company_name: 'Acme', company_domain: 'acme.example' },
    {
      resolveHost: publicDns,
      fetcher: (async () => new Response(
        '<title>acme.example - Acme - available at ExampleBrandMarket</title>',
        { headers: { 'content-type': 'text/html' } },
      )) as typeof fetch,
    },
  );
  assert.deepEqual(result, { verified: false, reason: 'identity_mismatch' });
});

test('an unspaced em dash still separates title segments', async () => {
  /* Title templates set em dashes tight as often as spaced, and no brand contains one, so the
     whitespace rule that protects hyphenated brands must not apply to it. */
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/favicon.png')) return new Response(png, { headers: { 'content-type': 'image/png' } });
    return new Response('<html><head><title>Home\u2014Acme</title><link rel="icon" href="/favicon.png"></head></html>', {
      headers: { 'content-type': 'text/html' },
    });
  };
  const result = await verifyCatalogSourceLogo(
    { company_name: 'Acme', company_domain: 'acme.example' },
    { fetcher: fetcher as typeof fetch, resolveHost: publicDns },
  );
  assert.equal(result.verified, true);
});
