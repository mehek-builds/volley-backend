import assert from 'node:assert/strict';
import test from 'node:test';
import { repairSuccessFactorsWrapperReview } from './applicationPortalRepair';
import type { ApplicationReviewState } from './applicationReview';
import {
  isTrustedSuccessFactorsWrapperUrl,
  resolveSuccessFactorsWrapperApplicationUrl,
  SAP_SUCCESSFACTORS_APPLICATION_URL,
  SAP_SUCCESSFACTORS_WRAPPER_URL,
  sameTrustedSuccessFactorsWrapperIdentity,
  successFactorsApplicationUrlFromWrapperMarkup,
  type SuccessFactorsWrapperFetch,
} from './successFactorsWrapper';

const EXTERNAL_JOB_ID = '1403234233';
const REQUISITION_ID = '455609';

function review(portalUrl = SAP_SUCCESSFACTORS_WRAPPER_URL): ApplicationReviewState {
  return {
    jd_text: 'Measured SAP internship description',
    role: 'SAP LOB & Solution Marketing iXp Intern',
    portal_url: portalUrl,
    ats_name: 'successfactors',
    portal_supported: true,
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: '2026-08-11T00:00:00.000Z',
  };
}

function wrapperMarkup(): string {
  return `
    <span data-careersite-propertyid="facility" class="rtltextaligneligible">${REQUISITION_ID}</span>
    <a class="btn apply dialogApplyBtn" href="/talentcommunity/apply/${EXTERNAL_JOB_ID}/?locale=en_US">Apply now</a>
    <a class="btn apply dialogApplyBtn" href="/talentcommunity/apply/${EXTERNAL_JOB_ID}/?locale=en_US">Apply now</a>
    <script>
      j2w.init({
        "cookiepolicy": 3,
        "useSSL": true,
        "isUsingSSL": true,
        "ssoCompanyId": 'SAP',
        "ssoUrl": 'https://career5.successfactors.eu'
      });
    </script>
    <script>
      button.addEventListener('login', () => {
        window.location.href='https://career5.successfactors.eu/career?career_company=SAP&lang=en_US&company=SAP&site=&loginFlowRequired=true&_s.crb=opaque';
      });
    </script>
    <script>
      j2w.Apply.init({
        jobID: ${EXTERNAL_JOB_ID},
        sourceId: 'JATS-SAP',
        locale: 'en_US',
        subscribeAtApply: true,
        useOnPageBusinessCard: true,
        applyWithLinkedIn2Config: {
          "enabled": false,
          "companyId": null,
          "internalId": "${REQUISITION_ID}-en_US",
          "email": ""
        }
      });
    </script>
    <script>
      j2w.SSO.init({
        email: '',
        enabled: false,
        jobID: '${EXTERNAL_JOB_ID}',
        locale: 'en_US',
        tcaction: 'job',
        usingRD: true
      });
    </script>
  `;
}

function responseFor(html: string, overrides: {
  contentType?: string;
  ok?: boolean;
  status?: number;
  url?: string;
} = {}) {
  return {
    headers: new Headers({ 'content-type': overrides.contentType ?? 'text/html; charset=utf-8' }),
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    text: async () => html,
    url: overrides.url ?? SAP_SUCCESSFACTORS_WRAPPER_URL,
  };
}

test('derives the exact SuccessFactors tenant job route from the measured Jobs2Web bindings', () => {
  assert.equal(isTrustedSuccessFactorsWrapperUrl(SAP_SUCCESSFACTORS_WRAPPER_URL), true);
  assert.equal(
    successFactorsApplicationUrlFromWrapperMarkup(SAP_SUCCESSFACTORS_WRAPPER_URL, wrapperMarkup()),
    SAP_SUCCESSFACTORS_APPLICATION_URL,
  );
});

