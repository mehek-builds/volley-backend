import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../db/schema';

/* DOES A NEW STUDENT ACTUALLY GET SERVED THE NOTIFICATIONS SCREEN, and can they get past it.
 *
 * WHY THIS EXISTS AS A DATABASE TEST. `applicationStepFrom` is unit tested and proves the ORDER of
 * the seven names in an array. It proves nothing about whether a real account ever reaches that
 * array: the sequence is gated on `derivedStep === 'done'`, on `flow.available`, and on
 * `onboarding_completed_at` being null, and every one of those is a query. Until this file nothing
 * registered `onboardingRoutes` against a database at all, so the entire application sequence -
 * the six screens that shipped before this one included - had never been walked through the route
 * that serves it. A student stranded on screen 08 would have looked exactly like a green suite.
 *
 * THE TWO FAILURES THIS IS POINTED AT, both of which are silent:
 *   1. the step is never SERVED, because some profile gate is not satisfied and the account sits on
 *      a setup screen forever;
 *   2. the step is served and cannot be ACKNOWLEDGED, because the acknowledgement route's schema or
 *      its replay-ordering check refuses a name it does not recognise, which parks the student on
 *      screen 08 with a Continue button that 400s.
 *
 * Neither is visible from a unit test of the constant, and the second is the one that would have
 * been found by a real student rather than by us.
 */

const JWT_SECRET = 'onboarding-sequence-db-test-secret-32ch';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-onboarding-seq-'));
const savedEnv = { ...process.env };
const STUDENT = '3f1c9b0e-2a44-4c31-9f52-11ab77c30d91';

let database: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let backendPool: { end(): Promise<void> };
let authorization: string;

