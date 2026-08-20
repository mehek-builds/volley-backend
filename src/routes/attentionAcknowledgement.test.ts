/* THE CHECKBOX THAT CHECKED NOTHING.
 *
 * The "Your turn" panel on /dashboard/applications draws one checkbox per attention row, labelled
 * "Mark ... done". It had no handler, no state and no request behind it: ticking a box wrote
 * nothing, and the next poll re-rendered the panel with the box cleared. Measured on the Easy
 * Dynamics rippling packet on 2026-08-20 - the same dead-control class as the styled-span action
 * pills reviewAnswerSave.test.ts records.
 *
 * The repair is POST /applications/:id/review/attention-acks, which persists the tick as
 * `_review.attention_acknowledgements` and changes nothing else. These tests hold the three claims
 * that make it a fix rather than a second decoration: the tick is ON THE ROW afterwards, the run
 * state around it is untouched, and the tick expires with the report it annotates - a fresh
 * attention_reason or a fresh submit-request clears the map, so a re-run never inherits ticks made
 * against sentences it has not written yet.
 *
 * WHY REAL ROUTES AND A REAL DATABASE, same reason as reviewAnswerSave.test.ts: a route that
 * answered 200 and wrote nothing is exactly the defect being fixed, and only reading the row
 * afterwards can tell those two apart. Fixture is PGlite over a unix socket with the production db
 * module, the production routes and the production auth middleware.
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
import type { ApplicationReviewState } from '../lib/applicationReview';

const JWT_SIGNING_SECRET = 'attention-ack-secret';
const ENCRYPTION_KEY = 'attention-ack-key';

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

const STOPPED_AT = '2026-08-20T09:00:00.000Z';
const BLOCKER = '"Are you willing to undergo a background check?" is required and is still empty';
/* The id the dashboard derives from that sentence (keyFor in submission-checklist.ts). The server
 * treats it as opaque; what matters here is that the same key comes back out. */
const ITEM_ID = 'blocker-are-you-willing-to-undergo-a-background-check-is-required-and-is-still-empty';

/** A packet stopped at needs_attention, still wearing its run's claim, exactly as a stall leaves it. */
function stoppedRun(extra: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return {
    jd_text: 'Security engineer at Easy Dynamics',
    status: 'needs_attention',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: STOPPED_AT,
    portal_url: 'https://app.rippling.com/ats/jobs/easy-dynamics/security-engineer/apply',
    ats_name: 'rippling',
    submission_run_id: 'run-1',
    submission_claimed_at: STOPPED_AT,
    submission_claim_id: 'claim-1',
    attention_reason: BLOCKER,
    ...extra,
  };
}

