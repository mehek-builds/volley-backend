import assert from 'node:assert/strict';
import test from 'node:test';

import { asksForUsState, isUsState, usStateScopeSkipReason } from './residenceScope';
import { resolveKnownAnswer } from './questionDiscovery';

/* THE PIN. DV Trading, measured 2026-08-09: "If applicable, which US state do you reside in?" is an
 * optional fifty-state select, and Litos put "Dubai" into it. Nothing wrong reached the employer
 * only because no option matched, which is luck rather than a safeguard, and every loosening of the
 * matcher shortens the distance between that answer and a state she has never lived in. */
test('a residence outside the United States never resolves to a US state', () => {
  const label = 'If applicable, which US state do you reside in?';
  const resolved = resolveKnownAnswer(label, 'text', { address_state: 'Dubai' }, undefined);
  assert.ok(resolved && 'skipReason' in resolved, `expected a skipReason, got ${JSON.stringify(resolved)}`);
  assert.match(resolved.skipReason, /US state/);
});

test('the same question is answered normally when she does live in a state', () => {
  const label = 'If applicable, which US state do you reside in?';
  assert.deepEqual(resolveKnownAnswer(label, 'text', { address_state: 'California' }, undefined), { value: 'California' });
  assert.deepEqual(resolveKnownAnswer(label, 'text', { address_state: 'CA' }, undefined), { value: 'CA' });
});

test('an unscoped state or province field still takes her region, whatever country it is in', () => {
  // The generic address field on every form. Refusing here would blank a field she can answer.
  assert.equal(usStateScopeSkipReason('State/Province', 'Dubai'), null);
  assert.equal(usStateScopeSkipReason('In which state do you currently reside?', 'Dubai'), null);
  assert.equal(usStateScopeSkipReason('State of residence', 'Ontario'), null);
});

test('the US scope is read off the question, in the wordings employers use', () => {
  assert.equal(asksForUsState('If applicable, which US state do you reside in?'), true);
  assert.equal(asksForUsState('Which U.S. state do you live in?'), true);
  assert.equal(asksForUsState('Please select your state in the United States'), true);
  assert.equal(asksForUsState('State/Province'), false);
  // A long legal sentence that names the country for another reason is not a state question.
  assert.equal(
    asksForUsState('Are you legally authorized to work in the United States without sponsorship, and in what capacity?'),
    false,
  );
});

test('membership is the fifty states plus DC, by name or postal code, and nothing else', () => {
  assert.equal(isUsState('California'), true);
  assert.equal(isUsState('ca'), true);
  assert.equal(isUsState('District of Columbia'), true);
  assert.equal(isUsState('Washington D.C.'), true);
  assert.equal(isUsState('Dubai'), false);
  assert.equal(isUsState('Ontario'), false);
  assert.equal(isUsState('United Arab Emirates'), false);
  assert.equal(isUsState(''), false);
  assert.equal(isUsState(undefined), false);
});
