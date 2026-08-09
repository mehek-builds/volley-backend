import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import type { ApplicationReviewState } from './applicationReview';
import type { ManagedBrowserAction } from './browserbase';
import { applyReviewPatch } from './applicationStall';
import { submitRequestDisposition, resumeEditDisposition } from './submissionSafety';
import {
  attentionCategoriesForReasons,
  isTerminalRunStatus,
  UNEXPLAINED_ATTENTION_REASON,
  UNEXPLAINED_SECURITY_CODE_REASON,
} from './submissionTerminalCause';
import {
  beginSecurityCodeState,
  findSecurityCodeAttempt,
  normalizeSecurityCode,
  readManagedSecurityCodeChallenge,
  securityCodeAttentionReason,
  securityCodeFingerprint,
  withSecurityCode,
  withSecurityCodeAttempt,
} from './securityCode';

/* The state Litos could not describe.
 *
 * On 2026-08-08 three Greenhouse packets (Redwood Materials, Scale AI, Cresta) sat at
 * 'ready_for_final_approval' with submitted_at null, receipt null and attention_reason null, while
 * the applicant's mailbox held three Greenhouse security-code emails timestamped to the minute of
 * each run. The state was wrong in both directions at once: it said nothing had been submitted when
 * something had, and it said nothing was waiting on a human when something was.
 *
 * Every test below fails on the unfixed code. There is no 'awaiting_security_code' status to write,
 * no 'security_code' category to derive, and submitRequestDisposition happily re-runs a packet that
 * an employer has already received once. */

const CHALLENGE = {
  humanVerification: {
    kind: 'security_code' as const,
    fieldCount: 8,
    sentTo: 'mehekmandal05@gmail.com',
  },
};

const review = (patch: Partial<ApplicationReviewState> = {}): ApplicationReviewState => ({
  jd_text: '',
  status: 'needs_attention',
  edited_terms: [],
  questions: [],
  skipped_reasons: [],
  updated_at: '2026-08-08T12:22:59.584Z',
  ...patch,
});

// ---- reading the challenge ----

test('the challenge is read off the control the runner reported, not off the page', () => {
  const challenge = readManagedSecurityCodeChallenge(CHALLENGE);
  assert.deepEqual(challenge, { digits: 8, sentTo: 'mehekmandal05@gmail.com' });
});

test('a run that saw no code control reports no challenge', () => {
  assert.equal(readManagedSecurityCodeChallenge({ humanVerification: null }), null);
  // Absent, not null: this is a runner deployed before the field existed, which is the ordinary case
  // mid-rollout. Absent means "not observed" and must never read as "no challenge is present".
  assert.equal(readManagedSecurityCodeChallenge({}), null);
});

test('a control that did not say how long the code is reports zero, not a guessed eight', () => {
  const challenge = readManagedSecurityCodeChallenge({
    humanVerification: { kind: 'security_code', fieldCount: 0, sentTo: null },
  });
  // Greenhouse's own sentence says "8-character". Reading the number out of that sentence is exactly
  // the prose-matching this design refuses, so an unstated length stays unstated.
  assert.deepEqual(challenge, { digits: 0 });
});

// ---- the sentence and its category ----

test('the sentence says an application went in, and that it is not finished', () => {
  const state = beginSecurityCodeState({
    challenge: { digits: 8, sentTo: 'mehekmandal05@gmail.com' },
    attemptedAt: '2026-08-08T12:22:59.584Z',
    authorized: false,
  });
  const reason = securityCodeAttentionReason(state);
  assert.match(reason, /submitted this application/);
  assert.match(reason, /8-character security code/);
  assert.match(reason, /mehekmandal05@gmail\.com/);
  assert.match(reason, /not filed until that code is entered/);
  // The one thing it must never say. Both generic fallbacks in submissionTerminalCause say some
  // version of it, and here it is false: the employer already has a submission.
  assert.doesNotMatch(reason, /nothing has been sent/i);
});

test('the sentence names no address and no length when the page gave neither', () => {
  const reason = securityCodeAttentionReason(beginSecurityCodeState({
    challenge: { digits: 0 },
    attemptedAt: '2026-08-08T12:22:59.584Z',
    authorized: true,
  }));
  assert.match(reason, /a security code was emailed,/);
  assert.doesNotMatch(reason, /undefined|null|0-character/);
});

