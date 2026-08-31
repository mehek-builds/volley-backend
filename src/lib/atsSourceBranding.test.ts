import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VERIFIED_ATS_DURABLE_COPY_LOGO_METHOD,
  VERIFIED_ATS_SOURCE_LOGO_METHOD,
  verifyAtsSourceBranding,
  type AtsSourceBrandingCandidate,
} from './atsSourceBranding';
import { parseAtsScrapersJobSources } from './jobSourceDiscovery';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function html(body: string, init?: ResponseInit): Response {
  return new Response(body, { ...init, headers: { 'content-type': 'text/html; charset=utf-8', ...init?.headers } });
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init?.headers },
  });
}

function image(contentType = 'image/png'): Response {
  return new Response(png, { headers: { 'content-type': contentType } });
}

function candidate(
  ats_name: AtsSourceBrandingCandidate['ats_name'],
  board_token: string,
  company_name: string,
): AtsSourceBrandingCandidate {
  return { ats_name, board_token, company_name };
}

test('verifies Greenhouse explicit board logo and refuses to rely on its social image', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const logo = 'https://recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/000/000/115/original/airbnb.jpg?1406213952';
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === logo) return image();
    return html(`<meta property="og:image" content="https://generic.example/social.jpg">
      <img src="${logo}" alt="Airbnb Logo" class="image-container logo">`);
  };
  const result = await verifyAtsSourceBranding(
    candidate('greenhouse', 'airbnb', 'Airbnb'),
    fetcher as typeof fetch,
  );
  assert.deepEqual(result, {
    verified: true,
    company_name: 'Airbnb',
    company_logo_url: logo,
    method: VERIFIED_ATS_SOURCE_LOGO_METHOD,
  });
  assert.equal(requests[0].url, 'https://job-boards.greenhouse.io/embed/job_board?for=airbnb');
  assert.equal(requests[0].init?.redirect, 'manual');
  assert.ok(requests[0].init?.signal instanceof AbortSignal);
});

test('branding verification shares the poller executable-token contract', async () => {
  const logo = 'https://recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/000/000/115/original/acme.png';
  const requests: string[] = [];
  const result = await verifyAtsSourceBranding(
    candidate('greenhouse', 'Acme~West', 'Acme'),
    async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === logo) return image();
      return html(`<img src="${logo}" alt="Acme Logo" class="logo">`);
    },
  );
  assert.equal(result.verified, true);
  assert.match(requests[0], /for=acme~west$/);

  const invalid = await verifyAtsSourceBranding(
    candidate('breezy', 'tenant.example', 'Acme'),
    async () => html('unexpected request'),
  );
  assert.deepEqual(invalid, { verified: false, reason: 'invalid_source' });
});

test('verifies Lever client-logo asset against two agreeing employer identity fields', async () => {
  const logo = 'https://lever-client-logos.s3-us-west-2.amazonaws.com/b8300af6-ed1c-4d0b-8956-cee7839555b9-1586196845320.png';
  const result = await verifyAtsSourceBranding(candidate('lever', 'palantir', 'Palantir'), async (input) => {
    if (String(input) === logo) return image('binary/octet-stream');
    return html(`<title>Palantir Technologies</title>
      <meta property="og:title" content="Palantir Technologies jobs">
      <meta property="og:image" content="${logo}">`);
  });
  assert.deepEqual(result, {
    verified: true,
    company_name: 'Palantir Technologies',
    company_logo_url: logo,
    method: VERIFIED_ATS_SOURCE_LOGO_METHOD,
  });
});

test('verifies Ashby org-theme-logo and ignores its separate org-theme-social image', async () => {
  const logo = 'https://app.ashbyhq.com/api/images/org-theme-logo/7a158cac-9866-4881-95a8-bc946d3dca79/c68257b4-5a2d-4ecc-93a6-fe3c6766ce8b/55852d64-3584-498c-8afb-0679e5c9dede.png';
  const result = await verifyAtsSourceBranding(candidate('ashby', 'ramp', 'Ramp'), async (input) => {
    if (String(input) === logo) return image();
    return html(`<title>Ramp Jobs</title>
      <meta property="og:title" content="Ramp Jobs">
      <meta property="og:image" content="https://app.ashbyhq.com/api/images/org-theme-social/a/b/c.png">
      <link rel="preload" as="image" href="${logo}">`);
  });
  assert.deepEqual(result, {
    verified: true,
    company_name: 'Ramp',
    company_logo_url: logo,
    method: VERIFIED_ATS_SOURCE_LOGO_METHOD,
  });
});

