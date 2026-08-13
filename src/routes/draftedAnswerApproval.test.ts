/* THE DRAFTED ANSWER THAT COULD NOT BE APPROVED.
 *
 * Litos holds a packet when an answer it drafted needs review. On 2026-08-13 that described 93 of
 * the 286 live needs_attention packets, carrying 223 machine-written essay answers between them, and
 * there was no request in the product that could clear one. The applicant's only affordance was
 * REVIEW, which opens the answers screen; saving there writes, but the merge mints a per-answer
 * claim ONLY where she filled a blank, so approving an already-drafted answer stamped nothing.
 * Measured on packet b18f1842 after a successful save: `questions_reviewed_at` written, 0 of 9
 * answers carrying a claim, both drafted-answer holds still standing.
 *
 * The narrowness of that mint rule is CORRECT and is not touched here. It is narrow because the
 * blanket version would have flipped 802 machine-written answers across 174 packets into answers
 * attributed to the applicant, among them EEO self-identification, immigration sponsorship and
 * compensation expectations. This suite pins that the approval route is a separate act with a
 * separate field, and that the save's behaviour is exactly what it was.
 *
 * Real routes and a real database, same reason as reviewAnswerSave.test.ts: the difference between
 * this fix and the defect is what is on the row afterwards, and only reading the row can tell them
 * apart.
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

const JWT_SIGNING_SECRET = 'drafted-answer-approval-secret';
const ENCRYPTION_KEY = 'drafted-answer-approval-key';

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
const PORTAL_URL = 'https://jobs.ashbyhq.com/deepgram/00000000-0000-4000-8000-000000000000/application';

/* The words the model wrote, on the live Deepgram packet's shape. Nobody typed a character of this,
 * which is the whole point: it may be approved and it may never be attributed. */
const DRAFT = 'I have spent the last two years building speech tooling, and Deepgram is the only team '
  + 'shipping models at that latency in production.';

const DRAFTED_QUESTION: ApplicationReviewQuestion = {
  id: 'excites-you',
  question: 'What excites you about Deepgram?',
  answer: DRAFT,
  kind: 'essay',
  required: true,
  portal_selector: '#excites',
  portal_input_type: 'textarea',
  ats_api_field: 'answers[7]',
};

/* THE ANSWER THAT MUST NOT BE TOUCHED BY ANY OF THIS. Resolved from the profile by an earlier run,
 * so it carries no claim at all. In production this is the 802: gender, disability status, veteran
 * status, sponsorship, compensation expectations. A fixture without it cannot tell "stamp the one
 * she approved" from "stamp everything", which is the distinction the whole design turns on. */
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

/** The blank one, so the save's own rule keeps being exercised beside the approval's. */
const HELD_QUESTION: ApplicationReviewQuestion = {
  id: 'prior-application',
  question: 'Have you applied to Deepgram before?',
  answer: '',
  kind: 'required',
  required: true,
  portal_selector: '#prior',
  portal_input_type: 'select',
};

/* The two lines the runner writes when a draft needs reading, verbatim from submissionRunner.ts.
 * They are the hold, and no path in this suite is allowed to erase them. */
const DRAFT_HOLD = 'drafted answer needs your review: Names/orgs not found in your background or the job post (verify): GPT\n'
  + 'AI-drafted answer needs your review before this goes out: "what excites you about deepgram?"';

function heldByDraft(extra: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return {
    jd_text: 'Speech engineer at Deepgram',
    status: 'needs_attention',
    edited_terms: [],
    questions: [DRAFTED_QUESTION, MACHINE_ANSWERED_QUESTION, HELD_QUESTION],
    skipped_reasons: [],
    updated_at: STOPPED_AT,
    portal_url: PORTAL_URL,
    ats_name: 'ashby',
    submission_run_id: 'run-1',
    submission_claimed_at: STOPPED_AT,
    submission_claim_id: 'claim-1',
    attention_reason: DRAFT_HOLD,
    ...extra,
  };
}

