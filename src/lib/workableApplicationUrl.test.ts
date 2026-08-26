import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
