/* THE LIST THE DASHBOARD PUTS IN FRONT OF HER, READ OFF THE ROUTE THAT PUBLISHES IT.
 *
 * Measured on packet 4a79eec1 (Hudson River Trading, greenhouse), ready_for_final_approval:
 *
 *   sensitive_questions_requiring_confirmation: [
 *     "will you now, or in the future, require visa sponsorship to legally work in the country
 *      specified for this position?",
 *     "what is your gender?"
 *   ]
 *
 * THIS ROUTE IS WHY THE ROUND HAD TO BE THREADED THROUGH IT. The declined-resolver fix lives in the
 * send gate, and this surface calls the same gate to say which questions the send will refuse over.
 * Give it the packet's review round and the two agree; forget to, and the dashboard sends her to
 * confirm a question nothing is waiting on. A list that disagrees with the gate it describes is
 * worse than no list, and the argument that keeps them agreeing is one token at one call site.
 *
 * WHAT CLEARS HERE AND WHAT DOES NOT, pinned rather than claimed:
 *
 *   sponsorship   the resolver DECLINES the label, so her own current-round answer settles it and
 *                 it leaves the list. This is the fix.
 *   gender        the resolver ANSWERS "Female" from her eeo_prefs while the packet holds the
 *                 control's own "Woman". The value branch now reads those two as one declaration,
 *                 under resolution's own option vocabulary, so it leaves the list too. The list is
 *                 empty and nothing on this packet is waiting on a press from her.
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

const JWT_SIGNING_SECRET = 'sensitive-envelope-secret';
const ENCRYPTION_KEY = 'sensitive-envelope-key';

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

const PORTAL_URL = 'https://boards.greenhouse.io/hudsonrivertrading/jobs/1234567890';

/** The employer's own wordings, byte for byte off the packet. */
const SPONSORSHIP_LABEL =
  'will you now, or in the future, require visa sponsorship to legally work in the country specified for this position?';
const GENDER_LABEL = 'what is your gender?';

/** Nothing in her profile settles a label that names three countries, so it stays hers to answer. */
const SPONSORSHIP_QUESTION: ApplicationReviewQuestion = {
  id: 'sponsorship',
  question: SPONSORSHIP_LABEL,
  answer: 'Yes',
  kind: 'required',
  required: true,
  portal_selector: '#sponsorship',
  portal_input_type: 'select',
  answer_source: 'applicant_review',
  answer_reviewed_at: '2026-09-01T21:28:12.934Z',
};

/**
 * The gender control exactly as the live packet holds it: the employer's own option as the answer,
 * her review stamped in this round, and the machine's "Female" recorded as what she overrode.
 */
const GENDER_QUESTION: ApplicationReviewQuestion = {
  id: 'gender',
  question: GENDER_LABEL,
  answer: 'Woman',
  kind: 'required',
  required: true,
  portal_selector: '#gender',
  portal_input_type: 'select',
  options: ['Woman', 'Man', 'Non-binary', "I don't wish to answer"],
  answer_source: 'applicant_review',
  answer_reviewed_at: '2026-09-01T21:28:12.934Z',
  answer_override_of: 'Female',
} as ApplicationReviewQuestion;

function filledPacket(questions: readonly ApplicationReviewQuestion[]): ApplicationReviewState {
  return {
    jd_text: 'Software Engineer at Hudson River Trading',
    status: 'ready_for_final_approval',
    edited_terms: [],
    questions: [...questions],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
    questions_reviewed_at: '2026-09-01T21:28:12.934Z',
    portal_url: PORTAL_URL,
    ats_name: 'greenhouse',
    submission_run_id: 'run-final',
    preview_screenshot_url: 'https://example.test/preview.png',
    filled_fields: ['name', 'email'],
  } as unknown as ApplicationReviewState;
}

async function applicationWith(review: ApplicationReviewState): Promise<string> {
  const [row] = await db.insert(schema.generated_resumes).values({
    user_id: userId,
    job_context: { company: 'Hudson River Trading', role: 'Software Engineer' },
    spec: { _review: review },
    resume_object_key: `users/${userId}/resumes/${crypto.randomUUID()}.pdf`,
  }).returning({ id: schema.generated_resumes.id });
  return row.id;
}

