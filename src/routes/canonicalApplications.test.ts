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
  manualSubmissionResolutionDecision,
  manualSubmissionResolutionSchema,
  manualSubmissionStartSchema,
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
    assert.match(source, /handoff: fillHandoffResponse\(\{ \.\.\.activeApplication, portal_url: portalUrl \}\)/);
    assert.match(source, /application: applicationResponse\(\{ \.\.\.activeApplication, portal_url: portalUrl \}\)/);
    assert.match(source, /account_id: userId/);
    assert.match(source, /legacy_generated_resume_id: row\.legacy_generated_resume_id/);
    assert.match(source, /code: 'unsafe_portal_url'/);
    assert.match(source, /\.\.\.\(resumeAttached \? \[\] : \['resume_attachment'\]\)/);
    assert.doesNotMatch(source, /selectedResumeArtifactId \? \[\] : \['resume_attachment'\]/);
  });

  test('records owner-scoped native submission outcomes without an automation gate', () => {
    assert.equal(manualSubmissionStartSchema.safeParse({
      event_id: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
      current_url: 'https://jobs.example.com/apply/1',
    }).success, true);
    assert.equal(manualSubmissionOutcomeSchema.safeParse({
      event_id: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
      outcome: 'confirmed',
      final_url: 'https://jobs.example.com/apply/receipt',
      confirmation_text: 'Application received',
    }).success, true);
    assert.equal(manualSubmissionOutcomeSchema.safeParse({
      event_id: 'not-an-id', outcome: 'confirmed', final_url: 'https://jobs.example.com',
    }).success, false);
    assert.equal(manualSubmissionResolutionSchema.safeParse({
      attempt_id: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
      found: false,
    }).success, true);
    assert.equal(manualSubmissionResolutionSchema.safeParse({
      attempt_id: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
      found: false,
      reason: 'extension_cancelled_before_press',
    }).success, true);
    assert.equal(manualSubmissionResolutionSchema.safeParse({
      attempt_id: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
      found: true,
      reason: 'extension_cancelled_before_press',
    }).success, false);
    assert.equal(manualSubmissionResolutionSchema.safeParse({
      attempt_id: 'not-an-id',
      found: false,
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
    assert.equal(manualOutcomeEventDecision({ ...existing, outcome: 'failed' }, {
      applicationId: 'app-1',
      portalIdentity: 'https://jobs.example.com',
      outcome: 'confirmed',
      finalUrl: 'https://jobs.example.com/apply/receipt',
      confirmationText: 'Application received',
    }), 'promote');
    assert.equal(manualOutcomeEventDecision(existing, {
      applicationId: 'app-2',
      portalIdentity: 'https://jobs.example.com',
      outcome: 'confirmed',
      finalUrl: 'https://jobs.example.com/apply/receipt',
      confirmationText: null,
    }), 'binding_conflict');

    assert.equal(manualSubmissionResolutionDecision({
      kind: 'blocked_unverified',
      attemptId: 'attempt-1',
      at: '2026-08-24T10:00:00.000Z',
      reason: 'pressed',
    }, false), 'resolve');
    assert.equal(manualSubmissionResolutionDecision({
      kind: 'blocked_unverified',
      attemptId: 'attempt-1',
      at: '2026-08-24T10:00:00.000Z',
      reason: 'boundary_authorized',
      leaseId: 'lease-1',
      expiresAt: '2026-08-24T10:03:00.000Z',
    }, false), 'not_resolvable');
    assert.equal(manualSubmissionResolutionDecision({
      kind: 'blocked_unverified',
      attemptId: 'attempt-1',
      at: '2026-08-24T10:00:00.000Z',
      reason: 'boundary_authorized',
      leaseId: 'lease-1',
      expiresAt: '2026-08-24T10:03:00.000Z',
    }, true), 'resolve');
    assert.equal(manualSubmissionResolutionDecision({
      kind: 'safe_not_sent',
      attemptId: 'attempt-1',
      proofKind: 'applicant_checked_not_sent',
      resolvedAt: '2026-08-24T10:05:00.000Z',
    }, false), 'exact_replay');
    assert.equal(manualSubmissionResolutionDecision({
      kind: 'safe_not_sent',
      attemptId: 'attempt-1',
      proofKind: 'applicant_checked_not_sent',
      resolvedAt: '2026-08-24T10:05:00.000Z',
    }, true), 'resolve');
    assert.equal(manualSubmissionResolutionDecision({
      kind: 'blocked_confirmed',
      attemptId: 'attempt-1',
      confirmedAt: '2026-08-24T10:05:00.000Z',
    }, false), 'terminal_conflict');
    assert.equal(manualSubmissionResolutionDecision({
      kind: 'blocked_unverified',
      attemptId: 'attempt-1',
      at: '2026-08-24T10:00:00.000Z',
      reason: 'invalid_sequence',
    }, false), 'not_resolvable');

    const source = readFileSync('src/routes/canonicalApplications.ts', 'utf8');
    const startRoute = source.slice(source.indexOf("fastify.post('/applications/:id/manual-submission-start'"), source.indexOf("fastify.post('/applications/:id/manual-submission-outcome'"));
    const resolutionRoute = source.slice(source.indexOf("fastify.post('/applications/:id/manual-submission-resolution'"), source.indexOf("fastify.post('/applications/:id/manual-submission-outcome'"));
    const route = source.slice(source.indexOf("fastify.post('/applications/:id/manual-submission-outcome'"), source.indexOf("fastify.get('/applications/:id/fill-data'"));
    assert.match(startRoute, /lockSubmissionAttemptUser\(tx, userId\)/);
    assert.match(startRoute, /duplicateApplicationVerdict\(\{/);
    assert.match(startRoute, /eventKind: 'attempt_opened'/);
    assert.match(startRoute, /safety\.kind === 'blocked_unverified' && safety\.reason === 'opened'/);
    assert.match(startRoute, /manual_submission_outcome_unresolved/);
    assert.match(resolutionRoute, /lockSubmissionAttemptUser\(tx, userId\)/);
    assert.match(resolutionRoute, /canonicalAttemptEventMayMutateApplication\(tx, userId, opening, currentApplication\)/);
    assert.match(resolutionRoute, /manualSubmissionResolutionDecision\(exactSafety, parsed\.data\.found\)/);
    assert.match(resolutionRoute, /'applicant_checked_not_sent' as const/);
    assert.match(resolutionRoute, /const boundaryAuthorizationEvent = events\.find\([\s\S]*?event\.event_kind === 'boundary_authorized'/);
    assert.match(resolutionRoute, /machinePreClickCleanup && boundaryAuthorizationEvent/);
    assert.match(resolutionRoute, /!parsed\.data\.found && boundaryAuthorizationEvent/);
    assert.match(resolutionRoute, /exactAttemptPermanentlyBlocksNegativeResolution\(events, parsed\.data\.attempt_id\)/);
    assert.match(resolutionRoute, /code: 'manual_submission_permanent_duplicate_risk'/);
    assert.doesNotMatch(resolutionRoute, /!parsed\.data\.found[\s\S]{0,180}authorization\?\.active/);
    assert.match(resolutionRoute, /exactBoundaryConfirmation[\s\S]{0,180}exactSafety\.kind === 'blocked_unverified'/);
    assert.match(resolutionRoute, /machinePreClickCleanup[\s\S]*?exactSafety\.reason !== 'opened'/);
    assert.match(resolutionRoute, /events\.some\(\(event\) => event\.event_kind !== 'attempt_opened'\)/);
    assert.match(resolutionRoute, /'extension_cancelled_before_press' as const/);
    assert.match(resolutionRoute, /machinePreClickCleanup \? 'extension-cancelled-before-press' : 'applicant-resolution'/);
    assert.match(resolutionRoute, /retry_safety: result\.retrySafety/);
    assert.match(resolutionRoute, /result\.kind === 'not_found'[\s\S]*?retry_safety: await canonicalSubmissionRetrySafety\(application\)/);
    assert.ok(
      resolutionRoute.indexOf("if (!parsed.data.found && boundaryAuthorizationEvent)")
        < resolutionRoute.indexOf("const eventKind = parsed.data.found"),
      'a boundary-authorized negative answer must fail before not_sent_proven can be selected',
    );
    assert.match(route, /ownedApplication\(request, reply, parsed\.data\.event_id\)/);
    assert.match(route, /portal_identity_mismatch/);
    assert.match(route, /submission_event_binding_conflict/);
    assert.match(route, /submission_event_terminal/);
    assert.match(route, /lockSubmissionAttemptUser\(tx, userId\)/);
    assert.match(route, /appendCanonicalManualSubmissionFacts\(\{/);
    assert.doesNotMatch(route, /automatic_submission|requireFeature|reserveEntitledUsage/);
    assert.match(source, /const expectedPacketId = input\.application\.legacy_generated_resume_id \?\? input\.application\.id/);
    assert.match(source, /packetId: expectedPacketId/);
    assert.match(source, /eventKind: 'attempt_opened'/);
    assert.match(source, /eventKind: 'press_observed'/);
    assert.match(source, /const live = freezePostingIdentity\(\{[\s\S]{0,120}role: application\.role,[\s\S]{0,40}\}, currentUrl\)/);
    assert.doesNotMatch(source, /const live = freezePostingIdentity\(\{[\s\S]{0,120}job_id: application\.job_id/);
    assert.match(startRoute, /const storedPosting = freezePostingIdentity\(/);
    assert.match(startRoute, /manualSubmissionPostingMatches\(storedPosting, currentApplication, currentUrl\)/);
    assert.match(source, /if \(input\.outcome === 'confirmed'\)[\s\S]{0,500}eventKind: 'submission_confirmed'/);
    assert.doesNotMatch(source, /input\.outcome === 'failed'[\s\S]{0,300}not_sent_proven/);
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
      /await\s+(?!(?:tx\.|lockSubmissionAttemptUser\(|canonicalApplicationForExactAttempt\(|appendCanonicalManualSubmissionFacts\(|canonicalSubmissionRetrySafety\())|\b(?:fetch|putObject|deleteObject|sendEmail|enqueue|publish)\s*\(/,
      'the whole-transaction retry callback must contain only direct database work or audited ledger helpers bound to the same executor',
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
