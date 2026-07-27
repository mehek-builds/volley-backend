import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  standingConsentEligibility,
  mayChangeStandingConsent,
  MIN_REVIEWED_SUBMITS,
} from './standingConsent';

const at = (n: number) => standingConsentEligibility(n);

describe('standingConsentEligibility', () => {
  test('a new account cannot hand over the click', () => {
    const e = at(0);
    assert.equal(e.eligible, false);
    assert.equal(e.remaining, MIN_REVIEWED_SUBMITS);
  });

  test('eligibility arrives exactly at the threshold, not before', () => {
    assert.equal(at(MIN_REVIEWED_SUBMITS - 1).eligible, false);
    assert.equal(at(MIN_REVIEWED_SUBMITS).eligible, true);
  });

  test('remaining never goes negative once past the threshold', () => {
    assert.equal(at(MIN_REVIEWED_SUBMITS + 50).remaining, 0);
  });

  test('garbage counts are treated as zero rather than trusted', () => {
    for (const value of [Number.NaN, -5, Infinity]) {
      assert.equal(standingConsentEligibility(value as number).eligible, false);
    }
  });
});

describe('mayChangeStandingConsent', () => {
  test('an ineligible student cannot enable it', () => {
    const result = mayChangeStandingConsent({ enabling: true, eligibility: at(0) });
    assert.equal(result.allowed, false);
  });

  test('the refusal says how many are left, not just no', () => {
    const result = mayChangeStandingConsent({ enabling: true, eligibility: at(1) });
    assert.equal(result.allowed, false);
    assert.match(result.allowed === false ? result.reason : '', /2 to go/);
  });

  test('an eligible student can enable it', () => {
    assert.equal(mayChangeStandingConsent({ enabling: true, eligibility: at(MIN_REVIEWED_SUBMITS) }).allowed, true);
  });

  test('TURNING IT OFF IS ALWAYS ALLOWED, from any state', () => {
    // A safety gate the student cannot re-arm is not a safety gate.
    for (const count of [0, 1, MIN_REVIEWED_SUBMITS, 99]) {
      assert.equal(mayChangeStandingConsent({ enabling: false, eligibility: at(count) }).allowed, true);
    }
  });
});

/**
 * The gate has to hold at every WRITER, not just in the pure function.
 *
 * Pre-merge review found POST /onboarding/complete wrote automatic_submission_enabled straight from
 * the request body with no check, and the /start finish screen shipped a live checkbox wired to it,
 * so a brand-new student turned unattended submission on at reviewed_submits = 0. Every unit test
 * in this file passed with that hole wide open, which is exactly why this one reads the route
 * source: a third writer must fail CI rather than ship.
 */
describe('every writer of the setting goes through the gate', () => {
  const routes = readFileSync(path.join(__dirname, '..', 'routes', 'onboarding.ts'), 'utf8');

  test('there is exactly one gate helper, and it is the only eligibility caller', () => {
    assert.match(routes, /async function gatedAutomationConsent\(/);
    // mayChangeStandingConsent must be called in exactly one place: inside the helper.
    const calls = routes.match(/mayChangeStandingConsent\(/g) ?? [];
    assert.equal(calls.length, 1, 'the rule must live in one place, or it will be skipped again');
  });

  test('every automationConsentValues write is preceded by the gate', () => {
    const writes = routes.split('automationConsentValues(');
    // First chunk is the import + everything before the first call site.
    for (let i = 1; i < writes.length; i++) {
      const before = writes.slice(0, i).join('automationConsentValues(');
      assert.ok(
        before.lastIndexOf('gatedAutomationConsent(') > before.lastIndexOf('fastify.'),
        'a consent write is not preceded by the gate within its own handler',
      );
    }
  });

  test('the direct column write in PUT /onboarding/automation is gated too', () => {
    const handler = routes.slice(routes.indexOf("put('/onboarding/automation'"));
    assert.ok(
      handler.indexOf('gatedAutomationConsent(') < handler.indexOf('patch.automatic_submission_enabled ='),
      'the gate must run before the patch is built',
    );
  });
});
