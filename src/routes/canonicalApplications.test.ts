import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  canonicalApplicationFingerprint,
  canonicalPortalIdentity,
  canonicalPortalUrl,
  fillApplicationSchema,
  isResumeArtifactKind,
  lifecycleStateAfterFill,
  manualOutcomeEventDecision,
  manualSubmissionOutcomeSchema,
  manualSubmissionTransition,
} from './canonicalApplications';

describe('canonical Free application contract', () => {
  test('prefers stable job identity and otherwise hashes portal identity', () => {
    assert.equal(canonicalApplicationFingerprint({
      jobId: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
      companyScopeKey: 'domain:example.com',
      role: 'Engineer',
    }), 'job:6d58c1f5-e885-41f7-a16a-dac37f98ab17');
    assert.equal(
      canonicalApplicationFingerprint({ portalUrl: 'https://example.com/apply', companyScopeKey: 'domain:example.com', role: 'Engineer' }),
      canonicalApplicationFingerprint({ portalUrl: 'https://example.com/apply', companyScopeKey: 'domain:other.com', role: 'Other' }),
    );
  });

  test('requires HTTPS for production portal handoffs and strips tracking fragments', () => {
    assert.throws(() => canonicalPortalUrl('http://example.com/jobs/1', true));
    assert.equal(
      canonicalPortalUrl('https://example.com/jobs/1/?utm_source=test#apply', true),
      'https://example.com/jobs/1',
    );
  });

  test('keeps create and fill outside premium generation', () => {
    const source = readFileSync('src/routes/canonicalApplications.ts', 'utf8');
    assert.match(source, /fastify\.post\('\/applications'/);
    assert.match(source, /fastify\.post\('\/applications\/:id\/fill'/);
    assert.match(source, /fastify\.get\('\/applications\/:id\/fill-data'/);
    assert.match(source, /fastify\.post\('\/applications\/:id\/manual-submission-outcome'/);
    assert.doesNotMatch(source, /reserveEntitledUsage|requireFeature/);
    assert.match(source, /application_fill: true/);
    assert.match(source, /resume_attached: resumeAttached/);
    assert.match(source, /resume_source: resumeSource/);
    assert.match(source, /automatic_submission_allowed: automaticSubmissionEnabled/);
    assert.match(source, /mode: 'extension_portal_fill'/);
    assert.match(source, /fill_data_url: `\/applications\/\$\{row\.id\}\/fill-data`/);
    assert.match(source, /handoff: fillHandoffResponse\(updated \?\? application\)/);
    assert.match(source, /handoff: fillHandoffResponse\(\{ \.\.\.application, portal_url: portalUrl \}\)/);
    assert.match(source, /application: applicationResponse\(\{ \.\.\.application, portal_url: portalUrl \}\)/);
    assert.match(source, /account_id: userId/);
    assert.match(source, /legacy_generated_resume_id: row\.legacy_generated_resume_id/);
    assert.match(source, /code: 'unsafe_portal_url'/);
    assert.match(source, /\.\.\.\(resumeAttached \? \[\] : \['resume_attachment'\]\)/);
    assert.doesNotMatch(source, /selectedResumeArtifactId \? \[\] : \['resume_attachment'\]/);
  });

  test('records owner-scoped native submission outcomes without an automation gate', () => {
    assert.equal(manualSubmissionOutcomeSchema.safeParse({
      event_id: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
      outcome: 'confirmed',
      final_url: 'https://jobs.example.com/apply/receipt',
      confirmation_text: 'Application received',
    }).success, true);
    assert.equal(manualSubmissionOutcomeSchema.safeParse({
      event_id: 'not-an-id', outcome: 'confirmed', final_url: 'https://jobs.example.com',
    }).success, false);
    assert.equal(canonicalPortalIdentity('https://JOBS.example.com/apply/1?utm_source=litos'), 'https://jobs.example.com');
    assert.deepEqual(manualSubmissionTransition('not_started', 'unknown'), {
      submissionState: 'needs_attention', trackerState: 'applying',
    });
    assert.deepEqual(manualSubmissionTransition('needs_attention', 'confirmed'), {
      submissionState: 'submitted', trackerState: 'applied',
    });
    assert.deepEqual(manualSubmissionTransition('submitted', 'failed'), {
      submissionState: 'submitted', trackerState: 'applied',
    });

    const existing = {
      application_id: 'app-1',
      portal_identity: 'https://jobs.example.com',
      outcome: 'unknown',
      final_url: 'https://jobs.example.com/apply/1',
      confirmation_text: null,
    };
    assert.equal(manualOutcomeEventDecision(existing, {
      applicationId: 'app-1',
      portalIdentity: 'https://jobs.example.com',
      outcome: 'unknown',
      finalUrl: 'https://jobs.example.com/apply/1',
      confirmationText: null,
    }), 'exact_replay');
    assert.equal(manualOutcomeEventDecision(existing, {
      applicationId: 'app-1',
      portalIdentity: 'https://jobs.example.com',
      outcome: 'confirmed',
      finalUrl: 'https://jobs.example.com/apply/receipt',
      confirmationText: 'Application received',
    }), 'promote');
    assert.equal(manualOutcomeEventDecision({ ...existing, outcome: 'confirmed' }, {
      applicationId: 'app-1',
      portalIdentity: 'https://jobs.example.com',
      outcome: 'failed',
      finalUrl: 'https://jobs.example.com/apply/failure',
      confirmationText: null,
    }), 'terminal_conflict');
    assert.equal(manualOutcomeEventDecision(existing, {
      applicationId: 'app-2',
      portalIdentity: 'https://jobs.example.com',
      outcome: 'confirmed',
      finalUrl: 'https://jobs.example.com/apply/receipt',
      confirmationText: null,
    }), 'binding_conflict');

    const source = readFileSync('src/routes/canonicalApplications.ts', 'utf8');
    const route = source.slice(source.indexOf("fastify.post('/applications/:id/manual-submission-outcome'"), source.indexOf("fastify.get('/applications/:id/fill-data'"));
    assert.match(route, /ownedApplication\(request, reply\)/);
    assert.match(route, /portal_identity_mismatch/);
    assert.match(route, /submission_event_binding_conflict/);
    assert.match(route, /submission_event_terminal/);
    assert.doesNotMatch(route, /automatic_submission|requireFeature|reserveEntitledUsage/);
  });

  test('retries native submission outcome transactions without replaying external work', () => {
    const source = readFileSync('src/routes/canonicalApplications.ts', 'utf8');
    const route = source.slice(
      source.indexOf("fastify.post('/applications/:id/manual-submission-outcome'"),
      source.indexOf("fastify.get('/applications/:id/fill-data'"),
    );
    const originValidation = route.indexOf('canonicalPortalIdentity(finalUrl)');
    const transaction = route.indexOf('const runManualSubmissionOutcomeTransaction =');
    const retry = route.indexOf('const result = await withReadOnlyRetry(');
    const directFallback = route.indexOf('onExhausted: () => withDedicatedDatabase');
    const directTransaction = route.indexOf('runManualSubmissionOutcomeTransaction(directDb)');
    const response = route.indexOf("return reply.header('Cache-Control'", retry);

    assert.ok(originValidation >= 0 && transaction > originValidation && retry > transaction
      && directFallback > retry && directTransaction > directFallback && response > directTransaction,
    'URL validation and response serialization must stay outside the retried database transaction');
    assert.match(route, /withReadOnlyRetry\(\s*\(\) => runManualSubmissionOutcomeTransaction\(db\)/);
    assert.match(route, /onExhausted: \(\) => withDedicatedDatabase/);
    assert.match(route, /runManualSubmissionOutcomeTransaction\(directDb\)/);

    const transactionBody = route.slice(transaction, retry);
    assert.doesNotMatch(
      transactionBody,
      /await\s+(?!tx\.)|\b(?:fetch|putObject|deleteObject|sendEmail|enqueue|publish)\s*\(/,
      'the whole-transaction retry callback must remain free of non-database awaited or external side effects',
    );
  });

  test('allows base and tailored resume artifacts but not unrelated generated documents', () => {
    assert.equal(isResumeArtifactKind('resume'), true);
    assert.equal(isResumeArtifactKind('tailored_resume'), true);
    assert.equal(isResumeArtifactKind('cover_letter'), false);
    assert.equal(isResumeArtifactKind('transcript'), false);
  });

  test('requires explicit and internally consistent resume attachment state', () => {
    assert.equal(fillApplicationSchema.safeParse({
      resume_attached: true,
      resume_source: 'base_resume',
    }).success, true);
    assert.equal(fillApplicationSchema.safeParse({
      resume_attached: true,
      resume_source: 'artifact',
      selected_resume_artifact_id: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
    }).success, true);
    assert.equal(fillApplicationSchema.safeParse({ resume_attached: true }).success, false);
    assert.equal(fillApplicationSchema.safeParse({
      resume_attached: false,
      resume_source: 'base_resume',
    }).success, false);
    assert.equal(fillApplicationSchema.safeParse({
      resume_attached: true,
      resume_source: 'none',
    }).success, false);
    assert.deepEqual(lifecycleStateAfterFill({
      tracker_state: 'applied', review_state: 'ready', submission_state: 'submitted',
    }), { trackerState: 'applied', reviewState: 'ready' });
    assert.deepEqual(lifecycleStateAfterFill({
      tracker_state: 'saved', review_state: 'not_started', submission_state: 'not_started',
    }), { trackerState: 'applying', reviewState: 'filling' });
  });
});
