import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comeetApplicationUrlFromWrapperMarkup,
  FORSIGHT_COMEET_APPLICATION_URL,
  FORSIGHT_COMEET_WRAPPER_URL,
  isTrustedComeetApplicationUrl,
  isTrustedComeetWrapperUrl,
  resolveTrustedComeetWrapperApplicationUrl,
  type ComeetWrapperFetch,
} from './comeetWrapper';

const COMPANY_UID = 'E9.008';
const POSITION_UID = '35.C68';
const TOKEN = '9E845581DB8009E83B7027A001DB8';

function wrapperMarkup(overrides: {
  companyUid?: string;
  positionUid?: string;
  token?: string;
  apiSource?: string;
} = {}): string {
  const companyUid = overrides.companyUid ?? COMPANY_UID;
  const positionUid = overrides.positionUid ?? POSITION_UID;
  const token = overrides.token ?? TOKEN;
  const apiSource = overrides.apiSource ?? '//www.comeet.co/careers-api/api.js';
  return `
    <main><h1>Software Engineer</h1></main>
    <script type="comeet-applyform" data-position-uid="${positionUid}" color="#5F4FC9"></script>
    <script>
      window.comeetInit = function() {
        COMEET.init({
          "token": "${token}",
          "company-uid": "${companyUid}",
          "company-name": "forsight"
        });
      };
      (function() { var js = {}; js.src = "${apiSource}"; }());
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
    url: overrides.url ?? FORSIGHT_COMEET_WRAPPER_URL,
  };
}

test('derives the exact token-bearing Comeet form from the measured Forsight wrapper bindings', () => {
  assert.equal(
    comeetApplicationUrlFromWrapperMarkup(FORSIGHT_COMEET_WRAPPER_URL, wrapperMarkup()),
    FORSIGHT_COMEET_APPLICATION_URL,
  );
});

test('refuses wrong company, position, or token identity without repairing or guessing', () => {
  for (const html of [
    wrapperMarkup({ companyUid: 'OTHER.001' }),
    wrapperMarkup({ positionUid: '35.C69' }),
    wrapperMarkup({ token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
  ]) {
    assert.equal(comeetApplicationUrlFromWrapperMarkup(FORSIGHT_COMEET_WRAPPER_URL, html), undefined);
  }
});

test('refuses duplicate, computed, or overriding initialization identity properties', () => {
  const valid = wrapperMarkup();
  for (const html of [
    valid.replace(`"token": "${TOKEN}",`, `"token": "${TOKEN}", token: "other",`),
    valid.replace(`"token": "${TOKEN}",`, `"token": "${TOKEN}", 'token': "other",`),
    valid.replace(`"token": "${TOKEN}",`, `"token": "${TOKEN}", ["token"]: "other",`),
    valid.replace(`"token": "${TOKEN}",`, `"token": "${TOKEN}", ...overrides,`),
    valid.replace(`"company-uid": "${COMPANY_UID}",`, `"company-uid": "${COMPANY_UID}", companyUid: "OTHER.001",`),
    valid.replace(`"company-uid": "${COMPANY_UID}",`, `"company-uid": "${COMPANY_UID}", 'company-uid': "OTHER.001",`),
    valid.replace(`"company-uid": "${COMPANY_UID}",`, `"company-uid": "${COMPANY_UID}", ["company-uid"]: "OTHER.001",`),
    valid.replace(`"company-name": "forsight"`, `"company-name": "forsight", "position-uid": "35.C69"`),
    valid.replace(`"company-name": "forsight"`, `"company-name": "forsight", "position-uid": "${POSITION_UID}", positionUid: "35.C69"`),
    valid.replace(`"company-name": "forsight"`, `"company-name": "forsight", ["position-uid"]: "${POSITION_UID}"`),
  ]) {
    assert.equal(comeetApplicationUrlFromWrapperMarkup(FORSIGHT_COMEET_WRAPPER_URL, html), undefined);
  }
});

test('refuses unquoted or duplicate position attributes even beside the expected quoted binding', () => {
  const valid = wrapperMarkup();
  for (const attributes of [
    `data-position-uid=35.C69 data-position-uid="${POSITION_UID}"`,
    `data-position-uid="35.C69" data-position-uid="${POSITION_UID}"`,
    `data-position-uid='35.C69' DATA-POSITION-UID="${POSITION_UID}"`,
  ]) {
    const html = valid.replace(`data-position-uid="${POSITION_UID}"`, attributes);
    assert.equal(comeetApplicationUrlFromWrapperMarkup(FORSIGHT_COMEET_WRAPPER_URL, html), undefined);
  }
});

test('a comment-only Comeet API assignment cannot authorize the wrapper', () => {
  for (const replacement of [
    `// js.src = "//www.comeet.co/careers-api/api.js";`,
    `/* js.src = "//www.comeet.co/careers-api/api.js"; */`,
    `var marker = 'js.src = "//www.comeet.co/careers-api/api.js"';`,
  ]) {
    const inactiveOnly = wrapperMarkup().replace(
      `js.src = "//www.comeet.co/careers-api/api.js";`,
      replacement,
    );
    assert.equal(
      comeetApplicationUrlFromWrapperMarkup(FORSIGHT_COMEET_WRAPPER_URL, inactiveOnly),
      undefined,
    );
  }
});

