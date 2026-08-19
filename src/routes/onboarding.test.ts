import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLICATION_STEPS,
  applicationStepFrom,
  isReplayStep,
  gapSuggestionsFrom,
  gapsAskedFrom,
  gapsFrom,
  hasFiveTargetRoles,
  gapsAskedColumnPresent,
  hasSetupGapsFrom,
  includesGapsStepFrom,
  hasFocusTargeting,
  hasWorkEligibilityDeclaration,
  onboardingStepFrom,
  requiresPaymentMethodFor,
  flowAcknowledgementDecision,
  nextReplayStep,
  replaySteps,
} from './onboarding';
import { encryptField } from '../lib/fieldCrypto';

process.env.ENCRYPTION_KEY ??= 'test-encryption-key-at-least-32-chars-long';

// gapsFrom is what /onboarding/state serves as `gaps`: the screen-03 questions the first
// application did not answer. languages is the first jsonb field on the list, and "answered"
// for it means a non-empty array, not a non-empty string.

describe('onboarding gaps: languages', () => {
  test('no profile row at all: every gap field is open, languages included, in render order', () => {
    assert.deepEqual(gapsFrom(undefined), [
      'gpa',
      'gpa_scale',
      'major',
      'languages',
      // Measured across 158 packets (2026-08-11): 8 distinct blocked packets each for the three
      // test fields, which is 2 postings at one employer retried four times.
      'standardized_test_type',
      'sat_score',
      'act_score',
      'desired_salary',
      'desired_salary_currency',
      'referral_source_default',
    ]);
  });

  test('a declared list closes the gap', () => {
    assert.equal(gapsFrom({ languages: ['English', 'Hindi'] }).includes('languages'), false);
  });

  test('an empty array is still a gap - skipped and never-asked are the same fact', () => {
    assert.equal(gapsFrom({ languages: [] }).includes('languages'), true);
  });

  test('null or a malformed non-array value is a gap, not a crash', () => {
    assert.equal(gapsFrom({ languages: null }).includes('languages'), true);
    assert.equal(gapsFrom({ languages: 'English' }).includes('languages'), true);
    assert.equal(gapsFrom({ languages: { fluent: true } }).includes('languages'), true);
  });

  /* The screen used to open blank for a student whose resume listed six languages, and saving a
     skip wrote [] over information already on file. These pin the one rule that keeps the
     suggestion from becoming the inference schema.ts forbids: it is offered only where the student
     has not answered, and it never becomes the answer on its own. */
  test('a gap is pre-answered with what the resume printed', () => {
    const gaps = gapsFrom({ languages: [] });
    assert.deepEqual(gapSuggestionsFrom(gaps, { languages: ['English', 'Hindi', 'French'] }), {
      languages: ['English', 'Hindi', 'French'],
    });
  });

  test('an answered field is never suggested over, however much the resume printed', () => {
    const gaps = gapsFrom({ languages: ['Spanish'] });
    assert.deepEqual(gapSuggestionsFrom(gaps, { languages: ['English', 'Hindi'] }), {});
  });

  test('nothing parsed means nothing suggested, and the question still gets asked', () => {
    const gaps = gapsFrom(undefined);
    assert.ok(gaps.includes('languages'));
    assert.deepEqual(gapSuggestionsFrom(gaps, null), {});
    assert.deepEqual(gapSuggestionsFrom(gaps, { languages: [] }), {});
    assert.deepEqual(gapSuggestionsFrom(gaps, { languages: ['  ', ''] }), {});
  });

  test('a malformed parse suggests nothing rather than throwing', () => {
    const gaps = gapsFrom(undefined);
    assert.deepEqual(gapSuggestionsFrom(gaps, { languages: 'English' }), {});
    assert.deepEqual(gapSuggestionsFrom(gaps, { languages: [1, null, 'English'] }), {
      languages: ['English'],
    });
  });

  test('duplicates collapse case-insensitively, keeping the first spelling', () => {
    const gaps = gapsFrom(undefined);
    assert.deepEqual(gapSuggestionsFrom(gaps, { languages: ['English', 'english', ' ENGLISH '] }), {
      languages: ['English'],
    });
  });

  test('text gap fields keep their readable() semantics beside it', () => {
    // major is plaintext, gpa is encrypted at rest; both count as answered exactly as before,
    // and the remaining gaps come back in GAP_FIELDS order.
    const g = gapsFrom({
      major: 'Computer Science',
      gpa: encryptField('3.89'),
      languages: ['English'],
    });
    assert.deepEqual(g, [
      'gpa_scale',
      'standardized_test_type',
      'sat_score',
      'act_score',
      'desired_salary',
      'desired_salary_currency',
      'referral_source_default',
    ]);
  });
});

