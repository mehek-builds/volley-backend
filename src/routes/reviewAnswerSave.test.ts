/* THE SAVE BUTTON THAT SAVED NOTHING.
 *
 * The Review-answers screen is where a run that stopped hands the applicant the questions only she
 * can answer. Its Save button called a local-only handler, printed "Saved." synchronously and issued
 * no request at all, so every answer typed there died with the tab. Neither existing route could be
 * pointed at it: POST /submit-request books a browser run, which is precisely what this screen must
 * not do, and PUT /review writes 'questions_ready' or 'ready_to_submit' over the status - and
 * refuses this packet outright anyway, because its gate is submitRequestDisposition and a stopped
 * run leaves needs_attention wearing a claim.
 *
 * WHY REAL ROUTES AND A REAL DATABASE, same reason as submissionClaimRouteGate: what matters is the
 * status the owner gets back and the row the database holds afterwards. A route that answered 200
 * and wrote nothing is exactly the defect being fixed, and only reading the row afterwards can tell
 * those two apart. Fixture is PGlite over a unix socket with the production db module, the
 * production routes and the production auth middleware, DDL generated from db/schema.ts at run time.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import type { ApplicationReviewQuestion, ApplicationReviewState } from '../lib/applicationReview';

const JWT_SIGNING_SECRET = 'review-answer-save-secret';
const ENCRYPTION_KEY = 'review-answer-save-key';

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
};

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let pool: typeof import('../db/index')['pool'];
let app: FastifyInstance;
let schema: typeof import('../db/schema');
let db: typeof import('../db/index')['db'];
let userId = '';
let token = '';

const STOPPED_AT = '2026-08-13T11:00:00.000Z';
const PORTAL_URL = 'https://jobs.ashbyhq.com/kos/f0f0f0f0-0000-4000-8000-000000000000/application';

/* The question a stopped run hands back, carrying the two things the fill needs and a client cannot
 * send: the ATS field it types into, and the selector discovery measured. questionSchema strips
 * both, so they are only still here if the save merged onto the stored record. */
const HELD_QUESTION: ApplicationReviewQuestion = {
  id: 'prior-application',
  question: 'Have you applied to another role at this company in the last 12 months?',
  answer: '',
  kind: 'required',
  required: true,
  portal_selector: '#question_prior_application',
  portal_input_type: 'select',
  ats_api_field: 'answers[3]',
};

/* AN ANSWER NO HUMAN TYPED, sitting on the same packet as the blank one above.
 *
 * Resolved from the profile by an earlier run, so it carries no answer_source and no
 * answer_reviewed_at: on 2026-08-12 that described 2790 of 2790 question records in production, and
 * 14 answers in the whole database carried an applicant_review claim. This is the shape a save must
 * not adopt. In production the 802 answers a blanket stamp would have claimed across 174 packets are
 * this one: gender, disability status, veteran status, sponsorship, compensation expectations. */
const MACHINE_ANSWERED_QUESTION: ApplicationReviewQuestion = {
  id: 'gender',
  question: 'Gender',
  answer: 'Female',
  kind: 'required',
  required: false,
  portal_selector: '#question_gender',
  portal_input_type: 'select',
  ats_api_field: 'demographics[gender]',
};

/** A packet stopped at needs_attention still wearing the claim its run took, owing one answer. */
function stoppedRun(extra: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return {
    jd_text: 'Backend engineer at kos',
    status: 'needs_attention',
    edited_terms: [],
    questions: [HELD_QUESTION],
    skipped_reasons: [],
    updated_at: STOPPED_AT,
    portal_url: PORTAL_URL,
    ats_name: 'ashby',
    submission_run_id: 'run-1',
    submission_claimed_at: STOPPED_AT,
    submission_claim_id: 'claim-1',
    attention_reason: 'This form asks whether you have applied before. Litos cannot answer that for you.',
    ...extra,
  };
}

async function applicationWith(review: ApplicationReviewState): Promise<string> {
  const [row] = await db.insert(schema.generated_resumes).values({
    user_id: userId,
    job_context: { company: 'kos', role: 'Backend engineer' },
    spec: { _review: review },
    resume_object_key: `users/${userId}/resumes/${crypto.randomUUID()}.pdf`,
  }).returning({ id: schema.generated_resumes.id });
  return row.id;
}

async function storedReview(applicationId: string): Promise<ApplicationReviewState> {
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select({ spec: schema.generated_resumes.spec })
    .from(schema.generated_resumes)
    .where(eq(schema.generated_resumes.id, applicationId))
    .limit(1);
  return (row?.spec as { _review: ApplicationReviewState })._review;
}

/** The body the Review-answers screen posts: the answer and the label, and nothing it cannot vouch for. */
function saveAnswers(applicationId: string, answer: string) {
  return app.inject({
    method: 'PUT',
    url: `/applications/${applicationId}/review/answers`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      questions: [{
        id: HELD_QUESTION.id,
        question: HELD_QUESTION.question,
        answer,
        kind: HELD_QUESTION.kind,
        required: HELD_QUESTION.required,
      }],
    },
  });
}

/* THE SAME PACKET WITH A SECOND QUESTION ON IT, which is what every real one looks like.
 *
 * The single-question fixture above is what let a blanket claim through: with one blank question and
 * one answer in the body, "stamp the blank she filled" and "stamp everything" are the same list.
 * Production packets are not that shape. The 174 affected ones hold a resolver-held blank next to
 * answers no human supplied, and only a fixture with both can tell the two rules apart. */