test('requires exactly one apply-form embed and one Comeet initialization', () => {
  const valid = wrapperMarkup();
  const applyForm = `<script type="comeet-applyform" data-position-uid="${POSITION_UID}"></script>`;
  const init = `<script>COMEET.init({"token":"${TOKEN}","company-uid":"${COMPANY_UID}"});
    var js = {}; js.src = "//www.comeet.co/careers-api/api.js";</script>`;
  for (const html of [
    valid.replace(/<script type="comeet-applyform"[\s\S]*?<\/script>/, ''),
    `${valid}${applyForm}`,
    valid.replace(/<script>\s*window\.comeetInit[\s\S]*?<\/script>/, ''),
    `${valid}${init}`,
  ]) {
    assert.equal(comeetApplicationUrlFromWrapperMarkup(FORSIGHT_COMEET_WRAPPER_URL, html), undefined);
  }
});

test('trusts only the exact secure Forsight wrapper origin and position path', () => {
  assert.equal(isTrustedComeetWrapperUrl(FORSIGHT_COMEET_WRAPPER_URL), true);
  for (const url of [
    'http://forsightrobotics.com/positions/position-35_c68',
    'https://www.forsightrobotics.com/positions/position-35_c68',
    'https://forsightrobotics.example/positions/position-35_c68',
    'https://forsightrobotics.com:444/positions/position-35_c68',
    'https://user@forsightrobotics.com/positions/position-35_c68',
    'https://forsightrobotics.com/positions/position-35_c69',
    'https://forsightrobotics.com/positions/position-35_c68/',
    'https://forsightrobotics.com/positions/position-35_c68?token=other',
    'https://forsightrobotics.com/positions/position-35_c68#apply',
  ]) {
    assert.equal(isTrustedComeetWrapperUrl(url), false, url);
    assert.equal(comeetApplicationUrlFromWrapperMarkup(url, wrapperMarkup()), undefined, url);
  }
});

