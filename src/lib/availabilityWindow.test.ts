import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  availabilityWindowForPosting,
  formatWindowDate,
  formatWindowRange,
  readAvailabilityWindow,
  readCycle,
  type AvailabilityWindowFacts,
} from './availabilityWindow';
import { resolveKnownAnswer, type ApplicationProfileLike } from './questionDiscovery';

/* THE ONE RULE THESE TESTS EXIST TO PIN.
 *
 * An unanswered availability question costs one manual entry. A wrong one is a commitment to an
 * employer that the applicant never made and may be held to. So every case below that is not an
 * exact, in-scope, unexpired match asserts that NOTHING is filled - and the answering case asserts
 * the exact string, because "answers something" is not the property that matters.
 */

/* Dates are built relative to today rather than hardcoded, so these tests cannot start passing or
 * failing for the calendar's reasons. The window sits two years out, which is always ahead of both
 * the expiry check and the spent-window check. */
const YEAR = new Date().getUTCFullYear() + 2;
const CYCLE = `Summer ${YEAR}`;
const NEXT_CYCLE = `Summer ${YEAR + 1}`;

const WINDOW: AvailabilityWindowFacts = {
  availability_window_start: `${YEAR}-06-01`,
  availability_window_end: `${YEAR}-08-20`,
  availability_cycle: CYCLE,
  availability_valid_through: `${YEAR}-05-01`,
};

/* The legacy pair, exactly as it sits on the owner's production row. Nothing in this branch may
 * read it, and the questionDiscovery test named "legacy availability facts never authorize a new
 * date, season, duration, or cadence commitment" is the other half of this guarantee. */
const LEGACY: ApplicationProfileLike = {
  availability_date: 'June 1, 2026',
  availability_term: 'Available full-time for 12 weeks between June and August 2026',
};

const IN_SCOPE_JD = `Software Engineer Intern (${CYCLE})`;
const OUT_OF_SCOPE_JD = `Software Engineer Intern (${NEXT_CYCLE})`;

const DATE_QUESTIONS = [
  'what dates are you available for an internship?',
  'when do you plan on ending your internship?',
  'when are you able to join us as an intern?',
  'when can you start?',
  'earliest start date',
] as const;

function resolve(label: string, profile: ApplicationProfileLike, jdText: string | undefined) {
  return resolveKnownAnswer(label, 'text', profile, jdText);
}

function assertLeftForHer(label: string, profile: ApplicationProfileLike, jdText: string | undefined, why: string) {
  const resolved = resolve(label, profile, jdText);
  assert.ok(resolved, `${why}: must be recognised, not dropped to the drafter - ${label}`);
  assert.ok('skipReason' in resolved, `${why}: must not be answered - ${label}`);
  assert.ok(resolved.skipReason.trim().length > 20, `${why}: must explain itself - ${label}`);
}