test('verifies Workable account open-graph logo but rejects static Workable artwork', async () => {
  const logo = 'https://workablehr.s3.amazonaws.com/uploads/account/open_graph_logo/410749/social?1780908161000';
  const good = await verifyAtsSourceBranding(candidate('workable', '1000heads', '1000heads'), async (input) => {
    if (String(input) === logo) return image();
    return html(`<title>1000heads - Current Openings</title>
      <meta property="og:title" content="1000heads">
      <meta property="og:image" content="${logo}">`);
  });
  assert.equal(good.verified, true);
  if (good.verified) assert.equal(good.company_logo_url, logo);

  const rejected = await verifyAtsSourceBranding(candidate('workable', '1000heads', '1000heads'), async () => (
    html(`<title>1000heads - Current Openings</title>
      <meta property="og:title" content="1000heads">
      <meta property="og:image" content="https://workable-application-form.s3.amazonaws.com/static/workable-social.png">`)
  ));
  assert.deepEqual(rejected, {
    verified: false,
    reason: 'logo_missing',
    identity_verified: true,
    company_name: '1000heads',
  });
});

test('verifies Breezy company object identity and its gallery logo URL', async () => {
  const rawLogo = 'https://gallery-cdn.breezy.hr/ef441e76-a468-4edc-ba3c-3f6ea20d598e/Screenshot 2026-06-11.png';
  const normalizedLogo = 'https://gallery-cdn.breezy.hr/ef441e76-a468-4edc-ba3c-3f6ea20d598e/Screenshot%202026-06-11.png';
  const result = await verifyAtsSourceBranding(candidate('breezy', 'agbo', 'AGBO'), async (input) => {
    if (String(input) === normalizedLogo) return image();
    return json([{ company: { name: 'AGBO', logo_url: rawLogo, friendly_id: 'agbo' } }]);
  });
  assert.deepEqual(result, {
    verified: true,
    company_name: 'AGBO',
    company_logo_url: normalizedLogo,
    method: VERIFIED_ATS_SOURCE_LOGO_METHOD,
  });
});

test('verifies Recruitee explicit navigation logo and ignores its generic Tellent share image', async () => {
  const logo = 'https://careers.recruiteecdn.com/image/upload/q_auto,f_auto,w_400,c_limit/production/images/B4IE/uFQjbOTybo8l.png';
  const result = await verifyAtsSourceBranding(
    candidate('recruitee', 'cbsconsulting', 'cbs Corporate Business Solutions GmbH'),
    async (input) => {
      if (String(input) === logo) return image();
      return html(`<meta property="og:image" content="https://careers.recruiteecdn.com/image/upload/assets/tellent-share.png">
        <img class="custom-css-style-navigation-logo-image" data-cy="navigation-section-logo-image"
          alt="cbs Corporate Business Solutions GmbH logo" src="${logo}">`);
    },
  );
  assert.deepEqual(result, {
    verified: true,
    company_name: 'cbs Corporate Business Solutions GmbH',
    company_logo_url: logo,
    method: VERIFIED_ATS_SOURCE_LOGO_METHOD,
  });
});

test('preserves Recruitee employer identity when its theme has no logo', async () => {
  const result = await verifyAtsSourceBranding(
    candidate('recruitee', 'acme', 'Acme'),
    async () => html('<title>Careers at Acme | Recruitee</title><meta property="og:title" content="Acme Careers">'),
  );
  assert.deepEqual(result, {
    verified: false,
    reason: 'logo_missing',
    identity_verified: true,
    company_name: 'Acme',
  });
});