test('trusts only the raw exact Forsight direct form path and one matching token identity', () => {
  assert.equal(isTrustedComeetApplicationUrl(FORSIGHT_COMEET_APPLICATION_URL), true);
  assert.equal(
    isTrustedComeetApplicationUrl(FORSIGHT_COMEET_APPLICATION_URL.replace('www.comeet.co', 'www.comeet.co:443')),
    true,
  );
  for (const url of [
    FORSIGHT_COMEET_APPLICATION_URL.replace('https:', 'http:'),
    FORSIGHT_COMEET_APPLICATION_URL.replace('www.comeet.co', 'user@www.comeet.co'),
    FORSIGHT_COMEET_APPLICATION_URL.replace('www.comeet.co', 'www.comeet.co:444'),
    FORSIGHT_COMEET_APPLICATION_URL.replace('www.comeet.co', 'www.comeet.co\t'),
    FORSIGHT_COMEET_APPLICATION_URL.replace('www.comeet.co', 'www.comeet.co\n'),
    FORSIGHT_COMEET_APPLICATION_URL.replace('www.comeet.co', 'WWW.COMEET.CO'),
    FORSIGHT_COMEET_APPLICATION_URL.replace('/35.C68/apply', '/other/../35.C68/apply'),
    FORSIGHT_COMEET_APPLICATION_URL.replace('/35.C68/apply', '/%2e/35.C68/apply'),
    FORSIGHT_COMEET_APPLICATION_URL.replace('/35.C68/apply', '/%2E/35.C68/apply'),
    FORSIGHT_COMEET_APPLICATION_URL.replace('/35.C68/apply', '/x/%2e%2e/35.C68/apply'),
    FORSIGHT_COMEET_APPLICATION_URL.replace('/35.C68/apply', '/35.C68%2Fapply'),
    FORSIGHT_COMEET_APPLICATION_URL.replace('/35.C68/apply', '/35.C68%5Capply'),
    `${FORSIGHT_COMEET_APPLICATION_URL}&token=${TOKEN}`,
    `${FORSIGHT_COMEET_APPLICATION_URL}&source=other`,
    FORSIGHT_COMEET_APPLICATION_URL.replace('?token=', '?to\tken='),
    FORSIGHT_COMEET_APPLICATION_URL.replace(TOKEN, 'OTHER'),
    `${FORSIGHT_COMEET_APPLICATION_URL}#apply`,
  ]) {
    assert.equal(isTrustedComeetApplicationUrl(url), false, url);
  }
});

test('never follows page instructions or accepts a cross-origin Comeet API source', () => {
  const arbitraryInstruction = `
    <a href="${FORSIGHT_COMEET_APPLICATION_URL}">Apply now</a>
    <script>window.instructions = {"token":"${TOKEN}","company-uid":"${COMPANY_UID}"};</script>
  `;
  assert.equal(
    comeetApplicationUrlFromWrapperMarkup(FORSIGHT_COMEET_WRAPPER_URL, arbitraryInstruction),
    undefined,
  );
  assert.equal(
    comeetApplicationUrlFromWrapperMarkup(
      FORSIGHT_COMEET_WRAPPER_URL,
      wrapperMarkup().replace('window.comeetInit = function() {', 'window.instructions = function() {'),
    ),
    undefined,
  );
  assert.equal(
    comeetApplicationUrlFromWrapperMarkup(
      FORSIGHT_COMEET_WRAPPER_URL,
      `<!-- ${wrapperMarkup()} -->`,
    ),
    undefined,
  );
  assert.equal(
    comeetApplicationUrlFromWrapperMarkup(
      FORSIGHT_COMEET_WRAPPER_URL,
      wrapperMarkup({ apiSource: '//evil.example/careers-api/api.js' }),
    ),
    undefined,
  );
});

test('fetches one exact non-redirected HTML response before accepting the wrapper', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const acceptedFetch: ComeetWrapperFetch = async (input, init) => {
    calls.push({ input, init });
    return responseFor(wrapperMarkup());
  };
  assert.equal(
    await resolveTrustedComeetWrapperApplicationUrl(FORSIGHT_COMEET_WRAPPER_URL, acceptedFetch),
    FORSIGHT_COMEET_APPLICATION_URL,
  );
  assert.deepEqual(calls, [{
    input: FORSIGHT_COMEET_WRAPPER_URL,
    init: { redirect: 'error', headers: { accept: 'text/html' } },
  }]);

  for (const response of [
    responseFor(wrapperMarkup(), { url: 'https://evil.example/positions/position-35_c68' }),
    responseFor(wrapperMarkup(), { contentType: 'application/json' }),
    responseFor(wrapperMarkup(), { ok: false, status: 503 }),
  ]) {
    const refusedFetch: ComeetWrapperFetch = async () => response;
    assert.equal(
      await resolveTrustedComeetWrapperApplicationUrl(FORSIGHT_COMEET_WRAPPER_URL, refusedFetch),
      undefined,
    );
  }
});