test('a rejected attempt changes the sentence, because the code in her hand is now the wrong one', () => {
  const state = withSecurityCodeAttempt(
    beginSecurityCodeState({ challenge: { digits: 8 }, attemptedAt: 'x', authorized: true }),
    { at: 'y', fingerprint: 'f', outcome: 'rejected' },
  );
  assert.match(securityCodeAttentionReason(state), /use the newest email/);
});

test('the sentence is categorized as a security code and not as a captcha', () => {
  const state = beginSecurityCodeState({
    challenge: { digits: 8, sentTo: 'mehekmandal05@gmail.com' },
    attemptedAt: '2026-08-08T12:22:59.584Z',
    authorized: true,
  });
  assert.deepEqual(attentionCategoriesForReasons([securityCodeAttentionReason(state)]), ['security_code']);
  // And it does not fall through to 'unknown', which is what every one of the three measured packets
  // would have got if the category had been derived from their (absent) reason.
  assert.deepEqual(attentionCategoriesForReasons(['CAPTCHA requires your attention']), ['captcha']);
  // The fallback sentence carries the category too, or a state stored without its details would be
  // uncountable exactly when it is least understood.
  assert.deepEqual(attentionCategoriesForReasons([UNEXPLAINED_SECURITY_CODE_REASON]), ['security_code']);
});

test('an employer field merely named "security code" is not this state', () => {
  /* The runner's required-field scan emits '"<label>" is required and is still empty' verbatim from
     the employer's own markup, so a form with a field labelled "Security code" produces a blocker
     line containing that phrase. A bare phrase match would label a form Litos simply failed to fill
     as an application already sitting with an employer, which is the more dangerous of the two
     wrong answers: it is the one that says something was sent. */
  assert.deepEqual(
    attentionCategoriesForReasons(['"Security code" is required and is still empty']),
    ['required_field'],
  );
});

// ---- the terminal-state contract ----

test('the state is terminal, so it cannot be persisted without a cause', () => {
  assert.equal(isTerminalRunStatus('awaiting_security_code'), true);
  // The exact shape of the three measured rows: a status, and no reason at all.
  const written = applyReviewPatch(review(), { status: 'awaiting_security_code', attention_reason: undefined });
  assert.equal(written.attention_reason, UNEXPLAINED_SECURITY_CODE_REASON);
  assert.deepEqual(written.attention_categories, ['security_code']);
  // NOT the generic attention fallback, which ends "nothing has been sent".
  assert.notEqual(written.attention_reason, UNEXPLAINED_ATTENTION_REASON);
  assert.doesNotMatch(written.attention_reason!, /nothing has been sent/i);
});

// ---- what may and may not move it ----

test('the ordinary submit path refuses a packet an employer has already received', () => {
  // needs_attention before a click is re-runnable, and that is correct. This is not: the form has
  // been sent once, and a second run issues a fresh code and can spend a re-application attempt on a
  // board that caps them.
  assert.equal(submitRequestDisposition('needs_attention'), 'start');
  assert.equal(submitRequestDisposition('awaiting_security_code'), 'reject');
  assert.equal(submitRequestDisposition('awaiting_security_code', true), 'reject');
  assert.equal(resumeEditDisposition('awaiting_security_code'), 'reject');
});

// ---- the code itself ----

test('a code keeps its case, loses its spacing, and is checked against the control', () => {
  // Greenhouse's own example is TPHJrFMJ. Upper- or lower-casing it destroys a valid code and
  // produces a rejection nobody can explain.
  assert.equal(normalizeSecurityCode('TPHJrFMJ', 8), 'TPHJrFMJ');
  assert.equal(normalizeSecurityCode(' TPHJ rFMJ ', 8), 'TPHJrFMJ');
  assert.equal(normalizeSecurityCode('TPHJ-rFMJ', 8), 'TPHJrFMJ');
  assert.equal(normalizeSecurityCode('TPHJrFM', 8), null, 'seven characters is not the eight the control asked for');
  assert.equal(normalizeSecurityCode('TPHJrFMJ9', 8), null);
  assert.equal(normalizeSecurityCode('TPHJ!FMJ', 8), null);
  assert.equal(normalizeSecurityCode(12345678, 8), null);
  // An unstated length falls back to a bound, never to "accept anything".
  assert.equal(normalizeSecurityCode('TPHJrFMJ', 0), 'TPHJrFMJ');
  assert.equal(normalizeSecurityCode('ABC', 0), null);
});

