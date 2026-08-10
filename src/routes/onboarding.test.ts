import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  gapSuggestionsFrom,
  gapsFrom,
  hasFiveTargetRoles,
  hasFocusTargeting,
  hasWorkEligibilityDeclaration,
  onboardingStepFrom,
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

  test('a new account starts with the resume before targeting', () => {
    assert.equal(onboardingStepFrom({ ...ready, hasResume: false, hasFocus: false }), 'resume');
  });

  test('the resume unlocks the inferred job and type choices', () => {
    assert.equal(onboardingStepFrom({ ...ready, hasFocus: false }), 'focus');
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
      ['resume', { ...ready, hasResume: false, hasFocus: false, hasSponsorshipAnswer: false }],
      ['focus', { ...ready, hasFocus: false, hasSponsorshipAnswer: false }],
      ['sponsorship', { ...ready, hasSponsorshipAnswer: false, hasBaseResume: false }],
      ['base', { ...ready, hasBaseResume: false }],
      ['done', ready],
    ];
    for (const [expected, input] of cases) {
      assert.equal(onboardingStepFrom(input), expected);
    }
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

  test('a legacy declaration timestamp remains compatible', () => {
    assert.equal(hasWorkEligibilityDeclaration({ sponsorship_declared_at: '2026-08-10T00:00:00Z' }), true);
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