async function applicationWith(review: ApplicationReviewState): Promise<string> {
  const [row] = await db.insert(schema.generated_resumes).values({
    user_id: userId,
    job_context: { company: 'Deepgram', role: 'Speech engineer' },
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

/** What the checkbox sends: the question in the path, the exact text it displayed in the body. */
function approve(applicationId: string, questionId: string, answer: string) {
  return app.inject({
    method: 'PUT',
    url: `/applications/${applicationId}/review/answers/${questionId}/approval`,
    headers: { authorization: `Bearer ${token}` },
    payload: { answer },
  });
}

/** A stored question reduced to what the answers screen can actually send. */
function asSent(question: ApplicationReviewQuestion, answer: string = question.answer) {
  return {
    id: question.id,
    question: question.question,
    answer,
    kind: question.kind,
    required: question.required,
  };
}

function saveQuestions(applicationId: string, questions: readonly ReturnType<typeof asSent>[]) {
  return app.inject({
    method: 'PUT',
    url: `/applications/${applicationId}/review/answers`,
    headers: { authorization: `Bearer ${token}` },
    payload: { questions },
  });
}

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-answer-approval-'));
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

  const [account] = await db.insert(schema.users).values({ email: 'answer-approval@example.test' }).returning();
  userId = account.id;

  token = await new SignJWT({
    userId,
    email: 'answer-approval@example.test',
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

/* THE DEFECT, STATED AS THE ROW. Not "the request returned 200" but "the approval is on disk",
 * because the whole of the old behaviour was a control that returned nothing and wrote nothing. */
test('approving a drafted answer records the approval on the row', async () => {
  const id = await applicationWith(heldByDraft());

  const response = await approve(id, DRAFTED_QUESTION.id, DRAFT);
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  const approved = persisted.questions.find((question) => question.id === DRAFTED_QUESTION.id)!;
  assert.ok(approved.answer_approved_at, 'the approval is stored, which is what the checkbox never did');
  assert.ok(persisted.questions_reviewed_at, 'and the packet has the round it is anchored to');
  assert.equal(approved.answer_reviewed_at, persisted.questions_reviewed_at,
    'keyed to the round the row holds, or the merge discards it on the next save');
});

/* THE CLAIM THAT MUST NOT BE MINTED, WHICH IS THE POINT OF THE WHOLE DESIGN.
 *
 * "She typed this" and "she read what Litos typed and let it stand" are different sentences about
 * different authors. `answer_source` names the author and stays ABSENT on an approved draft, so
 * every reader that asks "which answers are attributed to the applicant" by testing that field -
 * refreshKnownQuestionAnswers and the runner's stale-draft guard both do - keeps getting the same
 * answer it got before this route existed. */
test('an approved draft is not recorded as an answer the applicant wrote', async () => {
  const id = await applicationWith(heldByDraft());

  await approve(id, DRAFTED_QUESTION.id, DRAFT);

  const persisted = await storedReview(id);
  const approved = persisted.questions.find((question) => question.id === DRAFTED_QUESTION.id)!;
  assert.equal(approved.answer_source, undefined,
    'Litos wrote these words and the record must not say otherwise');
  assert.equal(approved.answer, DRAFT, 'and the words themselves are untouched');
});

/* AND THE OTHER HALF OF THE DISTINCTION, WHICH ONLY A SIDE-BY-SIDE CAN SHOW. The same packet, one
 * blank filled through the save and one draft approved through this route, produce two different
 * records. If they produced the same one the audit trail would be conflating them. */
test('typing into a blank and approving a draft leave different records', async () => {
  const id = await applicationWith(heldByDraft());

  await saveQuestions(id, [
    asSent(DRAFTED_QUESTION),
    asSent(MACHINE_ANSWERED_QUESTION),
    asSent(HELD_QUESTION, 'No'),
  ]);
  await approve(id, DRAFTED_QUESTION.id, DRAFT);

  const persisted = await storedReview(id);
  const typed = persisted.questions.find((question) => question.id === HELD_QUESTION.id)!;
  const approved = persisted.questions.find((question) => question.id === DRAFTED_QUESTION.id)!;

  assert.equal(typed.answer_source, 'applicant_review', 'she supplied these words');
  assert.equal(typed.answer_approved_at, undefined, 'and was never asked to approve them');

  assert.equal(approved.answer_source, undefined, 'Litos supplied these');
  assert.ok(approved.answer_approved_at, 'and she signed off on them');
});

/* THE 802-ANSWER REGRESSION, PINNED FROM THIS SIDE TOO. An approval names one question in its path.
 * Nothing else on the packet may acquire a claim from it, and the answers most at risk are exactly
 * the ones sitting beside it. */
test('approving one answer stamps nothing on any other answer', async () => {
  const id = await applicationWith(heldByDraft());

  await approve(id, DRAFTED_QUESTION.id, DRAFT);

  const persisted = await storedReview(id);
  const machine = persisted.questions.find((question) => question.id === MACHINE_ANSWERED_QUESTION.id)!;
  assert.equal(machine.answer_approved_at, undefined,
    'this is gender, resolved by a run, and she has approved nothing about it');
  assert.equal(machine.answer_source, undefined);
  assert.equal(machine.answer_reviewed_at, undefined);

  const held = persisted.questions.find((question) => question.id === HELD_QUESTION.id)!;
  assert.equal(held.answer_approved_at, undefined, 'and a blank question was not approved into an answer');
});

/* AND THE SAME REGRESSION FROM THE SAVE'S SIDE, UNCHANGED BY THIS BRANCH. The narrow mint rule is
 * what this fix is built AROUND rather than through, so its behaviour is re-measured here: a save
 * that posts back every stored answer touches the claim on none of them. */
test('the save still stamps nothing on an answer it did not fill', async () => {
  const id = await applicationWith(heldByDraft());

  const response = await saveQuestions(id, [
    asSent(DRAFTED_QUESTION),
    asSent(MACHINE_ANSWERED_QUESTION),
    asSent(HELD_QUESTION, 'No'),
  ]);
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  const machine = persisted.questions.find((question) => question.id === MACHINE_ANSWERED_QUESTION.id)!;
  const drafted = persisted.questions.find((question) => question.id === DRAFTED_QUESTION.id)!;
  assert.equal(machine.answer_source, undefined, 'a machine answer posted back is still a machine answer');
  assert.equal(machine.answer_approved_at, undefined, 'and a save is not an approval');
  assert.equal(drafted.answer_source, undefined, 'nor is posting a draft back an act of writing it');
  assert.equal(drafted.answer_approved_at, undefined, 'nor of approving it');
});

/* THE HOLD IS ON THE ROW AND STAYS ON THE ROW. The item clearing is a reading of the answers, not a
 * relabelling of the packet: an approval that moved the status would be PUT /review's defect, and an
 * approval that erased the reason would delete the only sentence saying what stopped the run. */
test('approving leaves the packet at needs_attention with its reason intact', async () => {
  const id = await applicationWith(heldByDraft());

  await approve(id, DRAFTED_QUESTION.id, DRAFT);

  const persisted = await storedReview(id);
  assert.equal(persisted.status, 'needs_attention', 'a stopped run is still a stopped run');
  assert.equal(persisted.attention_reason, DRAFT_HOLD, 'and still says what stopped it');
  assert.equal(persisted.submission_claimed_at, STOPPED_AT, 'and still holds its claim');
  assert.equal(persisted.submission_run_id, 'run-1', 'and no run was booked');
  assert.equal(persisted.submitted_at, undefined);
});

/* THE SAME PROPERTY THROUGH THE OTHER PATH, because both were named as at risk and only one of them
 * has ever been measured. */
test('saving answers leaves the packet at needs_attention with its reason intact', async () => {
  const id = await applicationWith(heldByDraft());

  await saveQuestions(id, [asSent(DRAFTED_QUESTION), asSent(MACHINE_ANSWERED_QUESTION), asSent(HELD_QUESTION, 'No')]);

  const persisted = await storedReview(id);
  assert.equal(persisted.status, 'needs_attention');
  assert.equal(persisted.attention_reason, DRAFT_HOLD);
});

/* THE APPROVAL SURVIVES THE SCREEN IT WAS MADE ON BEING SAVED, which is the failure mode a
 * record-identity claim invites: the answers screen posts every question back, every provenance key
 * is stripped from the body by questionSchema, and a claim keyed on `answer_source` alone would find
 * no match and drop. The applicant would tick the box, press Save on the same screen, and watch the
 * hold return with nothing on screen explaining why. */
test('an approval survives a later save that changes nothing', async () => {
  const id = await applicationWith(heldByDraft());

  await approve(id, DRAFTED_QUESTION.id, DRAFT);
  const approvedAt = (await storedReview(id)).questions
    .find((question) => question.id === DRAFTED_QUESTION.id)!.answer_approved_at;

  const response = await saveQuestions(id, [
    asSent(DRAFTED_QUESTION),
    asSent(MACHINE_ANSWERED_QUESTION),
    asSent(HELD_QUESTION),
  ]);
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  const drafted = persisted.questions.find((question) => question.id === DRAFTED_QUESTION.id)!;
  assert.equal(drafted.answer_approved_at, approvedAt, 'the approval is still on the record');
  assert.equal(drafted.answer_source, undefined, 'and still does not claim she wrote it');
});

/* AND DIES WITH THE TEXT IT WAS ABOUT. She approved a paragraph; editing that paragraph means the
 * approval describes words that are no longer stored, and a record that kept it would say she signed
 * off on text she never read. */
test('editing an approved answer drops the approval', async () => {
  const id = await applicationWith(heldByDraft());

  await approve(id, DRAFTED_QUESTION.id, DRAFT);
  await saveQuestions(id, [
    asSent(DRAFTED_QUESTION, `${DRAFT} And I want to work on the decoder.`),
    asSent(MACHINE_ANSWERED_QUESTION),
    asSent(HELD_QUESTION),
  ]);

  const persisted = await storedReview(id);
  const drafted = persisted.questions.find((question) => question.id === DRAFTED_QUESTION.id)!;
  assert.equal(drafted.answer, `${DRAFT} And I want to work on the decoder.`, 'her edit is stored');
  assert.equal(drafted.answer_approved_at, undefined, 'and the approval of the old words is gone');
});

/* THE REFUSAL THAT MAKES THIS AN APPROVAL OF AN ANSWER RATHER THAN OF A ROW. A run rewrote the draft
 * between the screen rendering and the box being ticked; approving now would record a sign-off on
 * words she never saw. */
test('approving text the row no longer holds is refused, and writes nothing', async () => {
  const id = await applicationWith(heldByDraft());

  const response = await approve(id, DRAFTED_QUESTION.id, 'A paragraph an older run wrote.');
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'ANSWER_MOVED');

  const persisted = await storedReview(id);
  const drafted = persisted.questions.find((question) => question.id === DRAFTED_QUESTION.id)!;
  assert.equal(drafted.answer_approved_at, undefined, 'a refused approval records nothing');
});

test('approving a question with no answer on it is refused', async () => {
  const id = await applicationWith(heldByDraft());

  const response = await approve(id, HELD_QUESTION.id, '');
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'NOTHING_TO_APPROVE');

  const persisted = await storedReview(id);
  assert.equal(persisted.questions.find((question) => question.id === HELD_QUESTION.id)!.answer, '',
    'and does not turn a blank into an approved blank');
});

test('approving a question that is not on the packet is refused', async () => {
  const id = await applicationWith(heldByDraft());

  const response = await approve(id, 'not-a-question', DRAFT);
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'QUESTION_NOT_FOUND');
});

/* THE SAME REFUSALS THE SAVE MAKES, because an approval reaches the same row through the same gate.
 * A packet at the employer is the record of what was sent, and nothing about it may be re-signed. */
test('an application already at the employer refuses the approval', async () => {
  const id = await applicationWith(heldByDraft({
    status: 'submitted',
    submitted_at: STOPPED_AT,
    attention_reason: undefined,
  }));

  const response = await approve(id, DRAFTED_QUESTION.id, DRAFT);
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'REVIEW_ANSWERS_NOT_EDITABLE');

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer_approved_at, undefined);
  assert.equal(persisted.status, 'submitted');
});