test('verifies Crelate only when settings label HeaderLogoUrl as Logo mode', async () => {
  const organizationId = 'fe1806f8-4ed1-439b-c664-18a941d2da08';
  const logo = 'https://jobs.crelate.com/portal/v2/canonrecruiting/logo/ca719018-925a-4299-52f4-0e069d67db08';
  const urls: string[] = [];
  const result = await verifyAtsSourceBranding(
    candidate('crelate', 'canonrecruiting', 'Canon Recruiting Group'),
    async (input) => {
      const url = String(input);
      urls.push(url);
      if (url === logo) return image();
      if (url.includes('/getclientvars?')) return json({
        ORG_ID: organizationId,
        ORG_NAME: 'canonrecruiting',
        ORG_DISPLAY_NAME: 'Canon Recruiting Group ',
        BASE_URL: 'jobs.crelate.com',
      });
      return json({ Title: 'Canon Recruiting Group ', HeaderType: 3, HeaderLogoUrl: logo });
    },
  );
  assert.deepEqual(result, {
    verified: true,
    company_name: 'Canon Recruiting Group',
    company_logo_url: logo,
    method: VERIFIED_ATS_SOURCE_LOGO_METHOD,
  });
  assert.match(urls[0], /getclientvars\?onv=Y2Fub25yZWNydWl0aW5n/);
  assert.match(urls[1], /candidateportal\/Settings\?requestEnvelope=/);
});

test('rejects Crelate banners even though the provider calls the field HeaderLogoUrl', async () => {
  const result = await verifyAtsSourceBranding(
    candidate('crelate', 'canonrecruiting', 'Canon Recruiting Group'),
    async (input) => {
      if (String(input).includes('/getclientvars?')) return json({
        ORG_ID: 'fe1806f8-4ed1-439b-c664-18a941d2da08',
        ORG_NAME: 'canonrecruiting',
        ORG_DISPLAY_NAME: 'Canon Recruiting Group',
        BASE_URL: 'jobs.crelate.com',
      });
      return json({
        Title: 'Canon Recruiting Group',
        HeaderType: 1,
        HeaderLogoUrl: 'https://jobs.crelate.com/portal/v2/canonrecruiting/logo/ca719018-925a-4299-52f4-0e069d67db08',
      });
    },
  );
  assert.deepEqual(result, {
    verified: false,
    reason: 'logo_missing',
    identity_verified: true,
    company_name: 'Canon Recruiting Group',
  });
});

test('a discovery-only Rippling source copies proven signed logo bytes to durable storage', async () => {
  const [source] = parseAtsScrapersJobSources('rippling', [
    'name,slug,url',
    'Utility,utility,https://ats.rippling.com/utility/jobs',
    '',
  ].join('\n'));
  assert.ok(source);
  const signedLogo = 'https://prod-images.rippling.com/64467cdc6e33ba842961d4e1510e94b8aff1b3a0.png?Expires=4102444800&Signature=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789~safe&Key-Pair-Id=K2Y26R2ZPP26PH';
  const durableLogo = 'https://litos.public.blob.vercel-storage.com/company-logos/rippling/utility/logo.png';
  const requests: string[] = [];
  let copiedBytes: Uint8Array | null = null;
  const result = await verifyAtsSourceBranding({
    ats_name: source.ats_name,
    board_token: source.board_token,
    company_name: source.company_name,
    identity_mode: 'provisional',
  }, async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === signedLogo) return image();
    return html(`<html><head><title>Utility Careers</title>
      <link rel="prefetch" href="${signedLogo.replace(/&/g, '&amp;')}"></head>
      <body><h1><span>Utility</span> Careers</h1></body></html>`);
  }, async (asset) => {
    assert.equal(asset.provider, 'rippling');
    assert.equal(asset.board_token, 'utility');
    assert.equal(asset.content_type, 'image/png');
    copiedBytes = asset.bytes;
    return durableLogo;
  });
  assert.deepEqual(requests, ['https://ats.rippling.com/utility/jobs', signedLogo]);
  assert.deepEqual(copiedBytes, png);
  assert.deepEqual(result, {
    verified: true,
    company_name: 'Utility',
    company_logo_url: durableLogo,
    method: VERIFIED_ATS_DURABLE_COPY_LOGO_METHOD,
  });
});