before(async () => {
  database = await PGlite.create();
  const initial = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of initial) await database.exec(statement);
  server = new PGLiteSocketServer({ db: database, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();

  process.env.VERCEL = '1';
  process.env.LOG_LEVEL = 'silent';
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  process.env.JWT_SIGNING_SECRET = JWT_SECRET;
  process.env.ENCRYPTION_KEY = 'onboarding-sequence-db-test-encryption-key';

  ({ pool: backendPool } = await import('../db'));
  const { onboardingRoutes } = await import('./onboarding');
  app = Fastify({ logger: false });
  await app.register(onboardingRoutes);
  await app.ready();

  authorization = `Bearer ${await new SignJWT({ userId: STUDENT, isGuest: false, sessionVersion: 0, authMethod: 'password' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(JWT_SECRET))}`;
});

after(async () => {
  await app?.close();
  await backendPool?.end();
  await server?.stop();
  await database.close();
  rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

/**
 * A student who has finished every profile-derived setup step and nothing more.
 *
 * Seeded through the columns the route actually reads rather than through the setup routes, because
 * the subject here is what /onboarding/state DERIVES, and driving eight other endpoints first would
 * make a failure in any of them look like a failure in this.
 */
async function seedStudentThroughSetup() {
  const parsed = {
    full_name: 'A Candidate',
    source_pages: 2,
    target_roles: ['Software Engineer', 'Backend Engineer', 'Platform Engineer', 'Data Engineer', 'Product Engineer'],
    recent_experience_review: { completed: true },
  };
  const baseResume = { school: 'USC', degree: 'BS Computer Science', grad_date: 'May 2027', experience: [], skills: [] };
  await database.exec(`
    insert into "users" ("id", "email", "email_verified", "is_guest", "sponsorship_answer")
    values ('${STUDENT}', 'candidate@example.edu', true, false, 'no')
  `);
  await database.exec(`
    insert into "profiles" ("user_id", "parsed_json", "base_resume_json")
    values ('${STUDENT}', '${JSON.stringify(parsed)}', '${JSON.stringify(baseResume)}')
  `);
  await database.exec(`
    insert into "experience_bank" ("user_id", "type", "org", "title", "bullet_variants")
    values ('${STUDENT}', 'job', 'Campus Lab', 'Intern', '["Built a dashboard in TypeScript and React."]')
  `);
  await database.exec(`
    insert into "targeting" ("user_id", "categories", "titles", "role_types", "primary_period")
    values ('${STUDENT}', '["software"]', '["Software Engineer"]', '["internship"]', 'summer-2027')
  `);
  /* The three setup-gap fields answered, so the gaps screen has nothing to ask and the derived walk
     reaches 'done' rather than parking on it. */
  await database.exec(`
    insert into "application_profile" ("user_id", "gpa", "gpa_scale", "major", "setup_gaps_asked_at")
    values ('${STUDENT}', '3.8', '4.0', 'Computer Science', now())
  `);
}

async function state() {
  const response = await app.inject({ method: 'GET', url: '/onboarding/state', headers: { authorization } });
  assert.equal(response.statusCode, 200, `state read failed: ${response.body}`);
  return response.json();
}

async function acknowledge(step: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/onboarding/flow/steps',
    headers: { authorization },
    payload: { flow_version: 3, step, disposition: 'continued' },
  });
  assert.equal(response.statusCode, 200, `acknowledging ${step} failed: ${response.statusCode} ${response.body}`);
}

beforeEach(async () => {
  for (const table of ['onboarding_flow_step_acknowledgements', 'onboarding_flow_runs', 'application_profile', 'targeting', 'experience_bank', 'profiles', 'users']) {
    await database.exec(`delete from "${table}"`);
  }
  await seedStudentThroughSetup();
});

test('a new student is walked through every application screen, notifications included', async () => {
  /* THE WHOLE POINT. Not "the array is in this order" - that is unit tested - but "a real account
     reaching the end of setup is handed these seven, in this order, by the real route, and can get
     past every one of them". */
  const first = await state();
  assert.equal(first.step, 'match', 'a student who finished setup should be handed the match screen');
  assert.equal(first.includes_application_steps, true, 'the rail denominator has to include the sequence');
  assert.equal(first.requires_onboarding, true);

  const walked: string[] = [];
  for (let guard = 0; guard < 12; guard += 1) {
    const current = await state();
    if (current.step === 'done') break;
    walked.push(current.step);
    await acknowledge(current.step);
  }

  assert.deepEqual(
    walked,
    /* No 'sponsorship' here, and its absence is the conditional working: this fixture's account
       already carries a work-eligibility declaration, so the screen is skipped exactly as it is for
       the ~40% of students whose first employer asked both halves itself. An account WITHOUT a
       declaration is served it between 'questions' and 'review'; that path is pinned in
       onboarding.test.ts against applicationStepFrom directly, where the flag can be varied without
       a database. */
    ['match', 'questions', 'review', 'trial', 'notifications', 'plan'],
    'the served walk must match the designed order, with notifications between the trial and the price',
  );
  assert.equal((await state()).step, 'done');
});

test('the notifications screen can actually be acknowledged, and it advances to the plan', async () => {
  /* The failure this rules out is the quiet one: a step that is SERVED but that the acknowledgement
     route refuses, which parks a student on screen 08 with a Continue button that 400s. It is a
     separate risk from ordering because the two are decided by different code - one by
     APPLICATION_STEPS, the other by the route's zod enum and its replay-ordering branch. */
  for (const step of ['match', 'questions', 'review', 'trial']) await acknowledge(step);
  assert.equal((await state()).step, 'notifications');

  await acknowledge('notifications');
  assert.equal((await state()).step, 'plan', 'acknowledging screen 08 must hand the student the price');
});

test('a student who skips the screen is not parked on it forever', async () => {
  // Acknowledged means SEEN, not answered. Declining both permissions is a real answer and so is
  // walking past without touching them; neither may put the student back on the screen.
  for (const step of ['match', 'questions', 'review', 'trial']) await acknowledge(step);
  const response = await app.inject({
    method: 'POST',
    url: '/onboarding/flow/steps',
    headers: { authorization },
    payload: { flow_version: 3, step: 'notifications', disposition: 'skipped' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal((await state()).step, 'plan');
});

test('an account that already finished onboarding is never handed the sequence', async () => {
  /* THE GUARD THAT CARRIES THE SAFETY OF THE WHOLE THING, restated here because adding a screen to
     the sequence is exactly the change that could weaken it. Every existing account has an empty
     version-3 ledger, so without the completed_at check they would all be handed a flow they never
     opted into that ends in sending a real application. */
  await database.exec(`update "users" set onboarding_completed_at = now() where id = '${STUDENT}'`);
  const current = await state();
  assert.notEqual(current.step, 'notifications');
  assert.equal(current.includes_application_steps, false);
});

/* THE COUNT MUST NOT SHRINK UNDERNEATH SOMEBODY WHO JUST DID THE WORK.
 *
 * Found by walking production 2026-08-19. The work-visa screen printed "step 5 of 10", the student
 * answered it, and the next screen printed "step 5 of 9": answering is what sets the column the
 * flag was derived from, so finishing the screen removed it from the flow it belonged to. Two
 * different screens both called themselves five, and the total moved backwards.
 *
 * A DATABASE TEST because the fix reads the acknowledgement LEDGER, which is a table. The rule is
 * that a screen counts while it is still needed OR once it has been walked, and only the ledger
 * knows the second half.
 */
test('a walked work-visa screen stays in the flow, so the total never shrinks', async () => {
  // beforeEach already seeded this student.
  await database.exec(`update "users" set "sponsorship_answer" = null where "id" = '${STUDENT}'`);

  const before = await app.inject({ method: 'GET', url: '/onboarding/state', headers: { authorization } });
  const beforeBody = before.json();
  assert.equal(beforeBody.includes_sponsorship_step, true, 'the screen was not in the flow before it was answered');

  // Walk it the way the student does: acknowledge the step, then answer it.
  const ackReply = await app.inject({
    method: 'POST',
    url: '/onboarding/flow/steps',
    headers: { authorization },
    payload: { step: 'sponsorship', disposition: 'continued', flow_version: beforeBody.flow_version },
  });
  assert.equal(ackReply.statusCode, 200, `the acknowledgement was refused: ${ackReply.body.slice(0, 120)}`);
  await database.exec(`update "users" set "sponsorship_answer" = 'no' where "id" = '${STUDENT}'`);

  const after = await app.inject({ method: 'GET', url: '/onboarding/state', headers: { authorization } });
  assert.equal(
    after.json().includes_sponsorship_step,
    true,
    'answering the work-visa screen removed it from the flow, so the rail total shrank underneath the student',
  );
});

test('a student whose employer answered it never gets the screen in their flow at all', async () => {
  // The measured ~40%: the posting asked both halves, so the declaration exists and nothing was
  // ever shown. No acknowledgement, an answer on file, and therefore no step.
  await database.exec(`update "users" set "sponsorship_answer" = 'no' where "id" = '${STUDENT}'`);

  const state = await app.inject({ method: 'GET', url: '/onboarding/state', headers: { authorization } });
  assert.equal(
    state.json().includes_sponsorship_step,
    false,
    'a screen nobody was shown and nobody needs is being counted in the rail',
  );
});
