import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { applyReviewPatch } from '../lib/applicationStall';
import {
  TERMINAL_RUN_STATUSES,
  UNEXPLAINED_ATTENTION_REASON,
  UNEXPLAINED_RUN_FAILURE_REASON,
  isTerminalRunStatus,
  withTerminalCause,
} from '../lib/submissionTerminalCause';
import { extensionOutcomePatch } from '../lib/extensionSubmission';
import {
  FORM_NOT_REACHED_REASON,
  applicationFormWasReached,
  preparationEvidenceBlockers,
  submissionFailureOutcome,
} from './submissionRunner';
import type { ApplicationReviewState } from '../lib/applicationReview';
import type { SubmissionPacket } from '../lib/portalSubmission';

/* Measured on the owner's real packets on 2026-08-06, and both halves of Class C are here.
 *
 *  - Five runs (Akuna x3, Jump Trading, Nuro) recorded filled_fields: [] and told the applicant
 *    "The filled form did not record an email field / a resume upload / the applicant name
 *    fields." The preview screenshots are job description pages. Jump Trading's is a branded
 *    careers page whose only application control is an Apply button, with no form on it anywhere.
 *    Three sentences describing a filled form, about a form that was never opened.
 *
 *  - Three runs reached status 'failed' with attention_reason unset, no stall and no categories,
 *    carrying only submission_error "Each selector must be a non-empty string no longer than 500
 *    characters" - the remote runner talking to whoever maintains it. Unactionable for her,
 *    unqueryable for us.
 */

const baseReview: ApplicationReviewState = {
  jd_text: '',
  status: 'filling',
  edited_terms: [],
  questions: [],
  skipped_reasons: [],
  updated_at: '2026-08-06T00:00:00.000Z',
};

const packet = {
  fullName: 'Mehek Mandal',
  email: 'mehek@example.com',
  resume: Buffer.from('pdf'),
  resumeName: 'resume.pdf',
  questions: [],
} as unknown as SubmissionPacket;

/**
 * Every status in the union, read off the type rather than listed here.
 *
 * The point of deriving it is that a status added to ApplicationReviewState later cannot quietly
 * escape this enumeration: it will appear here, and it is either terminal (and must carry a cause)
 * or it is not (and must be left alone). A hand-written list would have gone stale the first time
 * someone added one.
 */