function stoppedRunWithMachineAnswer(extra: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return stoppedRun({ questions: [HELD_QUESTION, MACHINE_ANSWERED_QUESTION], ...extra });
}

/** A stored question reduced to what the client can actually send. questionSchema strips the rest. */
function asSent(question: ApplicationReviewQuestion, answer: string = question.answer) {
  return {
    id: question.id,
    question: question.question,
    answer,
    kind: question.kind,
    required: question.required,
  };
}

function saveQuestions(applicationId: string, questions: readonly (ReturnType<typeof asSent> & { confirmed?: true })[]) {
  return app.inject({
    method: 'PUT',
    url: `/applications/${applicationId}/review/answers`,
    headers: { authorization: `Bearer ${token}` },
    payload: { questions },
  });
}

function editReview(applicationId: string) {
  return app.inject({
    method: 'PUT',
    url: `/applications/${applicationId}/review`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      ats_name: 'ashby',
      portal_url: PORTAL_URL,
      questions: [{ ...HELD_QUESTION, answer: 'No' }],
      skipped_reasons: [],
    },
  });
}

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-answer-save-'));
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

  schema = await import('../db/schema');
  const dbModule = await import('../db/index');
  db = dbModule.db;
  pool = dbModule.pool;

  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await pglite.exec(statement);

  const [account] = await db.insert(schema.users).values({ email: 'answer-save@example.test' }).returning();
  userId = account.id;

  /* A REAL PROFILE, because the route now resolves against one.
   *
   * The save consults what the resolver answers, to tell an edit from a round trip of the resolver's
   * own value and to name the value an override was made against. With no profile row the resolver
   * declines on every label, so a fixture without one cannot exercise either decision - it would
   * assert the shape of a save that never met a resolved answer. `degree` is read from
   * profiles.parsed_json by loadApplicationProfileLike's academicStr. */
  await db.insert(schema.profiles).values({
    user_id: userId,
    parsed_json: {
      degree: 'Bachelor of Science in Computer Science',
      major: 'Computer Science',
      currently_enrolled: true,
    },
  });

  token = await new SignJWT({
    userId,
    email: 'answer-save@example.test',
    isGuest: false,
    authMethod: 'password',
    sessionVersion: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SIGNING_SECRET));

  const { applicationRoutes } = await import('./applications');
  app = Fastify({ logger: false });
  await app.register(applicationRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  await pool?.end();
  await server?.stop();
  await pglite?.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/* THE DEFECT, STATED AS THE ROW. Not "the request returned 200" but "the answer is on disk", which
 * is the only difference between this route and the handler it replaces. */
test('an answer saved from the Review-answers screen is on the row afterwards', async () => {
  const id = await applicationWith(stoppedRun());

  const response = await saveAnswers(id, 'No');
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer, 'No', 'the answer she typed is stored');
  assert.equal(response.json().review.questions[0].answer, 'No',
    'and the response says so, so the screen can show a banner about a write that happened');
});

/* THE STATUS THIS SAVE MUST NOT TOUCH. needs_attention is the record of a run that stopped and of
 * what it is still owed; the applicant answering one of its questions is not an instruction to
 * forget that. applyApplicationReviewEdit would have written 'questions_ready' here. */
test('saving an answer leaves the packet at needs_attention', async () => {
  const id = await applicationWith(stoppedRun());

  await saveAnswers(id, 'No');

  const persisted = await storedReview(id);
  assert.equal(persisted.status, 'needs_attention', 'the stopped run is still a stopped run');
  assert.equal(persisted.submission_claimed_at, STOPPED_AT, 'and still holds its claim');
  assert.equal(persisted.attention_reason, stoppedRun().attention_reason,
    'and still says what it is waiting for');
});

/* AND STARTS NOTHING. The whole reason this is not POST /submit-request: a save must not book a
 * browser, and a fresh submission_run_id would mean one had been booked. */
test('saving an answer books no submission run', async () => {
  const id = await applicationWith(stoppedRun());

  await saveAnswers(id, 'No');

  const persisted = await storedReview(id);
  assert.equal(persisted.submission_run_id, 'run-1', 'a new run id would mean a send was authorized');
  assert.equal(persisted.submission_authorization, undefined);
  assert.equal(persisted.submitted_at, undefined);
});

/* THE RECORD THAT MAKES THE ANSWER SURVIVE THE NEXT REFRESH. refreshKnownQuestionAnswers blanks
 * every answer to a held question it cannot attribute to the applicant, and it checks the per-answer
 * claim against the review's own round. Both halves, or the save has stored something the send will
 * throw away. */
test('a saved answer is recorded as the applicant\'s, against a review round the row also carries', async () => {
  const id = await applicationWith(stoppedRun());

  await saveAnswers(id, 'No');

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer_source, 'applicant_review');
  assert.ok(persisted.questions_reviewed_at, 'the packet now has a review round');
  assert.equal(persisted.questions[0].answer_reviewed_at, persisted.questions_reviewed_at,
    'and the claim is keyed to the round the row holds, or no reader can check it');
});

/* MERGED, NOT SUBSTITUTED. The client cannot send these and must not be able to erase them: the ATS
 * field is what the fill types into, and the selector is what discovery measured. */