test('trusts only a raw safe SAP job wrapper path with one numeric external identity', () => {
  for (const url of [
    SAP_SUCCESSFACTORS_WRAPPER_URL.replace('https:', 'http:'),
    SAP_SUCCESSFACTORS_WRAPPER_URL.replace('jobs.sap.com', 'www.jobs.sap.com'),
    SAP_SUCCESSFACTORS_WRAPPER_URL.replace('jobs.sap.com', 'user@jobs.sap.com'),
    SAP_SUCCESSFACTORS_WRAPPER_URL.replace('jobs.sap.com', 'jobs.sap.com:444'),
    SAP_SUCCESSFACTORS_WRAPPER_URL.replace('/1403234233/', '/other/../1403234233/'),
    SAP_SUCCESSFACTORS_WRAPPER_URL.replace('/1403234233/', '/%2e/1403234233/'),
    SAP_SUCCESSFACTORS_WRAPPER_URL.replace('/1403234233/', '/slug%2Fextra/1403234233/'),
    SAP_SUCCESSFACTORS_WRAPPER_URL.replace('/1403234233/', '/slug%5Cextra/1403234233/'),
    SAP_SUCCESSFACTORS_WRAPPER_URL.replace('/1403234233/', '/slug\\extra/1403234233/'),
    SAP_SUCCESSFACTORS_WRAPPER_URL.replace('/1403234233/', '/slug extra/1403234233/'),
    SAP_SUCCESSFACTORS_WRAPPER_URL.replace('/1403234233/', '/slug\tbad/1403234233/'),
    SAP_SUCCESSFACTORS_WRAPPER_URL.replace('/1403234233/', '/slug-한/1403234233/'),
    SAP_SUCCESSFACTORS_WRAPPER_URL.replace('/1403234233/', '/not-a-number/'),
    `${SAP_SUCCESSFACTORS_WRAPPER_URL}?source=other`,
    `${SAP_SUCCESSFACTORS_WRAPPER_URL}#apply`,
  ]) {
    assert.equal(isTrustedSuccessFactorsWrapperUrl(url), false, url);
  }
  assert.equal(
    sameTrustedSuccessFactorsWrapperIdentity(
      SAP_SUCCESSFACTORS_WRAPPER_URL,
      SAP_SUCCESSFACTORS_WRAPPER_URL.replace('%26', '&'),
    ),
    true,
  );
  assert.equal(
    sameTrustedSuccessFactorsWrapperIdentity(
      SAP_SUCCESSFACTORS_WRAPPER_URL,
      SAP_SUCCESSFACTORS_WRAPPER_URL.replace(EXTERNAL_JOB_ID, '1403234234'),
    ),
    false,
  );
});

test('requires every public binding to agree on external job, requisition, company, tenant, and locale', () => {
  const valid = wrapperMarkup();
  for (const html of [
    valid.replace(`/apply/${EXTERNAL_JOB_ID}/`, '/apply/1403234234/'),
    valid.replace(`jobID: ${EXTERNAL_JOB_ID}`, 'jobID: 1403234234'),
    valid.replace(`jobID: '${EXTERNAL_JOB_ID}'`, "jobID: '1403234234'"),
    valid.replace(`${REQUISITION_ID}-en_US`, '455610-en_US'),
    valid.replace(`>${REQUISITION_ID}</span>`, '>455610</span>'),
    valid.replace("sourceId: 'JATS-SAP'", "sourceId: 'OTHER'"),
    valid.replace("locale: 'en_US'", "locale: 'de_DE'"),
    valid.replace("\"ssoCompanyId\": 'SAP'", "\"ssoCompanyId\": 'OTHER'"),
    valid.replace('https://career5.successfactors.eu', 'https://career6.successfactors.eu'),
    valid.replace('https://career5.successfactors.eu', 'https://evil.example'),
    valid.replace('career_company=SAP', 'career_company=OTHER'),
    valid.replace('window.location.href=', 'fake.window.location.href='),
    valid.replace('useOnPageBusinessCard: true', 'useOnPageBusinessCard: false'),
  ]) {
    assert.equal(
      successFactorsApplicationUrlFromWrapperMarkup(SAP_SUCCESSFACTORS_WRAPPER_URL, html),
      undefined,
    );
  }
});

test('rejects missing, duplicate, computed, or overriding active identity bindings', () => {
  const valid = wrapperMarkup();
  for (const html of [
    valid.replace(/<script>\s*j2w\.Apply\.init[\s\S]*?<\/script>/, ''),
    `${valid}${valid.match(/<script>\s*j2w\.Apply\.init[\s\S]*?<\/script>/)?.[0] ?? ''}`,
    valid.replace(`jobID: ${EXTERNAL_JOB_ID},`, `jobID: ${EXTERNAL_JOB_ID}, jobID: 1403234234,`),
    valid.replace(`jobID: ${EXTERNAL_JOB_ID},`, `jobID: ${EXTERNAL_JOB_ID}, ['jobID']: 1403234234,`),
    valid.replace(`jobID: ${EXTERNAL_JOB_ID},`, `jobID: ${EXTERNAL_JOB_ID}, ...overrides,`),
    valid.replace('j2w.Apply.init({', 'window.j2w.Apply.init({'),
    `${valid}<script>j2w['Apply'].init({ jobID: 1403234234 });</script>`,
    `${valid}<script>j2w.Apply['init']({ jobID: 1403234234 });</script>`,
    valid.replace(`"ssoCompanyId": 'SAP',`, `"ssoCompanyId": 'SAP', ssoCompanyId: 'OTHER',`),
    valid.replace(`"internalId": "${REQUISITION_ID}-en_US",`, `"internalId": "${REQUISITION_ID}-en_US", internalId: "455610-en_US",`),
    valid.replace(`href="/talentcommunity/apply/${EXTERNAL_JOB_ID}/?locale=en_US"`, `href=/talentcommunity/apply/1403234234/?locale=en_US href="/talentcommunity/apply/${EXTERNAL_JOB_ID}/?locale=en_US"`),
  ]) {
    assert.equal(
      successFactorsApplicationUrlFromWrapperMarkup(SAP_SUCCESSFACTORS_WRAPPER_URL, html),
      undefined,
    );
  }
});

