import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readWorkableApplicationUrl,
  resolvedApprovedApplicationPageUrl,
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