test('saving an answer keeps the field bindings the run wrote', async () => {
  const id = await applicationWith(stoppedRun());

  await saveAnswers(id, 'No');

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].ats_api_field, 'answers[3]');
  assert.equal(persisted.questions[0].portal_selector, '#question_prior_application');
  assert.equal(persisted.questions[0].portal_input_type, 'select');
});

/* WHY THIS ROUTE HAD TO EXIST. The same packet, the same answer, through the edit route that was
 * suggested as the place to put this: refused before it writes anything. */
test('the review edit route still refuses this packet, which is why the save has its own', async () => {
  const id = await applicationWith(stoppedRun());

  const response = await editReview(id);
  assert.equal(response.statusCode, 409, response.body);

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer, '', 'a refused edit writes nothing, which is correct');
  assert.equal(persisted.status, 'needs_attention');
});

/* AND THE OTHER HALF OF THAT SENTENCE, WHICH IS THE WORSE ONE. Asserted rather than assumed,
 * because a live website change was built on the assumption that it could not happen.
 *
 * The refusal above is a CLAIMED stopped run. An UNCLAIMED one is a different row and a different
 * answer: submitRequestDisposition returns 'start' for it, so the edit route is permitted rather
 * than refused. It writes `status: questions_ready | ready_to_submit` over a `...current` spread and
 * replies 200, so a packet that is still blocked comes back wearing a ready status, and nothing in
 * the response says the stop was dropped. The attention_reason prose survives on the row, which
 * makes it worse rather than better: the row now says READY and carries the sentence explaining why
 * it is not.
 *
 * Website PR #319 (a39fe29, live) routed EVERY needs_attention packet through that route to persist
 * its reviewed answers before an exact-packet audit. The intent was right and the route was not.
 * This test is the measurement behind features/applications/domain/review-answer-save.ts's
 * auditAnswerWrite, which keeps the intent and sends the stalled packet here instead. */
test('the edit route is not refused on an unclaimed stopped run, and relabels it', async () => {
  const unclaimed = stoppedRun({ submission_claimed_at: undefined, submission_claim_id: undefined });
  const throughEdit = await applicationWith(unclaimed);
  const throughSave = await applicationWith(unclaimed);

  const edited = await editReview(throughEdit);
  assert.equal(edited.statusCode, 200, edited.body);
  const afterEdit = await storedReview(throughEdit);
  assert.equal(afterEdit.status, 'questions_ready',
    'permitted, and the stop is gone from the one field the dashboard badges');
  assert.equal(afterEdit.attention_reason, unclaimed.attention_reason,
    'while the sentence saying what it is still waiting for stays on the row, under a ready status');

  const saved = await saveAnswers(throughSave, 'No');
  assert.equal(saved.statusCode, 200, saved.body);
  const afterSave = await storedReview(throughSave);
  assert.equal(afterSave.status, 'needs_attention',
    'the same packet and the same answer, through the answers route, is still a stopped run');
  assert.equal(afterSave.attention_reason, unclaimed.attention_reason, 'still owed the same thing');
  assert.equal(afterSave.questions[0].answer, 'No',
    'and the answer is stored, which is the whole reason #319 wanted a write here at all');
});

/* THE REFUSALS. Each asserts the row as well as the status, because a route that answered 409 and
 * wrote anyway would pass on the status line alone. */

test('an application already at the employer refuses the save', async () => {
  const id = await applicationWith(stoppedRun({
    status: 'submitted',
    submitted_at: STOPPED_AT,
    attention_reason: undefined,
  }));

  const response = await saveAnswers(id, 'No');
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'REVIEW_ANSWERS_NOT_EDITABLE');

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer, '',
    'the answers on a sent application are the record of what was sent');
  assert.equal(persisted.status, 'submitted');
});

test('an application waiting on the employer\'s emailed code refuses the save', async () => {
  const id = await applicationWith(stoppedRun({ status: 'awaiting_security_code' }));

  const response = await saveAnswers(id, 'No');
  assert.equal(response.statusCode, 409, response.body);

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer, '');
  assert.equal(persisted.status, 'awaiting_security_code');
});

test('an application with a run filling the form refuses the save', async () => {
  const id = await applicationWith(stoppedRun({ status: 'filling' }));

  const response = await saveAnswers(id, 'No');
  assert.equal(response.statusCode, 409, response.body);

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer, '', 'the run owns this row until it finishes');
  assert.equal(persisted.status, 'filling');
});

/* A filled form with a preview the applicant is looking at. New answers underneath it would leave
 * that picture describing something else; her way in is the resume edit, which refills it. */
test('an application waiting on final approval refuses the save', async () => {
  const id = await applicationWith(stoppedRun({
    status: 'ready_for_final_approval',
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
  }));

  const response = await saveAnswers(id, 'No');
  assert.equal(response.statusCode, 409, response.body);

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer, '');
  assert.equal(persisted.status, 'ready_for_final_approval');
});

/* AND THE ORDINARY PRE-SEND STATES ARE NOT COLLATERAL. Refusing everything would pass every test
 * above and ship a Save button that still saves nothing. */
test('an application still being prepared accepts the save', async () => {
  const id = await applicationWith(stoppedRun({
    status: 'questions_ready',
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    attention_reason: undefined,
  }));

  const response = await saveAnswers(id, 'No');
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer, 'No');
  assert.equal(persisted.status, 'questions_ready', 'and this status is left alone too');
});