describe('the availability window model', () => {
  test('an empty profile is not a window', () => {
    assert.equal(readAvailabilityWindow({}, new Date()), null);
  });

  test('three of the four values is not a window either', () => {
    for (const missing of [
      'availability_window_start',
      'availability_window_end',
      'availability_cycle',
      'availability_valid_through',
    ] as const) {
      const partial = { ...WINDOW, [missing]: undefined };
      assert.equal(readAvailabilityWindow(partial, new Date()), null, `answered without ${missing}`);
    }
  });

  test('a lapsed declaration says nothing, however complete it is', () => {
    const lapsed = { ...WINDOW, availability_valid_through: `${YEAR - 4}-05-01` };
    assert.equal(readAvailabilityWindow(lapsed, new Date()), null);
  });

  test('the reuse-through date is inclusive and expires the following day', () => {
    const boundary = {
      ...WINDOW,
      availability_valid_through: `${YEAR}-05-20`,
    };
    assert.ok(readAvailabilityWindow(boundary, new Date(`${YEAR}-05-20T23:59:59Z`)));
    assert.equal(readAvailabilityWindow(boundary, new Date(`${YEAR}-05-21T00:00:00Z`)), null);
  });

  test('a window whose last day has already passed says nothing either', () => {
    const spent = {
      availability_window_start: `${YEAR - 4}-06-01`,
      availability_window_end: `${YEAR - 4}-08-20`,
      availability_cycle: `Summer ${YEAR - 4}`,
      // Generous expiry, spent window. The expiry check alone would let this through.
      availability_valid_through: `${YEAR}-05-01`,
    };
    assert.equal(readAvailabilityWindow(spent, new Date()), null);
  });

  test('a cycle from a different year than the window is a typo, not a declaration', () => {
    const mismatched = { ...WINDOW, availability_cycle: NEXT_CYCLE };
    assert.equal(readAvailabilityWindow(mismatched, new Date()), null);
  });

  test('a window that ends before it begins is refused rather than reordered', () => {
    const backwards = {
      ...WINDOW,
      availability_window_start: `${YEAR}-08-20`,
      availability_window_end: `${YEAR}-06-01`,
    };
    assert.equal(readAvailabilityWindow(backwards, new Date()), null);
  });

  test('only a real ISO date counts: free text and impossible days are refused', () => {
    for (const bad of ['June 2027', `${YEAR}/06/01`, `${YEAR}-02-31`, `${YEAR}-13-01`, '']) {
      assert.equal(
        readAvailabilityWindow({ ...WINDOW, availability_window_start: bad }, new Date()),
        null,
        `accepted ${JSON.stringify(bad)} as a start date`,
      );
    }
  });

  test('a complete, unexpired, coherent declaration reads back exactly as stored', () => {
    assert.deepEqual(readAvailabilityWindow(WINDOW, new Date()), {
      start: `${YEAR}-06-01`,
      end: `${YEAR}-08-20`,
      cycle: CYCLE,
      validThrough: `${YEAR}-05-01`,
    });
  });

  test('the posting has to name its own cycle before the window may speak for it', () => {
    assert.ok(availabilityWindowForPosting(WINDOW, IN_SCOPE_JD, new Date()));
    assert.equal(availabilityWindowForPosting(WINDOW, OUT_OF_SCOPE_JD, new Date()), null);
    // No season anywhere in the description: coverage cannot be established, so nothing is claimed.
    assert.equal(availabilityWindowForPosting(WINDOW, 'Backend Engineering Intern', new Date()), null);
    assert.equal(availabilityWindowForPosting(WINDOW, undefined, new Date()), null);
  });

  test('one rule reads the cycle, whichever side it is written on', () => {
    assert.equal(readCycle('SUMMER 2027 internship, applications open'), 'Summer 2027');
    assert.equal(readCycle('fall 2027'), 'Fall 2027');
    assert.equal(readCycle('Backend Intern'), null);
  });

  test('a date control gets ISO, everything else gets words', () => {
    assert.equal(formatWindowDate(`${YEAR}-06-01`, 'date'), `${YEAR}-06-01`);
    assert.equal(formatWindowDate(`${YEAR}-06-01`, 'text'), `June 1, ${YEAR}`);
    const window = readAvailabilityWindow(WINDOW, new Date())!;
    assert.equal(formatWindowRange(window, 'text'), `June 1, ${YEAR} to August 20, ${YEAR}`);
    // A native date picker holds one date; it gets the start, which is the value it can be asked for.
    assert.equal(formatWindowRange(window, 'date'), `${YEAR}-06-01`);
  });
});

