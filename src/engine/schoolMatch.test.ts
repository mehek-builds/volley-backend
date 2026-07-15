import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAlumniMatch, aliasGroupOf } from './schoolMatch';

test('USC abbreviation matches the full "University of Southern California"', () => {
  assert.equal(isAlumniMatch('USC', ['University of Southern California']), true);
  assert.equal(isAlumniMatch('University of Southern California', ['USC']), true);
});

test('USC matches even when the contact school has extra school/college qualifiers', () => {
  assert.equal(isAlumniMatch('USC', ['USC Marshall School of Business']), true);
  assert.equal(isAlumniMatch('University of Southern California', ['USC Viterbi School of Engineering']), true);
});

test('different schools do not match', () => {
  assert.equal(isAlumniMatch('Stanford', ['Harvard']), false);
  assert.equal(isAlumniMatch('Stanford University', ['Harvard University']), false);
});

test('same UC system but different campuses do not match', () => {
  // Berkeley vs UCLA share "university of california" only - must not be treated as alumni.
  assert.equal(isAlumniMatch('UC Berkeley', ['University of California, Los Angeles']), false);
  assert.equal(isAlumniMatch('University of California, Berkeley', ['UCLA']), false);
});

test('empty / whitespace / missing user school never matches', () => {
  assert.equal(isAlumniMatch('', ['University of Southern California']), false);
  assert.equal(isAlumniMatch('   ', ['USC']), false);
  assert.equal(isAlumniMatch(null, ['USC']), false);
  assert.equal(isAlumniMatch(undefined, ['USC']), false);
});

test('no candidate schools never matches', () => {
  assert.equal(isAlumniMatch('USC', []), false);
  assert.equal(isAlumniMatch('USC', [null, undefined, '']), false);
});

test('a filler-only user school (no real institution token) never matches', () => {
  assert.equal(isAlumniMatch('University', ['University of Michigan']), false);
});

test('light spelling / punctuation differences of the same school match', () => {
  assert.equal(isAlumniMatch('Stanford University', ['Stanford']), true);
  assert.equal(isAlumniMatch('M.I.T.', ['Massachusetts Institute of Technology']), true);
  assert.equal(isAlumniMatch('New York University', ['NYU']), true);
});

test('matches the correct alum among several candidate schools', () => {
  assert.equal(
    isAlumniMatch('USC', ['Harvard University', 'University of Southern California', 'Boston College']),
    true,
  );
  assert.equal(isAlumniMatch('USC', ['Harvard University', 'Boston College']), false);
});

test('different schools sharing one token do NOT match (single-token false positives)', () => {
  // Extra distinctive token on one side ("State" / "Louis" / "New") must break the match.
  assert.equal(isAlumniMatch('University of Michigan', ['Michigan State University']), false);
  assert.equal(isAlumniMatch('Michigan State University', ['University of Michigan']), false);
  assert.equal(isAlumniMatch('University of Washington', ['Washington University in St. Louis']), false);
  assert.equal(isAlumniMatch('York University', ['New York University']), false);
  // Same name token but a different institution TYPE.
  assert.equal(isAlumniMatch('Boston University', ['Boston College']), false);
  assert.equal(isAlumniMatch('Columbia University', ['Columbia College Chicago']), false);
  // Same name token + type but opposite word order (two genuinely different schools).
  assert.equal(isAlumniMatch('University of Miami', ['Miami University']), false);
  assert.equal(isAlumniMatch('Miami University', ['University of Miami']), false);
});

test('bare distinctive name still matches its fuller form (no over-correction)', () => {
  assert.equal(isAlumniMatch('Michigan', ['University of Michigan']), true);
  assert.equal(isAlumniMatch('Boston University', ['Boston University']), true);
  assert.equal(isAlumniMatch('Dartmouth', ['Dartmouth College']), true);
});

test('aliasGroupOf resolves known variants to the same group and unknowns to null', () => {
  assert.equal(aliasGroupOf('USC'), aliasGroupOf('University of Southern California'));
  assert.notEqual(aliasGroupOf('USC'), aliasGroupOf('UCLA'));
  assert.equal(aliasGroupOf('Some Community College Nobody Aliased'), null);
});
