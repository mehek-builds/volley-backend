import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasTargeting,
  normalizeTargeting,
  recommendationTargetingEligible,
} from './jobPreferences';
import { readPostingSponsorship } from './sponsorship';

const SUMMER_2027 = normalizeTargeting({
  categories: ['software-engineering', 'data-ml', 'product'],
  titles: ['AI Engineer', 'Product Manager', 'Product Engineer'],
  role_types: ['internship'],
  primary_period: 'summer-2027',
  backup_period: null,
});

describe('hard recommendation requirements', () => {
  test('a posting-level U.S. Person restriction overrides employer filing history', () => {
    assert.equal(readPostingSponsorship(
      'U.S. Person status is required as this position needs to access export controlled data.',
    ), 'refuses');
    assert.equal(readPostingSponsorship(
      'Applicants must be a U.S. citizen to be eligible for this role.',
    ), 'refuses');
    assert.equal(readPostingSponsorship(
      'We consider applicants regardless of citizenship or national origin.',
    ), 'unstated');
  });

  test('a saved recruiting period is retained and counts as targeting', () => {
    const targeting = normalizeTargeting({ primary_period: 'summer-2027' });
    assert.equal(targeting.primary_period, 'summer-2027');
    assert.equal(targeting.backup_period, null);
    assert.equal(hasTargeting(targeting), true);
  });

  test('Summer 2027 targeting rejects an explicit Fall 2026 title', () => {
    assert.equal(recommendationTargetingEligible(
      { title: 'Software Engineer Intern (Fall 2026) - Austin, TX' },
      SUMMER_2027,
      'Bachelor of Science in Computer Science',
    ), false);
  });

  test('the primary and backup periods are both allowed', () => {
    const targeting = normalizeTargeting({
      ...SUMMER_2027,
      backup_period: 'fall-2026',
    });
    assert.equal(recommendationTargetingEligible(
      { title: 'Software Engineer Intern (Fall 2026)' },
      targeting,
      'Bachelor of Science in Computer Science',
    ), true);
  });

  test('a title with no explicit season stays visible', () => {
    assert.equal(recommendationTargetingEligible(
      { title: 'Campus Software Engineer Intern' },
      SUMMER_2027,
      'Bachelor of Science in Computer Science',
    ), true);
  });

  test('an ambiguous two-season title stays visible', () => {
    assert.equal(recommendationTargetingEligible(
      { title: 'Intern, Fall 2026 cohort with Summer 2027 start' },
      SUMMER_2027,
      'Bachelor of Science in Computer Science',
    ), true);
  });

  test('generic developer overlap cannot admit an unselected quant role', () => {
    assert.equal(recommendationTargetingEligible(
      { title: 'Quantitative Developer Intern - Summer 2027' },
      SUMMER_2027,
      'Bachelor of Science in Computer Science',
    ), false);
  });

  test('selecting quant makes the same role eligible', () => {
    const targeting = normalizeTargeting({
      ...SUMMER_2027,
      categories: [...SUMMER_2027.categories, 'quant-trading'],
    });
    assert.equal(recommendationTargetingEligible(
      { title: 'Quantitative Developer Intern - Summer 2027' },
      targeting,
      'Bachelor of Science in Computer Science',
    ), true);
  });

  test('an unselected research track does not ride through the data category', () => {
    assert.equal(recommendationTargetingEligible(
      { title: 'Machine Learning Researcher - Intern' },
      SUMMER_2027,
      'Bachelor of Science in Computer Science',
    ), false);
  });

  test('an explicit PhD internship is rejected for a bachelors candidate', () => {
    assert.equal(recommendationTargetingEligible(
      { title: 'PhD GenAI Research Scientist Intern' },
      normalizeTargeting({ ...SUMMER_2027, categories: [...SUMMER_2027.categories, 'research'] }),
      'Bachelor of Science in Computer Science',
    ), false);
  });

  test('a BS, MS, or PhD title accepts a bachelors candidate', () => {
    assert.equal(recommendationTargetingEligible(
      { title: 'Research Intern (BS/MS/PhD)' },
      normalizeTargeting({ ...SUMMER_2027, categories: [...SUMMER_2027.categories, 'research'] }),
      'B.S. Computer Science',
    ), true);
  });

  test('unknown targeting or degree facts never hide a role', () => {
    assert.equal(recommendationTargetingEligible(
      { title: 'PhD Research Intern, Fall 2026' },
      normalizeTargeting(null),
      null,
    ), true);
  });

  test('the live August 13 feed removes every observed targeting contradiction', () => {
    const titles = [
      'Product Management Intern (Summer 2027)',
      'Software Engineer Intern - Summer 2027',
      '2027 Software Engineer Intern',
      'Software Engineer Intern (Fall 2026) - Austin, TX',
      '2027 Internship - Software Engineer',
      'Campus Data Engineer (Intern)',
      'Campus Software Engineer (Intern)',
      'Quantitative Developer Intern - Summer 2027',
      'Software Engineer Intern - Python, Summer 2027',
      'Software Engineer Intern - Full Stack Web, Summer 2027',
      'Software Engineer Intern - C++, Summer 2027',
      'Campus UI Software Engineer (Intern)',
      'PhD GenAI Research Scientist Intern',
      'Data Science Intern (Customer Success)',
      'Summer Intern 2027 - Software Developer',
      'Machine Learning Researcher - Intern',
      'Quantitative Developer Intern',
      'Software Engineer Intern - C# .NET Desktop, Summer 2027',
    ];
    const hidden = titles.filter((title) => !recommendationTargetingEligible(
      { title },
      SUMMER_2027,
      'Bachelor of Science in Computer Science',
    ));
    assert.deepEqual(hidden, [
      'Software Engineer Intern (Fall 2026) - Austin, TX',
      'Quantitative Developer Intern - Summer 2027',
      'PhD GenAI Research Scientist Intern',
      'Machine Learning Researcher - Intern',
      'Quantitative Developer Intern',
    ]);
  });
});