describe('onboarding step order', () => {
  const ready = {
    completed: false,
    hasResume: true,
    hasFocus: true,
    hasSponsorshipAnswer: true,
    hasBaseResume: true,
  };

  test('a new account starts with targeting before the resume', () => {
    assert.equal(onboardingStepFrom({ ...ready, hasResume: false, hasFocus: false }), 'focus');
  });

  test('targeting no longer waits on the resume', () => {
    assert.equal(onboardingStepFrom({ ...ready, hasFocus: false }), 'focus');
  });

  test('the resume is asked for once targeting is stated', () => {
    assert.equal(onboardingStepFrom({ ...ready, hasResume: false }), 'resume');
  });

  test('a new upload pauses for recent-experience review before targeting', () => {
    assert.equal(onboardingStepFrom({ ...ready, hasImpactReview: false }), 'impact');
  });

  test('completed accounts return only when a new upload has an unfinished review', () => {
    assert.equal(onboardingStepFrom({ ...ready, completed: true, hasImpactReview: false }), 'impact');
    assert.equal(onboardingStepFrom({ ...ready, completed: true }), 'done');
  });

  test('setup ends after the core resume and targeting decisions', () => {
    const cases: Array<[string, Parameters<typeof onboardingStepFrom>[0]]> = [
      ['done', { ...ready, completed: true, hasResume: false }],
      ['focus', { ...ready, hasResume: false, hasFocus: false, hasSponsorshipAnswer: false }],
      ['resume', { ...ready, hasResume: false, hasSponsorshipAnswer: false }],
      ['sponsorship', { ...ready, hasSponsorshipAnswer: false, hasBaseResume: false }],
      ['base', { ...ready, hasBaseResume: false }],
      ['done', ready],
    ];
    for (const [expected, input] of cases) {
      assert.equal(onboardingStepFrom(input), expected);
    }
  });
});

describe('version 3 walkthrough replay', () => {
  test('an existing account reviews every core screen even when its data is already complete', () => {
    const steps = replaySteps(false);
    assert.deepEqual(steps, ['focus', 'resume', 'impact', 'sponsorship', 'base']);
    assert.equal(nextReplayStep([], false), 'focus');
    assert.equal(nextReplayStep(['focus'], false), 'resume');
    assert.equal(nextReplayStep(['focus', 'resume', 'impact', 'sponsorship'], false), 'base');
    assert.equal(nextReplayStep(steps, false), 'done');
  });

  test('the existing conditional details screen stays in the account-specific flow', () => {
    const steps = replaySteps(true);
    assert.deepEqual(steps, ['focus', 'resume', 'impact', 'sponsorship', 'base', 'gaps']);
    assert.equal(nextReplayStep(steps.slice(0, -1), true), 'gaps');
    assert.equal(nextReplayStep(steps, true), 'done');
  });

  test('duplicate receipts do not move the server-owned cursor out of order', () => {
    assert.equal(nextReplayStep(['focus', 'focus', 'resume'], false), 'impact');
    assert.equal(nextReplayStep(['resume'], false), 'focus');
  });

  test('a lost acknowledgement response can be retried idempotently', () => {
    assert.deepEqual(flowAcknowledgementDecision(['focus'], 'focus', false), {
      accepted: true,
      alreadyRecorded: true,
      expected: 'resume',
    });
    assert.deepEqual(flowAcknowledgementDecision(['focus'], 'impact', false), {
      accepted: false,
      alreadyRecorded: false,
      expected: 'resume',
    });
  });
});

