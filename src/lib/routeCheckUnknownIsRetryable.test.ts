import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApplicantEmailRegenerationRequiredError,
  ApplicantEmailRouteUnknownError,
  resolveFrozenApplicantEmail,
} from './applicationEmail';

/* A CHECK THAT COULD NOT RUN IS NOT A VERDICT.
 *
 * resolveFrozenApplicantEmail caught the deliverability probe with `.catch(() => null)` and then
 * treated the null exactly like a definitive `deliverable: false`: both raised
 * ApplicantEmailRegenerationRequiredError, whose sentence to the applicant is "This application
 * must be regenerated before submission because its stored Litos email no longer matches the
 * active inbound email route."
 *
 * That is a permanent verdict about HER PACKET, published in response to a transient failure of a
 * network probe about the ROUTE - something regenerating the packet cannot change. Measured live
 * 2026-09-04 on Exa packet 73768339: its packet audit, which resolves through this same function,
 * passed minutes before the send refused with that sentence, and the dashboard offered no control
 * that could act on it.
 *
 * The two cases now raise different errors, and the runner gives them opposite instructions.
 */

const SPEC = {
  // Shaped as isAliasAddress requires: app-<10 hex>-<12 hex>.
  _applicant_email: {
    address: 'app-1234567890-abcdef123456@example.com',
    source: 'litos_alias',
    tracked: true,
    reason: 'deliverable',
    decided_at: '2026-09-04T00:00:00.000Z',
  },
  _contact: { email: 'someone@usc.edu' },
};

function resolve(deliverability: () => Promise<never> | Promise<any>) {
  return resolveFrozenApplicantEmail(
    { userId: 'user-1', applicationId: 'app-1', spec: SPEC },
    { deliverability, aliasActive: async () => true },
  );
}

test('a deliverability probe that THROWS is retryable, not a regeneration hold', async () => {
  await assert.rejects(
    () => resolve(async () => { throw new Error('socket hang up'); }),
    (error: unknown) => {
      assert.ok(
        error instanceof ApplicantEmailRouteUnknownError,
        `expected ApplicantEmailRouteUnknownError, got ${(error as Error)?.name}`,
      );
      assert.ok(
        !(error instanceof ApplicantEmailRegenerationRequiredError),
        'a probe that could not run must never read as "regenerate this packet"',
      );
      return true;
    },
  );
});

test('a probe that RAN and said no is still a regeneration hold', async () => {
  await assert.rejects(
    () => resolve(async () => ({
      deliverable: false,
      domain: null,
      reason: 'inbound_route_missing',
      mx_hosts: [],
      mx_provider: 'unknown',
      mx_provider_agrees: false,
      resend_domain_status: null,
      resend_receiving_status: null,
      inbound_route_configured: false,
      checked_at: '2026-09-04T00:00:00.000Z',
    })),
    (error: unknown) => {
      assert.ok(
        error instanceof ApplicantEmailRegenerationRequiredError,
        `a definitive refusal must stay a regeneration hold, got ${(error as Error)?.name}`,
      );
      // And it names what the probe actually said, rather than a generic failure token.
      assert.match((error as Error).message, /inbound_route_missing/);
      return true;
    },
  );
});

test('the two errors carry distinct codes, so callers can tell them apart', () => {
  const retryable = new ApplicantEmailRouteUnknownError('probe timed out');
  const permanent = new ApplicantEmailRegenerationRequiredError('alias is stale');
  assert.equal(retryable.code, 'applicant_email_route_unknown');
  assert.equal(permanent.code, 'applicant_email_regeneration_required');
  assert.notEqual(retryable.code, permanent.code);
  // The retryable sentence must not tell her to rebuild anything.
  assert.doesNotMatch(retryable.message, /regenerat/i);
});
