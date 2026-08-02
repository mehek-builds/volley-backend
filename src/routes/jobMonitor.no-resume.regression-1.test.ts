import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeTargeting } from '../lib/jobPreferences';
import { rankByFit, type RankableJob } from './jobMonitor';

// Regression: ISSUE-003, guest accounts without a resume showed a fabricated 0% resume match
// Found by /qa on 2026-08-02
// Report: .gstack/qa-reports/qa-report-trylitos-com-2026-08-02.md
test('preference ranking without a resume keeps match scores absent', () => {
  const rows: RankableJob[] = [
    { company_name: 'Acme', title: 'Software Engineer', scored_description: 'Requirements: TypeScript and React.' },
    { company_name: 'Other', title: 'Product Designer', scored_description: 'Requirements: Figma and research.' },
  ];
  const targeting = normalizeTargeting({ titles: ['Software Engineer'] });
  const ranked = rankByFit(rows, '', targeting);

  assert.equal(ranked[0]?.row.title, 'Software Engineer');
  assert.equal(ranked[0]?.score, null);
  assert.equal(ranked[1]?.score, null);
});