test('another owner\'s application is not saveable', async () => {
  const [stranger] = await db.insert(schema.users).values({ email: 'stranger@example.test' }).returning();
  const [row] = await db.insert(schema.generated_resumes).values({
    user_id: stranger.id,
    job_context: { company: 'kos', role: 'Backend engineer' },
    spec: { _review: stoppedRun() },
    resume_object_key: `users/${stranger.id}/resumes/${crypto.randomUUID()}.pdf`,
  }).returning({ id: schema.generated_resumes.id });

  const response = await saveAnswers(row.id, 'No');
  assert.equal(response.statusCode, 404, response.body);

  const persisted = await storedReview(row.id);
  assert.equal(persisted.questions[0].answer, '');
});

/* WHOSE ANSWER IS IT. One save must not sign the applicant's name to work she never did.
 *
 * A claim of 'applicant_review' is not decoration. refreshKnownQuestionAnswers blanks every answer
 * to a resolver-held question that cannot be attributed to her, so the stamp is exactly what decides
 * whether an answer reaches an employer's form. Stamping every non-empty answer in the merged list
 * would have carried 802 machine-written answers across 174 live packets past that check as hers -
 * gender, disability status, veteran status, sponsorship, compensation - which is the category
 * Litos holds back BECAUSE only she may answer it. */

test('a save stamps the blank she filled and leaves the machine-written answer beside it unclaimed', async () => {
  const id = await applicationWith(stoppedRunWithMachineAnswer());

  // The shipped client posts the whole list it is holding, so the machine answer comes back too.
  const response = await saveQuestions(id, [
    asSent(HELD_QUESTION, 'No'),
    asSent(MACHINE_ANSWERED_QUESTION),
  ]);
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  const [held, machine] = persisted.questions;

  assert.equal(held.answer, 'No', 'the blank she typed into is saved');
  assert.equal(held.answer_source, 'applicant_review', 'and is recorded as hers, which is the fix');
  assert.equal(held.answer_reviewed_at, persisted.questions_reviewed_at);

  assert.equal(machine.answer, 'Female', 'the answer she never touched is still there');
  assert.equal(machine.answer_source, undefined,
    'and is not signed with her name: she did not supply it, she only failed to delete it');
  assert.equal(machine.answer_reviewed_at, undefined);
});

test('a stored question the request never mentioned has no claim minted for it', async () => {
  const id = await applicationWith(stoppedRunWithMachineAnswer());

  /* The shape that arrives from the shipped client whenever a run adds a question to the row after
   * the client's last poll: she answers what is on her screen, and the row holds one more. */
  const response = await saveQuestions(id, [asSent(HELD_QUESTION, 'No')]);
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  assert.equal(persisted.questions.length, 2, 'the unmentioned question is kept, not dropped');

  const machine = persisted.questions[1];
  assert.equal(machine.question, MACHINE_ANSWERED_QUESTION.question);
  assert.equal(machine.answer, 'Female');
  assert.equal(machine.answer_source, undefined,
    'a question this request never carried cannot have been answered by this request');
  assert.equal(machine.answer_reviewed_at, undefined);
});

/* WHAT THE STATUS CANNOT SEE. needs_attention is also what a run that may have pressed submit leaves
 * behind: unverifiedSubmissionPatch writes submission_attempted_at, records an unresolved
 * unverified_submission, and KEEPS the claim. Two of the 286 live needs_attention rows on 2026-08-13
 * carried that evidence, and the dashboard offers "Check the answers" for both, so the route is
 * reachable from the screen. A gate keyed on status alone let every one of them through.
 *
 * One case per stored fact, because each is independently sufficient. See
 * employerMayHoldApplication, which is where submissionProvablyNotSent asks the same question. */

const SEND_EVIDENCE: Array<[string, Partial<ApplicationReviewState>]> = [
  ['a recorded submit attempt', { submission_attempted_at: STOPPED_AT }],
  ['the employer\'s own confirmation', {
    receipt: {
      confirmation_text: 'Thanks for applying to kos.',
      final_url: `${PORTAL_URL}/confirmation`,
      captured_at: STOPPED_AT,
    },
  }],
  ['an unresolved unverified submission', {
    unverified_submission: { at: STOPPED_AT, cause: 'no_confirmation_state', portal_url: PORTAL_URL },
  }],
  ['a standing security code wall', {
    security_code: { digits: 6, requested_at: STOPPED_AT, submit_was_authorized: true },
  }],
];

for (const [name, evidence] of SEND_EVIDENCE) {
  test(`a stopped run carrying ${name} refuses the save and is left untouched`, async () => {
    const id = await applicationWith(stoppedRun(evidence));

    const response = await saveAnswers(id, 'No');
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'REVIEW_ANSWERS_NOT_EDITABLE');

    const persisted = await storedReview(id);
    assert.equal(persisted.questions[0].answer, '',
      'the answers on a row that may already be at an employer are the record of what was sent');
    assert.equal(persisted.questions_reviewed_at, undefined, 'and no review round was minted');
    assert.equal(persisted.status, 'needs_attention');
  });
}

/* HER LOOK IS THE RELEASE. The resolution route records 'not_sent' only after she has opened the
 * employer page and answered, releases the claim, and promises "Litos can send it again whenever
 * you are ready". Measured on the Easy Dynamics Rippling packet (2026-08-20): the promise was
 * unfulfillable, because the save gate read the RESOLVED record and the same press's
 * submission_attempted_at as an employer hold, and the review screen's save-then-audit sequence
 * aborted at the 409 before the audit ever ran. A resolved not_sent neutralises exactly those two
 * facts; a receipt or a security code still refuses, and a resolution of 'sent' still refuses. */
