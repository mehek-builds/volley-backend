import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessImpactBullet,
  buildRecentExperienceReview,
  comparableEndDate,
  composeImpactBullet,
  selectRecentExperience,
  type RecentExperienceEntry,
} from './recentExperience';

const entry = (id: string, date_range: string | null, bullets: string[]): RecentExperienceEntry => ({
  id, type: 'job', org: id, title: 'Engineer', date_range, bullet_variants: bullets,
});

test('current work outranks completed work', () => {
  const selected = selectRecentExperience([
    entry('old', 'Jan 2024 - Dec 2025', ['Built reports.']),
    entry('current', 'Jan 2025 - Present', ['Built workflows.']),
  ]);
  assert.equal(selected.selected?.id, 'current');
  assert.equal(selected.ambiguous, false);
});

test('missing or tied dates require the user to choose', () => {
  assert.equal(selectRecentExperience([entry('a', null, ['Built a.'])]).ambiguous, true);
  assert.equal(selectRecentExperience([
    entry('a', '2025', ['Built a.']), entry('b', '2025', ['Built b.']),
  ]).ambiguous, true);
});

test('month and year parsing compares end dates', () => {
  assert.ok((comparableEndDate('May 2024 - August 2025') ?? 0) > (comparableEndDate('2024') ?? 0));
});

test('nonnumeric scope counts and complete bullets proceed', () => {
  const assessment = assessImpactBullet([
    'Built an onboarding workflow used by the recruiting team, reducing review time.',
  ]);
  assert.equal(assessment.score, 4);
  assert.equal(assessment.components.metric_or_scope.present, true);
});

test('an action verb is not double-counted as a separate outcome', () => {
  const assessment = assessImpactBullet([
    'Launched an onboarding workflow used by the recruiting team.',
  ]);
  assert.equal(assessment.score, 3);
  assert.equal(assessment.components.outcome.present, false);
});

test('related source bullets may contribute outcome evidence', () => {
  const assessment = assessImpactBullet([
    'Built a reporting dashboard for customer operations.',
    'Reduced reporting dashboard review time by 30%.',
  ]);
  assert.equal(assessment.components.outcome.present, true);
  assert.equal(assessment.components.metric_or_scope.present, true);
});

test('unrelated bullets are not combined', () => {
  const assessment = assessImpactBullet([
    'Built a reporting dashboard for weekly customer operations reviews.',
    '30% reduction in recruiting time.',
  ]);
  assert.equal(assessment.components.metric_or_scope.present, false);
});

test('fewer than three bullets opens input even with a complete impact bullet', () => {
  const review = buildRecentExperienceReview([
    entry('current', '2025 - Present', ['Built a workflow across three teams, reducing review time.']),
  ]);
  assert.equal(review.status, 'needs_input');
  assert.equal(review.missing_bullets, 2);
});

test('answers compose a grounded user-owned bullet', () => {
  assert.equal(composeImpactBullet('', {
    action: 'Built', noun: 'an onboarding workflow', metric_or_scope: 'across three teams',
    outcome: 'reducing review time',
  }), 'Built an onboarding workflow across three teams, reducing review time.');
});