describe('the resolver answers an availability question only from a window that covers the posting', () => {
  test('nothing stored: every date question comes back to her', () => {
    for (const label of DATE_QUESTIONS) assertLeftForHer(label, {}, IN_SCOPE_JD, 'empty profile');
  });

  test('the legacy fields alone still authorize nothing', () => {
    for (const label of DATE_QUESTIONS) assertLeftForHer(label, LEGACY, IN_SCOPE_JD, 'legacy only');
  });

  test('a stored window that covers the posting answers, with her own dates', () => {
    const profile = { ...WINDOW } as ApplicationProfileLike;
    assert.deepEqual(
      resolve('what dates are you available for an internship?', profile, IN_SCOPE_JD),
      { value: `June 1, ${YEAR} to August 20, ${YEAR}` },
    );
    assert.deepEqual(
      resolve('when do you plan on ending your internship?', profile, IN_SCOPE_JD),
      { value: `August 20, ${YEAR}` },
    );
    assert.deepEqual(
      resolve('when are you able to join us as an intern?', profile, IN_SCOPE_JD),
      { value: `June 1, ${YEAR}` },
    );
    assert.deepEqual(resolve('when can you start?', profile, IN_SCOPE_JD), { value: `June 1, ${YEAR}` });
    assert.deepEqual(resolve('earliest start date', profile, IN_SCOPE_JD), { value: `June 1, ${YEAR}` });
    assert.deepEqual(
      resolveKnownAnswer('earliest start date', 'date', profile, IN_SCOPE_JD),
      { value: `${YEAR}-06-01` },
    );
  });

  test('a stored window for a DIFFERENT cycle answers nothing at all', () => {
    for (const label of DATE_QUESTIONS) {
      assertLeftForHer(label, { ...WINDOW }, OUT_OF_SCOPE_JD, 'out of scope cycle');
    }
  });

  test('a posting that never names a cycle answers nothing, even with a live window', () => {
    for (const label of DATE_QUESTIONS) {
      assertLeftForHer(label, { ...WINDOW }, 'Backend Engineering Intern', 'unscoped posting');
    }
  });

  test('a lapsed window answers nothing, on the posting it was written for', () => {
    const lapsed = { ...WINDOW, availability_valid_through: `${YEAR - 4}-05-01` } as ApplicationProfileLike;
    for (const label of DATE_QUESTIONS) assertLeftForHer(label, lapsed, IN_SCOPE_JD, 'lapsed');
  });

  test('the legacy fields cannot rescue an incomplete window', () => {
    // The exact shape a half-finished onboarding leaves behind, with the old columns still populated.
    const partial = {
      ...LEGACY,
      availability_window_start: `${YEAR}-06-01`,
      availability_cycle: CYCLE,
    } as ApplicationProfileLike;
    for (const label of DATE_QUESTIONS) assertLeftForHer(label, partial, IN_SCOPE_JD, 'partial window');
  });
});

describe('what the window is deliberately NOT allowed to answer', () => {
  const profile = { ...WINDOW } as ApplicationProfileLike;

  test('a cadence question asks for hours, and the window holds none', () => {
    for (const label of [
      `are you available full-time for ${CYCLE.toLowerCase()}?`,
      'can you commit to 40 hours per week for 12 weeks from june through august?',
      'are you available to work 40 hours a week for the duration of the internship?',
    ]) {
      assertLeftForHer(label, profile, IN_SCOPE_JD, 'cadence');
    }
  });

  test('a duration question asks for a length, and subtracting her dates would invent one', () => {
    for (const label of ['length or term of availability', 'how long are you available to intern?']) {
      assertLeftForHer(label, profile, IN_SCOPE_JD, 'duration');
    }
  });

  test('a question about where she sits is still a location question', () => {
    assertLeftForHer(
      'this role will be in-office on a hybrid schedule, can you commit to being in-office three days per week at the location listed?',
      profile,
      IN_SCOPE_JD,
      'location commitment',
    );
  });

  test('the season the posting is for is still read from the posting, not from her window', () => {
    assert.deepEqual(
      resolve('please confirm the season you are applying for.', profile, OUT_OF_SCOPE_JD),
      { value: NEXT_CYCLE },
    );
  });
});

describe('finishing a degree is an education date, never an availability date', () => {
  test('it is answered from the graduation date and refused without one', () => {
    const label = 'please confirm when you will complete your university studies';
    assert.deepEqual(
      resolve(label, { ...WINDOW, grad_date: 'May 2028' } as ApplicationProfileLike, IN_SCOPE_JD),
      { value: 'May 2028' },
    );
    // With a live window and no graduation date, the window must not be reached for it.
    assertLeftForHer(label, { ...WINDOW } as ApplicationProfileLike, IN_SCOPE_JD, 'no graduation date');
  });
});
