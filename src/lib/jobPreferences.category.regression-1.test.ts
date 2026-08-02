import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeTargeting, preferenceFit, targetTitleTerms } from './jobPreferences';

// Regression: ISSUE-002, a Product Designer role matched Software engineering through "mobile"
// Found by /qa on 2026-08-02
// Report: .gstack/qa-reports/qa-report-trylitos-com-2026-08-02.md
test('mobile design is not classified as software engineering without an engineering title', () => {
  const targeting = normalizeTargeting({ categories: ['software-engineering'] });

  assert.equal(targetTitleTerms(targeting).includes('mobile'), false);
  assert.equal(preferenceFit({ title: 'Senior Product Designer, Core Mobile Experiences' }, targeting).score, 0);
  assert.ok(preferenceFit({ title: 'Mobile Software Engineer' }, targeting).score > 0);
});