/* The step PR #116 deleted, and the two conditions that stop it being deleted again.
 *
 * #116's diff is the specification for this suite: "Every gap field is optional and skippable, so
 * gating on `gaps.length` derives 'gaps' FOREVER for anyone who skipped them." Each test below is
 * one half of why that no longer follows. */
describe('the setup gaps step', () => {
  const ready = {
    completed: false,
    hasResume: true,
    hasFocus: true,
    hasSponsorshipAnswer: true,
    hasBaseResume: true,
  };

  test('an unasked student with a missing academic fact is routed to it, after the one-page review', () => {
    assert.equal(onboardingStepFrom({ ...ready, hasSetupGaps: true, gapsAsked: false }), 'gaps');
    // Strictly after base: the screen is the last thing before Done, not a detour from the payoff.
    assert.equal(onboardingStepFrom({ ...ready, hasBaseResume: false, hasSetupGaps: true, gapsAsked: false }), 'base');
  });

  /* THE #116 REGRESSION, stated as directly as it can be. Skipping saves nothing, so the fields are
     still missing on the next request; only the stamp distinguishes this state from never-asked. */
  test('skipping is permanent: a student asked once is never routed back, fields still empty', () => {
    assert.equal(onboardingStepFrom({ ...ready, hasSetupGaps: true, gapsAsked: true }), 'done');
  });

  test('a student with nothing outstanding never sees it', () => {
    assert.equal(onboardingStepFrom({ ...ready, hasSetupGaps: false, gapsAsked: false }), 'done');
    // ...and having been asked does not resurrect it once the fields are filled.
    assert.equal(onboardingStepFrom({ ...ready, hasSetupGaps: false, gapsAsked: true }), 'done');
  });

  /* Completion outranks it in both directions. A finished account that later empties a GPA field in
     Settings must not be dragged back into setup, and the short-circuit at the top is what does it. */
  test('a completed account is never routed back into setup by a new gap', () => {
    assert.equal(onboardingStepFrom({ ...ready, completed: true, hasSetupGaps: true, gapsAsked: false }), 'done');
  });

  /* Absent flags are the pre-existing callers and the unmigrated read path. Both must behave as the
     flow did before this shipped, which is: no gaps step at all. */
  test('callers that pass neither flag get the flow exactly as it was', () => {
    assert.equal(onboardingStepFrom(ready), 'done');
  });

  describe('what decides whether the screen appears', () => {
    test('the academic three gate it', () => {
      for (const field of ['gpa', 'gpa_scale', 'major']) {
        assert.equal(hasSetupGapsFrom([field]), true, `${field} should open the screen`);
      }
    });

    /* The fields that made the pre-#116 gate fire for everybody, and the two the base screen now
       collects one step earlier. Gating on any of them brings back a screen nobody can finish
       (desired_salary) or one that re-asks what was just answered (languages, referral). */
    test('optional and already-asked fields do not', () => {
      assert.equal(hasSetupGapsFrom(['desired_salary', 'desired_salary_currency']), false);
      assert.equal(hasSetupGapsFrom(['languages', 'referral_source_default']), false);
      assert.equal(hasSetupGapsFrom([]), false);
    });

    /* The 2026-08-11 additions RENDER on the screen but must never OPEN it, which is the same
       distinction desired_salary draws above. Test scores are asked by trading and quant firms and
       by almost nobody else; gating on them would put a whole screen in front of every account
       forever, which is exactly the pre-#116 defect. They are shown to someone already routed here
       for a missing GPA or major. */
    test('the measured 2026-08-11 additions render but never gate', () => {
      assert.equal(hasSetupGapsFrom(['standardized_test_type', 'sat_score', 'act_score']), false);
    });

    test('a full gap list still opens it, because the academic three are in it', () => {
      assert.equal(hasSetupGapsFrom(gapsFrom(undefined)), true);
    });
  });

  /* THREE states, and the third is the deploy window. Both repos deploy on merge and the migration
     is run by hand, so the code can be live against a database with no such column. */
  describe('has the student been asked', () => {
    test('a timestamp means asked and null means not', () => {
      assert.equal(gapsAskedFrom({ setup_gaps_asked_at: new Date() }), true);
      assert.equal(gapsAskedFrom({ setup_gaps_asked_at: null }), false);
    });

    /* An ABSENT key is not a null one. selectApplicationProfileRow drops the column from the
       projection when the migration has not run, and a step that cannot record having been asked is
       a step nobody can leave - so the unmigrated window suppresses it rather than trapping anyone. */
    test('an absent column reads as asked, so the step disappears rather than becoming inescapable', () => {
      assert.equal(gapsAskedFrom({ gpa: null }), true);
    });

    test('no row at all is not asked, and the stamp creates the row', () => {
      assert.equal(gapsAskedFrom(undefined), false);
    });

    /* The column-presence probe on its own. It is the half of the rule that decides whether the
       DEPLOY WINDOW suppresses the step, and reading it through includesGapsStepFrom alone left its
       no-row branch asserted only by implication. */
    test('the column probe reads a row without the key as unmigrated, and a row with it as ready', () => {
      assert.equal(gapsAskedColumnPresent({ setup_gaps_asked_at: null }), true);
      assert.equal(gapsAskedColumnPresent({ setup_gaps_asked_at: new Date() }), true);
      assert.equal(gapsAskedColumnPresent({ gpa: null }), false);
    });

    /* No row is not evidence the column is missing, and must not read as such: profile.ts creates
       the row only when the resume parse produced a seed, so the students this screen exists for
       arrive with no row at all. Reading that as unmigrated would suppress the step for exactly the
       population it is meant to reach. */
    test('no row does not read as an unmigrated database', () => {
      assert.equal(gapsAskedColumnPresent(undefined), true);
    });
  });

  /* The rail's denominator, which is a DIFFERENT question from "where is this student now". */
  describe('does the flow contain the screen', () => {
    const OPEN = ['gpa', 'gpa_scale', 'major'];

    test('it is counted one step early, from base, or the total grows underneath them', () => {
      assert.equal(includesGapsStepFrom(OPEN, { setup_gaps_asked_at: null }), true);
    });

    /* The half that is easy to omit. Answering the screen empties the gap list, so a denominator
       read from the list alone drops from seven to six on the last screen of setup - the same class
       of defect as #285, pointing the other way. */
    test('it stays counted after the student answers it and the gaps close', () => {
      assert.equal(includesGapsStepFrom([], { setup_gaps_asked_at: new Date() }), true);
    });

    test('skipping keeps it counted too, and skipping is what leaves the gaps open', () => {
      assert.equal(includesGapsStepFrom(OPEN, { setup_gaps_asked_at: new Date() }), true);
    });

    test('a student the screen was never for is never counted a seventh step', () => {
      assert.equal(includesGapsStepFrom(['desired_salary'], { setup_gaps_asked_at: null }), false);
      assert.equal(includesGapsStepFrom([], { setup_gaps_asked_at: null }), false);
    });

    /* The rail and the route have to agree in the deploy window as well, in BOTH directions: no
       column and a row means the route will never answer 'gaps', so counting it would print a
       seventh step nobody walks. */
    test('an unmigrated database counts six, because the route will never route to it', () => {
      assert.equal(includesGapsStepFrom(OPEN, { gpa: null }), false);
    });

    /* ...and no row at all is the student this screen exists for - profile.ts creates the row only
       when the parse produced a seed - so they are counted and the route does send them. */
    test('no row is counted, matching the step the route derives for them', () => {
      assert.equal(includesGapsStepFrom(OPEN, undefined), true);
      assert.equal(
        onboardingStepFrom({ ...ready, hasSetupGaps: hasSetupGapsFrom(OPEN), gapsAsked: gapsAskedFrom(undefined) }),
        'gaps',
      );
    });
  });
});

