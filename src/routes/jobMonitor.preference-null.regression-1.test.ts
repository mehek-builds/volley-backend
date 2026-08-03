import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeTargeting, preferenceFit, hasTargeting } from '../lib/jobPreferences';

// Regression: ISSUE-014, second shape. GET /jobs sent preference_score: 0 for an account that had
// saved no preferences at all, and the two dashboard screens then disagreed about what a 0 meant:
// Home drew a "0" ring labelled "fit", Jobs drew nothing.
//
// The rule: 0 and "nothing was asked" are different answers, and this route is the only place that
// can tell them apart, because it is the only place holding the targeting row.

describe('preferenceFit floors at zero, so the route must carry the distinction', () => {
  const posting = {
    title: 'Product Management Intern (Summer 2027)',
    location: 'San Francisco, CA',
    employment_type: 'Internship',
    remote: false,
  };

  test('an account that asked for nothing scores 0 with no reasons', () => {
    const targeting = normalizeTargeting(null);
    assert.equal(hasTargeting(targeting), false);
    assert.deepEqual(preferenceFit(posting, targeting), { score: 0, reasons: [] });
  });

  test('an account that asked for things this posting lacks scores the same 0', () => {
    const targeting = normalizeTargeting({ categories: ['hardware'], role_types: ['new-grad'] });
    assert.equal(hasTargeting(targeting), true);
    assert.equal(preferenceFit(posting, targeting).score, 0);
    // Identical output for a completely different question. This is why the score alone cannot be
    // the signal, and why the route reads hasTargeting rather than testing for zero.
    assert.deepEqual(preferenceFit(posting, targeting).reasons, []);
  });

  test('a real match scores above zero and says why', () => {
    const targeting = normalizeTargeting({ categories: ['product'], role_types: ['internship'], locations: ['San Francisco'] });
    const fit = preferenceFit(posting, targeting);
    assert.equal(fit.score, 40);
    assert.deepEqual(fit.reasons, ['product', 'San Francisco', 'internship']);
  });

  test('every rule that scores also pushes a reason, so a non-zero score is never unexplained', () => {
    // The property both clients rely on to suppress a number they cannot caption.
    for (const targeting of [
      normalizeTargeting({ titles: ['Product Management Intern'] }),
      normalizeTargeting({ categories: ['product'] }),
      normalizeTargeting({ locations: ['San Francisco'] }),
      normalizeTargeting({ role_types: ['internship'] }),
      normalizeTargeting({ remote_only: true }),
    ]) {
      const fit = preferenceFit({ ...posting, remote: true }, targeting);
      assert.equal(fit.score > 0, fit.reasons.length > 0, JSON.stringify(targeting));
    }
  });
});

describe('the route sends null rather than a fabricated zero', () => {
  const source = readFileSync(path.join(__dirname, 'jobMonitor.ts'), 'utf8');

  test('preference_score and preference_reasons are both gated on hasTargeting', () => {
    assert.match(source, /const scored = hasTargeting\(jobTargeting\);/);
    assert.match(source, /preference_score: scored \? fit\.score : null,/);
    assert.match(source, /preference_reasons: scored \? fit\.reasons : \[\],/);
  });

  test('preferenceFit is called once per row, not twice', () => {
    // It used to be invoked separately for the score and for the reasons, which is two passes over
    // the same row per posting per page for one answer.
    assert.doesNotMatch(source, /preference_score: preferenceFit\(/);
  });
});
