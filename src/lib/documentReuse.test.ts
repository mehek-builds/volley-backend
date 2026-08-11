/* THE PROMISE THAT WAS PUBLISHED BEFORE IT WAS BUILT.
 *
 * Three surfaces said the same thing about a stored document and none of them was true of the code:
 *
 *   app/privacy/page.tsx   "so a later application can use the same file without us asking you
 *                           for it again"
 *   TranscriptModal        "Reuse this for future applications that ask", the checkbox, default ON
 *   TranscriptModal        the confirmation, telling her the next employer that asks gets it
 *
 * `user_documents.reusable` was written by the upload route and read as a filter by NOTHING. Every
 * second application asked her for the same file, and the column that recorded her answer was
 * decoration.
 *
 * The tests below fence the three decisions that make it real, plus the two that keep it honest:
 *
 *   - which asks a stored file may answer, and which are hers to answer alone,
 *   - that `reusable = false` is a refusal and never a preference,
 *   - that a reuse stamps last_used_at, which is both the account card's "last used" and the pick
 *     order for the application after this one,
 *   - that reuse runs on BOTH prepare paths, since one path only is the promise kept on some
 *     portals and quietly broken on the rest,
 *   - and that it cannot cost a run, because a prepared application is worth more than a reuse.
 *
 * Where a test reads source text rather than calling a function, it says so: the two prepare sites
 * are hundreds of lines of live browser work that no unit test can reach.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { reusableDocumentQuery } from './documentStore';
import {
  documentAsksLitosCannotResolve,
  documentAsksOpenToReuse,
  documentControlSupported,
  type RequiredDocumentAsk,
} from './requiredDocuments';

// __dirname rather than import.meta.url: tsconfig.api.json compiles this tree as CommonJS, the same
// reason coverLetterAttachment.test.ts gives.
const source = (...parts: string[]) => readFileSync(join(__dirname, '..', ...parts), 'utf8');

/* Comments stripped before any "is it gone?" assertion, the way tests/review-highlighting.test.mjs
   does it on the website side. Every explanation in the code below necessarily NAMES the shape it
   exists to prevent - the nested jsonb path, the throw - so a bare search counts the warning as the
   defect, and deleting the warning to satisfy a search would be the wrong repair. */
const shipped = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const TRANSCRIPT: RequiredDocumentAsk = {
  kind: 'transcript',
  label: 'Unofficial transcript (PDF)',
  official_requested: false,
};
const OFFICIAL: RequiredDocumentAsk = {
  kind: 'transcript',
  label: 'Official transcript',
  official_requested: true,
};

const ATTACHED = { attached_at: '2026-08-11T09:00:00.000Z', ordered_at: null };
const ORDERED = { attached_at: null, ordered_at: '2026-08-11T09:00:00.000Z' };

/* ---- which asks a stored file is allowed to answer ---- */

test('a measured ask on an application carrying nothing is the one reuse exists for', () => {
  assert.deepEqual(
    documentAsksOpenToReuse({ required_documents: [TRANSCRIPT] }, {}),
    [TRANSCRIPT],
  );
});

test('an unmeasured form asks for nothing, so nothing is reused into it', () => {
  assert.deepEqual(documentAsksOpenToReuse({}, {}), []);
  assert.deepEqual(documentAsksOpenToReuse({ required_documents: [] }, {}), []);
});

test('reuse never overwrites a file she chose herself', () => {
  assert.deepEqual(
    documentAsksOpenToReuse({ required_documents: [TRANSCRIPT] }, { transcript: ATTACHED }),
    [],
  );
});

test('reuse never answers over "I have ordered it"', () => {
  /* A mark exists only because she did something. Attaching on top of a recorded order would quietly
     answer a question she had already answered differently, and it is the answer that decides
     whether this application is Litos's to finish. */
  assert.deepEqual(
    documentAsksOpenToReuse({ required_documents: [OFFICIAL] }, { transcript: ORDERED }),
    [],
  );
});

test('a form the run found no control on is not reused into', () => {
  /* Recording an attachment here would write down that this employer is getting the transcript when
     nothing on either send path can deliver it. The ask stays outstanding and the screen says why,
     which is the honest state. */
  assert.deepEqual(
    documentAsksOpenToReuse({ required_documents: [TRANSCRIPT], transcript_supported: false }, {}),
    [],
  );
});

test('unmeasured capability is not a measured no', () => {
  // The tri-state, the same discipline cover_letter_required is held to. Every packet prepared
  // before the measurement existed carries undefined, and undefined must never behave like false.
  assert.deepEqual(
    documentAsksOpenToReuse({ required_documents: [TRANSCRIPT] }, {}),
    [TRANSCRIPT],
  );
  assert.deepEqual(
    documentAsksOpenToReuse({ required_documents: [TRANSCRIPT], transcript_supported: true }, {}),
    [TRANSCRIPT],
  );
  assert.equal(documentControlSupported({}, 'transcript'), undefined);
  assert.equal(documentControlSupported({ transcript_supported: false }, 'transcript'), false);
});

/* ---- reusable = false is a refusal, not a preference ---- */

