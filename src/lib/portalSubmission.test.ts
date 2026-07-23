import assert from 'node:assert/strict';
import test from 'node:test';
import { buildManagedPortalActions, detectPortal, portalApplicationUrl, readManagedReceipt } from './portalSubmission';

test('detects the three supported applicant portal families', () => {
  assert.equal(detectPortal('https://boards.greenhouse.io/acme/jobs/123'), 'greenhouse');
  assert.equal(detectPortal('https://jobs.lever.co/acme/123/apply'), 'lever');
  assert.equal(detectPortal('https://jobs.ashbyhq.com/acme/123/application'), 'ashby');
});

test('opens Ashby directly on its application tab for managed filling', () => {
  assert.equal(
    portalApplicationUrl('ashby', 'https://jobs.ashbyhq.com/acme/123'),
    'https://jobs.ashbyhq.com/acme/123/application',
  );
  assert.equal(
    portalApplicationUrl('ashby', 'https://jobs.ashbyhq.com/acme/123/application'),
    'https://jobs.ashbyhq.com/acme/123/application',
  );
  assert.equal(
    portalApplicationUrl('lever', 'https://jobs.lever.co/acme/123/apply'),
    'https://jobs.lever.co/acme/123/apply',
  );
});

test('rejects insecure and lookalike portal URLs', () => {
  assert.throws(() => detectPortal('http://boards.greenhouse.io/acme/jobs/123'), /HTTPS/);
  assert.throws(() => detectPortal('https://greenhouse.io.attacker.example/acme'), /not supported/);
  assert.throws(() => detectPortal('https://example.com/apply'), /not supported/);
});

test('controlled portal is gated by an explicit server flag', () => {
  const previous = process.env.LITOS_ENABLE_TEST_PORTAL;
  delete process.env.LITOS_ENABLE_TEST_PORTAL;
  assert.throws(() => detectPortal('https://trylitos.com/qa/portal-submission'), /not supported/);
  process.env.LITOS_ENABLE_TEST_PORTAL = 'true';
  assert.equal(detectPortal('https://trylitos.com/qa/portal-submission'), 'controlled_test');
  if (previous === undefined) delete process.env.LITOS_ENABLE_TEST_PORTAL;
  else process.env.LITOS_ENABLE_TEST_PORTAL = previous;
});

test('managed controlled-portal actions include reviewed fields, resume upload, and final submit', () => {
  const actions = buildManagedPortalActions('controlled_test', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [{ question: 'Why this role?', answer: 'I enjoy systems work.' }],
  }, true);
  assert.deepEqual(actions.map((action) => action.type), [
    'fill', 'fill', 'fill', 'upload', 'fillByLabelText', 'click',
  ]);
  assert.equal(actions.find((action) => action.type === 'upload')?.file?.base64, 'cGRm');
});

test('managed receipt requires confirmation language and captures the reference', () => {
  assert.deepEqual(readManagedReceipt({
    title: 'Complete',
    url: 'https://trylitos.com/qa/portal-submission?complete=1',
    text: 'Thank you. Application reference: LITOS-QA-2027',
  }), {
    confirmationText: 'Thank you. Application reference: LITOS-QA-2027',
    finalUrl: 'https://trylitos.com/qa/portal-submission?complete=1',
    referenceId: 'LITOS-QA-2027',
  });
  assert.throws(() => readManagedReceipt({ title: 'Form', url: 'https://example.com', text: 'Apply now' }), /verifiable/);
});

test('a question that cannot be typed degrades to a blocker instead of killing the run', () => {
  // Live failure on Aquatic's Greenhouse form, 2026-07-23: "Please select all fields of study" is
  // a checkbox group, Playwright's fill() cannot fill a checkbox, and because the question action
  // was not optional the whole run ended `failed` with a raw Playwright stack trace, discarding
  // the name, email, phone and resume it had already entered successfully.
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      { question: 'Please select all fields of study', answer: 'Computer Science' },
      { question: 'What are your annualized total compensation expectations?', answer: 'USD 175,000 per year' },
    ],
  });
  const questionActions = actions.filter((action) => action.type === 'fillByLabelText');
  assert.equal(questionActions.length, 2);
  for (const action of questionActions) {
    assert.equal(action.optional, true, `"${action.text}" must not be able to abort the run`);
  }
});

test('choice controls are not auto-clicked by matching answer text', () => {
  // Deliberate omission. Matching a label to a short answer like "Yes" can tick a legal
  // acknowledgement or consent box elsewhere on the page, which the student cannot undo. An
  // unanswered choice question is a blocker she clears in seconds.
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [{ question: 'Do you consent to the terms?', answer: 'Yes' }],
  });
  const clicks = actions.filter((action) => action.type === 'click');
  assert.equal(clicks.length, 0, 'no click action may be synthesized from an answer string');
});