test('the code is never stored, and the same code is recognised again', () => {
  const first = securityCodeFingerprint('app-1', 'TPHJrFMJ');
  assert.doesNotMatch(first, /TPHJrFMJ/i, 'the digest must not contain the code');
  assert.equal(securityCodeFingerprint('app-1', 'TPHJrFMJ'), first, 'the same code fingerprints the same');
  assert.notEqual(securityCodeFingerprint('app-2', 'TPHJrFMJ'), first, 'salted per application');
  assert.notEqual(securityCodeFingerprint('app-1', 'TPHJrFMK'), first);

  const state = withSecurityCodeAttempt(
    beginSecurityCodeState({ challenge: { digits: 8 }, attemptedAt: 'x', authorized: true }),
    { at: 'y', fingerprint: first, outcome: 'rejected' },
  );
  assert.equal(findSecurityCodeAttempt(state, first)?.outcome, 'rejected');
  assert.equal(findSecurityCodeAttempt(state, securityCodeFingerprint('app-1', 'ZZZZZZZZ')), undefined);
});

test('attempts survive a re-issued challenge, so a replay is still recognised', () => {
  const first = securityCodeFingerprint('app-1', 'TPHJrFMJ');
  const tried = withSecurityCodeAttempt(
    beginSecurityCodeState({ challenge: { digits: 8 }, attemptedAt: 'x', authorized: true }),
    { at: 'y', fingerprint: first, outcome: 'rejected' },
  );
  // The employer sends a second code. The clock restarts; the history must not, or the same rejected
  // code could be replayed against the employer immediately.
  const reissued = beginSecurityCodeState({
    challenge: { digits: 8 }, attemptedAt: 'z', authorized: true, existing: tried,
  });
  assert.equal(reissued.requested_at, 'z');
  assert.equal(findSecurityCodeAttempt(reissued, first)?.outcome, 'rejected');
});

test('an unauthorized submit is recorded as one', () => {
  // A fill run that reaches this screen has submitted an application with nobody's authorization,
  // which is a Litos defect and not a fact about the employer. It has to be countable.
  const fromFill = beginSecurityCodeState({ challenge: { digits: 8 }, attemptedAt: 'x', authorized: false });
  const fromSubmit = beginSecurityCodeState({ challenge: { digits: 8 }, attemptedAt: 'x', authorized: true });
  assert.equal(fromFill.submit_was_authorized, false);
  assert.equal(fromSubmit.submit_was_authorized, true);
});

// ---- the action budget ----

test('carrying the code costs no actions at all', () => {
  // MANAGED_ACTION_LIMIT is 120 and a real Greenhouse packet reconstructs to exactly 120, with the
  // trim having already shaved preferred_first_name and preferred_last_name off the end. An action
  // added here displaces a field the applicant expects filled.
  const actions: ManagedBrowserAction[] = [
    { type: 'fill', selector: '#email', value: 'a@b.com' },
    { type: 'click', selector: 'button[type="submit"], input[type="submit"]' },
  ];
  const withCode = withSecurityCode(actions, 'TPHJrFMJ');
  assert.equal(withCode.length, actions.length, 'the list must be exactly as long as it was');
  assert.equal(withCode[1].securityCode, 'TPHJrFMJ');
  assert.equal(actions[1].securityCode, undefined, 'and the caller\'s own list is not mutated');
});

test('a list with no submit click is left alone rather than given one', () => {
  // A caller with no submit click has been gated upstream: portalCanAutoSubmit, the multi-step
  // wizards, the account-walled families. Appending a click here would walk straight through that.
  const prepareOnly: ManagedBrowserAction[] = [{ type: 'fill', selector: '#email', value: 'a@b.com' }];
  assert.deepEqual(withSecurityCode(prepareOnly, 'TPHJrFMJ'), prepareOnly);
  const wizard: ManagedBrowserAction[] = [{ type: 'click', selector: '#next-step', label: 'advance to step 2' }];
  assert.deepEqual(withSecurityCode(wizard, 'TPHJrFMJ'), wizard);
});

