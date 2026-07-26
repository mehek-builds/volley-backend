import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skillsSourceFor } from './baseResume';

/* profiles.skills is NULL for every student at onboarding - the screen that collects it comes
 * later - so a build that read only that column always ran in non-declared mode. Measured on a real
 * Cal Poly CS resume, 2026-07-27: eighteen skills on the page, nine on the base resume, zero of them
 * the student's own words. */

describe('skillsSourceFor', () => {
  test('falls back to what the resume printed when nothing was declared yet', () => {
    assert.deepEqual(skillsSourceFor(null, { skills: ['C', 'Swift', 'Xcode'] }), ['C', 'Swift', 'Xcode']);
    assert.deepEqual(skillsSourceFor([], { skills: ['C', 'Swift'] }), ['C', 'Swift']);
  });

  test('a declared list always wins over the parse', () => {
    assert.deepEqual(skillsSourceFor(['Rust'], { skills: ['C', 'Swift'] }), ['Rust']);
  });

  test('returns null rather than an empty authority', () => {
    // [] would put pruning into declared mode against nothing and strip the skills line bare.
    assert.equal(skillsSourceFor(null, { skills: [] }), null);
    assert.equal(skillsSourceFor(null, null), null);
    assert.equal(skillsSourceFor([], {}), null);
  });

  test('junk in a hand-edited jsonb column cannot reach a prompt', () => {
    assert.deepEqual(skillsSourceFor([1, null, 'Rust', '  '], null), ['Rust']);
    assert.equal(skillsSourceFor('not-an-array', { skills: 'also-not' }), null);
  });
});
