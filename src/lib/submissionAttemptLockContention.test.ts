/* ONE SLOW READ MUST NOT MAKE EVERY WRITE ON THE ACCOUNT FAIL.
 *
 * MEASURED LIVE 2026-09-04, account mehekmandal05@gmail.com. POST
 * /applications/:id/packet-audit answered 503 "This account changed at the same time. Try the
 * request again." on four attempts spaced 20-40s apart, and kept answering it for minutes. The
 * dashboard was read-only: the packet audit gates filling and sending, so nothing could be sent.
 *
 * #925 reclassified that condition correctly (it had been a 500 leaking the raw SQL), so the
 * REPORTING was already right. What was left is that the condition is not rare. It was permanent.
 *
 * THE HOLDER WAS NOT A RUN, AND NOT THE TWO PACKETS STUCK IN `filling`. A dead transaction holds
 * no lock, so a frozen row holds nothing. The holder was the dashboard itself:
 * authoritativeSubmissionProjection is a READ, and it took `submission-attempt:<userId>`
 * EXCLUSIVELY for the whole of projectionSnapshot - which loads the entire account: every
 * application, every packet (201 rows on that account), every attempt event, every canonical
 * receipt, every email message, every artifact and artifact version. The packet page issues that
 * read on a 2.5-SECOND POLL. Once one pass outran the poll interval the passes overlapped, and
 * being mutually exclusive they QUEUED - so the key was held essentially without interruption, and
 * the revision trigger, which tried and gave up instantly, failed every single-statement write on
 * the account. Opening the packet page is what sustained it, which is why opening it to watch the
 * stuck rows heal never healed them.
 *
 * Two changes, and these tests pin both. Readers take the key SHARED, so they stop serializing
 * against each other while still never straddling a revision bump. The guard WAITS a bounded
 * moment before refusing, so a reader holding it for milliseconds is no longer a 503.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ledger = readFileSync('src/lib/submissionAttemptLedger.ts', 'utf8');
const projection = readFileSync('src/lib/authoritativeSubmissionProjection.ts', 'utf8');
const providerCleanup = readFileSync('src/lib/browserProviderResourceCleanup.ts', 'utf8');
const applications = readFileSync('src/routes/applications.ts', 'utf8');

function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `anchor not found: ${from}`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `closing anchor not found: ${to}`);
  return source.slice(start, end);
}

/* THE READER STOPS PARTICIPATING IN THE LOCK AT ALL, which is the whole of the fix.
 *
 * Shared alone would not have been enough, and the reason is worth pinning: shared readers stop
 * queueing behind each other, but a read that outlasts the 2.5s poll interval still produces
 * UNBROKEN shared coverage - poll N+1 starts before poll N finishes - and shared still blocks the
 * exclusive lock the revision guard needs. The account would have stayed read-only. A REPEATABLE
 * READ transaction gets the same consistent (revision, snapshot) pair from MVCC, holding nothing,
 * so a reader can no longer fail a write at ANY duration. */