test('an application with a run filling the form refuses the approval', async () => {
  const id = await applicationWith(heldByDraft({ status: 'filling' }));

  const response = await approve(id, DRAFTED_QUESTION.id, DRAFT);
  assert.equal(response.statusCode, 409, response.body);

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer_approved_at, undefined, 'the run owns this row until it finishes');
  assert.equal(persisted.status, 'filling');
});

/* IDEMPOTENT, AND THE REASON IS NOT TIDINESS. The panel polls every 2.5 seconds and re-renders the
 * row from the response; a second press, or a replayed request, must not read as a second reading of
 * the draft at a later time. */
test('approving twice is one approval at one time', async () => {
  const id = await applicationWith(heldByDraft());

  await approve(id, DRAFTED_QUESTION.id, DRAFT);
  const first = (await storedReview(id)).questions
    .find((question) => question.id === DRAFTED_QUESTION.id)!.answer_approved_at;

  const second = await approve(id, DRAFTED_QUESTION.id, DRAFT);
  assert.equal(second.statusCode, 200, second.body);

  const persisted = await storedReview(id);
  assert.equal(
    persisted.questions.find((question) => question.id === DRAFTED_QUESTION.id)!.answer_approved_at,
    first,
    'the timestamp says when she read it, and she read it once',
  );
});

