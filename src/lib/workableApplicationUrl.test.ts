import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isGreenhouseLegacyHostRedirect,
  readWorkableApplicationUrl,
  resolvedApprovedApplicationPageUrl,
  sortManagedPageUrlParams,
} from './workableApplicationUrl';

test('Workable URL identity accepts its public short link and canonical tenant shape', () => {
  assert.deepEqual(readWorkableApplicationUrl('https://apply.workable.com/j/20e78cba92/apply'), {
    href: 'https://apply.workable.com/j/20e78cba92/apply',
    origin: 'https://apply.workable.com',
    tenant: null,
    jobToken: '20E78CBA92',
    search: '',
    shape: 'bare',
  });
  assert.equal(
    readWorkableApplicationUrl('https://apply.workable.com/max-borges-agency/j/20e78cba92/apply')?.jobToken,
    '20E78CBA92',
  );
});

test('only the same Workable short-link identity resolves to a tenant URL', () => {
  const expected = 'https://apply.workable.com/j/20e78cba92/apply?source=litos#apply';
  const observed = 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply?source=litos';
  assert.equal(resolvedApprovedApplicationPageUrl(expected, observed), observed);
  assert.equal(resolvedApprovedApplicationPageUrl(observed, observed), observed);
  for (const rejected of [
    'https://apply.workable.com/max-borges-agency/j/AAAAAAAAAA/apply?source=litos',
    'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply?source=other',
    'https://apply.workable.com/another/j/20E78CBA92/apply/extra?source=litos',
    'https://user:pass@apply.workable.com/max-borges-agency/j/20E78CBA92/apply?source=litos',
    'https://apply.workable.com:444/max-borges-agency/j/20E78CBA92/apply?source=litos',
    'http://apply.workable.com/max-borges-agency/j/20E78CBA92/apply?source=litos',
    'https://careers.example.com/max-borges-agency/j/20E78CBA92/apply?source=litos',
    'https://apply.workable.com/j/20E78CBA92/apply?source=litos',
  ]) {
    assert.equal(resolvedApprovedApplicationPageUrl(expected, rejected), null, rejected);
  }
});

test('a canonical Workable tenant URL cannot change tenant under the redirect exception', () => {
  assert.equal(
    resolvedApprovedApplicationPageUrl(
      'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply',
      'https://apply.workable.com/another-tenant/j/20E78CBA92/apply',
    ),
    null,
  );
});

/* Greenhouse's embed URL (?for=<board>&token=<jobId>) re-serializes its own query string after
 * mount, reordering the same params it was given. Regression coverage for the false-refusal this
 * caused live on Redwood Materials ("the employer page redirected away from the approved
 * destination", 3/3 identical failures via backend logs). */
test('sortManagedPageUrlParams tolerates reordering but changes a genuinely different param set', () => {
  const asGiven = new URL('https://boards.greenhouse.io/embed/job_app?for=redwood&token=123456');
  const asReordered = new URL('https://boards.greenhouse.io/embed/job_app?token=123456&for=redwood');
  sortManagedPageUrlParams(asGiven);
  sortManagedPageUrlParams(asReordered);
  assert.equal(asGiven.href, asReordered.href);

  const differentBoard = new URL('https://boards.greenhouse.io/embed/job_app?for=other&token=123456');
  sortManagedPageUrlParams(differentBoard);
  assert.notEqual(differentBoard.href, asGiven.href);

  const differentJob = new URL('https://boards.greenhouse.io/embed/job_app?for=redwood&token=999999');
  sortManagedPageUrlParams(differentJob);
  assert.notEqual(differentJob.href, asGiven.href);
});

test('a reordered Greenhouse query string resolves as the approved boundary, not a redirect away from it', () => {
  const expected = 'https://boards.greenhouse.io/embed/job_app?for=redwood&token=123456';
  const observedAfterReorder = 'https://boards.greenhouse.io/embed/job_app?token=123456&for=redwood';
  const expectedUrl = new URL(expected);
  const observedUrl = new URL(observedAfterReorder);
  sortManagedPageUrlParams(expectedUrl);
  sortManagedPageUrlParams(observedUrl);
  assert.equal(resolvedApprovedApplicationPageUrl(expectedUrl, observedUrl), observedUrl.href);
});