test('the passive authority projection takes no account lock at all', () => {
  const passive = slice(
    projection,
    'export async function authoritativeSubmissionProjection',
    'const packetIds = uniqueStrings',
  );
  assert.match(passive, /isolationLevel: 'repeatable read'/u,
    'consistency comes from the snapshot, since it no longer comes from the lock');
  assert.match(passive, /accessMode: 'read only'/u,
    'and the database enforces that this page render cannot write');
  assert.match(passive, /lockMode: 'snapshot'/u);

  // The passive branch is chosen exactly when the caller supplied no executor - the poll path.
  const chooses = slice(passive, 'if (!input.executor)', 'const lockMode');
  assert.doesNotMatch(chooses, /lockSubmissionAttemptUser(?!Shared)\(/u,
    'the poll path must not take the key the revision guard needs');

  // snapshot mode must not lock, and must not write - the seed insert would fail read-only anyway.
  const read = slice(
    readFileSync('src/lib/submissionAuthorityRevision.ts', 'utf8'),
    'export async function readSubmissionAuthorityRevision',
    '\n}',
  );
  assert.match(read, /lockMode !== 'snapshot'/u, 'a snapshot read must skip the seed write');
  assert.match(read, /lockMode === 'snapshot' && result\.rows\[0\] === undefined/u,
    'and must answer 0 for an account with no row, which is what the seed would have created');
});

/* AND THE INVARIANT IS NOT WEAKENED, which is the thing a careless version of this fix breaks.
 * The revision counter gates duplicate-send safety, so a WRITER sharing the key would let two
 * writers interleave around a bump. Writers, and the trigger, keep taking it exclusively; shared
 * still conflicts with exclusive, so a reader's (revision, snapshot) pair stays consistent. */
test('writers and the revision guard still take the account key exclusively', () => {
  const exclusive = slice(ledger, 'export async function lockSubmissionAttemptUser(', '\n}');
  assert.match(exclusive, /pg_advisory_xact_lock\(hashtextextended\(/u);
  assert.doesNotMatch(exclusive, /_shared/u,
    'the writer lock must never become shared: it is what serializes revision bumps');

  const bump = slice(
    readFileSync('src/lib/submissionAuthorityRevision.ts', 'utf8'),
    'export async function bumpSubmissionAuthorityRevision',
    '\n}',
  );
  assert.match(bump, /lockSubmissionAttemptUser\(executor, userId\)/u);
  assert.doesNotMatch(bump, /Shared/u, 'an explicit bump is a write and takes the key exclusively');
});

/* THE PER-USER SCOPE IS DELIBERATE AND STAYS. The key is not narrowed to a packet, because the
 * invariant genuinely is account-wide: submission_authority_revisions holds ONE row per user, and
 * projectionSnapshot reads the whole account because duplicate-send safety is cross-packet - two
 * packets for one posting have to see each other's attempts. Per-row scoping would let them bump
 * independent counters and each conclude the other had never been sent. */
test('the authority key stays account-wide, never per packet', () => {
  const body = slice(ledger, 'export async function lockSubmissionAttemptUser(', '\n}');
  assert.match(body, /`submission-attempt:\$\{userId\}`/u,
    'the key is derived from the account and nothing else');
  assert.doesNotMatch(body, /packetId|applicationId|rowId/u);

  /* The snapshot that the revision describes is account-wide for the same reason: duplicate-send
   * safety is cross-packet, so narrowing either the key or the read would let two packets for one
   * posting each conclude the other had never been sent. */
  const snapshot = slice(projection, 'async function projectionSnapshot', 'canonicalReceipts');
  assert.match(snapshot, /eq\(generated_resumes\.user_id, userId\)/u);
  assert.doesNotMatch(snapshot, /limit\(/u, 'the account snapshot is never truncated');
});

/* NO LONG-RUNNING WORK HOLDS THE LEDGER KEY. createFencedBrowserSession spans an external POST
 * bounded at 15s, and it held the very key the revision trigger takes on every write, so each
 * session creation made 15 seconds of that account's writes answer 503. Same shape as the 280s
 * managed prepare submissionAccountFence.ts was split out for; missed then because this one takes
 * the key directly instead of through withProviderCallFence. */
test('the fenced provider POST does not hold the key every write needs', () => {
  const fenced = slice(
    providerCleanup,
    'export async function createFencedBrowserSession',
    '\nasync function markResourceGone',
  );
  assert.match(fenced, /createReservedBrowserSession\(/u, 'the external POST is still inside the fence');
  assert.match(fenced, /lockSubmissionProviderCallUser\(tx, input\.userId\)/u);
  assert.doesNotMatch(fenced, /lockSubmissionAttemptUser\(tx/u,
    'holding the ledger key across a 15s provider POST is what made the account read-only');
});

/* #927 DID NOT FIRE, AND THIS IS THE ARM THAT LOST. The release is wired into the routes the
 * packet page actually hits - GET /applications/:id/submission (the 2.5s poll) and
 * POST /applications/:id/packet-audit - so the wiring was never the problem. Its try-lock arm was:
 * the projection read behind that same poll held this key, so a poll arriving while the previous
 * one was still reading found it taken and returned a bare null. Nothing was logged, which is why
 * 40 seconds of watching a packet page produced no explanation and no release. */
test('a stalled-fill release that loses the account lock says so instead of vanishing', () => {
  const repair = slice(applications, 'async function repairStalledFillRun', '\nfunction editableResumeSpec');
  assert.match(repair, /tryLockSubmissionAttemptUser\(tx, userId\)/u,
    'it still tries rather than waits - a best-effort repair must never queue behind a run');
  assert.doesNotMatch(
    slice(repair, 'tryLockSubmissionAttemptUser(tx, userId)', 'const [locked]'),
    /return null/u,
    'losing the lock must be distinguishable from having nothing to repair',
  );
  assert.match(repair, /lock_contended/u);
  assert.match(repair, /log\.warn\(/u, 'and it has to reach the logs, or the next person measures silence');
});

/* THE RELEASE IS STILL REACHED FROM THE PACKET PAGE'S OWN ROUTES. Pinned because the fix above
 * only matters if these call sites survive: a release nobody calls heals nothing. */
test('the stalled-fill release still runs on the poll and on the packet audit', () => {
  for (const route of ["'/applications/:id/packet-audit'", "'/applications/:id/submission'"]) {
    const at = applications.indexOf(route);
    assert.ok(at >= 0, `route missing: ${route}`);
    const handler = applications.slice(at, at + 4000);
    assert.match(handler, /repairStalledFillRun\(row, request\.jwtPayload!\.userId, request\.log\)/u,
      `${route} must still attempt the stalled-fill release`);
  }
});
