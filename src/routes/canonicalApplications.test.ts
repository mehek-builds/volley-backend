import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  canonicalApplicationFingerprint,
  canonicalManualDocumentBindingFromSnapshot,
  canonicalPortalIdentity,
  canonicalPortalUrl,
  fillApplicationSchema,
  isResumeArtifactKind,
  lifecycleStateAfterFill,
  manualOutcomeEventDecision,
  manualSubmissionOutcomeSchema,
  manualSubmissionTransition,
} from './canonicalApplications';
import { companyDomainFor } from '../lib/companyDomains';
import { CANONICAL_FREE_NONE_BINDING } from '../lib/canonicalFreeDocumentBinding';

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
    assert.match(route, /await lockSubmissionAttemptUser\(tx, userId\)[\s\S]*?\.for\('update'\)/);
    assert.match(route, /duplicateApplicationVerdict\([\s\S]*?, tx\)/);
    assert.match(route, /eventKind: 'attempt_opened'/);
    assert.match(route, /eventKind: 'boundary_authorized'|authorizeFinalSubmissionBoundary/);
    assert.match(route, /eventKind: 'press_observed'/);
    assert.match(route, /eventKind: 'submission_confirmed'/);
    assert.match(route, /authoritativeConfirmedProjectionMatches/);
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
      /\b(?:fetch|putObject|deleteObject|sendEmail|enqueue|publish)\s*\(/,
      'the whole-transaction retry callback must remain free of external side effects',
    );
    assert.match(transactionBody, /canonicalManualDocumentBinding\(tx, currentApplication\)/);
    assert.match(transactionBody, /submissionAttemptEventsForPacket\([\s\S]*?\{ executor: tx \}\)/);
    assert.match(transactionBody, /appendSubmissionAttemptEvent\([\s\S]*?\{ executor: tx \}\)/);
    assert.match(transactionBody, /authoritativeSubmissionProjection\([\s\S]*?executor: tx/);
  });

  test('canonical manual outcomes freeze an exact no-resume document binding', () => {
    const application = {
      id: 'fd3a3c21-e8c2-4677-80e4-429d96a40cb9',
      user_id: 'cf48e921-8543-466c-b51f-1598fd723235',
      selected_resume_artifact_id: null,
      resume_attached: false,
      resume_source: 'none',
      resume_attached_at: null,
    };
    assert.equal(canonicalManualDocumentBindingFromSnapshot({
      application: application as never,
      links: [],
      artifact: null,
      versions: [],
    }), CANONICAL_FREE_NONE_BINDING);
    assert.equal(canonicalManualDocumentBindingFromSnapshot({
      application: { ...application, resume_attached: true } as never,
      links: [],
      artifact: null,
      versions: [],
    }), null);
    assert.equal(canonicalManualDocumentBindingFromSnapshot({
      application: {
        ...application,
        resume_source: 'base_resume',
        resume_attached: true,
        resume_attached_at: new Date('2026-08-31T10:00:00.000Z'),
      } as never,
      links: [],
      artifact: null,
      versions: [],
    }), null);
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

/*
 * The Tracker draws a company's logo beside its name the way Jobs and Home already do, and it can
 * only do that if this route tells it the employer's domain. The dashboard has the company NAME and
 * nothing else, and a domain guessed from a name is how a row ends up wearing another company's
 * logo - which tells a student this application is to a different employer than it is. So the
 * resolution happens here, against the same verified map the job board and the notification emails
 * use, and the client renders a monogram whenever this is null rather than a wrong icon.
 */
describe('the canonical application response carries the company domain', () => {
  const source = readFileSync('src/routes/canonicalApplications.ts', 'utf8');

  test('every listed application resolves its domain from the shared map', () => {
    assert.match(source, /company_domain: companyDomainFor\(row\.company_name\)/);
    assert.match(source, /import \{ companyDomainFor \} from '\.\.\/lib\/companyDomains'/);
  });

  test('it is resolved in the one response builder, so every route that returns an application has it', () => {
    /* applicationResponse is what the list, the create and the detail routes all return. Resolving
       it at one of those call sites instead would give the Tracker logos on some screens only. */
    const builder = source.slice(source.indexOf('function applicationResponse('));
    const body = builder.slice(0, builder.indexOf('\n}'));
    assert.match(body, /company_domain:/);
  });

  test('a company the map does not know resolves to null, never to a guess', () => {
    assert.equal(companyDomainFor('a company that is not in the map at all'), null);
    assert.equal(companyDomainFor(''), null);
    assert.equal(companyDomainFor(null), null);
  });

  test('a known company resolves to the employer domain and not to its job board', () => {
    const notion = companyDomainFor('Notion');
    assert.ok(notion, 'the map has to know at least one of the companies this dashboard shows');
    assert.doesNotMatch(notion, /greenhouse|lever|ashby|workday|myworkdayjobs/);
  });
});
