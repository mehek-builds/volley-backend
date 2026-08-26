import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/routes/applications.ts', 'utf8');

function returnedReplyBodies(route: string): string[] {
  const bodies: string[] = [];
  const starts = [...route.matchAll(/return reply(?:\.status\([^)]*\))?\.send\(/g)];
  for (const start of starts) {
    const open = start.index! + start[0].length - 1;
    let depth = 0;
    let quote: "'" | '"' | '`' | null = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = open; index < route.length; index += 1) {
      const char = route[index];
      const next = route[index + 1];
      if (lineComment) {
        if (char === '\n') lineComment = false;
        continue;
      }
      if (blockComment) {
        if (char === '*' && next === '/') {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '/' && next === '/') {
        lineComment = true;
        index += 1;
        continue;
      }
      if (char === '/' && next === '*') {
        blockComment = true;
        index += 1;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') {
        quote = char;
        continue;
      }
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          bodies.push(route.slice(open + 1, index));
          break;
        }
      }
    }
  }
  return bodies;
}

test('extension submission routes keep auth, ownership, quota, and claims server-side', () => {
  assert.match(source, /submission\/extension-start'[\s\S]*?preHandler: requireAuth/);
  assert.match(source, /submission\/extension-outcome'[\s\S]*?preHandler: requireAuth/);
  assert.match(source, /lockSubmissionAttemptUser\(tx, userId\)/);
  assert.match(source, /eq\(generated_resumes\.user_id, userId\)/);
  assert.match(source, /submission_claimed_at' is null/);
  assert.match(source, /submission_claim_id' = \$\{input\.claimId\}/);
  assert.match(source, /submission_claim_id'->|submission_claim_id/);
});

test('the 0.6.2 generated extension lane is paused before any claim or boundary mutation', () => {
  const route = source.slice(
    source.indexOf("'/applications/:id/submission/extension-start'"),
    source.indexOf("'/applications/:id/submission/extension-outcome'"),
  );
  assert.match(source, /export const GENERATED_EXTENSION_SUBMISSION_ENABLED = false/);
  const pause = route.indexOf('if (!GENERATED_EXTENSION_SUBMISSION_ENABLED)');
  const typedCode = route.indexOf("code: 'GENERATED_EXTENSION_SUBMISSION_PAUSED'", pause);
  const parse = route.indexOf('extensionStartBodySchema.safeParse', pause);
  const transaction = route.indexOf('database.transaction(async (tx) =>', pause);
  const opening = route.indexOf("appendApplicationAttemptFact(attemptBinding, 'attempt_opened'", pause);
  const boundary = route.indexOf('finalApplicationBoundaryGate({', pause);
  assert.ok(
    pause >= 0
      && typedCode > pause
      && parse > typedCode
      && transaction > parse
      && opening > transaction
      && boundary > opening,
    'the typed pause response must return before parsing can reach the claim transaction or boundary gate',
  );
  assert.match(route.slice(pause, parse), /reply\.status\(409\)\.send\(\{[\s\S]*?retry_safety:/);
});

test('Free attended submissions stay manual while standing consent remains entitlement-gated', () => {
  const route = source.slice(
    source.indexOf("'/applications/:id/submission/extension-start'"),
    source.indexOf("'/applications/:id/submission/extension-outcome'"),
  );
  assert.match(route, /extensionAuthorizationRequiresAutomaticSubmission\(parsed\.data\.authorization\)/);
  assert.match(route, /requireFeature\([\s\S]*?'automatic_submission'/);
  assert.ok(
    route.indexOf('extensionAuthorizationRequiresAutomaticSubmission(parsed.data.authorization)')
      < route.indexOf("'automatic_submission'"),
  );
});

test('attended extension refill returns the exact owned generated packet and a fresh resume capability', () => {
  const route = source.slice(
    source.indexOf("'/applications/:id/submission/extension-packet'"),
    source.indexOf("'/applications/:id/submission/extension-start'"),
  );
  assert.match(route, /preHandler: requireAuth/);
  assert.match(route, /const row = await ownedResume\(request, reply\)/);
  assert.match(source, /eq\(generated_resumes\.user_id, request\.jwtPayload!\.userId\)/);
  assert.match(route, /extensionPacketQuerySchema\.safeParse\(request\.query\)/);
  assert.match(route, /extensionHandoffPacketMatches\(/);
  assert.match(route, /frozenHandoffUrl: review\.extension_handoff_url/);
  assert.match(route, /row\.resume_object_key/);
  assert.match(route, /mintDownloadToken\([\s\S]*?row\.resume_object_key/);
  assert.match(route, /resume_id: row\.id/);
  assert.match(route, /handoff_version: handoffVersion/);
  assert.match(route, /extensionHandoffVersion\([\s\S]*?applicationId: row\.id[\s\S]*?resumeObjectKey: row\.resume_object_key[\s\S]*?spec: row\.spec[\s\S]*?jobContext: row\.job_context/);
  /* The whole stored packet still goes to the extension, minus the Blob pointers on any document
   * she attached. This pin used to read `spec: stored`, which is how that payload came to be
   * handing a content script running in the employer's page origin a key that is permanent
   * unauthenticated access to a student's transcript. The extension has no file channel for a
   * document anyway: its only one is the resume capability token minted a few lines above. */
  assert.match(route, /application: \{ id: row\.id, spec: specWithoutDocumentPointers\(stored\) \}/);
  /* And the RAW spec is still what the handoff version hashes, deliberately. That value binds the
   * packet the extension is about to fill; stripping a field out of its input would change every
   * version string on an application that has an attachment. */
  assert.match(route, /extensionHandoffVersion\(\{[\s\S]*?spec: row\.spec,/);
  assert.match(route, /applicant_snapshot: review\.applicant_snapshot/);
  assert.match(route, /review\.ats_name === 'jobvite'[\s\S]*?review\.ats_name === 'icims'[\s\S]*?review\.ats_name === 'oraclecloud'[\s\S]*?!review\.applicant_snapshot/);
  assert.doesNotMatch(route, /resume\/generate/);
  assert.ok(route.indexOf('ownedResume(request, reply)') < route.indexOf('extensionHandoffPacketMatches('));
  assert.ok(route.indexOf('extensionHandoffPacketMatches(') < route.indexOf('mintDownloadToken('));
});

test('attended extension start validates every supplied binding and carries one audited question snapshot into its exact-CAS claim', () => {
  const route = source.slice(
    source.indexOf("'/applications/:id/submission/extension-start'"),
    source.indexOf("'/applications/:id/submission/extension-outcome'"),
  );
  assert.match(route, /extensionStartHandoffBinding\(/);
  assert.match(route, /binding === 'missing'/);
  assert.match(route, /binding === 'mismatch'/);
  assert.match(route, /binding === 'stale'/);
  assert.doesNotMatch(route, /extension_handoff_url\).*binding/);
  assert.match(route, /const packetQuestions = resolvePacketAuditQuestionFixpoint\(/);
  assert.match(route, /questions:\s*packetQuestions/);
  assert.match(route, /precheckPacketQuestions = packetQuestions/);
  assert.match(route, /const refreshedQuestions = precheckPacketQuestions;/);
  assert.equal(route.match(/resolvePacketAuditQuestionFixpoint\(/g)?.length, 1,
    'the transaction must not produce a second question identity from a later profile or clock read');
  assert.equal(route.match(/loadSensitiveQuestionProfile\(/g)?.length, 1,
    'the profile that produced the audited snapshot must also drive the send-time sensitive gate');
  assert.doesNotMatch(route, /parsed\.data\.handoff_version && !isDeepStrictEqual/,
    'legacy clients without a handoff version must not be allowed to send a second snapshot');
  assert.match(route, /generated_resumes\.spec\} = \$\{JSON\.stringify\(precheckRow\.spec\)\}::jsonb/);
  assert.match(route, /row\.resume_object_key !== precheckRow\.resume_object_key/);
  assert.match(route, /isDeepStrictEqual\(row\.job_context, precheckRow\.job_context\)/);
  assert.match(route, /generated_resumes\.resume_object_key\} is not distinct from \$\{precheckRow\.resume_object_key\}/);
  assert.match(route, /generated_resumes\.job_context\} is not distinct from/);
});

test('review writes compare the complete packet, not only its status', () => {
  const route = source.slice(
    source.indexOf("'/applications/:id/review'"),
    source.indexOf("'/applications/:id/submit-request'"),
  );
  assert.match(route, /eq\(generated_resumes\.user_id, request\.jwtPayload!\.userId\)/);
  assert.match(route, /generated_resumes\.spec\} = \$\{JSON\.stringify\(row\.spec\)\}::jsonb/);
});

test('extension outcomes only mark confirmed claims applied', () => {
  const outcomeContract = source.slice(
    source.indexOf('async function verifyExtensionOutcomePacket('),
    source.indexOf('function finalApplicationAuthorizationMatches('),
  );
  const outcomeCommit = source.slice(
    source.indexOf('export async function commitExtensionSubmissionOutcome('),
    source.indexOf('function finalApplicationAuthorizationMatches('),
  );
  /* The stage write is gated on the DERIVED outcome, not the reported one: a claimed confirmation
   * without a sufficient employer receipt is downgraded first, and only what survives that may mark
   * the packet applied. */
  assert.match(outcomeCommit, /outcome === 'confirmed'[\s\S]{0,120}pipeline_stage: 'applied'/);
  assert.match(outcomeCommit, /input\.reportedOutcome === 'confirmed' && !extensionEmployerReceiptIsSufficient/);
  assert.match(outcomeCommit, /const exactClaim = current\.submission_claim_id === input\.claimId/);
  assert.match(outcomeCommit, /const confirmedRecovery = outcome === 'confirmed'/);
  assert.match(source, /extensionReceiptUrlSchema/);
  assert.match(outcomeCommit, /extensionEmployerReceiptIsSufficient\(/);
  assert.match(outcomeCommit, /outcome === 'confirmed'/);
  assert.match(outcomeContract, /questions:\s*review\.questions/,
    'non-confirmed outcome transitions must still use the stored packet snapshot');
  assert.doesNotMatch(outcomeContract, /resolvedPacketAuditQuestions\(/,
    'post-send profile or clock drift must not prevent receipt recording');
  assert.match(outcomeCommit, /if \(outcome !== 'confirmed'\)[\s\S]*?audited\.verification\.valid/,
    'only a non-confirmed outcome is decided by the packet audit');
  assert.doesNotMatch(outcomeCommit, /if \(outcome === 'confirmed'\)[\s\S]{0,160}verifyPacket/,
    'a sufficient exact employer receipt must not be vetoed by packet drift after the press');
  assert.match(outcomeCommit, /extensionOutcomeForReceipt\(input, review\) === 'confirmed'\) return null/,
    'the confirmed path must not pay for an audit it is forbidden to act on');

  /* THE DEADLOCK THIS REPLACED. currentAcknowledgedPacketAudit reads the pooled handle and can
   * fetch the resume; on Vercel the pool is one client, so awaiting it inside the locked
   * transaction waited on the client that transaction was holding, forever. The press_observed
   * fact rolled back with it, so a run that pressed Submit at the employer recorded nothing. The
   * audit must therefore be computed before the transaction opens, and the locked body may only
   * consume a verdict whose spec still matches byte for byte. */
  const lockedBody = source.slice(
    source.indexOf('async function commitAuditedExtensionOutcome('),
    source.indexOf('function extensionOutcomeForReceipt('),
  );
  assert.doesNotMatch(lockedBody, /await verifyPacket\(/,
    'the packet audit must never run inside the locked transaction');
  assert.doesNotMatch(lockedBody, /currentAcknowledgedPacketAudit\(/,
    'no pooled packet-audit read may run inside the locked transaction');
  assert.match(lockedBody, /audited\.specJson !== JSON\.stringify\(latest\.spec\)[\s\S]*?audit_stale/,
    'a verdict whose row moved must be re-audited, never applied to different bytes');
  const pressIndex = lockedBody.indexOf("'press_observed'");
  const verdictIndex = lockedBody.indexOf('audited.verification.valid');
  assert.ok(pressIndex >= 0 && verdictIndex > pressIndex,
    'the pressed-submit fact must be appended before the audit can return, so a failed audit still commits it');
});

test('extension claim reservation and outcome evidence fail closed across retries', () => {
  const start = source.slice(
    source.indexOf("'/applications/:id/submission/extension-start'"),
    source.indexOf("'/applications/:id/submission/extension-outcome'"),
  );
  const lock = start.indexOf('lockSubmissionAttemptUser(tx, userId)');
  const duplicate = start.indexOf('duplicateApplicationVerdict({', lock);
  const claim = start.indexOf('tx.update(generated_resumes)', duplicate);
  const reserve = start.indexOf("appendApplicationAttemptFact(attemptBinding, 'attempt_opened'", claim);
  assert.ok(lock >= 0 && duplicate > lock && claim > duplicate && reserve > claim,
    'the user lock, duplicate gate, row claim, and immutable opening must share one transaction');
  assert.match(start, /evidenceCode: 'atomic_extension_claim_reserved'/);

  const outcome = source.slice(
    source.indexOf('export async function commitExtensionSubmissionOutcome('),
    source.indexOf('function finalApplicationAuthorizationMatches('),
  );
  const validate = outcome.indexOf('extensionAttemptBindingMatches(');
  const press = outcome.indexOf("appendApplicationAttemptFact(binding, 'press_observed'");
  assert.ok(validate >= 0 && press > validate,
    'the exact immutable extension binding must be validated before any outcome fact is appended');
  const matcher = source.slice(
    source.indexOf('export function extensionAttemptBindingMatches('),
    source.indexOf('function finalApplicationAuthorizationMatches('),
  );
  assert.match(matcher, /binding\.source === 'chrome_extension'/);
  assert.match(matcher, /binding\.operation === 'initial_submission'/);
  assert.match(matcher, /binding\.packetId === row\.id/);
  assert.match(matcher, /binding\.submissionClaimId === claimId/);
  const outcomeRoute = source.slice(
    source.indexOf("'/applications/:id/submission/extension-outcome'"),
    source.indexOf("'/applications/:id/resume'"),
  );
  assert.match(outcomeRoute, /EXTENSION_ATTEMPT_BINDING_MISMATCH/,
    'a managed-browser attempt id used as an extension outcome must fail with 409 and no new fact');
  assert.match(outcome, /appendApplicationAttemptFact\(binding, 'press_observed'[\s\S]*?extension_submit_may_have_been_pressed/);
  assert.match(outcome, /outcome === 'confirmed'[\s\S]*?'submission_confirmed'/);
  assert.doesNotMatch(outcome, /not_sent_proven/,
    'failed and cancelled extension outcomes have no typed pre-click proof and must stay unresolved');
  assert.match(outcome, /submission_claim_id' = \$\{input\.claimId\}/);
  assert.match(outcomeRoute, /retry_safety: await packetRetrySafety\(result\.row\)/);
  assert.match(outcome, /disposition === 'replay_unverified'[\s\S]*?review: current/,
    'an unknown outcome retry must replay without rewriting its volatile timestamp');
  assert.match(outcome, /extensionOutcomeClaimDisposition\(current, input\.claimId, outcome\)/,
    'a later verified receipt must promote the exact unresolved extension claim');
  assert.doesNotMatch(outcome, /extension-outcome'[\s\S]{0,180}observedAt:/,
    'the stable press fact must not change its payload on a response retry');
});

test('unsupported email records dispatch risk before the provider call', () => {
  const submitRequest = source.slice(
    source.indexOf("'/applications/:id/submit-request'"),
    source.indexOf("'/applications/:id/submission/channels'"),
  );
  const branch = submitRequest.slice(
    submitRequest.indexOf('if (current.portal_url && !isPortalSupported(current.portal_url))'),
    submitRequest.indexOf("const controlledTest = process.env.LITOS_ENABLE_TEST_PORTAL"),
  );
  const reserve = branch.indexOf("appendApplicationAttemptFact(attemptBinding, 'attempt_opened'");
  const dispatch = branch.indexOf("appendApplicationAttemptFact(emailAttemptBinding, 'press_observed'");
  const send = branch.indexOf('sendPreparedUnsupportedPortalApplicationEmail(preparedEmail)', dispatch);
  const receipt = branch.indexOf("appendApplicationAttemptFact(emailAttemptBinding, 'submission_confirmed'", send);
  assert.ok(reserve >= 0 && dispatch > reserve && send > dispatch && receipt > send,
    'opening, dispatch risk, provider call, and provider receipt must be recorded in safety order');
  assert.match(branch, /if \(!crossedSendBoundary\)[\s\S]*?'not_sent_proven'[\s\S]*?proofKind: 'typed_pre_click_stop'/);
  assert.match(branch, /const failed = crossedSendBoundary[\s\S]*?status: 'needs_attention'[\s\S]*?unverified_submission/);
  assert.match(branch, /submission_run_id' = \$\{pending\.submission_run_id\}[\s\S]*?submission_claim_id' = \$\{claimId\}/);
});

test('unverified resolution is bound to one immutable attempt and exposes retry safety', () => {
  assert.match(source, /const unverifiedOutcomeBodySchema = z\.object\(\{[\s\S]*?attempt_id: z\.string\(\)\.uuid\(\)/);
  const route = source.slice(source.indexOf("'/applications/:id/submission/unverified'"));
  const commit = source.slice(
    source.indexOf('export async function commitUnverifiedSubmissionResolution('),
    source.indexOf('async function recordAttendedSubmissionFact('),
  );
  assert.match(route, /requestedOpening\?\.source === 'legacy_backfill'/);
  assert.match(route, /retrySafety\.kind === 'blocked_unverified'[\s\S]*?retrySafety\.attemptId === parsed\.data\.attempt_id/);
  assert.match(commit, /submissionAttemptBindingFromEvent\(existingOpening\)/);
  assert.match(commit, /input\.found \? 'submission_confirmed' : 'not_sent_proven'/);
  assert.match(commit, /proofKind: 'applicant_checked_not_sent'/);
  assert.match(commit, /submission_claim_id' = \$\{input\.current\.submission_claim_id\}/);
  assert.match(commit, /submission_run_id' = \$\{input\.pending\.submission_run_id\}/);
  assert.match(route, /retry_safety: await packetRetrySafety\(row\)/);
  assert.match(route, /retry_safety: await packetRetrySafety\(updated\[0\]\)/,
    'found:false must fold retry safety from the persisted released row, not the stale blocked row');
});

test('submission reads expose ledger retry safety at the top level', () => {
  const route = source.slice(
    source.indexOf("'/applications/:id/submission'"),
    source.indexOf("'/applications/:id/submission/handoff-complete'"),
  );
  assert.match(route, /application_id: row\.id,[\s\S]*?review,[\s\S]*?retry_safety: await packetRetrySafety\(row\)/);
});

test('every submit-request response carries top-level retry safety', () => {
  const route = source.slice(
    source.indexOf("'/applications/:id/submit-request'"),
    source.indexOf("'/applications/:id/submission/channels'"),
  );
  const bodies = returnedReplyBodies(route);
  assert.ok(bodies.length >= 15, 'the branch inventory must include success, refusal, and CAS-race responses');
  for (const body of bodies) {
    assert.match(body, /retry_safety:/, `submit-request response omitted retry safety:\n${body.slice(0, 240)}`);
  }
  const restartResponse = bodies.find((body) => body.includes('PREPARED_RUN_RESTARTABLE'));
  assert.ok(restartResponse, 'the prepared-run ternary response must remain in the branch inventory');
  assert.equal(restartResponse.match(/retry_safety:/g)?.length, 3,
    'each restartable, unverified, and terminal refusal variant needs its own retry safety value');
});

test('successful dashboard submission mutations carry top-level retry safety', () => {
  for (const [path, nextPath] of [
    ["'/applications/:id/review'", "'/applications/:id/review/answers'"],
    ["'/applications/:id/submission/handoff-complete'", "'/applications/:id/submission/self-submitted'"],
    ["'/applications/:id/submission/self-submitted'", "'/applications/:id/submission/approve'"],
    ["'/applications/:id/submission/approve'", "'/applications/:id/security-code'"],
    ["'/applications/:id/security-code'", "'/applications/:id/status'"],
    ["'/applications/:id/submission/unverified'", 'registerApplicationRoutes'],
  ] as const) {
    const route = source.slice(source.indexOf(path), source.indexOf(nextPath, source.indexOf(path) + path.length));
    assert.match(route, /application_id:[\s\S]*?review:[\s\S]*?retry_safety:/,
      `${path} must return retry safety with its successful submission envelope`);
  }
});

test('every applicant-facing submission mutation branch carries top-level retry safety', () => {
  for (const [path, nextPath] of [
    ["'/applications/:id/submission/extension-start'", "'/applications/:id/submission/extension-outcome'"],
    ["'/applications/:id/submission/extension-outcome'", "'/applications/:id/resume'"],
    ["'/applications/:id/submission/handoff-complete'", "'/applications/:id/submission/self-submitted'"],
    ["'/applications/:id/submission/self-submitted'", "'/applications/:id/submission/approve'"],
    ["'/applications/:id/submission/approve'", "'/applications/:id/security-code'"],
    ["'/applications/:id/security-code'", "'/applications/:id/status'"],
    ["'/applications/:id/status'", "'/applications/:id/submission/unverified'"],
    ["'/applications/:id/submission/unverified'", 'registerApplicationRoutes'],
  ] as const) {
    const start = source.indexOf(path);
    const route = source.slice(start, source.indexOf(nextPath, start + path.length));
    const bodies = returnedReplyBodies(route);
    assert.ok(bodies.length > 0, `${path} response inventory is empty`);
    for (const body of bodies) {
      assert.match(body, /retry_safety:/, `${path} response omitted retry safety:\n${body.slice(0, 240)}`);
    }
  }
});

test('a losing attended submission CAS rolls back without inventing immutable facts', () => {
  for (const [path, nextPath, factKey] of [
    ["'/applications/:id/submission/handoff-complete'", "'/applications/:id/submission/self-submitted'", 'handoff-complete'],
    ["'/applications/:id/submission/self-submitted'", "'/applications/:id/submission/approve'", 'self-submitted'],
  ] as const) {
    const route = source.slice(source.indexOf(path), source.indexOf(nextPath));
    const transaction = route.indexOf('db.transaction(async (tx) =>');
    const lock = route.indexOf('lockSubmissionAttemptUser(tx, request.jwtPayload!.userId)', transaction);
    const update = route.indexOf('tx.update(generated_resumes)', lock);
    const loserReturn = route.indexOf('if (!rows.length) return rows;', update);
    const facts = route.indexOf(`recordAttendedSubmissionFact(manualAttempt, new Date(now), '${factKey}', tx)`, loserReturn);
    assert.ok(transaction >= 0 && lock > transaction && update > lock && loserReturn > update && facts > loserReturn,
      `${path} must append facts only after its exact packet CAS wins inside the same locked transaction`);
  }
});

test('attended handoff submission trusts only the retained exact session receipt', () => {
  assert.match(source, /handoffCompleteBodySchema/);
  assert.match(source, /submission\/handoff-complete'[\s\S]*?preHandler: requireAuth/);
  assert.match(source, /parsed\.data\.outcome === 'submitted'/);
  assert.match(source, /!current\.browser_session_id/);
  assert.match(source, /getBrowserSession\(current\.browser_session_id\)/);
  assert.match(source, /connectToSession\(session\)/);
  assert.match(source, /observedReceipt = await readReceipt\(connected\.page\)/);
  assert.match(source, /extensionEmployerReceiptIsSufficient\([\s\S]*?confirmationText: observedReceipt\.confirmationText[\s\S]*?finalUrl: observedReceipt\.finalUrl/);
  assert.match(source, /source: 'attended_handoff'/);
  assert.match(source, /pipeline_stage: 'applied'/);
  assert.doesNotMatch(source, /Submitted by the applicant in the live company page/);
  assert.doesNotMatch(source, /confirmation_text: parsed\.data\.confirmation_text/);
  assert.doesNotMatch(source, /final_url: parsed\.data\.final_url/);
  const handler = source.slice(
    source.indexOf("'/applications/:id/submission/handoff-complete'"),
    source.indexOf("'/applications/:id/submission/self-submitted'"),
  );
  const submittedBranch = handler.indexOf("parsed.data.outcome === 'submitted'");
  const receiptRead = handler.indexOf('getBrowserSession(current.browser_session_id)', submittedBranch);
  assert.ok(submittedBranch >= 0 && receiptRead > submittedBranch);
  assert.doesNotMatch(
    handler.slice(submittedBranch, receiptRead),
    /preparedRunHandoffExpired/,
    'a short capability lease expiring cannot erase a later positive employer receipt',
  );
  assert.ok(
    handler.indexOf('extensionEmployerReceiptIsSufficient(', receiptRead) > receiptRead,
    'the late positive outcome still has to be verified from the retained exact session',
  );
});

test('manual employer controls are reserved before exposure and completion is exact-attempt bound', () => {
  const reservation = source.slice(
    source.indexOf('async function reserveAttendedManualAttempt('),
    source.indexOf('function legacyApplicationAttemptId'),
  );
  const lock = reservation.indexOf('lockSubmissionAttemptUser(tx, row.user_id)');
  const duplicate = reservation.indexOf('duplicateApplicationVerdict(', lock);
  const cas = reservation.indexOf('tx.update(generated_resumes)', duplicate);
  const opening = reservation.indexOf("appendApplicationAttemptFact(binding, 'attempt_opened'", cas);
  assert.ok(lock >= 0 && duplicate > lock && cas > duplicate && opening > cas,
    'manual capability reservation must lock, gate, CAS, then append its opening in one transaction');
  assert.match(reservation, /source: 'attended_handoff'/);
  assert.match(reservation, /operation: 'manual_submission'/);

  const dashboardHandoff = source.slice(
    source.indexOf("'/applications/:id/submission/manual-handoff'"),
    source.indexOf("'/applications/:id/submission/extension-packet'"),
  );
  const dashboardReserve = dashboardHandoff.indexOf('reserveAttendedManualAttempt(refreshed, refreshedReview');
  const dashboardBoundary = dashboardHandoff.indexOf('finalApplicationBoundaryGate({', dashboardReserve);
  const dashboardExposure = dashboardHandoff.indexOf('manual_handoff: {', dashboardBoundary);
  assert.ok(
    dashboardReserve >= 0 && dashboardBoundary > dashboardReserve && dashboardExposure > dashboardBoundary,
    'the dashboard handoff must reserve and authorize its exact attempt before returning the employer page',
  );
  assert.match(dashboardHandoff, /manual_attempt_id: reservation\.binding\.attemptId/);

  const selfSubmitStart = source.slice(
    source.indexOf("'/applications/:id/submission/self-submit-start'"),
    source.indexOf("'/applications/:id/submission/handoff-complete'"),
  );
  const selfSubmitReserve = selfSubmitStart.indexOf('reserveAttendedManualAttempt(row, review');
  const selfSubmitBoundary = selfSubmitStart.indexOf('finalApplicationBoundaryGate({', selfSubmitReserve);
  const selfSubmitFinalization = selfSubmitStart.indexOf('finalizeAttendedHandoffCapability({', selfSubmitBoundary);
  const selfSubmitExposure = selfSubmitStart.indexOf('portal_url: finalized.url', selfSubmitFinalization);
  assert.ok(
    selfSubmitReserve >= 0 && selfSubmitBoundary > selfSubmitReserve
      && selfSubmitFinalization > selfSubmitBoundary && selfSubmitExposure > selfSubmitFinalization,
    'self-submit must reserve, authorize, and finalize its exact attempt before returning the employer page',
  );
  assert.match(selfSubmitStart, /documentAsksLitosCannotResolve\(review, storedDocuments\(row\)\)\.length === 0/);
  assert.match(selfSubmitStart, /manual_attempt_id: reservation\.binding\.attemptId/);

  const handoff = source.slice(
    source.indexOf("'/applications/:id/submission/handoff-complete'"),
    source.indexOf("'/applications/:id/submission/self-submitted'"),
  );
  assert.match(source, /const handoffCompleteBodySchema = z\.object\(\{[\s\S]*?attempt_id: z\.string\(\)\.uuid\(\)/);
  assert.match(handoff, /current\.submission_claim_id !== parsed\.data\.attempt_id/);
  assert.match(handoff, /attendedManualAttemptBinding\(row, parsed\.data\.attempt_id\)/);
  assert.match(handoff, /submission_claim_id' = \$\{parsed\.data\.attempt_id\}/);
  assert.match(handoff, /completeAttendedHandoffNotSent\(\s*row,\s*request\.jwtPayload!\.userId,\s*parsed\.data\.attempt_id,/);
  const exactClear = source.slice(
    source.indexOf('export async function completeAttendedHandoffNotSent('),
    source.indexOf('function editableResumeSpec'),
  );
  assert.match(exactClear, /lockSubmissionAttemptUser\(tx, userId\)/);
  assert.match(exactClear, /event_kind === 'boundary_authorized'[\s\S]*?event_kind === 'press_observed'[\s\S]*?event_kind === 'submission_confirmed'/);
  const events = exactClear.indexOf('submissionAttemptEventsForPacket(userId, latest.id');
  const permanentBoundaryRisk = exactClear.indexOf("event.event_kind === 'boundary_authorized'", events);
  const activeBoundaryRefusal = exactClear.indexOf("boundary?.active) return { kind: 'active_boundary'", permanentBoundaryRisk);
  const clearClaim = exactClear.indexOf('tx.update(generated_resumes)', permanentBoundaryRisk);
  const notSentFact = exactClear.indexOf("appendApplicationAttemptFact(lockedAttempt, 'not_sent_proven'", clearClaim);
  assert.ok(events >= 0
    && permanentBoundaryRisk > events
    && activeBoundaryRefusal > permanentBoundaryRisk
    && clearClaim > activeBoundaryRefusal
    && notSentFact > clearClaim,
    'the exact immutable boundary fact must permanently refuse clearing before either mutable or ledger write');
  assert.match(exactClear, /if \(hasBoundaryFact[\s\S]*?return \{ kind: 'boundary_risk'/,
    'expired or malformed boundary metadata must remain a permanent negative-resolution refusal');
  assert.doesNotMatch(exactClear, /boundary\.serverNow/,
    'negative resolution timestamps must not be derived from boundary expiry metadata');
  assert.match(exactClear, /proofKind: 'applicant_checked_not_sent'/);
  assert.match(exactClear, /evidenceCode: 'applicant_cleared_handoff_without_submitting'/);
  assert.match(handoff, /retry_safety: await packetRetrySafety\(completion\.row\)/,
    'handoff clear must return safe_not_sent from the persisted released row');

  const genericResolution = source.slice(
    source.indexOf('function exactAttemptPermanentlyBlocksNegativeResolution('),
    source.indexOf('async function recordAttendedSubmissionFact('),
  );
  const exactPressRisk = genericResolution.indexOf(
    'if (!input.found && exactAttemptPermanentlyBlocksNegativeResolution(events, input.attemptId))',
  );
  const boundaryMetadata = genericResolution.indexOf('const boundaryAuthorization = await submissionBoundaryAuthorization');
  assert.ok(exactPressRisk >= 0 && boundaryMetadata > exactPressRisk,
    'an exact immutable press or confirmation must reject not-sent before lease metadata is interpreted');
  assert.match(genericResolution, /event\.event_kind === 'boundary_authorized'/);
  assert.match(genericResolution, /capability\.source !== 'legacy_backfill'/,
    'every live managed, direct, extension, unsupported-email, API, and attended boundary must permanently veto a negative resolution');
  const genericProof = genericResolution.indexOf("input.found ? 'submission_confirmed' : 'not_sent_proven'", exactPressRisk);
  assert.ok(genericProof > boundaryMetadata,
    'the permanent negative veto must run before any not-sent fact can be appended');

  const expiryRepair = source.slice(
    source.indexOf('export async function repairExpiredAttendedHandoffClaim('),
    source.indexOf('export type AttendedHandoffNotSentCompletion'),
  );
  const repairBoundary = expiryRepair.indexOf("event.event_kind === 'boundary_authorized'");
  const repairUpdate = expiryRepair.indexOf('tx.update(generated_resumes)', repairBoundary);
  assert.ok(repairBoundary >= 0 && repairUpdate > repairBoundary,
    'claim expiry repair must reject any boundary-authorized attempt before clearing the claim');

  const selfSubmitted = source.slice(
    source.indexOf("'/applications/:id/submission/self-submitted'"),
    source.indexOf("'/applications/:id/submission/approve'"),
  );
  assert.match(selfSubmitted, /selfSubmittedBodySchema\.safeParse/);
  assert.match(selfSubmitted, /current\.submission_claim_id !== parsed\.data\.attempt_id/);
  assert.match(selfSubmitted, /attendedManualAttemptBinding\(row, parsed\.data\.attempt_id\)/);
  assert.match(selfSubmitted, /submission_claim_id' = \$\{parsed\.data\.attempt_id\}/);

  const approve = source.slice(
    source.indexOf("'/applications/:id/submission/approve'"),
    source.indexOf("'/applications/:id/security-code'"),
  );
  const activeManual = approve.indexOf('if (current.submission_claim_id)');
  assert.ok(activeManual >= 0 && activeManual < approve.indexOf('refuseDuplicateApplication('),
    'approve must refuse an unresolved manual capability before opening an automatic one');
});
