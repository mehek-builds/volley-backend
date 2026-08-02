import { describe, test } from 'node:test';
import assert from 'node:assert';
import { matchingRoleType, normalizeTargeting, preferenceFit, roleTypePattern, targetTitleTerms } from './jobPreferences';

describe('job preferences', () => {
  test('normalizes saved account preferences without trusting jsonb values', () => {
    assert.deepStrictEqual(normalizeTargeting({
      categories: ['product'],
      titles: [' Product Manager ', 4],
      role_types: ['internship', 'contract'],
      locations: ['Dubai', 'London'],
      remote_only: true,
    }), {
      categories: ['product'],
      titles: ['Product Manager'],
      role_types: ['internship'],
      locations: ['Dubai', 'London'],
      remote_only: true,
    });
  });

  test('selected categories expand to the real title vocabulary used by postings', () => {
    const terms = targetTitleTerms(normalizeTargeting({ categories: ['software-engineering'] }));
    assert.ok(terms.includes('frontend'));
    assert.ok(terms.includes('backend'));
    assert.ok(terms.includes('software'));
  });

  test('multi-word titles survive an employer inserting the season into its title', () => {
    const terms = targetTitleTerms(normalizeTargeting({ titles: ['Investment Banking Analyst'] }));
    assert.ok(terms.includes('investment banking'));
    assert.ok(terms.includes('banking analyst'));
  });

  test('role types classify internships, co-ops, new-grad roles and ordinary full-time jobs', () => {
    assert.equal(matchingRoleType({ title: 'Product Management Intern' }, ['internship']), 'internship');
    assert.equal(matchingRoleType({ title: 'Software Engineer Co-op' }, ['co-op']), 'co-op');
    assert.equal(matchingRoleType({ title: 'New Graduate Data Analyst' }, ['new-grad']), 'new-grad');
    assert.equal(matchingRoleType({ title: 'Product Manager', employment_type: 'Full-time' }, ['full-time']), 'full-time');
    assert.equal(matchingRoleType({ title: 'Software Engineering Intern', employment_type: 'Full-time' }, ['full-time']), null);
    assert.equal(matchingRoleType({ title: 'Part-time Product Manager' }, ['full-time']), null);
  });

  test('the SQL role pattern covers every non-full-time selected type', () => {
    const pattern = roleTypePattern(['internship', 'co-op', 'new-grad']);
    assert.ok(pattern);
    assert.match('Product Intern', new RegExp(pattern!, 'i'));
    assert.match('Engineering Co-op', new RegExp(pattern!, 'i'));
    assert.match('New Graduate Analyst', new RegExp(pattern!, 'i'));
  });

  test('saved titles outrank a generic category match and explain the result', () => {
    const targeting = normalizeTargeting({
      categories: ['product'],
      titles: ['Product Manager'],
      role_types: ['full-time'],
      locations: ['Dubai'],
    });
    const exact = preferenceFit({ title: 'Product Manager', location: 'Dubai', employment_type: 'Full-time' }, targeting);
    const broad = preferenceFit({ title: 'Product Operations Analyst', location: 'Dubai', employment_type: 'Full-time' }, targeting);
    assert.ok(exact.score > broad.score);
    assert.ok(exact.reasons.includes('Product Manager'));
    assert.ok(exact.reasons.includes('Dubai'));
  });
});
