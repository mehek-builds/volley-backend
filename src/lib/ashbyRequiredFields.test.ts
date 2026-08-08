import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildManagedDiscoveryActions,
  buildManagedPortalActions,
  MANAGED_ACTION_LIMIT,
  type SubmissionPacket,
} from './portalSubmission';

/* D-01, THE FILL HALF. The three required fields production packet 245c827a left empty.
 *
 * Measured on the live Deepgram Ashby form, 2026-08-09:
 *   Current Location   an <input role="combobox"> with NO id and NO name, inside
 *                      <div data-field-path="_systemfield_location">. The only selector this
 *                      codebase had, input[name="_systemfield_location"], matches ZERO elements
 *                      there, so the fill was optional, matched nothing, and "location" never
 *                      appeared in filled_fields.
 *   the two work-eligibility questions
 *                      <button>Yes</button><button>No</button> plus a display:none mirror checkbox.
 *                      Neither was discovered as a question at all, so the resolver never got the
 *                      chance to answer them from work_authorized and needs_sponsorship - both of
 *                      which this user has stored.
 */

const PACKET = {
  fullName: 'Mehek Mandal',
  email: 'mehekman@usc.edu',
  phone: '+1 213 555 0100',
  city: 'Los Angeles, California, United States',
  country: 'United States',
  linkedinUrl: 'https://linkedin.com/in/mehekmandal',
  githubUrl: 'https://github.com/mehek',
  portfolioUrl: 'https://mehek.dev',
  resume: 'BASE64',
  resumeName: 'resume.pdf',
  jdText: 'Deepgram voice AI internship',
  questions: [],
} as unknown as SubmissionPacket;

/** The packet as the run now assembles it, with the durable selectors discovery reports. */
function deepgramPacket(): SubmissionPacket {
  return {
    ...PACKET,
    questions: [
      {
        question: 'are you legally authorized to work in the country where this role is located?',
        answer: 'Yes',
        portalSelector: '[name="477fc43f-966e-4740-b93b-71f92b83993e"]',
        portalInputType: 'checkbox',
      },
      {
        question: 'will you now or in the future require visa sponsorship to work in the country where this role is located?',
        answer: 'Yes',
        portalSelector: '[name="41f15488-e126-43c0-8cb5-f12dc88d391b"]',
        portalInputType: 'checkbox',
      },
    ],
  } as unknown as SubmissionPacket;
}

test('the Ashby fill aims at the location control that actually exists', () => {
  const actions = buildManagedPortalActions('ashby', PACKET);
  const location = actions.find((action) => action.label === 'location');
  assert.ok(location, 'the Ashby branch must still attempt the location field');
  // The entry's own per-question attribute, which is the part that survives Ashby dropping the id
  // and the name from the input itself.
  assert.match(location.selector ?? '', /\[data-field-path="_systemfield_location"\]/);
  assert.match(location.selector ?? '', /input\[role="combobox"\]/);
  // The legacy name is kept, after the durable hook, for a board still serving an older bundle.
  assert.match(location.selector ?? '', /input\[name="_systemfield_location"\]/);
  // ONE action for the whole list: the runner takes the first match, so a longer selector list
  // costs nothing against MANAGED_ACTION_LIMIT.
  assert.equal(actions.filter((action) => action.label === 'location').length, 1);
});

test('an Ashby yes/no question with a durable selector is still attempted', () => {
  /* The regression this exists to catch. Before durable selectors, portalSelectorForField withheld
     a selector for every shape but text, so a choice question always fell through to the
     no-selector path at the bottom of buildManagedPortalActions. It now arrives WITH a selector, and
     the `checkbox|radio` branch used to `continue` without pushing anything for a non-Greenhouse
     board - so a question that had just become fillable would have stopped being attempted. */
  const actions = buildManagedPortalActions('ashby', deepgramPacket());
  for (const question of ['legally authorized', 'visa sponsorship']) {
    const matching = actions.filter((action) => (action.label ?? '').includes(question));
    assert.ok(matching.length > 0, `no action was pushed for the "${question}" question`);
    // fillByLabelText, not a click on the selector: a durable selector on Ashby's yes/no resolves to
    // the display:none mirror input, and clicking that neither drives React nor distinguishes Yes
    // from No. The runner's scoped choice handling reads the container and presses the pill.
    assert.ok(
      matching.some((action) => action.type === 'fillByLabelText' && action.value === 'Yes'),
      `the "${question}" question must be answered through the scoped choice path`,
    );
  }
});

test('answering the two work-eligibility questions leaves the action budget untouched', () => {
  /* MANAGED_ACTION_LIMIT is 120 and the runner rejects a longer list with HTTP 400 TOO_MANY_ACTIONS
     before a browser opens - which submissionRunner swallows with .catch(() => null), so an over-
     budget list looks exactly like a form with no questions on it. Greenhouse sits within a couple
     of actions of the ceiling, so anything added here has to be paid for somewhere. */
  const before = buildManagedPortalActions('ashby', PACKET).length;
  const after = buildManagedPortalActions('ashby', deepgramPacket(), true).length;
  assert.ok(after <= MANAGED_ACTION_LIMIT, `Ashby submit list is over budget at ${after}`);
  assert.ok(
    after - before <= 4,
    `two questions must cost at most two actions each; cost ${after - before}`,
  );
  assert.ok(buildManagedDiscoveryActions('ashby', deepgramPacket()).length <= MANAGED_ACTION_LIMIT);
});

test('a question with no answer is never given an action, whatever the employer marks required', () => {
  /* THE CORRECTNESS RULE. This system has answered "Yes" to "are you authorized to work for all
     employers in the US on a full-time basis?" while the profile's needs_sponsorship was true, and
     has auto-agreed to a binding season-long exclusivity commitment. A required field with no
     stored fact behind it must be left blank and raised as a blocker - never filled with a
     plausible value - and the blank is what makes the required-answer gate speak for it.

     Asked of the ACTION LIST rather than of a resolver, because this is the last layer before the
     answers reach an employer's form: whatever any resolver decides, nothing without an answer may
     be typed anywhere. */
  const unanswerable = {
    ...PACKET,
    questions: [
      { question: 'are you legally authorized to work in the country where this role is located?', answer: '', portalSelector: '[name="477fc43f"]', portalInputType: 'checkbox' },
      { question: 'will you now or in the future require visa sponsorship to work in the country where this role is located?', answer: '   ', portalSelector: '[name="41f15488"]', portalInputType: 'checkbox' },
      { question: 'current location', answer: '', portalSelector: '[data-field-path="_systemfield_location"]', portalInputType: 'combobox' },
      { question: 'have you previously applied to deepgram?', answer: '', portalSelector: '#prior', portalInputType: 'text' },
    ],
  } as unknown as SubmissionPacket;
  const actions = buildManagedPortalActions('ashby', unanswerable, true);
  for (const action of actions) {
    assert.ok(
      !(action.label ?? '').startsWith('question'),
      `an unanswered question produced an action: ${action.label}`,
    );
  }
  // And nothing anywhere in the list carries a Yes or a No that no stored fact supports.
  for (const action of actions) {
    assert.ok(
      !/^(yes|no)$/i.test(String(action.value ?? '')),
      `a yes/no value appeared with no answer behind it: ${JSON.stringify(action)}`,
    );
  }
});