/* Measured 2026-09-04 from the shell:
 *   GET https://boards.greenhouse.io/embed/job_app?for=sage49&token=6131185004
 *     -> 301 location: https://job-boards.greenhouse.io/embed/job_app?for=sage49&token=6131185004
 * portalApplicationUrl builds every Greenhouse application URL on the legacy host, so the expected
 * URL is always legacy and the landed URL always current. Both sides of the managed proof refused
 * that pair, and Sage application aae653a3-2d5a-4f3e-ba3b-afea4219df37 failed twice with nothing
 * filled and nothing sent. */
test("Greenhouse's legacy-host 301 resolves as the approved boundary", () => {
  const expected = 'https://boards.greenhouse.io/embed/job_app?for=sage49&token=6131185004';
  const observed = 'https://job-boards.greenhouse.io/embed/job_app?for=sage49&token=6131185004';
  assert.equal(resolvedApprovedApplicationPageUrl(expected, observed), observed);
  // The same whole-host 301 is served for the hosted posting route.
  assert.equal(
    resolvedApprovedApplicationPageUrl(
      'https://boards.greenhouse.io/sage49/jobs/6131185004',
      'https://job-boards.greenhouse.io/sage49/jobs/6131185004',
    ),
    'https://job-boards.greenhouse.io/sage49/jobs/6131185004',
  );
});

test('the Greenhouse legacy-host exception cannot reach a different job', () => {
  const expected = 'https://boards.greenhouse.io/embed/job_app?for=sage49&token=6131185004';
  for (const rejected of [
    // A different board, or a different job, is a different application.
    'https://job-boards.greenhouse.io/embed/job_app?for=notsage&token=6131185004',
    'https://job-boards.greenhouse.io/embed/job_app?for=sage49&token=9999999999',
    'https://job-boards.greenhouse.io/embed/job_app?for=sage49',
    // A host migration carries the path across untouched, so a moved path is a real move.
    'https://job-boards.greenhouse.io/embed/job_app/extra?for=sage49&token=6131185004',
    'https://job-boards.greenhouse.io/sage49/jobs/6131185004?for=sage49&token=6131185004',
    // Neither a lookalike host nor another silo is Greenhouse's own redirect target.
    'https://job-boards.greenhouse.io.evil.example/embed/job_app?for=sage49&token=6131185004',
    'https://job-boards.eu.greenhouse.io/embed/job_app?for=sage49&token=6131185004',
    // The transport floor still applies to the accepted pair.
    'http://job-boards.greenhouse.io/embed/job_app?for=sage49&token=6131185004',
    'https://user:pass@job-boards.greenhouse.io/embed/job_app?for=sage49&token=6131185004',
    'https://job-boards.greenhouse.io:444/embed/job_app?for=sage49&token=6131185004',
  ]) {
    assert.equal(resolvedApprovedApplicationPageUrl(expected, rejected), null, rejected);
  }
  // Greenhouse redirects legacy -> current only, so the reverse ordering is not this redirect.
  assert.equal(
    resolvedApprovedApplicationPageUrl(
      'https://job-boards.greenhouse.io/embed/job_app?for=sage49&token=6131185004',
      'https://boards.greenhouse.io/embed/job_app?for=sage49&token=6131185004',
    ),
    null,
  );
  // An embed route naming no job has no identity for the equal query strings to have bound.
  assert.equal(
    isGreenhouseLegacyHostRedirect(
      'https://boards.greenhouse.io/embed/job_app',
      'https://job-boards.greenhouse.io/embed/job_app',
    ),
    false,
  );
  assert.equal(isGreenhouseLegacyHostRedirect('not a url', 'also not a url'), false);
});
