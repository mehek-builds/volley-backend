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
