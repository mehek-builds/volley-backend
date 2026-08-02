import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyParsedProfilePatch,
  normalizeEditableList,
  parsedProfilePatchSchema,
} from './profile';

test('the parsed profile correction accepts the safe editable fields', () => {
  const result = parsedProfilePatchSchema.safeParse({
    full_name: 'Mehek Mandal',
    phone: '+1 213 555 0100',
    school: 'University of Southern California',
    degree: 'BS Computer Science and Business Administration',
    grad_date: 'May 2027',
    objective: 'Builder interested in investing and technology.',
    skills: ['Python', 'Financial modeling'],
    target_roles: [
      'Private Equity Associate',
      'Growth Equity Analyst',
      'Venture Capital Analyst',
      'Investment Banking Analyst',
      'Strategy Associate',
    ],
  });

  assert.equal(result.success, true);
});

test('any real role title is valid, including private equity', () => {
  const result = parsedProfilePatchSchema.safeParse({
    target_roles: [
      'Private Equity Associate',
      'Search Fund Intern',
      'Chief of Staff',
      'Quantitative Researcher',
      'Technical Program Manager',
    ],
  });
  assert.equal(result.success, true);
});

test('target roles remain a complete five-title targeting set', () => {
  assert.equal(parsedProfilePatchSchema.safeParse({ target_roles: ['Private Equity Associate'] }).success, false);
  assert.equal(parsedProfilePatchSchema.safeParse({ target_roles: Array.from({ length: 6 }, (_, i) => `Role ${i}`) }).success, false);
  assert.equal(parsedProfilePatchSchema.safeParse({ target_roles: ['Role 1', 'Role 2', 'Role 3', 'Role 4', 'role 1'] }).success, false);
});

test('account and structured work fields cannot be changed through the parsed profile route', () => {
  assert.equal(parsedProfilePatchSchema.safeParse({ email: 'other@example.com' }).success, false);
  assert.equal(parsedProfilePatchSchema.safeParse({ experience: [] }).success, false);
  assert.equal(parsedProfilePatchSchema.safeParse({ grad_year: 2035 }).success, false);
});

test('skills and objective may be deliberately cleared', () => {
  const result = parsedProfilePatchSchema.safeParse({ skills: [], objective: '' });
  assert.equal(result.success, true);
});

test('editable lists are trimmed and deduplicated without role taxonomy filtering', () => {
  assert.deepEqual(
    normalizeEditableList([' Private Equity ', 'private equity', 'Chief of Staff']),
    ['Private Equity', 'Chief of Staff'],
  );
});

test('a profile patch preserves unsent fields and keeps graduation year in sync', () => {
  const next = applyParsedProfilePatch(
    { email: 'verified@example.com', school: 'USC', grad_year: 2026, skills: ['Old'] },
    { grad_date: 'August 2024 - May 2028', skills: [' Python ', 'python', 'SQL'] },
  );

  assert.equal(next.email, 'verified@example.com');
  assert.equal(next.school, 'USC');
  assert.equal(next.grad_year, 2028);
  assert.deepEqual(next.skills, ['Python', 'SQL']);
});

test('clearing graduation text also clears the derived eligibility year', () => {
  const next = applyParsedProfilePatch({ grad_date: 'May 2027', grad_year: 2027 }, { grad_date: '' });

  assert.equal(next.grad_date, '');
  assert.equal('grad_year' in next, false);
});
