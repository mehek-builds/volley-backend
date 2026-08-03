import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  academicSeedFrom,
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

/* The resume editor sends `languages` on EVERY save, including as an empty array, and this schema
 * is .strict(). So the field is not optional in practice: drop it or rename it and Zod answers
 * "Unrecognized key(s) in object: 'languages'" and every student save 400s, no matter what else
 * the payload got right. The ISSUE-020 deploy on 2026-08-03 only missed that outage through deploy
 * ordering. These cases exist so the next person to touch the field breaks a test instead. */
test('an empty languages array parses, because the resume editor sends one on every save', () => {
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: [] }).success, true);
});

test('a spoken language list the student corrected parses', () => {
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: ['Hindi', 'Arabic'] }).success, true);
});

// The payload shape the editor actually PUTs, languages included. The single-field cases above
// would still pass if the strict schema rejected this combination, so pin the real one too.
test('the whole editor save payload parses with languages alongside every other field', () => {
  const result = parsedProfilePatchSchema.safeParse({
    full_name: 'Mehek Mandal',
    phone: '+1 213 555 0100',
    school: 'University of Southern California',
    degree: 'BS Computer Science and Business Administration',
    grad_date: 'May 2027',
    objective: 'Builder interested in investing and technology.',
    skills: ['Python', 'Financial modeling'],
    languages: [],
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

test('a blank language is rejected rather than stored as whitespace', () => {
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: [' '] }).success, false);
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: ['a'.repeat(81)] }).success, false);
});

test('a languages list past thirty is a parse failure, not a polyglot', () => {
  const thirty = Array.from({ length: 30 }, (_, i) => `Language ${i}`);
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: thirty }).success, true);
  assert.equal(
    parsedProfilePatchSchema.safeParse({ languages: [...thirty, 'Language 30'] }).success,
    false,
  );
});

test('a languages correction is trimmed and deduplicated like every other editable list', () => {
  const next = applyParsedProfilePatch(
    { school: 'USC', languages: ['Old'] },
    { languages: [' Hindi ', 'hindi', 'Arabic'] },
  );

  assert.deepEqual(next.languages, ['Hindi', 'Arabic']);
  assert.deepEqual(next.languages, normalizeEditableList([' Hindi ', 'hindi', 'Arabic']));
  assert.equal(next.school, 'USC');
});

/* A resume line is not a fluency claim. Languages corrected here land in parsed_json only;
 * application_profile.languages stays the student's own declaration from onboarding, and the one
 * writer this route has into that table is the academic seed, which cannot carry the field. */
test('a languages correction never becomes a declared fluency on application_profile', () => {
  const next = applyParsedProfilePatch({}, { languages: ['Hindi'] });
  assert.deepEqual(Object.keys(next), ['languages']);

  // gpa is left out only because it is encrypted on the way in and this case is about the shape of
  // the seed, not the ciphertext. The parse being seeded from carries languages, as a real one does.
  const parseWithLanguages = { gpa_scale: '4.0', major: 'Computer Science', languages: ['Hindi'] };
  const seed = academicSeedFrom(parseWithLanguages, undefined);
  assert.deepEqual(Object.keys(seed).sort(), ['gpa_scale', 'major']);
});
