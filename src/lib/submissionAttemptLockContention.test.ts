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

/* THE READER STOPS EXCLUDING OTHER READERS. This is the whole of the read-only-dashboard fix: the
 * projection is a read, so shared is what it actually needs, and shared/shared does not conflict. */
test('the passive authority projection holds the account key shared, not exclusively', () => {
  const shared = slice(ledger, 'export async function lockSubmissionAttemptUserShared', '\n}');
  assert.match(shared, /pg_advisory_xact_lock_shared\(hashtextextended\(/u);
  assert.match(shared, /submission-attempt:\$\{userId\}/u);

  // The passive branch - the one behind the 2.5s poll and every page render - must choose it.
  const passive = slice(
    projection,
    'export async function authoritativeSubmissionProjection',
    'const packetIds = uniqueStrings',
  );
  assert.match(passive, /lockMode: 'shared'/u,
    'the branch that opens its own transaction is the poll path and must take the key shared');
  assert.match(passive, /lockSubmissionAttemptUserShared\(input\.executor, input\.userId\)/u);
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
  for (const helper of ['lockSubmissionAttemptUser(', 'lockSubmissionAttemptUserShared(']) {
    const body = slice(ledger, `export async function ${helper.slice(0, -1)}`, '\n}');
    assert.match(body, /`submission-attempt:\$\{userId\}`/u,
      'the key is derived from the account and nothing else');
    assert.doesNotMatch(body, /packetId|applicationId|rowId/u);
  }
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