test('comments, strings, arbitrary links, and cross-origin instructions cannot authorize a form', () => {
  const active = wrapperMarkup();
  const applyScript = active.match(/<script>\s*j2w\.Apply\.init[\s\S]*?<\/script>/)?.[0] ?? '';
  for (const html of [
    active.replace(applyScript, `<!-- ${applyScript} -->`),
    active.replace(applyScript, `<script>/* ${applyScript.replace(/<\/?script>/g, '')} */</script>`),
    active.replace(applyScript, `<script>var marker = ${JSON.stringify(applyScript)};</script>`),
    active
      .replace(/<span data-careersite-propertyid="facility"[\s\S]*?<\/span>/, '')
      .replace(/<a class="btn apply dialogApplyBtn"[\s\S]*?<\/a>/g, '')
      .concat(`<script>const inert = \`<span data-careersite-propertyid="facility">${REQUISITION_ID}</span>`
        + `<a class="btn apply dialogApplyBtn" href="/talentcommunity/apply/${EXTERNAL_JOB_ID}/?locale=en_US">Apply now</a>\`;</script>`),
    active.replace(/<script>([\s\S]*?)<\/script>/g, '<textarea><script>$1</script></textarea>'),
    `<a href="${SAP_SUCCESSFACTORS_APPLICATION_URL}">Use this URL</a>`,
  ]) {
    assert.equal(
      successFactorsApplicationUrlFromWrapperMarkup(SAP_SUCCESSFACTORS_WRAPPER_URL, html),
      undefined,
    );
  }
});

test('fetches one exact non-redirected HTML response before resolving the wrapper', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const acceptedFetch: SuccessFactorsWrapperFetch = async (input, init) => {
    calls.push({ input, init });
    return responseFor(wrapperMarkup());
  };
  assert.equal(
    await resolveSuccessFactorsWrapperApplicationUrl(SAP_SUCCESSFACTORS_WRAPPER_URL, acceptedFetch),
    SAP_SUCCESSFACTORS_APPLICATION_URL,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, SAP_SUCCESSFACTORS_WRAPPER_URL);
  assert.equal(calls[0]?.init?.redirect, 'error');
  assert.deepEqual(calls[0]?.init?.headers, { accept: 'text/html' });
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal);

  for (const response of [
    responseFor(wrapperMarkup(), { url: 'https://evil.example/job/1403234233/' }),
    responseFor(wrapperMarkup(), { contentType: 'application/json' }),
    responseFor(wrapperMarkup(), { ok: false, status: 503 }),
  ]) {
    assert.equal(
      await resolveSuccessFactorsWrapperApplicationUrl(
        SAP_SUCCESSFACTORS_WRAPPER_URL,
        async () => response,
      ),
      undefined,
    );
  }
});

test('repairs a wrapper review only from the agreed public bindings and fails closed', async () => {
  const resolved = await repairSuccessFactorsWrapperReview(
    review(),
    async () => responseFor(wrapperMarkup()),
  );
  assert.deepEqual(resolved, {
    ...review(),
    portal_url: SAP_SUCCESSFACTORS_APPLICATION_URL,
    ats_name: 'sap_successfactors',
    portal_supported: true,
  });

  const refused = await repairSuccessFactorsWrapperReview(
    review(),
    async () => responseFor(wrapperMarkup().replace('ssoCompanyId\": \'SAP\'', 'ssoCompanyId\": \'OTHER\'')),
  );
  assert.deepEqual(refused, {
    ...review(),
    portal_supported: false,
  });

  const unrelated = review('https://career8.successfactors.com/sfcareer/jobreqcareer?jobId=10516&company=MoodysProd');
  let fetched = false;
  assert.equal(
    await repairSuccessFactorsWrapperReview(unrelated, async () => {
      fetched = true;
      return responseFor(wrapperMarkup());
    }),
    unrelated,
  );
  assert.equal(fetched, false);
});