/* ---- the interaction with D-01's send gate ----
 *
 * PR #378 put a blank-required-answer refusal in front of every send inside submit(), which is right
 * and which lands the packet in needs_attention. A packet finishing a security-code submission is
 * the one thing that refusal must not demote: the form has already reached the employer, so "this
 * was not sent" is false, and submitRequestDisposition treats needs_attention as re-runnable, which
 * would reopen the ordinary submit path on an application an employer already holds.
 *
 * A source-shape assertion for the same reason #378's own gate tests are: what this protects is a
 * PLACEMENT inside a function that needs a database and a live browser to reach, and no unit test of
 * a predicate can notice a branch that stopped being conditional.
 */
test('the blank-required gate refuses without demoting a security-code packet', async () => {
  const source = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = source.indexOf('const unansweredRequired = blankRequiredQuestionLabels(claimedReview.questions);');
  assert.ok(start > 0, 'the send gate must still be there');
  const gate = source.slice(start, source.indexOf('const claimedPortal = detectPortal', start));
  // Still a refusal: the claim is released and nothing is sent.
  assert.match(gate, /submission_claimed_at: undefined/);
  // But the state it lands in depends on whether this is a security-code finish.
  assert.match(gate, /finishingSecurityCode \? 'awaiting_security_code' : 'needs_attention'/);
  // Keyed on the REQUEST, not the status: finishSecurityCodeSubmission has already moved the packet
  // to 'submitting' by the time this runs, so the status can no longer tell you.
  assert.match(gate, /Boolean\(options\.securityCode\) && Boolean\(claimedReview\.security_code\)/);
  // And the sentence still leads with the fact that an application has already gone in.
  assert.match(gate, /securityCodeAttentionReason\(claimedReview\.security_code!\)/);
});

test('the duplicate gate refuses without demoting a security-code packet either', async () => {
  /* PR #379 added a second refusal above the send, for a posting the user has already applied to.
     It is right, and it lands in needs_attention like the blank-required one. Both have to answer
     the security-code packet the same way or they drift apart, and the one that drifts is the one
     that quietly reopens the ordinary submit path on an application an employer already holds. */
  const source = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = source.indexOf("if (duplicate.kind === 'duplicate')");
  assert.ok(start > 0, 'the duplicate gate must still be there');
  const gate = source.slice(start, source.indexOf('const claimedRow = await claimSubmission', start));
  assert.match(gate, /finishingSecurityCode \? 'awaiting_security_code' : 'needs_attention'/);
  assert.match(gate, /Boolean\(options\.securityCode\) && Boolean\(current\.security_code\)/);
  // The duplicate finding is still reported. Refusing quietly would be its own defect.
  assert.match(gate, /duplicate\.reason/);
  assert.match(gate, /'security_code', 'duplicate_application'/);
});

test('nothing but the code endpoint can move a packet out of the waiting state', async () => {
  const source = await readFile('src/routes/applications.ts', 'utf8');
  // preparedRunCanRestart is D-01's escape hatch from a 409, and it is scoped to
  // ready_for_final_approval only. A packet the employer already has must not be restartable by it.
  const safety = await readFile('src/lib/submissionSafety.ts', 'utf8');
  assert.match(safety, /status === 'ready_for_final_approval' && !submissionWasClaimed/);
  const restartFn = safety.slice(
    safety.indexOf('export function preparedRunCanRestart'),
    safety.indexOf('export function submitRequestDisposition'),
  );
  assert.ok(restartFn.length > 0, 'preparedRunCanRestart must sit above submitRequestDisposition');
  assert.doesNotMatch(restartFn, /awaiting_security_code/);
  // And the only route that names the state is the code one.
  assert.match(source, /'\/applications\/:id\/security-code'/);
});