describe('country-scoped work eligibility onboarding', () => {
  test('one complete country record completes the step', () => {
    assert.equal(hasWorkEligibilityDeclaration({
      work_eligibility_by_country: [{
        country_code: 'GB', authorized_now: false, needs_sponsorship_now: true, needs_sponsorship_future: true,
      }],
    }), true);
  });

  test('ambiguous old US scalars do not silently complete the new declaration', () => {
    assert.equal(hasWorkEligibilityDeclaration({ work_authorized: true, needs_sponsorship: true }), false);
    assert.equal(hasWorkEligibilityDeclaration({
      work_authorized: true,
      needs_sponsorship: true,
      sponsorship_answer: 'needs_future',
    }), true);
  });

  test('a declaration timestamp without a safe answer does not complete onboarding', () => {
    assert.equal(hasWorkEligibilityDeclaration({}), false);
  });
});

describe('resume-informed focus completion', () => {
  test('old category-only targeting does not skip the five inferred jobs screen', () => {
    assert.equal(hasFocusTargeting({ categories: ['software-engineering'], role_types: ['internship'] }), false);
  });

  test('titles and role type complete the resume-informed focus screen', () => {
    assert.equal(hasFocusTargeting({
      categories: ['software-engineering'],
      titles: ['Software Engineer'],
      role_types: ['internship'],
    }), true);
  });
});