test('Rippling refuses a signed-looking logo on the wrong asset domain', async () => {
  const wrongLogo = 'https://attacker.example/64467cdc6e33ba842961d4e1510e94b8aff1b3a0.png?Expires=4102444800&Signature=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789~safe&Key-Pair-Id=K2Y26R2ZPP26PH';
  const requests: string[] = [];
  const result = await verifyAtsSourceBranding(
    candidate('rippling', 'utility', 'Utility'),
    async (input) => {
      requests.push(String(input));
      return html(`<title>Utility Careers</title><link rel="preload" as="image" href="${wrongLogo.replace(/&/g, '&amp;')}">`);
    },
    async () => 'https://litos.public.blob.vercel-storage.com/unreachable.png',
  );
  assert.deepEqual(requests, ['https://ats.rippling.com/utility/jobs']);
  assert.deepEqual(result, {
    verified: false,
    reason: 'logo_missing',
    identity_verified: true,
    company_name: 'Utility',
  });
});

test('rejects identity disagreement before requesting the image', async () => {
  let imageRequests = 0;
  const result = await verifyAtsSourceBranding(candidate('lever', 'lookalike', 'Acme'), async (input) => {
    if (String(input).includes('lever-client-logos')) {
      imageRequests += 1;
      return image();
    }
    return html(`<title>Another Company</title>
      <meta property="og:title" content="Another Company jobs">
      <meta property="og:image" content="https://lever-client-logos.s3-us-west-2.amazonaws.com/logo.png">`);
  });
  assert.equal(imageRequests, 0);
  assert.deepEqual(result, { verified: false, reason: 'identity_mismatch' });
});

test('lets first-party ATS identity replace a provisional discovery slug', async () => {
  const logo = 'https://lever-client-logos.s3-us-west-2.amazonaws.com/wpp-media.png';
  const result = await verifyAtsSourceBranding({
    ...candidate('lever', 'wppmedia', 'wppmedia'),
    identity_mode: 'provisional',
  }, async (input) => {
    if (String(input) === logo) return image();
    return html(`<title>WPP Media</title>
      <meta property="og:title" content="WPP Media jobs">
      <meta property="og:image" content="${logo}">`);
  });
  assert.deepEqual(result, {
    verified: true,
    company_name: 'WPP Media',
    company_logo_url: logo,
    method: VERIFIED_ATS_SOURCE_LOGO_METHOD,
  });
});

test('rejects unsafe logo hosts, malformed provider JSON, and HTML masquerading as an image', async () => {
  const unsafe = await verifyAtsSourceBranding(candidate('breezy', 'agbo', 'AGBO'), async () => json([{
    company: { name: 'AGBO', friendly_id: 'agbo', logo_url: 'https://attacker.example/logo.png' },
  }]));
  assert.deepEqual(unsafe, {
    verified: false,
    reason: 'logo_missing',
    identity_verified: true,
    company_name: 'AGBO',
  });

  const malformed = await verifyAtsSourceBranding(candidate('breezy', 'agbo', 'AGBO'), async () => (
    new Response('{not-json', { headers: { 'content-type': 'application/json' } })
  ));
  assert.deepEqual(malformed, { verified: false, reason: 'malformed_response' });

  const logo = 'https://lever-client-logos.s3-us-west-2.amazonaws.com/logo.png';
  const fakeImage = await verifyAtsSourceBranding(candidate('lever', 'acme', 'Acme'), async (input) => {
    if (String(input) === logo) return html('<p>not an image</p>');
    return html(`<title>Acme</title><meta property="og:title" content="Acme jobs">
      <meta property="og:image" content="${logo}">`);
  });
  assert.deepEqual(fakeImage, {
    verified: false,
    reason: 'invalid_logo_asset',
    identity_verified: true,
    company_name: 'Acme',
  });
});

