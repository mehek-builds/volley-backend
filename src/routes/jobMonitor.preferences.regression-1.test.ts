import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeTargeting, preferenceFit } from '../lib/jobPreferences';
import { boardConditions } from './jobMonitor';

// Regression: ISSUE-001, remote-only erased a saved location requirement
// Found by /qa on 2026-08-02
// Report: .gstack/qa-reports/qa-report-trylitos-com-2026-08-02.md
test('saved remote-only and location preferences both become board constraints', () => {
  const targeting = normalizeTargeting({
    categories: ['software-engineering'],
    titles: ['Software Engineer'],
    role_types: ['full-time'],
    locations: ['New York'],
    remote_only: true,
  });
  const baseline = boardConditions({}).length;

  assert.equal(boardConditions({ targeting }).length, baseline + 4);

  const fit = preferenceFit({
    title: 'Software Engineer',
    location: 'New York, NY',
    employment_type: 'Full-time',
    remote: true,
  }, targeting);
  assert.ok(fit.reasons.includes('New York'));
});
