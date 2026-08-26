import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationReviewState } from './applicationReview';
import { passiveSubmissionReview } from './passiveSubmissionReview';

const EMPLOYER = 'https://apply.workable.com/example/j/PASSIVE1/';

function reviewFixture(): ApplicationReviewState {
  return {
    jd_text: 'Apply for the example role.',
    portal_url: EMPLOYER,
    extension_handoff_url: `${EMPLOYER}handoff`,
    ats_name: 'workable',
    status: 'submitted',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: '2026-08-26T10:00:00.000Z',
    progress_screenshot_url: 'https://proof.example/progress.png',
    preview_screenshot_url: 'https://proof.example/preview.png',
    applicant_snapshot: {
      profile: {
        full_name: 'Applicant',
        experience: [],
        skills: [],
        school: 'School',
        grad_year: 2028,
      },
      application_profile: {
        linkedin_url: 'https://www.linkedin.com/in/applicant',
        github_url: 'https://github.com/applicant',
        portfolio_url: 'https://applicant.example',
      },
    },
    unverified_submission: {
      at: '2026-08-26T09:55:00.000Z',
      cause: 'provider_error',
      portal_url: `${EMPLOYER}check`,
      network: [{ method: 'POST', url: `${EMPLOYER}submit`, status: null }],
    },
    receipt: {
      confirmation_text: 'Application received',
      final_url: `${EMPLOYER}confirmation`,
      screenshot_url: 'https://proof.example/receipt.png',
      captured_at: '2026-08-26T10:00:00.000Z',
    },
  };
}

test('passive submission review recursively removes employer navigation fields without mutating storage', () => {
  const stored = reviewFixture();
  const original = structuredClone(stored);
  const projected = passiveSubmissionReview(stored) as any;

  assert.deepEqual(stored, original);
  assert.equal('portal_url' in projected, false);
  assert.equal('extension_handoff_url' in projected, false);
  assert.equal('portal_url' in projected.unverified_submission, false);
  assert.equal('url' in projected.unverified_submission.network[0], false);
  assert.equal('final_url' in projected.receipt, false);
  assert.equal(projected.unverified_submission.network[0].method, 'POST');
  assert.equal(projected.receipt.confirmation_text, 'Application received');
});

test('new URL-shaped fields are private by default at every nesting depth', () => {
  const stored = {
    ...reviewFixture(),
    applicationUrl: `${EMPLOYER}new-root`,
    future: {
      redirect_href: `${EMPLOYER}redirect`,
      destination_uri: `${EMPLOYER}destination`,
      employer_links: [`${EMPLOYER}one`, `${EMPLOYER}two`],
    },
  } as ApplicationReviewState & Record<string, unknown>;
  const projected = passiveSubmissionReview(stored) as any;

  assert.equal('applicationUrl' in projected, false);
  assert.equal('redirect_href' in projected.future, false);
  assert.equal('destination_uri' in projected.future, false);
  assert.equal('employer_links' in projected.future, false);
  assert.doesNotMatch(JSON.stringify(projected), /apply\.workable\.com/);
});

test('the narrow evidence and applicant-link exceptions remain available', () => {
  const projected = passiveSubmissionReview(reviewFixture()) as any;

  assert.equal(projected.progress_screenshot_url, 'https://proof.example/progress.png');
  assert.equal(projected.preview_screenshot_url, 'https://proof.example/preview.png');
  assert.equal(projected.receipt.screenshot_url, 'https://proof.example/receipt.png');
  assert.equal(
    projected.applicant_snapshot.application_profile.linkedin_url,
    'https://www.linkedin.com/in/applicant',
  );
  assert.equal(projected.applicant_snapshot.application_profile.github_url, 'https://github.com/applicant');
  assert.equal(projected.applicant_snapshot.application_profile.portfolio_url, 'https://applicant.example');
});