test('the pick names reusable and excludes tombstones, in the statement itself', () => {
  /* THE ONE ASSERTION THIS WHOLE FEATURE RESTS ON. She unticked the box to say that file was for one
     employer; a query that forgets the column reuses it at the next employer anyway, and there is no
     screen anywhere that would show her it had happened. Compiled rather than grepped, so the test
     is reading the statement the driver will send. */
  const query = reusableDocumentQuery('a18f774b-a306-4804-93f3-cd6020c27fb3', 'transcript').toSQL();
  assert.match(query.sql, /"reusable"\s*=/, 'a file marked not reusable must be unreachable, not merely unpreferred');
  assert.match(query.sql, /"deleted_at"\s+is\s+null/, 'a tombstone points at a blob that is already gone');
  assert.match(query.sql, /"kind"\s*=/);
  assert.match(query.sql, /"user_id"\s*=/);
  assert.ok(query.params.includes(true), 'reusable is bound to true, not to whatever the row happens to hold');
  assert.match(
    query.sql,
    /order by coalesce\("user_documents"\."last_used_at", "user_documents"\."created_at"\) desc/i,
    'the same order Profile > Documents shows, so the file at the top of her list is the file the next application picks',
  );
});

test('the stamp is guarded by the same predicate the pick used, not by a restatement of it', () => {
  /* Source text: the update runs against a database. Two copies of "is this file still hers to
     reuse" is how one of them stops mentioning `reusable` a year from now, and the copy that would
     stop mentioning it is the one nothing reads. */
  const store = source('lib', 'documentStore.ts');
  assert.equal(
    (store.match(/reusableForKind\(userId, kind\)/g) ?? []).length,
    2,
    'the pick and the claim have to ask the same question',
  );
  assert.match(store, /last_used_at: new Date\(\)/, 'a reuse that did not stamp it would tell her the file had never been used');
});

/* ---- the asks no upload can clear, which is what the exit is gated on ---- */

test('an ordered official copy is something Litos cannot resolve', () => {
  assert.deepEqual(
    documentAsksLitosCannotResolve({ required_documents: [OFFICIAL] }, { transcript: ORDERED }),
    [OFFICIAL],
  );
});

test('a form with no control Litos can fill is unresolvable whether or not a file is stored', () => {
  const review = { required_documents: [TRANSCRIPT], transcript_supported: false };
  assert.deepEqual(documentAsksLitosCannotResolve(review, {}), [TRANSCRIPT]);
  assert.deepEqual(
    documentAsksLitosCannotResolve(review, { transcript: ATTACHED }),
    [TRANSCRIPT],
    'a stored file is not a delivered file, and the row that confirms the storage must not answer for the employer',
  );
});

test('an ask she can still satisfy is NOT unresolvable, so the exit cannot become a way past a working gate', () => {
  assert.deepEqual(documentAsksLitosCannotResolve({ required_documents: [TRANSCRIPT] }, {}), []);
  assert.deepEqual(
    documentAsksLitosCannotResolve({ required_documents: [TRANSCRIPT] }, { transcript: ATTACHED }),
    [],
  );
  assert.deepEqual(documentAsksLitosCannotResolve({}, {}), []);
});

/* ---- where the reuse runs, and what it may cost ---- */

test('reuse runs on both prepare paths, after the review is written, and cannot take the run down', () => {
  /* Source text, because both sites sit inside hundreds of lines of live browser work.
   *
   * BOTH PATHS, for the reason required_documents is written on both: measured on one runner only,
   * the promise is kept on some portals and silently broken on the rest. That is G5 in the
   * integration map, and this feature is one line away from repeating it.
   *
   * AFTER writeReview, so the application is already durably prepared when the reuse is attempted,
   * and inside a catch, so a blob outage costs a convenience and never a filled application. */
  const runner = source('routes', 'submissionRunner.ts');
  assert.equal(
    (runner.match(/await reuseStoredDocuments\(row, review, fastify\)/g) ?? []).length,
    2,
    'the managed path and the direct path both measure the ask, so both owe the reuse',
  );
  for (const match of runner.matchAll(/await writeReview\(row, review\);([\s\S]{0,400}?)reuseStoredDocuments/g)) {
    assert.doesNotMatch(match[1], /await writeReview/, 'the reuse follows the write it must not be able to lose');
  }
  const body = shipped(runner.slice(
    runner.indexOf('export async function reuseStoredDocuments'),
    runner.indexOf('A thrown value turned into a sentence'),
  ));
  assert.match(body, /try \{/);
  assert.match(body, /catch \(error\) \{[\s\S]{0,400}fastify\.log\.error/);
  assert.doesNotMatch(body, /throw /, 'a reuse that can abort a prepared application is worse than no reuse');
});

test('the reuse writes into _documents the same way the upload route does, and only into an empty kind', () => {
  /* jsonb_set with create_missing only creates the LAST element of the path, so writing
     '{_documents,transcript}' into a spec that has never held a document is a silent no-op that
     reports one row updated. routes/documents.ts records the measurement against Postgres; this is
     the second writer of the same path and it must not relearn it.

     The `is null` guard is the concurrency half: she may have attached or ordered on another tab
     between the measurement and this write, and reuse must never overwrite her own answer. */
  const runner = source('routes', 'submissionRunner.ts');
  const body = shipped(runner.slice(
    runner.indexOf('export async function reuseStoredDocuments'),
    runner.indexOf('A thrown value turned into a sentence'),
  ));
  assert.match(body, /'\{_documents\}'/);
  assert.doesNotMatch(body, /'\{_documents,/, 'the nested path is the silent no-op');
  assert.match(body, /-> '_documents', '\{\}'::jsonb\) \|\|/, 'the merge is what keeps every other kind');
  assert.match(body, /-> '_documents' -> \$\{ask\.kind\} is null/);
});