test('a press she looked into and answered "not there" is editable again', async () => {
  const id = await applicationWith(stoppedRun({
    submission_attempted_at: STOPPED_AT,
    unverified_submission: {
      at: STOPPED_AT, cause: 'no_confirmation_state', portal_url: PORTAL_URL,
      resolution: 'not_sent', resolved_at: STOPPED_AT,
    },
  }));

  const response = await saveAnswers(id, 'No');
  assert.equal(response.statusCode, 200, response.body);
});

test('a resolution of "sent" keeps the row locked: the employer has it', async () => {
  const id = await applicationWith(stoppedRun({
    submission_attempted_at: STOPPED_AT,
    unverified_submission: {
      at: STOPPED_AT, cause: 'no_confirmation_state', portal_url: PORTAL_URL,
      resolution: 'sent', resolved_at: STOPPED_AT,
    },
  }));

  const response = await saveAnswers(id, 'No');
  assert.equal(response.statusCode, 409, response.body);
});

test('a resolved not_sent beside a security code still refuses: the wall is the employer\u2019s record', async () => {
  const id = await applicationWith(stoppedRun({
    unverified_submission: {
      at: STOPPED_AT, cause: 'no_confirmation_state', portal_url: PORTAL_URL,
      resolution: 'not_sent', resolved_at: STOPPED_AT,
    },
    security_code: { digits: 6, requested_at: STOPPED_AT, submit_was_authorized: true },
  }));

  const response = await saveAnswers(id, 'No');
  assert.equal(response.statusCode, 409, response.body);
});

/* THE SAVE THAT LOST THE RACE, AND THE ONE BYTE THAT LETS THE SCREEN KNOW.
 *
 * The 202 body was shape-identical to the 200's, and the client resolves on any res.ok and returns
 * the parsed body with the status discarded, so "Saved." was shown for a write that did not land and
 * the applicant's typing was replaced with the stored review that does not contain it.
 *
 * STAGED WITH A TRIGGER, because the interleaving cannot be staged from outside the process: the
 * route has no await between reading the row and its conditional write, and PGlite serializes whole
 * connections, so a second connection cannot get a write in between. The trigger IS the run that got
 * there first - it writes its own version of the row, then returns NULL so the applicant's UPDATE
 * touches nothing and RETURNING yields no row, which is exactly what the conditional predicate
 * failing does. */
test('a save that lost the race answers 202, says so, and does not report a write that did not happen', async () => {
  const id = await applicationWith(stoppedRun());
  await pglite.exec(`
    CREATE OR REPLACE FUNCTION litos_test_run_wins_race() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
      UPDATE generated_resumes
         SET spec = jsonb_set(OLD.spec, '{_review,attention_reason}', '"The run wrote here first."'::jsonb)
       WHERE id = OLD.id;
      RETURN NULL;
    END $$;
    DROP TRIGGER IF EXISTS litos_test_run_wins_race ON generated_resumes;
    CREATE TRIGGER litos_test_run_wins_race BEFORE UPDATE ON generated_resumes
      FOR EACH ROW EXECUTE FUNCTION litos_test_run_wins_race();
  `);

  let response;
  try {
    response = await saveAnswers(id, 'No');
  } finally {
    await pglite.exec('DROP TRIGGER IF EXISTS litos_test_run_wins_race ON generated_resumes');
  }

  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().saved, false,
    'the body must say the save did not land, or a client that only reads the body cannot tell');
  assert.equal(response.json().review.attention_reason, 'The run wrote here first.',
    'and it carries what is actually stored, not what this request wanted to store');

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer, '', 'nothing of this save reached the row');
  assert.equal(persisted.questions_reviewed_at, undefined);
});

/* AND THE 200 CARRIES NO SUCH KEY. The client reads `saved === false` rather than an absence, so a
 * successful save must not answer with a discriminator at all. */
test('a save that landed answers 200 with no saved flag on it', async () => {
  const id = await applicationWith(stoppedRun());

  const response = await saveAnswers(id, 'No');

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().saved, undefined);
});

/* THE OTHER LOST RACE, WHICH REACHED HER AS A CRASH CARRYING THE STATEMENT.
 *
 * The three tests above stage the race the row can show: the run commits, the exact-spec predicate
 * matches nothing, and the route answers 202. Production had a second one that never got that far.
 * Every write to generated_resumes fires the submission-authority revision guard from a BEFORE
 * trigger; the guard takes the per-user advisory lock with pg_try_advisory_xact_lock - TRY, never
 * wait - and RAISES 40001 the instant anything else on the account holds it. A managed run holds it
 * for its whole transaction, and the dashboard's own 2.5-second poll holds it for a few
 * milliseconds. drizzle wraps that raise in a DrizzleQueryError whose message is `Failed query:
 * <the whole UPDATE>\nparams: <every bound value>`, and nothing caught it.
 *
 * MEASURED LIVE 2026-09-04, account mehekmandal05@gmail.com, Exa packet 73768339: this save answered
 * 500 with that statement in the body, the dashboard printed "Internal Server Error", and the
 * identical save answered 200 the moment the run finished.
 *
 * STAGED WITH A TRIGGER that raises exactly what the shipped guard raises, for the same reason the
 * lost-CAS test above uses one: the interleaving cannot be produced from outside the process. The
 * counter makes it the transient case - one refusal, then out of the way - which is the shape a
 * poll produces and the shape a retry is for.
 */