describe('five-role resume contract', () => {
  test('only five distinct non-empty parsed roles unlock focus suggestions', () => {
    assert.equal(hasFiveTargetRoles({ target_roles: ['One', 'Two', 'Three', 'Four'] }), false);
    assert.equal(hasFiveTargetRoles({ target_roles: ['One', 'Two', 'Three', 'Four', 'one'] }), false);
    assert.equal(hasFiveTargetRoles({ target_roles: ['One', 'Two', 'Three', 'Four', 'Five'] }), true);
    assert.equal(hasFiveTargetRoles(null), false);
  });
});

/* The application sequence: six ledger-driven screens between finishing setup and finishing
 * onboarding. Ledger-driven rather than derived, because "has this student seen the match screen"
 * is a fact about their session and not about their profile. */
describe('the application sequence', () => {
  test('it runs in order and ends at done', () => {
    assert.equal(applicationStepFrom([]), 'match');
    assert.equal(applicationStepFrom(['match']), 'build');
    assert.equal(applicationStepFrom(['match', 'build']), 'questions');
    assert.equal(applicationStepFrom(['match', 'build', 'questions']), 'review');
    assert.equal(applicationStepFrom(['match', 'build', 'questions', 'review']), 'trial');
    assert.equal(applicationStepFrom(['match', 'build', 'questions', 'review', 'trial']), 'plan');
    assert.equal(applicationStepFrom([...APPLICATION_STEPS]), 'done');
  });

  test('a screen acknowledged out of order still counts as seen', () => {
    /* Declining a match, or saving a packet to send later, still means the screen was SEEN, and
       the flow must not put the student back on it forever. Same distinction setup_gaps_asked_at
       makes one screen earlier. */
    assert.equal(applicationStepFrom(['build']), 'match');
    assert.equal(applicationStepFrom(['match', 'questions']), 'build');
  });

  test('setup steps are replay steps and application steps are not', () => {
    // Replay exists to walk an EXISTING account back through setup, and no existing account has an
    // application sequence to replay, so the ordering check must not apply to these.
    for (const step of ['resume', 'impact', 'focus', 'sponsorship', 'base', 'gaps']) {
      assert.equal(isReplayStep(step), true, `${step} should be a replay step`);
    }
    for (const step of APPLICATION_STEPS) {
      assert.equal(isReplayStep(step), false, `${step} must not be a replay step`);
    }
  });
});


