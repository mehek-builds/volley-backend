import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* D-01. EVERY PATH TO AN EMPLOYER REFUSES A BLANK REQUIRED ANSWER, not just the ones that were easy
 * to reach.
 *
 * Production packet 245c827a (Deepgram, Ashby) was offered to a person as "Done - 5 checked" with a
 * green Send it button while three required fields on the employer's form were empty. Part of that
 * was the runner not seeing the fields at all, which is fixed in stratus-browser-cloud. The other
 * part is here: FIVE code paths write status 'submitted', and the required-answer check reached
 * some of them and not others.
 *
 * These are source-shape assertions rather than behavioural ones because what they protect is a
 * placement: the check has to sit in front of the send, on every path, and no unit test of the
 * predicate can notice a path that forgot to call it. The one thing that IS behavioural - that the
 * check no longer stands in front of a fill run - is at the bottom of this file against a real
 * database, because that was the regression that locked packets for good.
 */

function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `could not find ${from}`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `could not find ${to} after ${from}`);
  return source.slice(start, end);
}

test('the extension send path refuses a blank required answer before it claims the packet', async () => {
  /* The path this closes. extension-start hands the packet to the Chrome extension, which fills the
     employer's form and presses Submit in the applicant's own browser; extension-outcome only
     records what happened afterwards. So this route is the last server-side moment before a send,
     and it had never carried a required-answer check of any kind. */
  const route = await readFile('src/routes/applications.ts', 'utf8');
  const handler = slice(
    route,
    "'/applications/:id/submission/extension-start'",
    "'/applications/:id/submission/extension-outcome'",
  );
  assert.match(handler, /blankRequiredQuestionLabels\(refreshedQuestions\)/);
  assert.match(handler, /kind: 'required_answer_missing'/);
  assert.match(handler, /result\.kind === 'required_answer_missing'/);
  assert.match(handler, /Answer every required question before submitting\./);
  // Ordering, mirroring the sensitive-question assertion in submissionEducationGuard.regression-1:
  // a claim taken for a submission that is then refused leaves the packet stuck in 'submitting'.
  assert.ok(
    handler.indexOf('blankRequiredQuestionLabels') < handler.indexOf('tx.update(generated_resumes)'),
    'a blank required answer must block before the submission claim is written',
  );
  // Against the REFRESHED questions, so a value the profile has since supplied counts as answered
  // and the applicant is not asked for something Litos can now fill in.
  assert.ok(
    handler.indexOf('const refreshedQuestions =') < handler.indexOf('blankRequiredQuestionLabels'),
    'the check must read the refreshed answers, not the stored snapshot',
  );
});

test('the final click refuses a blank required answer on every provider, including the ATS API', async () => {
  /* prepare() decides `safe` for the two browser providers and that covers standing consent. It
     does NOT cover the ATS API channel, which prepares with `safe` as a literal true - no browser,
     no blockers, no question list read anywhere - and then posts the application to the employer's
     API from submit(). This assertion pins the gate ABOVE that call, which is the only placement
     that covers it. */
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const submit = slice(runner, 'async function submit(row: ResumeRow', '\nasync function ');
  assert.match(submit, /const unansweredRequired = blankRequiredQuestionLabels\(claimedReview\.questions\)/);
  assert.match(submit, /status: 'needs_attention'/);

  const gate = submit.indexOf('blankRequiredQuestionLabels');
  assert.ok(gate >= 0, 'submit() must consult the required-answer gate');
  // After the claim, so it reads the review as it stands at the moment of the click.
  assert.ok(
    submit.indexOf('await claimSubmission(row)') < gate,
    'the gate must read the claimed review rather than the queued one',
  );
  // Before every send. Each of these is a separate way to reach an employer from this function.
  for (const send of [
    'submitControlled(row, claimedReview, fastify)',
    'submitViaAtsSubmissionChannel(row, claimedReview, fastify)',
    'buildManagedPortalActions(portal, packet, true)',
    'clickFinalSubmit(page)',
  ]) {
    const at = submit.indexOf(send);
    assert.ok(at >= 0, `submit() no longer contains ${send}; re-point this assertion`);
    assert.ok(gate < at, `the required-answer gate must run before ${send}`);
  }
});

test('the unsupported-portal email fallback still refuses before it emails an employer', async () => {
  const route = await readFile('src/routes/applications.ts', 'utf8');
  const handler = slice(route, "'/applications/:id/submit-request'", "'/applications/:id/submission/channels'");
  const gate = handler.indexOf('blankRequired.length > 0');
  const send = handler.indexOf('sendUnsupportedPortalApplicationEmail');
  assert.ok(gate >= 0 && send > gate, 'the blank-required refusal must precede the email send');
  // Scoped to the branch that sends. Everything else in this route books a browser, and a fill run
  // is what ANSWERS a required question, so refusing the run is a loop with no exit.
  assert.match(handler, /const sendsWithoutAnotherRun = Boolean\(current\.portal_url\) && !isPortalSupported/);
});

test('booking a fill run is not gated on the answers the run exists to produce', async () => {
  const route = await readFile('src/routes/applications.ts', 'utf8');
  const handler = slice(route, "'/applications/:id/submit-request'", "'/applications/:id/submission/channels'");
  // The deadlock: mergeSubmittedApplicationReviewQuestions is stored-driven, so once a run has
  // written one required question with a blank answer, no payload any client can send clears the
  // condition and the packet is refused forever.
  assert.doesNotMatch(
    handler,
    /if \(normalizedSubmittedQuestions\.some\(\(question\) => question\.required && !question\.answer\.trim\(\)\)\)/,
    'an unconditional required-answer refusal in front of the fill run is the deadlock',
  );
  const gate = handler.indexOf('blankRequired.length > 0');
  const books = handler.indexOf('processSubmissionApplication(row.id, fastify)');
  assert.ok(books > gate, 'expected the browser-booking call after the email branch');
});

test('the ATS API channel does not describe a packet as ready without reading its questions', async () => {
  /* The one preparation with no browser behind it. It opens no page, computes no blockers and never
     sees the employer's form, so `safe` was written as a literal `true` - honest about the form and
     wrong about the packet, because with standing consent that turns straight into 'submitting' and
     submitViaAtsSubmissionChannel posts the application. Latent today, since atsApiSubmissionEnabled()
     gates the branch; the literal is the shape that bites the day the flag goes on. */
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const branch = slice(runner, "if (atsAssessment?.status === 'available')", 'if (shouldUseLocalControlledBrowser(portal))');
  assert.doesNotMatch(branch, /preparedReviewPatch\(authorization, true\)/);
  assert.match(branch, /blankRequiredQuestionLabels\(current\.questions\)/);
  assert.match(branch, /preparedReviewPatch\(authorization, atsUnansweredRequired\.length === 0\)/);
  // And it says why, rather than leaving a packet at needs_attention with no stated cause.
  assert.match(branch, /still unanswered/);
});