async function installAuthorityGuard(refusals: 'once' | 'always'): Promise<void> {
  /* THE ATTEMPT COUNTER IS A SEQUENCE, and it has to be. The raise aborts the statement's whole
   * transaction - which is the very property that makes a retry safe - so a counter kept in a table
   * is rolled back with it and every attempt reads "first attempt" forever. nextval is exempt from
   * rollback, so it is the one thing in Postgres that can remember an attempt the database has
   * un-remembered. Measured: a table-backed counter made the 'once' guard refuse without end. */
  await pglite.exec(`
    CREATE SEQUENCE IF NOT EXISTS litos_test_guard_attempts;
    ALTER SEQUENCE litos_test_guard_attempts RESTART WITH 1;
    CREATE OR REPLACE FUNCTION litos_test_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF nextval('litos_test_guard_attempts') > ${refusals === 'once' ? '1' : '2147483647'}
        THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'submission authority changed concurrently; retry the request'
        USING ERRCODE = '40001';
    END $$;
    DROP TRIGGER IF EXISTS litos_test_authority_guard ON generated_resumes;
    CREATE TRIGGER litos_test_authority_guard BEFORE UPDATE ON generated_resumes
      FOR EACH ROW EXECUTE FUNCTION litos_test_authority_guard();
  `);
}

async function removeAuthorityGuard(): Promise<void> {
  await pglite.exec('DROP TRIGGER IF EXISTS litos_test_authority_guard ON generated_resumes');
}

/* THE COMMON CASE, AND THE ONE THE APPLICANT SHOULD NEVER SEE AT ALL. The guard refused once and
 * then let go, which is what a poll holding the lock for four milliseconds looks like. The raise
 * happens in a BEFORE trigger, so the statement aborted before touching anything: retrying it is
 * retrying a write that provably did not happen, and the retried statement is byte-identical, exact
 * -spec predicate included, so it can only land on the row this request read. */
test('a save the authority guard refuses once still lands', async () => {
  const id = await applicationWith(stoppedRun());
  await installAuthorityGuard('once');

  let response;
  try {
    response = await saveAnswers(id, 'No');
  } finally {
    await removeAuthorityGuard();
  }

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().saved, undefined, 'it landed, so it carries no lost-race discriminator');
  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer, 'No', 'and her answer is on the row, not merely reported');
});

/* AND WHEN IT NEVER LETS GO, IT IS STILL NOT AN ERROR ABOUT HER APPLICATION. Nothing was written -
 * the same proof the retry rests on - so "your answers did not land, they are still on this screen"
 * is exactly true, and that sentence is what the dashboard already renders for 202 + saved:false
 * (REVIEW_ANSWERS_SAVE_RACED). A 500 said none of it, and said it with the UPDATE attached. */
test('a save the authority guard never lets through answers 202, not 500', async () => {
  const id = await applicationWith(stoppedRun());
  await installAuthorityGuard('always');

  let response;
  try {
    response = await saveAnswers(id, 'No');
  } finally {
    await removeAuthorityGuard();
  }

  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().saved, false,
    'the body must say the save did not land, or a client that only reads the body cannot tell');

  /* THE LEAK, ASSERTED SEPARATELY FROM THE STATUS, because fixing one without the other still ships
   * the statement. The 500 body carried the whole UPDATE, its jsonb_set, its `spec = $4::jsonb`
   * predicate and its bound-parameter shape to a browser. No response on this route may contain any
   * of it, whatever status it wears. */
  for (const forbidden of ['Failed query', 'jsonb_set', 'generated_resumes', 'params:']) {
    assert.ok(!response.body.includes(forbidden),
      `the response leaks server internals: ${forbidden} appears in ${response.body.slice(0, 400)}`);
  }

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer, '', 'and nothing of this save reached the row');
  assert.equal(persisted.questions_reviewed_at, undefined);
});

/* THE SAME GUARD ON THE SIBLING ROUTE, which shares this one's 202 + saved:false contract to the
 * byte. Ticking a "Your turn" checkbox while a run works the packet must not 500 either. */