async function needsHer(applicationId: string): Promise<string[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/applications/${applicationId}/submission`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { sensitive_questions_requiring_confirmation?: unknown };
  const list = body.sensitive_questions_requiring_confirmation;
  assert.ok(Array.isArray(list), 'the envelope must publish the list at all, or nothing below means anything');
  return list as string[];
}

/** What the packet's own answers settle to, so a cleared gate cannot be hiding a blanked answer. */
async function answers(applicationId: string): Promise<Record<string, string>> {
  const response = await app.inject({
    method: 'GET',
    url: `/applications/${applicationId}/submission`,
    headers: { authorization: `Bearer ${token}` },
  });
  const body = response.json() as { review: { questions: ApplicationReviewQuestion[] } };
  return Object.fromEntries(body.review.questions.map((question) => [question.id, question.answer]));
}

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-sensitive-envelope-'));
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

  const [account] = await db.insert(schema.users).values({ email: 'sensitive-envelope@example.test' }).returning();
  userId = account.id;

  /* HER REAL SELF-IDENTIFICATION RECORD, in the column the resolver actually reads.
   *
   * application_profile.eeo_prefs, NOT profiles.parsed_json. loadApplicationProfileLike takes
   * eeo_prefs off the application_profile row and nowhere else, so a fixture that writes it into
   * parsed_json produces a profile with no stated gender at all - and the gate then refuses for the
   * right reason about the wrong record, which is a test that passes while proving nothing. This row
   * is the whole provenance signal: nothing on the packet and nothing in a request can move it. */
  await db.insert(schema.application_profile).values({
    user_id: userId,
    eeo_prefs: { gender: 'Female', veteran_status: 'No', disability_status: 'No' },
  });
  await db.insert(schema.profiles).values({ user_id: userId, parsed_json: {} });

  token = await new SignJWT({
    userId,
    email: 'sensitive-envelope@example.test',
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

test('nothing on this packet is waiting on a press from her', () => {
  return applicationWith(filledPacket([SPONSORSHIP_QUESTION, GENDER_QUESTION]))
    .then(async (id) => {
      assert.deepEqual(await needsHer(id), [],
        'neither question is waiting on her: one she answered herself, one her profile answers');
    });
});

test('and it goes only because the route hands the gate the packet\'s own review round', async () => {
  /* THE SAME PACKET WITH ITS ROUND REMOVED. answer_reviewed_at no longer equals
   * questions_reviewed_at, so nothing on the row proves she attended to it in this round and the
   * gate is fail-closed again. This is what dropping the argument at the call site looks like. */
  const id = await applicationWith({
    ...filledPacket([SPONSORSHIP_QUESTION, GENDER_QUESTION]),
    questions_reviewed_at: undefined,
  } as ApplicationReviewState);

  assert.ok((await needsHer(id)).includes(SPONSORSHIP_LABEL),
    'without the round the declined question is refused again, which is the fail-closed default');
  /* And gender leaves the list here for a reason worth writing down rather than asserting past: with
   * no round, her override no longer holds either, so the refresh recomputes the answer back to her
   * profile's own "Female" and the value branch then accepts it by byte equality. Different route,
   * same conclusion, and it is why this assertion names the sponsorship label rather than a whole
   * list that moves for two independent reasons. */
});

test('her answer is still the one the employer would receive, not a blank', async () => {
  /* A cleared gate beside a blanked answer would be worse than the refusal: the send would stop on
   * "a required answer is still blank" and the fix would read as progress. */
  const id = await applicationWith(filledPacket([SPONSORSHIP_QUESTION, GENDER_QUESTION]));

  const stored = await answers(id);
  assert.equal(stored['sponsorship'], 'Yes', 'her declaration, unchanged by the refresh');
  assert.equal(stored['gender'], 'Woman', 'and the control\'s own option beside it');
});

test('an answer nobody attended to is still refused', async () => {
  const unreviewed: ApplicationReviewQuestion = {
    ...SPONSORSHIP_QUESTION,
    answer_source: undefined,
    answer_reviewed_at: undefined,
  } as ApplicationReviewQuestion;
  const id = await applicationWith(filledPacket([unreviewed]));

  assert.deepEqual(await needsHer(id), [SPONSORSHIP_LABEL],
    'the round is only half the proof; an unstamped answer never had the other half');
});
