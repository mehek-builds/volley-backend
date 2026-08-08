import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { submitRequestDisposition } from '../lib/submissionSafety';

function routeSlice(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing route marker ${startMarker}`);
  assert.ok(end > start, `missing route boundary ${endMarker}`);
  return source.slice(start, end);
}

test('supported submit-request discovery is not blocked by a sensitive pre-run snapshot', async () => {
  const source = await readFile('src/routes/applications.ts', 'utf8');
  const handler = routeSlice(
    source,
    "'/applications/:id/submit-request'",
    "'/applications/:id/submission/channels'",
  );

  assert.match(handler, /const sensitive = sensitiveQuestionFor\(normalizedSubmittedQuestions, sensitiveProfile, current\.jd_text\)/);
  assert.doesNotMatch(handler, /if \(sensitive\) \{\s*return reply\.status\(422\)/);
  assert.match(
    handler,
    /if \(current\.portal_url && !isPortalSupported\(current\.portal_url\) && sensitive\)/,
  );
  assert.ok(
    handler.indexOf('processSubmissionApplication(row.id, fastify)')
      > handler.indexOf('&& sensitive)'),
    'the supported portal path must remain able to start its discovery run',
  );
});

test('unsupported email and final approval retain sensitive-question send gates', async () => {
  const source = await readFile('src/routes/applications.ts', 'utf8');
  const submitRequest = routeSlice(
    source,
    "'/applications/:id/submit-request'",
    "'/applications/:id/submission/channels'",
  );
  const unsupportedGate = submitRequest.indexOf('&& sensitive)');
  const unsupportedSend = submitRequest.indexOf('sendUnsupportedPortalApplicationEmail');
  assert.ok(unsupportedGate >= 0 && unsupportedSend > unsupportedGate, 'email fallback must stay behind the sensitive gate');
  assert.match(submitRequest, /Sensitive question requires your attention/);

  const approval = routeSlice(
    source,
    "'/applications/:id/submission/approve'",
    "'/applications/:id/status'",
  );
  assert.match(approval, /const sensitive = sensitiveQuestionFor\(approvalReview\.questions/);
  assert.match(approval, /if \(sensitive\) \{/);
  assert.match(approval, /approvalIssues\.push\(`Sensitive question requires your attention:/);
});

test('direct browser send remains blocked by discovered sensitive and self-declaration attention', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');

  assert.match(runner, /sensitive question left for you:/);
  assert.match(runner, /if \(isSelfDeclarationQuestion\(label\)\) \{/);
  assert.match(runner, /attentionReasons\.push\(selfDeclarationSkipReason\(label\)\)/);
  assert.match(runner, /attentionCount: discoveryAttention\.length/);

  const safety = await readFile('src/lib/submissionSafety.ts', 'utf8');
  assert.match(safety, /options\.attentionCount === 0/);
});

test('claimed or uncertain packets cannot restart a fill run', () => {
  assert.equal(submitRequestDisposition('needs_attention', true), 'reject');
  assert.equal(submitRequestDisposition('ready_for_final_approval', true), 'reject');
  assert.equal(submitRequestDisposition('submitting', true), 'in_flight');
  assert.equal(submitRequestDisposition('submitted', true), 'submitted');
});