test('a checklist tick the authority guard refuses answers 202, not 500', async () => {
  const id = await applicationWith(stoppedRun());
  await installAuthorityGuard('always');

  let response;
  try {
    response = await app.inject({
      method: 'POST',
      url: `/applications/${id}/review/attention-acks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { item_id: 'line-1', label: 'Upload your transcript on the company page', acknowledged: true },
    });
  } finally {
    await removeAuthorityGuard();
  }

  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().saved, false);
  assert.ok(!response.body.includes('Failed query'), 'and it does not ship the statement');
});

/* THE OTHER SILENT 200, WHICH THIS ROUTE ALSO ANSWERED FOR MONTHS AFTER IT COULD SAVE.
 *
 * The tests above prove a BLANK gets filled. Rewriting an answer an earlier run had already resolved
 * was a different path and a worse failure: the row took her bytes, the route answered 200, and
 * refreshKnownQuestionAnswers - which every reader and the fill run on this output - recomputed the
 * profile value straight back over it. Measured on the live Lever degree control, where the resolver
 * has no options to snap onto and answers "Bachelor of Science in Computer Science" against a list
 * offering "Bachelor Degree".
 *
 * The row is what this file checks, so the row is what this asserts: both halves of the record the
 * refresh needs. That the refresh then honours them is pinned in lib/applicantAnswerOverride.test.ts,
 * which runs the same composition the readers run. */
test('rewriting an answer an earlier run resolved records her claim and what she overrode', async () => {
  const RESOLVED = 'Bachelor of Science in Computer Science';
  const machineAnswered: ApplicationReviewQuestion = {
    id: 'degree--0',
    question: 'What degree are you currently pursuing?',
    answer: RESOLVED,
    kind: 'required',
    required: true,
    portal_selector: '#degree',
    portal_input_type: 'select',
    ats_api_field: 'answers[7]',
  };
  const id = await applicationWith(stoppedRun({ questions: [machineAnswered] }));

  const response = await saveQuestions(id, [asSent(machineAnswered, "Bachelor's Degree")]);
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer, "Bachelor's Degree", 'her wording is on the row');
  assert.equal(persisted.questions[0].answer_source, 'applicant_review',
    'attributed to her, or the next refresh recomputes it away');
  assert.equal(persisted.questions[0].answer_reviewed_at, persisted.questions_reviewed_at,
    'against a round the row also carries, or no reader can check the claim');
  assert.equal(persisted.questions[0].answer_override_of, RESOLVED,
    'and what she typed over, so the override cannot outlive the profile fact underneath it');
  assert.equal(persisted.questions[0].ats_api_field, 'answers[7]', 'still merged onto the stored record');
});

/* AND AN UNEDITED SAVE OF THAT SAME PACKET CLAIMS NOTHING. The screen posts back every question it is
 * holding, so if "she supplied this" were keyed on the answer being non-empty rather than on this
 * request having changed it, one Save would claim every resolved answer on the packet as hers. That is
 * the 802-answer laundering, and it is what the gate is written to exclude. */
test('an unedited save claims nothing on a machine-resolved answer', async () => {
  const id = await applicationWith(stoppedRunWithMachineAnswer());

  const response = await saveQuestions(id, [
    asSent(HELD_QUESTION, 'No'),
    asSent(MACHINE_ANSWERED_QUESTION),
  ]);
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  const machine = persisted.questions.find((question) => question.id === MACHINE_ANSWERED_QUESTION.id);
  assert.equal(machine?.answer, 'Female', 'untouched, and still the resolver\'s to recompute');
  assert.equal(machine?.answer_source, undefined, 'a question she did not touch is not her claim');
  assert.equal(machine?.answer_override_of, undefined);
  const held = persisted.questions.find((question) => question.id === HELD_QUESTION.id);
  assert.equal(held?.answer_source, 'applicant_review', 'and the one she did answer still is');
});

/* THE CONFIRM THAT CONFIRMED NOTHING, measured on the DV Trading packet e0a0eb84 on 2026-08-17.
 *
 * The dashboard's YOUR TURN panel holds the work-eligibility class back for the applicant and offers
 * CONFIRM. That control opens the Review-answers screen, she reads the answers, presses Save, and the
 * body that arrives here is byte-identical to an untouched Save - which the gate above rightly
 * refuses to read as a choice. So no claim was ever minted, nothing on the row changed, and the same
 * CONFIRM ask re-rendered after every save, indefinitely.
 *
 * The fix is the one honest byte the client can add: `confirmed: true` on exactly the question she
 * confirmed. The claim it mints is the applicant-claim's own definition - she read this exact text
 * and let it stand - so it is keyed to the same round an edit's claim is. */
test('a confirmed answer mints her claim without an edit, and only on the flagged question', async () => {
  const SPONSORSHIP_QUESTION: ApplicationReviewQuestion = {
    id: 'sponsorship',
    question: 'Will you now or in the future require sponsorship for an employment visa?',
    answer: 'Yes, will require firm sponsorship',
    kind: 'required',
    required: true,
    portal_selector: '#question_sponsorship',
    portal_input_type: 'select',
    ats_api_field: 'answers[9]',
  };
  const id = await applicationWith(stoppedRun({ questions: [SPONSORSHIP_QUESTION, MACHINE_ANSWERED_QUESTION] }));

  const response = await saveQuestions(id, [
    { ...asSent(SPONSORSHIP_QUESTION), confirmed: true },
    asSent(MACHINE_ANSWERED_QUESTION),
  ]);
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  const confirmed = persisted.questions.find((question) => question.id === SPONSORSHIP_QUESTION.id);
  assert.equal(confirmed?.answer, SPONSORSHIP_QUESTION.answer, 'the answer she confirmed, unchanged');
  assert.equal(confirmed?.answer_source, 'applicant_review',
    'her confirmation is her claim, or the CONFIRM ask re-renders forever');
  assert.equal(confirmed?.answer_reviewed_at, persisted.questions_reviewed_at,
    'keyed to the round the row holds, like every other applicant-claim');
  assert.equal((confirmed as Record<string, unknown> | undefined)?.confirmed, undefined,
    'the request flag is spent, not stored: answer_source already carries the claim');
  assert.equal(confirmed?.ats_api_field, 'answers[9]', 'still merged onto the stored record');
  const machine = persisted.questions.find((question) => question.id === MACHINE_ANSWERED_QUESTION.id);
  assert.equal(machine?.answer_source, undefined,
    'the unflagged question on the same save stays unclaimed: the laundering gate is untouched');
});

/* AND THE FLAG REACHES THROUGH THE RESOLVER ROUND-TRIP, which is the exact DV shape. The review
 * screen displays the REFRESHED value rather than the stored one, so a confirmation routinely posts
 * back the resolver's own answer - the shape the mint gate excludes hardest, because without the
 * flag it proves nothing. With it, the claim lands anyway. */
test('confirming the resolver\'s own value still mints the claim', async () => {
  const RESOLVED = 'Bachelor of Science in Computer Science';
  const degreeQuestion: ApplicationReviewQuestion = {
    id: 'degree--confirm',
    question: 'What degree are you currently pursuing?',
    answer: RESOLVED,
    kind: 'required',
    required: true,
    portal_selector: '#degree',
    portal_input_type: 'select',
    ats_api_field: 'answers[7]',
  };
  const id = await applicationWith(stoppedRun({ questions: [degreeQuestion] }));

  const response = await saveQuestions(id, [
    { ...asSent(degreeQuestion), confirmed: true },
  ]);
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer, RESOLVED);
  assert.equal(persisted.questions[0].answer_source, 'applicant_review');
  assert.equal(persisted.questions[0].answer_reviewed_at, persisted.questions_reviewed_at);
  assert.equal(persisted.questions[0].answer_override_of, undefined,
    'a confirmation is not an override: she typed nothing over anything');
});

/* THE FLAG CANNOT RIDE A RENAME. The claim is persisted against the STORED label, and the id
 * fallback lets a submitted question match while carrying different text - so a confirm minted
 * through that path would stamp "she read this exact text" onto text the request never contained.
 * The mint demands exact label equality, which a genuine confirmation always has: the review screen
 * posts back the label it displayed. */
test('a confirmed answer under a renamed label mints nothing', async () => {
  const id = await applicationWith(stoppedRunWithMachineAnswer());

  const response = await saveQuestions(id, [
    asSent(HELD_QUESTION, 'No'),
    { ...asSent(MACHINE_ANSWERED_QUESTION), question: 'Gender identity', confirmed: true },
  ]);
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  const machine = persisted.questions.find((question) => question.id === MACHINE_ANSWERED_QUESTION.id);
  assert.equal(machine?.question, MACHINE_ANSWERED_QUESTION.question, 'the stored label is the form identity');
  assert.equal(machine?.answer_source, undefined,
    'no claim under a label the request did not repeat exactly');
});

/* A CONFIRMED CONSENT IS HERS, NOT THE MACHINE'S. The grant fields exist so the audit shows an
 * acceptance made on her behalf rather than a tick that reads as her own - and a confirmation is
 * her making it her own. Carrying the grant under the fresh applicant claim would produce a record
 * no other writer produces: her claim beside a machine-permission grant for the same answer. */
test('confirming a machine-accepted consent replaces the grant with her claim', async () => {
  const CONSENT_QUESTION: ApplicationReviewQuestion = {
    id: 'privacy-consent',
    question: 'I have read and accept the candidate privacy notice',
    answer: 'I agree',
    kind: 'required',
    required: true,
    portal_selector: '#consent',
    portal_input_type: 'select',
    answer_source: 'consent_permission',
    consent_permission_granted_at: '2026-08-01T00:00:00.000Z',
    consent_permission_version: 'v3',
    answer_option_source: 'Yes',
  };
  const id = await applicationWith(stoppedRun({ questions: [CONSENT_QUESTION] }));

  const response = await saveQuestions(id, [{ ...asSent(CONSENT_QUESTION), confirmed: true }]);
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  const consent = persisted.questions[0];
  assert.equal(consent.answer, 'I agree', 'the answer she confirmed, unchanged');
  assert.equal(consent.answer_source, 'applicant_review', 'the acceptance now reads as hers');
  assert.equal(consent.answer_reviewed_at, persisted.questions_reviewed_at);
  assert.equal(consent.consent_permission_granted_at, undefined,
    'the machine grant drops: her claim and the permission record cannot describe the same answer');
  assert.equal(consent.consent_permission_version, undefined);
  assert.equal(consent.answer_option_source, 'Yes',
    'the snap derivation stays: what the value was snapped from is as true as before');
});

/* CONFIRMING A VALUE THE RESOLVER DISPUTES RECORDS WHAT SHE OVERRODE, exactly as an edit does.
 * Without the override note the refresh keeps a claimed non-band answer only when it equals the
 * resolver's value, so a confirm of a stale-tab value minted its claim, answered 200, and was
 * recomputed away on the next read - the CONFIRM loop again, in a narrower shape. */
test('confirming a value the resolver disputes records the override beside the claim', async () => {
  const RESOLVED = 'Bachelor of Science in Computer Science';
  const degreeQuestion: ApplicationReviewQuestion = {
    id: 'degree--disputed',
    question: 'What degree are you currently pursuing?',
    answer: "Bachelor's Degree",
    kind: 'required',
    required: true,
    portal_selector: '#degree',
    portal_input_type: 'select',
  };
  const id = await applicationWith(stoppedRun({ questions: [degreeQuestion] }));

  const response = await saveQuestions(id, [{ ...asSent(degreeQuestion), confirmed: true }]);
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer, "Bachelor's Degree");
  assert.equal(persisted.questions[0].answer_source, 'applicant_review');
  assert.equal(persisted.questions[0].answer_override_of, RESOLVED,
    'which resolution she disagreed with, so the refresh keeps her value while the profile stands');
});
