import assert from 'node:assert/strict';
import test from 'node:test';
import { readMostRecentRole } from './submissionRunner';

// readMostRecentRole runs inside buildPacket, which every prepare and every submit goes through -
// on EVERY portal, not just the one that needs work history. So its failure mode is not "Paylocity
// misses a field", it is "one malformed parsed resume breaks Greenhouse, Lever and Ashby too".
// Review found it threw a TypeError on a null entry; these pin the whole shape.

test('a profile with no usable experience yields undefined rather than throwing', () => {
  assert.equal(readMostRecentRole({}), undefined);
  assert.equal(readMostRecentRole({ experience: undefined }), undefined);
  assert.equal(readMostRecentRole({ experience: [] }), undefined);
  assert.equal(readMostRecentRole({ experience: 'Traeco' }), undefined);
  assert.equal(readMostRecentRole({ experience: {} }), undefined);
});

test('a malformed first entry never throws, because it would break every other portal too', () => {
  for (const entry of [null, undefined, 'a string', 42, ['nested']]) {
    assert.doesNotThrow(() => readMostRecentRole({ experience: [entry] }), `entry: ${JSON.stringify(entry)}`);
    assert.equal(readMostRecentRole({ experience: [entry] }), undefined);
  }
});

test('a partial entry is dropped, since half a work-history row is worse than none', () => {
  assert.equal(readMostRecentRole({ experience: [{ company: 'Traeco' }] }), undefined);
  assert.equal(readMostRecentRole({ experience: [{ title: 'Engineer' }] }), undefined);
  assert.equal(readMostRecentRole({ experience: [{ company: '   ', title: 'Engineer' }] }), undefined);
  assert.equal(readMostRecentRole({ experience: [{ company: 42, title: 'Engineer' }] }), undefined);
});

test('org is the fallback for company, and the FIRST entry wins because resumes are written newest-first', () => {
  assert.deepEqual(
    readMostRecentRole({ experience: [{ org: 'Traeco', title: 'Engineer' }] }),
    { company: 'Traeco', title: 'Engineer', summary: undefined, startDate: undefined, endDate: undefined },
  );
  const two = readMostRecentRole({ experience: [
    { company: 'Now Co', org: 'Ignored', title: 'Founding Engineer', start: 'Jun 2025', end: 'Present', description: 'Built it.' },
    { company: 'Old Co', title: 'Intern' },
  ] });
  assert.equal(two?.company, 'Now Co');
  assert.equal(two?.startDate, 'Jun 2025');
  assert.equal(two?.summary, 'Built it.');
});