describe('the card gate on the dashboard', () => {
  const GATE = { CARD_GATE_FROM: '2026-08-19T00:00:00.000Z' } as NodeJS.ProcessEnv;
  const after = new Date('2026-08-20T00:00:00.000Z');
  const before = new Date('2026-08-18T00:00:00.000Z');

  test('is off entirely when CARD_GATE_FROM is unset', () => {
    /* The default, and the one that matters most. This flag's wrong value locks every
       student out of work they already own, so an unset or unparseable env has to mean
       "gate nobody" rather than "gate everybody". Deploy is therefore inert until
       someone deliberately sets it. */
    assert.equal(requiresPaymentMethodFor({ created_at: after }, {} as NodeJS.ProcessEnv), false);
    assert.equal(requiresPaymentMethodFor({ created_at: after }, { CARD_GATE_FROM: '   ' } as NodeJS.ProcessEnv), false);
    assert.equal(requiresPaymentMethodFor({ created_at: after }, { CARD_GATE_FROM: 'not-a-date' } as NodeJS.ProcessEnv), false);
  });

  test('never gates an account created before the cutover', () => {
    // Existing students keep the dashboard whatever their billing looks like.
    assert.equal(requiresPaymentMethodFor({ created_at: before }, GATE), false);
    assert.equal(requiresPaymentMethodFor({ created_at: null }, GATE), false);
  });

  test('gates a new account with no card, and opens once Stripe has one', () => {
    assert.equal(requiresPaymentMethodFor({ created_at: after }, GATE), true);
    assert.equal(requiresPaymentMethodFor({
      created_at: after,
      billing_provider: 'stripe',
      billing_customer_id: 'cus_123',
    }, GATE), false);
  });

  test('a guest is gated exactly like anyone else', () => {
    /* THE CONTRACT REVERSED, on Mehek's call, hours after the exemption shipped.
       Guest mode is a button on the front of /login, so exempting guests fixed a
       brick wall by opening a door around the payment gate. Nobody is exempt; the
       way out moved instead, to claiming an email (PlanStep reads claim_required).
       Pinned as an equality against the non-guest case so the two cannot drift. */
    assert.equal(requiresPaymentMethodFor({ created_at: after, is_guest: true } as never, GATE), true);
    assert.equal(
      requiresPaymentMethodFor({ created_at: after, is_guest: true } as never, GATE),
      requiresPaymentMethodFor({ created_at: after }, GATE),
    );
    // A guest who somehow holds a card is still open, same rule as everyone.
    assert.equal(requiresPaymentMethodFor({
      created_at: after,
      is_guest: true,
      billing_provider: 'stripe',
      billing_customer_id: 'cus_g',
    } as never, GATE), false);
  });

  test('a customer id without the Stripe provider is not a card', () => {
    /* Both halves are required. A stale customer id left by another provider, or a
       provider set with no customer, is not evidence that Stripe took a card. */
    assert.equal(requiresPaymentMethodFor({ created_at: after, billing_customer_id: 'cus_123' }, GATE), true);
    assert.equal(requiresPaymentMethodFor({ created_at: after, billing_provider: 'stripe' }, GATE), true);
    assert.equal(requiresPaymentMethodFor({
      created_at: after,
      billing_provider: 'lemonsqueezy',
      billing_customer_id: 'cus_123',
    }, GATE), true);
  });

  test('cancelling does not throw a student back into setup', () => {
    /* billing_customer_id survives cancellation, and that is the intended reading:
       someone who cancelled still has a card on file and belongs on the dashboard on
       Free, not back in the setup flow being asked for a card they already gave. */
    assert.equal(requiresPaymentMethodFor({
      created_at: after,
      billing_provider: 'stripe',
      billing_customer_id: 'cus_cancelled',
    }, GATE), false);
  });
});
