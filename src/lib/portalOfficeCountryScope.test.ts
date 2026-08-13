import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { postingCountryCodeFromJobContext, postingCountryFromJobContext } from './jobLocation';
import { resolveKnownAnswer, type ApplicationProfileLike } from './questionDiscovery';

/* ONE LABEL, THREE STORED PACKETS, TWO ANSWERS.
 *
 * "will you require sponsorship for work authorization in the future?" is stored three times for
 * account a18f774b, all three at Jump Trading, all three the same string:
 *
 *   0a88e20f  2026-08-05 15:36  answer "Yes"
 *   f4f278d2  2026-08-13 10:48  answer ""     <- required, blocked the send
 *   928e0c9a  2026-08-13 10:50  answer ""     <- required, blocked the send
 *
 * NOT A DUPLICATE CONTROL AND NOT A CACHE. The label is discovered once per packet. What differs is
 * the posting's structured location, which is the only other input workEligibilityAnswer reads:
 *
 *   0a88e20f  job_context.portal_country absent, location "Chicago; New York"
 *   f4f278d2  job_context.portal_country "Chicago, IL, United States | New York, NY, United States"
 *   928e0c9a  the same
 *
 * Greenhouse publishes portal_country as the posting's OFFICE LOCATIONS. Splitting that on the comma
 * and reading each fragment as a country field turns "IL" into Israel, so an American posting
 * produced {US, IL}, the conflict was refused, no country scope came out, and every work-eligibility
 * question on both packets was held. The applicant's answer is "Yes" and it is truthful and stored;
 * nothing was copied between controls to obtain it, and nothing here does.
 */
const SPONSORSHIP_LABEL = 'will you require sponsorship for work authorization in the future?';

/* Exactly what the loader hands the resolver for this account: the two legacy scalars, and no
 * scoped per-country list (application_profile.work_eligibility_by_country is NULL, which
 * countryEligibilityForRead turns into undefined). */
const APPLICANT: ApplicationProfileLike = {
  work_authorized: true,
  needs_sponsorship: true,
  work_eligibility_by_country: undefined,
};

function resolvedSponsorshipAnswer(jobContext: Record<string, unknown>) {
  return resolveKnownAnswer(
    SPONSORSHIP_LABEL,
    'text',
    APPLICANT,
    undefined,
    postingCountryFromJobContext(jobContext),
    postingCountryCodeFromJobContext(jobContext),
  );
}

const JUMP_OFFICES = 'Chicago, IL, United States | New York, NY, United States';

describe('a posting whose offices are published as locations', () => {
  test('all three stored instances of the sponsorship label carry the truthful answer', () => {
    for (const [packet, jobContext] of [
      ['0a88e20f 2026-08-05', { company: 'Jump Trading', location: 'Chicago; New York' }],
      ['f4f278d2 2026-08-13', { company: 'Jump Trading', location: 'Chicago; New York', portal_country: JUMP_OFFICES }],
      ['928e0c9a 2026-08-13', { company: 'Jump Trading', location: 'Chicago; New York', portal_country: JUMP_OFFICES }],
    ] as Array<[string, Record<string, unknown>]>) {
      assert.equal(postingCountryCodeFromJobContext(jobContext), 'US', packet);
      assert.deepEqual(resolvedSponsorshipAnswer(jobContext), { value: 'Yes' }, packet);
    }
  });

  test('the state abbreviation is a subdivision, not the country it shares a code with', () => {
    // IL Israel, MA Morocco, DE Germany, IN India, CO Colombia, PA Panama: twenty-two US state
    // codes are also ISO country codes, and every one of them used to refuse its own posting.
    for (const offices of [
      'Chicago, IL, United States',
      'Boston, MA, United States',
      'Wilmington, DE, United States',
      'Indianapolis, IN, United States',
      'Denver, CO, United States',
      'Philadelphia, PA, United States',
      'Toronto, ON, Canada',
    ]) {
      const country = postingCountryFromJobContext({ portal_country: offices });
      assert.notEqual(country, 'unknown', offices);
    }
    assert.equal(postingCountryCodeFromJobContext({ portal_country: 'Toronto, ON, Canada' }), 'CA');
  });
});

describe('what must still refuse to name one country', () => {
  test('a genuinely multi-country posting is held rather than read as American', () => {
    for (const offices of [
      `${JUMP_OFFICES} | London, United Kingdom`,
      `${JUMP_OFFICES} | Tel Aviv, IL`,
      'Berlin, Germany | Chicago, IL, United States',
    ]) {
      const jobContext = { portal_country: offices };
      assert.equal(postingCountryCodeFromJobContext(jobContext), undefined, offices);
      const held = resolvedSponsorshipAnswer(jobContext);
      assert.ok(held && 'skipReason' in held, `must hold: ${offices}`);
    }
  });

  test('a country FIELD still reads its bare ISO codes as countries', () => {
    // The premise this rule narrows is "IN means India and cannot mean Indiana". It still holds
    // wherever the portal published a country rather than a place hierarchy.
    assert.equal(postingCountryCodeFromJobContext({ portal_country: 'IL' }), 'IL');
    assert.equal(postingCountryCodeFromJobContext({ portal_country: 'IN' }), 'IN');
    assert.equal(postingCountryCodeFromJobContext({ portal_country: 'Tel Aviv, IL' }), 'IL');
    // Two bare codes are two countries however they are punctuated, so the posting is refused.
    for (const offices of ['US | IN', 'US / IN', 'US, IN']) {
      assert.equal(postingCountryCodeFromJobContext({ portal_country: offices }), undefined, offices);
    }
  });

  test('an unauthorized applicant is never answered from a US scope she does not have', () => {
    const notAuthorized: ApplicationProfileLike = {
      work_authorized: false,
      needs_sponsorship: false,
      work_eligibility_by_country: undefined,
    };
    const held = resolveKnownAnswer(
      SPONSORSHIP_LABEL,
      'text',
      notAuthorized,
      undefined,
      postingCountryFromJobContext({ portal_country: JUMP_OFFICES }),
      postingCountryCodeFromJobContext({ portal_country: JUMP_OFFICES }),
    );
    assert.ok(held && 'skipReason' in held, 'a profile describing nobody must still be handed back');
  });
});
