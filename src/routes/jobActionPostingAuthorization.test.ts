import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const jdMatch = readFileSync('src/routes/jdMatch.ts', 'utf8');
const resume = readFileSync('src/routes/resume.ts', 'utf8');
const onboarding = readFileSync('src/routes/onboarding.ts', 'utf8');

test('every JD-derived action rejects an unresolved supplied job id', () => {
  for (const [start, end] of [
    ["fastify.post('/jd-match/requirements'", "fastify.post('/jd-match'"],
    ["fastify.post('/jd-match'", "fastify.post('/jd-match/evidence'"],
    ["fastify.post('/interview-prep'", '});\n}'],
  ] as const) {
    const handler = jdMatch.slice(jdMatch.indexOf(start), jdMatch.indexOf(end, jdMatch.indexOf(start) + start.length));
    assert.match(handler, /await actionPostingRowForUser\(requestedJobId, userId\)/);
    assert.match(handler, /if \(requestedJobId && !posting\)/);
    assert.match(handler, /code: 'job_not_available'/);
  }
});

test('resume proves canonical ownership before using the historical-capable reader', () => {
  const handler = resume.slice(
    resume.indexOf("fastify.post('/resume/generate'"),
    resume.indexOf("fastify.get('/resume/download'"),
  );
  const ownershipRead = handler.indexOf('const ownedCanonicalApplications = await db.select');
  const bindingGate = handler.indexOf('canonicalApplicationBindingMismatches');
  const postingRead = handler.indexOf('resolvedPosting = await actionPostingRowForUser(body.job_id, userId)');
  assert.ok(ownershipRead >= 0);
  assert.ok(bindingGate > ownershipRead);
  assert.ok(postingRead > bindingGate);
  assert.match(handler, /if \(!resolvedPosting\)/);
  assert.match(handler, /ownedHistoricalActionPostingRow\(/);
});

test('resume rejects an invalid monitored action URL before quota or generation', () => {
  const handler = resume.slice(
    resume.indexOf("fastify.post('/resume/generate'"),
    resume.indexOf("fastify.get('/resume/download'"),
  );
  const canonicalUrl = handler.indexOf('const canonicalApplicationPortalUrl = body.application');
  const failedCanonicalUrl = handler.indexOf('body.application && body.job_id && !canonicalApplicationPortalUrl');
  const quota = handler.indexOf('const ent = await getEntitlements(userId)');
  const generation = handler.indexOf('generateResumeSpec(');
  assert.ok(canonicalUrl >= 0);
  assert.ok(failedCanonicalUrl > canonicalUrl);
  assert.ok(quota > failedCanonicalUrl);
  assert.ok(generation > failedCanonicalUrl);
  assert.match(handler.slice(failedCanonicalUrl, quota), /code: 'job_not_available'/);
  assert.doesNotMatch(
    handler,
    /monitoredApplicationUrlForGenerate\(body, resolvedPosting\)\s*\?\?/,
    'the monitored branch must not fall through to a caller URL',
  );
});

test('onboarding verifies the posting before reusable answers or legal declarations are written', () => {
  const handler = onboarding.slice(
    onboarding.indexOf("fastify.post('/onboarding/answers'"),
    onboarding.indexOf("fastify.post('/onboarding/gaps-asked'"),
  );
  const postingRead = handler.indexOf('await actionPostingRowForUser(parsed.data.job_id, userId)');
  const answerWrite = handler.indexOf('await rememberReusableAnswers(');
  const declarationWrite = handler.indexOf('await persistProfileWithCountryEligibility(');
  assert.ok(postingRead >= 0);
  assert.ok(answerWrite > postingRead);
  assert.ok(declarationWrite > answerWrite);
  assert.match(handler, /posting\?\.job_country \?\? null/);
});