test('rejects oversized responses, redirects, and invalid board tokens without following them', async () => {
  const oversized = await verifyAtsSourceBranding(candidate('lever', 'acme', 'Acme'), async () => (
    html('<title>Acme</title>', { headers: { 'content-length': '4000001' } })
  ));
  assert.deepEqual(oversized, { verified: false, reason: 'response_too_large' });

  const redirected = await verifyAtsSourceBranding(candidate('lever', 'acme', 'Acme'), async () => (
    new Response(null, { status: 302, headers: { location: 'https://attacker.example/' } })
  ));
  assert.deepEqual(redirected, { verified: false, reason: 'http_302' });

  let requests = 0;
  const badToken = await verifyAtsSourceBranding(candidate('recruitee', 'evil.example', 'Acme'), async () => {
    requests += 1;
    return html('');
  });
  assert.equal(requests, 0);
  assert.deepEqual(badToken, { verified: false, reason: 'invalid_source' });
});

test('preserves a retryable image status after first-party identity succeeds', async () => {
  const logo = 'https://lever-client-logos.s3-us-west-2.amazonaws.com/acme.png';
  const result = await verifyAtsSourceBranding(candidate('lever', 'acme', 'Acme'), async (input) => {
    if (String(input) === logo) return new Response(null, { status: 429 });
    return html(`<title>Acme</title><meta property="og:title" content="Acme jobs">
      <meta property="og:image" content="${logo}">`);
  });
  assert.deepEqual(result, {
    verified: false,
    reason: 'http_429',
    identity_verified: true,
    company_name: 'Acme',
  });
});

test('an aggregate verifier deadline aborts a provider request that never resolves', async () => {
  const controller = new AbortController();
  let providerSignal: AbortSignal | undefined;
  const verification = verifyAtsSourceBranding(
    candidate('lever', 'acme', 'Acme'),
    ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        providerSignal = init?.signal ?? undefined;
        assert.ok(providerSignal);
        const rejectForAbort = () => reject(providerSignal?.reason);
        if (providerSignal.aborted) rejectForAbort();
        else providerSignal.addEventListener('abort', rejectForAbort, { once: true });
      })
    )) as typeof fetch,
    undefined,
    { signal: controller.signal },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new DOMException('request budget elapsed', 'TimeoutError'));

  assert.deepEqual(await verification, { verified: false, reason: 'timeout' });
  assert.equal(providerSignal?.aborted, true);
});

test('follows a provider-internal redirect to a renamed board and verifies there', async () => {
  const logo = 'https://lever-client-logos.s3-us-west-2.amazonaws.com/acme.png';
  const urls: string[] = [];
  const result = await verifyAtsSourceBranding(candidate('lever', 'acme', 'Acme'), async (input) => {
    const url = String(input);
    urls.push(url);
    if (url === 'https://jobs.lever.co/acme') {
      return new Response(null, { status: 301, headers: { location: 'https://jobs.eu.lever.co/acme' } });
    }
    if (url === logo) return image();
    return html(`<title>Acme</title><meta property="og:title" content="Acme jobs">
      <meta property="og:image" content="${logo}">`);
  });
  assert.deepEqual(urls.slice(0, 2), ['https://jobs.lever.co/acme', 'https://jobs.eu.lever.co/acme']);
  assert.deepEqual(result, {
    verified: true,
    company_name: 'Acme',
    company_logo_url: logo,
    method: VERIFIED_ATS_SOURCE_LOGO_METHOD,
  });
});

test('a redirect crossing out of the provider keeps the original status as the reason', async () => {
  /* greenhouse.io.evil.example is the classic suffix lookalike; a host check that only does
     endsWith would follow it. The exact-host predicate must not. */
  const result = await verifyAtsSourceBranding(candidate('greenhouse', 'acme', 'Acme'), async () => (
    new Response(null, { status: 301, headers: { location: 'https://job-boards.greenhouse.io.evil.example/embed/job_board?for=acme' } })
  ));
  assert.deepEqual(result, { verified: false, reason: 'http_301' });
});

test('a provider that redirects forever costs a bounded number of requests', async () => {
  let requests = 0;
  const result = await verifyAtsSourceBranding(candidate('recruitee', 'acme', 'Acme'), async () => {
    requests += 1;
    return new Response(null, { status: 302, headers: { location: 'https://acme.recruitee.com/' } });
  });
  assert.equal(requests, 4);
  assert.deepEqual(result, { verified: false, reason: 'http_302' });
});