test('a security-code challenge is persisted before any receipt is parsed', async () => {
  const source = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const managedStart = source.indexOf('const challenge = readManagedSecurityCodeChallenge(receiptResult);');
  assert.ok(managedStart > 0, 'the managed result must inspect the challenge');
  const challengeBranch = source.indexOf('if (challenge)', managedStart);
  const awaitingWrite = source.indexOf("status: 'awaiting_security_code'", challengeBranch);
  const receiptRead = source.indexOf('readManagedReceipt(receiptResult)', managedStart);
  assert.ok(challengeBranch > managedStart);
  assert.ok(awaitingWrite > challengeBranch);
  assert.ok(receiptRead > awaitingWrite, 'receipt parsing must happen only after the challenge branch returns');
});

test('automatic verification records one remote managed continuation without exposing its token', async () => {
  const source = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = source.indexOf('const continuationEvidence = continuationIsLive');
  const end = source.indexOf('if (!receiptResult.screenshot)', start);
  assert.ok(start > 0 && end > start);
  const continuation = source.slice(start, end);
  assert.match(continuation, /runner: 'stratus-managed'/);
  assert.match(continuation, /managedContinuationFingerprint\(continuationToken\)/);
  assert.match(continuation, /receiptResult = await continueManagedBrowser\(continuationToken, prepared.actions\)/);
  assert.match(continuation, /continuation_resumed: true/);
  assert.doesNotMatch(continuation, /continuation_token:/i);
  const receipt = source.slice(end, source.indexOf("fastify.log.info({ applicationId: row.id }", end));
  assert.match(receipt, /source: 'managed_browser'/);
});

test('manual code continuation atomically claims the waiting application', async () => {
  const source = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const helperStart = source.indexOf('async function claimSecurityCodeSubmission(');
  const helperEnd = source.indexOf('async function claimPreparation(', helperStart);
  assert.ok(helperStart > 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /status: 'submitting'/);
  assert.match(helper, /submission_claimed_at: new Date\(\)\.toISOString\(\)/);
  assert.match(helper, /submission_claim_id: randomUUID\(\)/);
  assert.match(helper, /->>'status' = 'awaiting_security_code'/);
  assert.match(helper, /->>'submission_claimed_at' is null/);
  assert.match(helper, /\.returning\(\)/);

  const finishStart = source.indexOf('export async function finishSecurityCodeSubmission(');
  const finishEnd = source.indexOf('\n}', source.indexOf("return { kind: 'done', review", finishStart)) + 2;
  const finish = source.slice(finishStart, finishEnd);
  assert.match(finish, /const activeRow = await claimSecurityCodeSubmission\(row, current\)/);
  assert.match(finish, /if \(!activeRow\)/);
  assert.match(finish, /claimAlreadyHeld: true/);
  assert.doesNotMatch(finish, /submission_claimed_at: undefined/);
  assert.doesNotMatch(finish, /await writeReview\(row, requested\)/);
});

test('an already-held claim cannot bypass the submit claim checks unless it is complete', async () => {
  const source = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const validatorStart = source.indexOf('export function submissionClaimIsHeld(');
  const validatorEnd = source.indexOf('async function claimSecurityCodeSubmission(', validatorStart);
  assert.ok(validatorStart > 0 && validatorEnd > validatorStart);
  const validator = source.slice(validatorStart, validatorEnd);
  assert.match(validator, /review\?\.status === 'submitting'/);
  assert.match(validator, /review\.submission_claimed_at\.trim\(\)\.length > 0/);
  assert.match(validator, /review\.submission_claim_id\.trim\(\)\.length > 0/);

  const claimHelper = source.slice(
    source.indexOf('async function claimSubmission('),
    source.indexOf('async function claimSecurityCodeSubmission('),
  );
  assert.match(claimHelper, /if \(alreadyHeld\) return submissionClaimIsHeld\(current\) \? row : null/);
  const claimUse = source.slice(
    source.indexOf('const claimedRow = await claimSubmission'),
    source.indexOf('let claimedReview = readApplicationReview', source.indexOf('const claimedRow = await claimSubmission')),
  );
  assert.match(claimUse, /claimSubmission\(row, options\.claimAlreadyHeld\)/);
  assert.match(claimUse, /if \(!claimedRow\) return/);
});