/* THE ANSWER ON THE SCREEN IS NOT ALWAYS THE ANSWER IN THE ROW, AND APPROVAL COMPARED THE WRONG PAIR.
 *
 * GET /applications/:id/submission serves refreshKnownQuestionAnswers OUTPUT. For any question the
 * refresh rewrites, the string the applicant reads is not the string in `row.spec`, so an approval
 * validated against the stored record disagreed with her every time. It could never come right on a
 * retry either: the refresh is deterministic over the same profile and the GET never writes back, so
 * the packet was permanently unapprovable and the sentence she was shown - "Litos rewrote this
 * answer while you were reading it" - was false every time it appeared.
 *
 * Driven through the real GET rather than through a hand-built expectation, because the defect was
 * precisely that the route and the screen disagreed about what the answer was. Anything this test
 * asserted for itself could be wrong in the same direction as the bug. */
test('an answer the refresh rewrites can be approved as the screen showed it', async () => {
  const { eq } = await import('drizzle-orm');
  await db.insert(schema.profiles).values({
    user_id: userId,
    parsed_json: { grad_date: 'May 2028', grad_year: 2028 },
  });
  try {
    const graduation: ApplicationReviewQuestion = {
      id: 'grad-year',
      question: 'expected graduation year',
      // What an earlier run stored. The profile now carries the month, so the refresh rewrites it.
      answer: '2028',
      kind: 'required',
      required: true,
    };
    const id = await applicationWith(heldByDraft({
      questions: [DRAFTED_QUESTION, graduation, MACHINE_ANSWERED_QUESTION],
    }));

    const served = await app.inject({
      method: 'GET',
      url: `/applications/${id}/submission`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(served.statusCode, 200, served.body);
    const shown = served.json().review.questions
      .find((question: ApplicationReviewQuestion) => question.id === graduation.id)!;
    assert.equal(shown.answer, 'May 2028', 'the screen is served the refreshed answer, not the stored one');
    assert.notEqual(shown.answer, graduation.answer, 'which is the whole premise of this test');

    const response = await approve(id, graduation.id, shown.answer);
    assert.equal(response.statusCode, 200, response.body);

    const persisted = await storedReview(id);
    const approved = persisted.questions.find((question) => question.id === graduation.id)!;
    assert.ok(approved.answer_approved_at, 'the approval is recorded rather than permanently refused');
    assert.equal(approved.answer, 'May 2028',
      'and stored as the text she approved, so the stamp does not sit beside words she never read');

    /* AND IT STAYS. The refresh recomputes this same value, so the answer is unchanged byte for byte
     * and the keep-branch carries the applicant-claim forward. Persisting the stored '2028' instead
     * would have this very read replace it and strip the approval with it. */
    const reread = await app.inject({
      method: 'GET',
      url: `/applications/${id}/submission`,
      headers: { authorization: `Bearer ${token}` },
    });
    const afterRefresh = reread.json().review.questions
      .find((question: ApplicationReviewQuestion) => question.id === graduation.id)!;
    assert.equal(afterRefresh.answer_approved_at, approved.answer_approved_at,
      'an approval that the next read erases is not an approval');

    /* THE OTHER ROWS ARE NOT WRITTEN. An approval of one answer is not a save of all of them, which
     * is this route's stated contract. */
    const untouched = persisted.questions.find((question) => question.id === MACHINE_ANSWERED_QUESTION.id)!;
    assert.deepEqual(untouched, MACHINE_ANSWERED_QUESTION, 'the machine-resolved row is exactly as it was');
  } finally {
    await db.delete(schema.profiles).where(eq(schema.profiles.user_id, userId));
  }
});

/* A GENUINE REWRITE STILL REFUSES, which is what keeps the sentence above honest. The message is
 * only accurate if something can actually make it appear, and the thing that makes it appear is the
 * applicant approving text that is not what the packet holds now. */
test('approving text that is not the current answer is still refused', async () => {
  const id = await applicationWith(heldByDraft());

  const response = await approve(id, DRAFTED_QUESTION.id, 'Words from a draft that has since been rewritten.');
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'ANSWER_MOVED');

  const persisted = await storedReview(id);
  assert.equal(persisted.questions[0].answer_approved_at, undefined, 'and nothing was signed off');
});

/* DUPLICATE STORED IDS ARE REPRESENTABLE, AND THE APPROVAL STAMPED EVERY ROW THAT SHARED ONE.
 *
 * questionSchema takes a fully client-chosen id (`z.string().min(1).max(200)`) and
 * normalizeApplicationReviewQuestions dedupes on question TEXT, never on id, so two stored records
 * can carry the same id with different questions and different answers. The approval located ONE
 * record, validated the answer against that one, and then wrote the stamp with
 * `questions.map(q => q.id === target.id ? ... : q)` - which is every one of them. A second
 * machine-written answer, never read and never validated, came out of that carrying "she read this
 * and let it stand". mergeSubmittedApplicationReviewQuestions already refuses to match on ambiguous
 * duplicate ids for the same reason. */
test('an approval stamps one record, not every record sharing its id', async () => {
  const sibling: ApplicationReviewQuestion = {
    id: DRAFTED_QUESTION.id,
    question: 'Why are you a fit for this team?',
    answer: 'A second machine-written draft, which nobody has read.',
    kind: 'essay',
    required: true,
  };
  const id = await applicationWith(heldByDraft({
    questions: [DRAFTED_QUESTION, sibling, MACHINE_ANSWERED_QUESTION],
  }));

  const response = await approve(id, DRAFTED_QUESTION.id, DRAFT);
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  assert.ok(persisted.questions[0].answer_approved_at, 'the record whose answer was validated is approved');
  assert.equal(persisted.questions[1].answer_approved_at, undefined,
    'and the one that merely shares its id is not, because she never saw it');
  assert.equal(persisted.questions[1].answer_reviewed_at, undefined);
  assert.deepEqual(persisted.questions[1], sibling, 'that record is untouched');
});