async function applicationWith(review: ApplicationReviewState): Promise<string> {
  const [row] = await db.insert(schema.generated_resumes).values({
    user_id: userId,
    job_context: { company: 'Easy Dynamics', role: 'Security engineer' },
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

function tick(applicationId: string, acknowledged: boolean, itemId: string = ITEM_ID, label: string = BLOCKER) {
  return app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/review/attention-acks`,
    headers: { authorization: `Bearer ${token}` },
    payload: { item_id: itemId, label, acknowledged },
  });
}

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-attention-ack-'));
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

  const [account] = await db.insert(schema.users).values({ email: 'attention-ack@example.test' }).returning();
  userId = account.id;

  token = await new SignJWT({
    userId,
    email: 'attention-ack@example.test',
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

/* THE DEFECT, STATED AS THE ROW. Not "the request returned 200" but "the tick is on disk", which is
 * the only difference between this route and the checkbox it replaces. */
test('a ticked attention row is on the row afterwards, and the response says so', async () => {
  const id = await applicationWith(stoppedRun());

  const response = await tick(id, true);
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  assert.equal(persisted.attention_acknowledgements?.[ITEM_ID]?.label, BLOCKER, 'the tick is stored with the sentence it acknowledged');
  assert.ok(persisted.attention_acknowledgements?.[ITEM_ID]?.acknowledged_at, 'and when it was made');
  assert.equal(response.json().review.attention_acknowledgements?.[ITEM_ID]?.label, BLOCKER,
    'and the response carries it, so the panel can render the settled row from the write that happened');
});

/* DISPLAY-ONLY MEANS NOTHING ELSE MOVES. The tick is her claim about her own work on the employer
 * page; the run's record - status, claim, run id, attention_reason - is measurement and is not hers
 * to edit from a checkbox. */
test('ticking a row leaves the stopped run exactly as it stopped', async () => {
  const id = await applicationWith(stoppedRun());

  await tick(id, true);

  const persisted = await storedReview(id);
  assert.equal(persisted.status, 'needs_attention', 'the stopped run is still a stopped run');
  assert.equal(persisted.submission_claimed_at, STOPPED_AT, 'and still holds its claim');
  assert.equal(persisted.submission_run_id, 'run-1', 'a new run id would mean a send was booked');
  assert.equal(persisted.attention_reason, BLOCKER, 'and still says what it is waiting for');
});

/* THE TICK WITHDRAWN. An untick of the only row leaves the field ABSENT, not `{}`: a review she
 * never ticked and a review she ticked and unticked must be byte-identical, or every downstream
 * spec comparison starts distinguishing two states that mean the same thing. */
test('unticking the last row removes the map entirely', async () => {
  const id = await applicationWith(stoppedRun());

  await tick(id, true);
  const response = await tick(id, false);
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  assert.equal(persisted.attention_acknowledgements, undefined, 'no empty object left behind');
});

/* THE TICK EXPIRES WITH THE REPORT IT ANNOTATES, part one: any review patch that carries a fresh
 * attention_reason drops the map. This is applyReviewPatch's own-property rule, the same round
 * discipline the per-answer applicant claim is held to - a re-measured blocker that spells itself
 * identically still starts her checklist clean, because the tick was made against an older report. */
test('a patch carrying attention_reason clears the ticks, and one without it keeps them', async () => {
  const { applyReviewPatch } = await import('../lib/applicationStall');
  const ticked = stoppedRun({
    attention_acknowledgements: { [ITEM_ID]: { label: BLOCKER, acknowledged_at: STOPPED_AT } },
  });

  const rewritten = applyReviewPatch(ticked, { status: 'needs_attention', attention_reason: BLOCKER });
  assert.equal(rewritten.attention_acknowledgements, undefined,
    'the same sentence re-reported is a new report, and the tick does not survive onto it');

  const annotated = applyReviewPatch(ticked, { progress_stage: 'Reading the form' });
  assert.equal(annotated.attention_acknowledgements?.[ITEM_ID]?.label, BLOCKER,
    'a write that says nothing about attention leaves her ticks alone');
});

/* Part two: a fresh submit-request clears the map with the rest of the run-scoped state, through
 * the same function that clears attention_reason itself. */
test('a fresh submit-request review carries no ticks', async () => {
  const { freshSubmitRequestReview } = await import('./applications');
  const ticked = stoppedRun({
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    attention_acknowledgements: { [ITEM_ID]: { label: BLOCKER, acknowledged_at: STOPPED_AT } },
  });

  const fresh = freshSubmitRequestReview(ticked, []);
  assert.equal(fresh.attention_acknowledgements, undefined, 'the new run starts with a clean checklist');
  assert.equal(fresh.attention_reason, undefined, 'beside the cleared report it annotated');
});

/* THE KEY IS AN OBJECT PROPERTY, AND THE CLIENT CHOOSES IT. "__proto__" assigned by bracket write
 * re-parents a plain object instead of creating an own key: the tick would vanish while the route
 * answered 200 - the dead checkbox again, with a success status behind it. The schema's charset
 * (lowercase alphanumerics and hyphens, the only alphabet keyFor emits) refuses the whole class. */
test('a prototype-named item_id is refused, not silently dropped', async () => {
  const id = await applicationWith(stoppedRun());

  const response = await tick(id, true, '__proto__', 'anything');
  assert.equal(response.statusCode, 400, response.body);

  const persisted = await storedReview(id);
  assert.equal(persisted.attention_acknowledgements, undefined, 'nothing was written');
  assert.equal(({} as Record<string, unknown>).polluted, undefined, 'and no prototype was touched');
});

/* A NO-OP MUST NOT WRITE. Unticking a row that holds no tick changes nothing, and a write here
 * would bump updated_at and rewrite the whole spec for zero semantic change - churn that can fail
 * a real concurrent save's compare-and-swap for nothing. */
test('unticking a row that was never ticked leaves the row byte-identical', async () => {
  const id = await applicationWith(stoppedRun());

  const response = await tick(id, false, 'blocker-never-ticked', 'Never ticked');
  assert.equal(response.statusCode, 200, response.body);

  const persisted = await storedReview(id);
  assert.equal(persisted.updated_at, STOPPED_AT, 'updated_at did not move');
  assert.equal(persisted.attention_acknowledgements, undefined);
});

/* THE REPORT THE MERGE ITSELF INVENTS ALSO EXPIRES THE TICKS. withTerminalCause runs inside
 * applyReviewPatch and can mint an attention_reason no caller named; a patch-key test alone would
 * carry ticks onto that invented sentence. The rule's second half compares the merged report to
 * the one the ticks were made against. */
test('a reason minted by the merge expires the ticks like a stated one', async () => {
  const { applyReviewPatch } = await import('../lib/applicationStall');
  const ticked = stoppedRun({
    attention_reason: undefined,
    attention_acknowledgements: { [ITEM_ID]: { label: BLOCKER, acknowledged_at: STOPPED_AT } },
  });

  const failed = applyReviewPatch(ticked, { status: 'failed', submission_error: 'run threw' });
  assert.ok(failed.attention_reason, 'withTerminalCause minted a cause for the terminal state');
  assert.equal(failed.attention_acknowledgements, undefined,
    'and the ticks do not survive onto a sentence that did not exist when they were made');
});

/* THE CAP IS A LOOP DETECTOR. No real panel has a hundred rows; a client that gets here is stuck
 * re-ticking, and the refusal has to be loud rather than a quiet unbounded jsonb column. Re-ticking
 * an EXISTING row stays allowed at the cap, or a full map could never be corrected. */
test('the hundred-and-first distinct tick is refused, re-ticking an existing one is not', async () => {
  const atCap = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
    `blocker-${index}`, { label: `Blocker ${index}`, acknowledged_at: STOPPED_AT },
  ]));
  const id = await applicationWith(stoppedRun({ attention_acknowledgements: atCap }));

  const overflow = await tick(id, true, 'blocker-new', 'One more');
  assert.equal(overflow.statusCode, 400, overflow.body);

  const retick = await tick(id, true, 'blocker-7', 'Blocker 7');
  assert.equal(retick.statusCode, 200, retick.body);
});