async function reviewStatusUnion(): Promise<ApplicationReviewState['status'][]> {
  const source = await readFile('src/lib/applicationReview.ts', 'utf8');
  const start = source.indexOf('  status:\n');
  assert.ok(start > 0, 'could not find the status union in ApplicationReviewState');
  const end = source.indexOf(';', start);
  const statuses = [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
  assert.ok(statuses.length >= 11, `expected the full status union, parsed ${statuses.length}`);
  return statuses as ApplicationReviewState['status'][];
}

test('every terminal status in the union is classified, and only those are', async () => {
  const statuses = await reviewStatusUnion();
  const terminal = statuses.filter((status) => isTerminalRunStatus(status));
  assert.deepEqual(terminal.sort(), [...TERMINAL_RUN_STATUSES].sort());
  /* The non-terminal ones are stages the pipeline is still moving through, a wait on a decision
     that is not a failure, or a success that carries a receipt of its own. If one of these ever
     becomes a place a run can STOP, it belongs in TERMINAL_RUN_STATUSES and this line fails until
     someone decides which. */
  assert.deepEqual(statuses.filter((status) => !isTerminalRunStatus(status)), [
    'resume_ready',
    'questions_ready',
    'ready_to_submit',
    'submit_requested',
    'preparing',
    'filling',
    'ready_for_final_approval',
    'submitting',
    'submission_claimed',
    'submitted',
  ]);
});

test('no transition into a terminal status can persist without a cause', async () => {
  for (const status of await reviewStatusUnion()) {
    const written = applyReviewPatch(baseReview, { status });
    if (!isTerminalRunStatus(status)) {
      assert.equal(written.attention_reason, undefined, `${status} must not be given a cause it does not owe`);
      assert.equal(written.attention_categories, undefined, `${status} must not be given a category it does not owe`);
      continue;
    }
    assert.ok(written.attention_reason?.trim(), `${status} reached a terminal state with no reason`);
    assert.ok((written.attention_categories?.length ?? 0) > 0, `${status} reached a terminal state with no category`);
  }
});

test('a caller that explicitly clears the reason still cannot write a silent terminal state', () => {
  // This is the exact shape of the three failed rows: the status is set, the reason is undefined.
  const written = applyReviewPatch(baseReview, {
    status: 'failed',
    attention_reason: undefined,
    submission_error: 'Each selector must be a non-empty string no longer than 500 characters',
  });
  assert.equal(written.attention_reason, UNEXPLAINED_RUN_FAILURE_REASON);
  assert.deepEqual(written.attention_categories, ['run_failed']);
  // The provider text is kept for whoever debugs it, and is still not the thing shown to her.
  assert.match(written.submission_error!, /Each selector must be/);
});

test('needs_attention with a null helper reason gets the attention fallback, not the failure one', () => {
  // unattendedHandoffReason and portalHandoffReason both return null for some portals, and both
  // are written as `helper() ?? undefined` at their call sites.
  const written = applyReviewPatch(baseReview, { status: 'needs_attention', attention_reason: undefined });
  assert.equal(written.attention_reason, UNEXPLAINED_ATTENTION_REASON);
  assert.deepEqual(written.attention_categories, ['run_failed']);
  assert.doesNotMatch(written.attention_reason!, /try this one again/i, 'a parked run is not offering a retry');
});

test('a stated cause is never overwritten by the fallback', () => {
  const written = applyReviewPatch(baseReview, {
    status: 'needs_attention',
    attention_reason: 'CAPTCHA requires your attention',
  });
  assert.equal(written.attention_reason, 'CAPTCHA requires your attention');
  assert.deepEqual(written.attention_categories, ['captcha']);
});

test('the extension failure outcome cannot land reasonless either', () => {
  const patch = extensionOutcomePatch('failed', '2026-08-06T00:00:00.000Z', { finalUrl: 'https://example.com' });
  assert.equal(patch.attention_reason, undefined, 'the patch itself still states no reason');
  const written = applyReviewPatch(baseReview, patch);
  assert.ok(written.attention_reason?.trim(), 'the merge is what guarantees it');
  assert.ok((written.attention_categories?.length ?? 0) > 0);
});

test('withTerminalCause is idempotent, so a re-merge cannot churn the row', () => {
  const once = withTerminalCause({ ...baseReview, status: 'failed' });
  assert.deepEqual(withTerminalCause(once), once);
});

/* Enumerating the failure outcomes rather than sampling them. Five inputs, and the branch that
   shipped broken was reachable only when all four stop reasons were false at once - the single
   combination no example-based test had bothered to write down. */
test('every terminal submissionFailureOutcome carries a reason and a category', () => {
  const captchaStops = [null, 'before_fill', 'at_submit'] as const;
  const flags = [false, true];
  const reasons = [undefined, '   ', 'A stated reason'];
  let terminalCases = 0;
  for (const captchaStop of captchaStops) {
    for (const noSubmitControl of flags) {
      for (const uncertainAfterClaim of flags) {
        for (const externalGate of flags) {
          for (const providerSessionFailure of flags) {
            for (const currentAttentionReason of reasons) {
              const out = submissionFailureOutcome({
                captchaStop,
                noSubmitControl,
                uncertainAfterClaim,
                externalGate,
                providerSessionFailure,
                currentAttentionReason,
              });
              if (out.status === 'submit_requested') continue; // requeued, not terminal
              terminalCases += 1;
              const label = JSON.stringify({
                captchaStop, noSubmitControl, uncertainAfterClaim, externalGate, providerSessionFailure, currentAttentionReason,
              });
              assert.ok(isTerminalRunStatus(out.status), label);
              assert.ok(out.attentionReason.trim(), `terminal outcome with no reason: ${label}`);
              assert.ok(out.attentionCategories.length > 0, `terminal outcome with no category: ${label}`);
            }
          }
        }
      }
    }
  }
  /* 3 captcha stops x 2 x 2 x 2 x 2 flags x 3 carried reasons = 144 inputs. Exactly three of them
     requeue instead of terminating: all four stop reasons false with externalGate true, once per
     carried reason. Everything else has to answer for itself. */
  assert.equal(terminalCases, 141, 'the enumeration must cover every terminal combination');
});

test('a whitespace-only carried reason is treated as no reason, not as a reason', () => {
  const out = submissionFailureOutcome({
    captchaStop: null,
    noSubmitControl: false,
    uncertainAfterClaim: false,
    externalGate: false,
    providerSessionFailure: false,
    currentAttentionReason: '  \n  ',
  });
  assert.equal(out.status, 'failed');
  assert.equal(out.attentionReason, UNEXPLAINED_RUN_FAILURE_REASON);
});

test('the unexplained failure sentence admits it is generic and promises nothing false', () => {
  assert.match(UNEXPLAINED_RUN_FAILURE_REASON, /nothing has gone to the employer/i);
  // Status 'failed' is only reachable when the submission claim was never taken, so there is no
  // receipt anywhere. Sending her to look for one is the mistake the captcha and no-submit-control
  // branches already exist to avoid.
  assert.doesNotMatch(UNEXPLAINED_RUN_FAILURE_REASON, /check the portal or your email/i);
  for (const invented of [/captcha/i, /required/i, /field/i, /upload/i]) {
    assert.doesNotMatch(UNEXPLAINED_RUN_FAILURE_REASON, invented, 'the fallback must not invent a cause');
  }
});

/* ---- the other half: an abort must not be described as a filled form ---- */

test('Jump Trading: a page with no form is reported as not reached, with no invented blockers', () => {
  // The real 2026-08-06 run: a branded careers page, zero filled fields, zero provider blockers.
  const blockers = preparationEvidenceBlockers({
    text: 'Campus Software Engineer (Intern) Location Chicago Job Type Jump Trading - Intern Apply',
    filledFields: [],
    blockers: [],
    discovered: [],
  }, packet);

  assert.deepEqual(blockers, [FORM_NOT_REACHED_REASON]);
  for (const sentence of blockers) {
    assert.doesNotMatch(sentence, /did not record/, 'a form that was never opened has nothing to not record');
  }
});

test('Nuro: a required-and-empty provider blocker proves the form was reached', () => {
  // Same day, same empty filled_fields, but the provider located the Email control and said so.
  // "Reached it and left fields empty" is a different fact and gets the different sentences.
  const blockers = preparationEvidenceBlockers({
    text: 'Software Engineer, AI Platform - Intern',
    filledFields: [],
    blockers: ['"Email" is required and is still empty'],
  }, packet);

  assert.deepEqual(blockers, [
    'The filled form did not record an email field.',
    'The filled form did not record a resume upload.',
    'The filled form did not record the applicant name fields.',
  ]);
});

test('a CAPTCHA blocker alone is not evidence the form was reached', () => {
  // The Samsara run. A challenge can stop the runner at the door, so this stays honest about
  // reach while the CAPTCHA blocker itself is carried separately by the caller.
  assert.deepEqual(
    preparationEvidenceBlockers({ text: 'Samsara', filledFields: [], blockers: ['CAPTCHA requires your attention'] }, packet),
    [FORM_NOT_REACHED_REASON],
  );
});

test('reach is decided on positive evidence only, and each signal is sufficient on its own', () => {
  assert.equal(applicationFormWasReached({}), false);
  assert.equal(applicationFormWasReached({ filledFields: [], blockers: [] } as never), false);
  assert.equal(applicationFormWasReached({ filledFields: ['email'] }), true);
  assert.equal(applicationFormWasReached({ providerBlockers: ['"GPA" is required and is still empty'] }), true);
  assert.equal(applicationFormWasReached({ discoveredQuestionCount: 1 }), true);
  assert.equal(applicationFormWasReached({ extracted: [{ value: 'Mehek' }] }), true);
  assert.equal(applicationFormWasReached({ extracted: [{ value: null }, { value: '  ' }] }), false);
  assert.equal(
    applicationFormWasReached({ text: 'Email mehek@example.com', email: 'mehek@example.com' }),
    true,
    'the applicant email on the page can only have been typed there',
  );
  assert.equal(applicationFormWasReached({ text: 'Email', email: 'mehek@example.com' }), false);
});

/* BLOCKER 4. A CAPTCHA widget is evidence that a page loaded, never that a form was reached.
 *
 * PR 360 appended the CAPTCHA evidence reads to every managed fill run and PR 359 accepted any
 * non-empty extract as proof the form was reached, so on the merged tree the second undid the
 * first. MANAGED_CAPTCHA_ANCHOR_SELECTOR deliberately carries no badge exclusion - the badge's own
 * anchor is the only thing that identifies an invisible-only page - so it matches on any
 * reCAPTCHA-bearing page including the Akuna Greenhouse page, form or no form:
 *
 *   applicationFormWasReached({filledFields:[], providerBlockers:[], discoveredQuestionCount:0,
 *     extracted:[{value:null},
 *                {value:'https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible'}], ...})
 *   -> true
 *   preparationEvidenceBlockers(...) -> the exact three sentences PR 359 exists to delete
 *
 * FORM_NOT_REACHED_REASON was unreachable on the managed path for the three Akuna Class C packets.
 */
const RECAPTCHA_ANCHOR_EXTRACTS = [
  { value: null },
  { value: 'https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible' },
];

test('a reCAPTCHA anchor iframe is not evidence that an application form was reached', () => {
  assert.equal(
    applicationFormWasReached({
      filledFields: [],
      providerBlockers: [],
      discoveredQuestionCount: 0,
      extracted: RECAPTCHA_ANCHOR_EXTRACTS,
      text: 'Akuna Capital Quantitative Trader Intern',
      email: packet.email,
    }),
    false,
  );

  const blockers = preparationEvidenceBlockers({
    text: 'Akuna Capital Quantitative Trader Intern',
    filledFields: [],
    blockers: [],
    discovered: [],
    extracted: RECAPTCHA_ANCHOR_EXTRACTS,
  }, packet);
  assert.deepEqual(blockers, [FORM_NOT_REACHED_REASON]);
  for (const sentence of blockers) {
    assert.doesNotMatch(sentence, /did not record/, 'a form that was never opened has nothing to not record');
  }
});

test('every labelled CAPTCHA evidence read is subtracted from reach, whatever it returned', () => {
  for (const label of [
    'captcha_challenge',
    'captcha_size',
    'captcha_invisible_sitekey',
    'captcha_rendered_sitekey',
    'captcha_anchor',
    'captcha_bframe',
  ]) {
    assert.equal(
      applicationFormWasReached({ extracted: [{ label, value: 'something the widget said' }] }),
      false,
      `${label} must not count as reach`,
    );
  }
  // And an extract off the form itself still counts, which is the signal this must not cost.
  assert.equal(applicationFormWasReached({ extracted: [{ label: 'email', value: 'mehek@example.com' }] }), true);
});

/* The label is the easy case. The subtraction also has to work when the runner echoes an extract
 * back WITHOUT the label it was asked with, which is the reason the value-shape fallback exists at
 * all - the Akuna reproduction did exactly that.
 *
 * It caught a labelless anchor URL and missed a labelless size read, because the size read is the
 * one evidence extract whose value carries no captcha vocabulary: it comes back as the bare
 * contents of `data-size`. Measured:
 *
 *   {label: undefined, selector: undefined, value: 'invisible'} -> false
 *
 * so a page that reported nothing but its widget's size was recorded as having reached an
 * application form. Reporting-only, and wrong in the direction that hides a run that never opened
 * a form. */
test('a size read with no label is still a CAPTCHA evidence read, not a form field', () => {
  for (const value of ['invisible', 'normal', 'compact', 'Invisible']) {
    assert.equal(
      applicationFormWasReached({ extracted: [{ value }] }),
      false,
      `a labelless "${value}" is a data-size read, not something seen on the form`,
    );
  }
  // The whole value, not a substring. An application answer that merely contains the word is a
  // real answer off a real form, and subtracting it would cost the reach signal it proves.
  assert.equal(
    applicationFormWasReached({ extracted: [{ value: 'I am comfortable working normal business hours' }] }),
    true,
  );
});

test('a broken preview still outranks the reach question', () => {
  // Knowing the page is a 404 is more useful than knowing we did not reach a form on it.
  assert.deepEqual(
    preparationEvidenceBlockers({ text: 'Sorry, but we cannot find that page.', filledFields: [] }, packet),
    ['The filled form preview looks like an error, login, or missing page instead of a completed application form.'],
  );
});

test('the not-reached sentence is categorized apart from an evidence gap', async () => {
  const { attentionCategoriesForReasons } = await import('../lib/submissionTerminalCause');
  assert.deepEqual(attentionCategoriesForReasons([FORM_NOT_REACHED_REASON]), ['form_not_reached']);
  assert.deepEqual(
    attentionCategoriesForReasons(['The filled form did not record an email field.']),
    ['evidence_gap'],
    'the two must stay distinguishable, because telling them apart is the whole fix',
  );
});

test('legacy multiline option-read failures remain evidence gaps', async () => {
  const { attentionCategoriesForReasons } = await import('../lib/submissionTerminalCause');
  assert.deepEqual(attentionCategoriesForReasons([
    'Litos could not read the choices Data consent\nfor this application offers.',
  ]), ['evidence_gap']);
});

/* ---- a closed or past-deadline posting is its own category, across all three detectors ---- */

test('a monitor-detected take-down is categorised as posting_closed', async () => {
  const { attentionCategoriesForReasons } = await import('../lib/submissionTerminalCause');
  const { POSTING_CLOSED_BY_MONITOR_REASON } = await import('../lib/applicationPortalRepair');
  assert.deepEqual(attentionCategoriesForReasons([POSTING_CLOSED_BY_MONITOR_REASON]), ['posting_closed']);
});

test('a live-scraped take-down (postingClosedReason) is also posting_closed, not unknown', async () => {
  /* Before this branch existed, submissionRunner.ts's own postingClosedReason sentences fell all
   * the way through attentionCategoriesForReasons to 'unknown' - the exact gap this feature's
   * design trace measured. Both of postingClosedReason's two sentences are covered. */
  const { attentionCategoriesForReasons } = await import('../lib/submissionTerminalCause');
  assert.deepEqual(attentionCategoriesForReasons([
    'The employer has taken this posting down: the page says "This position is no longer active". '
    + 'There is no application form any more, nothing was filled in and nothing was sent. '
    + 'There is nothing left to do on this one.',
  ]), ['posting_closed']);
  assert.deepEqual(attentionCategoriesForReasons([
    'The employer’s application page no longer exists: it says "The page you were looking for '
    + 'doesn’t exist". The posting has most likely closed or moved, so nothing was filled in and '
    + 'nothing was sent. Check the posting itself if you want to be sure.',
  ]), ['posting_closed']);
});

test('a stated-deadline sentence is categorised as posting_closed', async () => {
  const { attentionCategoriesForReasons } = await import('../lib/submissionTerminalCause');
  assert.deepEqual(attentionCategoriesForReasons([
    'This posting’s stated deadline (August 31, 2026) has passed. Litos will not send it unless '
    + 'you confirm the employer still accepts applications.',
  ]), ['posting_closed']);
});

/* ---- an expired packet is a promise being kept, and must be categorised as one ---- */

test('an expired packet is categorised as packet_expired, not as a document the employer wants', () => {
  /* The required_document arm fires on a bare /file/, and this sentence contains the word twice.
     Falling through to it would tell the applicant an employer is waiting on an upload, for an
     application no employer has ever seen. */
  const out = submissionFailureOutcome({
    captchaStop: null,
    noSubmitControl: false,
    packetDocumentExpired: true,
    uncertainAfterClaim: true,
    externalGate: false,
    providerSessionFailure: false,
    currentAttentionReason: undefined,
  });
  assert.deepEqual(out.attentionCategories, ['packet_expired']);
  assert.ok(!out.attentionCategories.includes('required_document'));
  assert.ok(!out.attentionCategories.includes('run_failed'),
    'retrying cannot fix this, so it must not land in the bucket the applicant is told to retry');
  assert.ok(!out.attentionCategories.includes('unknown'));
});

test('an employer field label named Resume is not read as a retention deletion', () => {
  /* The mirror of the security-code branch's reasoning: the runner's required-field scan emits
     '"Resume" is required and is still empty', and matching on /resume/ rather than on the clause
     would file an unfilled form as an expired packet. */
  const out = submissionFailureOutcome({
    captchaStop: null,
    noSubmitControl: false,
    uncertainAfterClaim: false,
    externalGate: false,
    providerSessionFailure: false,
    currentAttentionReason: '"Resume" is required and is still empty',
  });
  assert.ok(!out.attentionCategories.includes('packet_expired'));
});

/* ---- the invariant has to hold at the write, not only in the helpers ---- */

test('the terminal-cause check sits inside the shared merge, not at the call sites', async () => {
  const stall = await readFile('src/lib/applicationStall.ts', 'utf8');
  assert.match(stall, /import \{ withTerminalCause \} from '\.\/submissionTerminalCause'/);
  /* The merge now carries a third spread (the acknowledgement expiry decided beside it) and lands
     in a const the expiry's second half inspects before returning. What this test holds is
     unchanged: the whole merged review passes through withTerminalCause inside applyReviewPatch,
     so no caller can persist a terminal state without a cause. */
  assert.match(stall, /const merged = withTerminalCause\(settleStall\(\{ \.\.\.current, \.\.\.patch, \.\.\.acknowledgements, updated_at: now\(\) \}, now\)\)/);
});

test('no route writes a terminal review state around the shared merge', async () => {
  for (const path of ['src/routes/submissionRunner.ts', 'src/routes/applications.ts']) {
    const source = await readFile(path, 'utf8');
    // Every terminal status literal must be part of a patch object, never a spread-built review
    // handed straight to the database. `...pending, status: 'failed'` is what bypassed this.
    assert.doesNotMatch(
      source,
      /\.\.\.\w+,\s*\n\s*status: '(?:failed|needs_attention)'/,
      `${path} builds a terminal review by spread instead of applyReviewPatch`,
    );
  }
});
