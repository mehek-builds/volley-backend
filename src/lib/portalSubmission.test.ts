import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import type { Page } from 'playwright-core';
import { CONTROLLED_PORTAL_BINDING_PARAM, controlledPortalBinding } from './controlledTestPortal';
import { resolveKnownAnswer } from './questionDiscovery';
import {
  AUTONOMOUS_PORTAL_FAMILIES,
  blockersRequireCoverLetter,
  buildManagedDiscoveryActions,
  buildManagedAttendedAccountProbeActions,
  buildManagedPortalActions,
  canFillReviewedQuestions,
  canonicalSmartRecruitersOneClickUrl,
  canonicalSupportedPortalUrl,
  coverLetterUploadSelector,
  detectPortal,
  fillPortal,
  isAccountWalledFamily,
  isAutonomousPortalFamily,
  isManagedAttendedAccountPortal,
  isChoiceQuestion,
  isPaylocityTerminalStep,
  managedResultFilledFields,
  managedAnswerLossReasons,
  ashbyControlWithinFieldPath,
  managedResultFieldOptions,
  managedResultSupportsDiscoveryRole,
  attachManagedFieldOptions,
  buildManagedDiscoveredOptionProbeActions,
  buildManagedDiscoveredOptionProbeBatches,
  escapeHatchOptionFor,
  managedOptionProbeControlId,
  managedOptionProbeTargets,
  managedOptionProbeAnalysis,
  managedUnreportedFillLabels,
  managedUnexplainedAnswers,
  managedUnexplainedAnswerReasons,
  mergeManagedFieldOptions,
  MANAGED_OPTION_PROBE_ACTIONS_PER_CONTROL,
  MANAGED_OPTION_PROBE_MAX_CONTROLS,
  reactSelectListboxSelector,
  GREENHOUSE_OPTION_PROBE_IDS,
  MANAGED_ACTION_LIMIT,
  ManagedActionBudgetError,
  budgetDroppedReviewedQuestions,
  reviewedQuestionsWithoutActions,
  PORTAL_FAMILIES,
  MANAGED_OPTION_EXTRACT_PREFIX,
  managedResultHasCoverLetterUpload,
  portalApplicationUrl,
  navigateToApplicationForm,
  portalCanAutoSubmit,
  portalHandoffReason,
  readManagedReceipt,
  chooseSubmitControl,
  READ_CONTROL_LABEL,
} from './portalSubmission';
import { POLLABLE_JOB_BOARDS } from './jobMonitor';
import { resolveProfileField } from './profileFieldResolution';
import {
  MANAGED_DISCOVERY_ROLE_CAPABILITY,
  MANAGED_EXTRACT_ASSERTIONS_CAPABILITY,
  type ManagedDiscoveredQuestion,
} from './browserbase';
import type { ReferralSourceEvidence } from './referralSource';

const JOB_BOARD_REFERRAL_EVIDENCE: ReferralSourceEvidence = {
  kind: 'litos_job_board',
  value: 'Job board',
  jobId: '11111111-1111-4111-8111-111111111111',
  sourceId: '22222222-2222-4222-8222-222222222222',
  sourceUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
  observedAt: '2026-08-09T00:00:00.000Z',
};

const EMPLOYER_SITE_REFERRAL_EVIDENCE: ReferralSourceEvidence = {
  ...JOB_BOARD_REFERRAL_EVIDENCE,
  kind: 'employer_career_site',
  value: 'Company website',
};

test('only an exact SmartRecruiters oneclick form can become an attended handoff URL', () => {
  const exact = 'https://jobs.smartrecruiters.com/oneclick-ui/company/SeekaTechnology/publication/123e4567-e89b-12d3-a456-426614174000';
  assert.equal(canonicalSmartRecruitersOneClickUrl(`${exact}?utm_source=test#application`), exact);
  assert.equal(canonicalSmartRecruitersOneClickUrl(
    'https://jobs.smartrecruiters.com/SeekaTechnology/744000063648206-software-engineer-internship',
  ), undefined);
  assert.equal(canonicalSmartRecruitersOneClickUrl('https://jobs.lever.co/acme/abc123/apply'), undefined);
  assert.equal(canonicalSmartRecruitersOneClickUrl(undefined), undefined);
});

function isGreenhousePreflightClick(action: { type: string; label?: string }) {
  return action.type === 'click'
    && (action.label?.startsWith('greenhouse_cookie_preflight:') === true
      || action.label === 'greenhouse_open_application_form');
}

function isGreenhouseFixedCandidatePrivacyClick(action: { type: string; label?: string }) {
  return action.type === 'click'
    && action.label === 'greenhouse_candidate_privacy_acknowledgement';
}

// Opening a react-select to READ its option list. The invariant the discovery run has to keep is
// that it changes nothing and sends nothing, and a dropdown that is opened and then closed with
// Escape does neither: no value is chosen and no form state moves. It is a click all the same, so
// it is named here rather than quietly widening the "no clicks" assertion below.
function isGreenhouseOptionProbeClick(action: { type: string; label?: string }) {
  return action.type === 'click' && action.label?.startsWith('option_probe_open:') === true;
}

test('detects the four supported applicant portal families', () => {
  assert.equal(detectPortal('https://boards.greenhouse.io/acme/jobs/123'), 'greenhouse');
  assert.equal(detectPortal('https://databricks.com/company/careers/open-positions/job?gh_jid=6883068002'), 'greenhouse');
  assert.equal(detectPortal('https://www.databricks.com/company/careers/product/product-management-intern-summer-2027-6883068002?gh_jid=6883068002'), 'greenhouse');
  assert.equal(detectPortal('https://jobs.lever.co/acme/123/apply'), 'lever');
  assert.equal(detectPortal('https://jobs.ashbyhq.com/acme/123/application'), 'ashby');
  assert.equal(detectPortal('https://jobs.smartrecruiters.com/Acme/744000-role'), 'smartrecruiters');
});

test('a managed discovery run detects custom questions and cover-letter attachment capability without submitting', () => {
  // R-055 on the managed path: this cheap first call exists only to get the page's custom
  // questions back (stratus-browser-cloud PR #7). It reuses the same fixed-field fills (including
  // the resume upload - harmless and idempotent, the real run below fills them again) but must
  // never send reviewed-question answers or click submit, since nothing has been resolved yet.
  const actions = buildManagedDiscoveryActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [{ question: 'Why this role?', answer: 'I enjoy systems work.' }],
  });
  // Relative order, not fixed tail positions: the second option-probe round is deliberately placed
  // after `discover` (it needs the time that DOM walk takes), so the discover action is no longer
  // the second-to-last entry. What matters is that discovery still scans the page and still reads
  // the cover-letter capability, both after every fill.
  const discoverIndex = actions.findIndex((a) => a.type === 'discover');
  const coverLetterIndex = actions.findIndex((a) => a.label === 'cover_letter_capability');
  assert.ok(discoverIndex >= 0);
  assert.ok(coverLetterIndex > discoverIndex);
  assert.deepEqual(actions[coverLetterIndex], {
    type: 'extract',
    selector: coverLetterUploadSelector('greenhouse'),
    attribute: 'type',
    label: 'cover_letter_capability',
    optional: true,
    timeout: 10_000,
  });
  assert.equal(actions.some((a) => a.type === 'fillByLabelText' && a.label?.startsWith('question:')), false);
  assert.equal(actions.some((a) =>
    a.type === 'click'
    && !isGreenhousePreflightClick(a)
    && !isGreenhouseOptionProbeClick(a)
    && !isGreenhouseFixedCandidatePrivacyClick(a)), false);
  const fillSelectors = actions.filter((a) => a.type === 'fill').map((a) => a.selector);
  assert.ok(fillSelectors.some((s) => s?.includes('first_name')));
  assert.equal(actions.some((a) => a.type === 'fillByLabelText' && a.label === 'first_name_label'), false);
  assert.ok(actions.some((a) => a.type === 'extract' && a.label === 'filled_field:first_name'));
  assert.ok(actions.some((a) => a.type === 'extract' && a.label === 'filled_field:email'));
  assert.ok(actions.some((a) => a.type === 'extract' && a.label === 'filled_field:resume'));
});

test('Databricks wrapper URLs use the Greenhouse managed flow without submitting during discovery', () => {
  const databricksUrl = 'https://databricks.com/company/careers/open-positions/job?gh_jid=6883068002';
  const canonical = 'https://boards.greenhouse.io/embed/job_app?token=6883068002';
  assert.equal(detectPortal(databricksUrl), 'greenhouse');
  assert.equal(canonicalSupportedPortalUrl(databricksUrl, 'greenhouse'), canonical);
  assert.equal(portalApplicationUrl('greenhouse', databricksUrl), canonical);
  assert.equal(portalApplicationUrl('greenhouse', canonical), canonical);

  const packet = {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  };
  const discovery = buildManagedDiscoveryActions('greenhouse', packet);
  assert.equal(discovery.some((action) => action.type === 'click' && action.selector === 'button[type="submit"], input[type="submit"]'), false);
  assert.ok(discovery.some((action) => action.type === 'fill' && action.selector?.includes('first_name')));
  assert.ok(discovery.some((action) => action.type === 'upload'));

  const submitting = buildManagedPortalActions('greenhouse', packet, true);
  assert.equal(
    submitting.filter((action) => action.type === 'confirmAndSubmit').length,
    1,
  );
  assert.ok(submitting.every((action) => action.type !== 'fill' || (action.timeout ?? Infinity) < 30_000));
  assert.ok(submitting.every((action) => action.type !== 'upload' || (action.timeout ?? Infinity) < 30_000));
  assert.equal(submitting.some((action) => action.type === 'extract' && action.label?.startsWith('filled_field:')), false);
});

test('Greenhouse job board detail URLs open the embedded application form for managed filling', () => {
  assert.equal(
    portalApplicationUrl('greenhouse', 'https://job-boards.greenhouse.io/databricks/jobs/6883068002'),
    'https://boards.greenhouse.io/embed/job_app?for=databricks&token=6883068002',
  );
  assert.equal(
    portalApplicationUrl('greenhouse', 'https://boards.greenhouse.io/gemini/jobs/4512345'),
    'https://boards.greenhouse.io/embed/job_app?for=gemini&token=4512345',
  );
  assert.equal(
    portalApplicationUrl('greenhouse', 'https://boards.greenhouse.io/embed/job_app?for=databricks&token=6883068002'),
    'https://boards.greenhouse.io/embed/job_app?for=databricks&token=6883068002',
  );
});

test('managed Greenhouse extracted field evidence repairs missing filledFields without storing values', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const selector = (label: string) => actions.find((action) => action.label === label)?.selector;

  assert.deepEqual(
    managedResultFilledFields({
      title: 'Apply',
      url: 'https://example.com',
      text: 'Apply for this job',
      filledFields: [],
      extracted: [
        { selector: selector('filled_field:first_name')!, value: 'Taylor' },
        { selector: selector('filled_field:last_name')!, value: 'Example' },
        { selector: selector('filled_field:email')!, value: 'taylor@example.com' },
        { selector: selector('filled_field:resume')!, value: 'C:\\fakepath\\resume.pdf' },
      ],
    }).sort(),
    ['email', 'first_name', 'last_name', 'resume'].sort(),
  );

  assert.deepEqual(
    managedResultFilledFields({
      title: 'Apply',
      url: 'https://example.com',
      text: 'Apply for this job',
      filledFields: [],
      extracted: [
        { selector: '#ignored-first', label: 'filled_field:first_name', value: 'Taylor' },
        { selector: '#ignored-last', label: 'filled_field:last_name', value: 'Example' },
        { selector: '#ignored-email', label: 'filled_field:email', value: 'taylor@example.com' },
        { selector: '#ignored-resume', label: 'filled_field:resume', value: 'C:\\fakepath\\resume.pdf' },
      ],
    }).sort(),
    ['email', 'first_name', 'last_name', 'resume'].sort(),
  );
});

test('managed Workable phone evidence replaces stale fill success with country and value readback', () => {
  const base = {
    title: 'Apply',
    url: 'https://apply.workable.com/pony-ai/j/example/apply',
    text: 'Apply for this job',
    filledFields: ['phone'],
  };
  assert.equal(managedResultFilledFields({ ...base, extracted: [] }).includes('phone'), false);
  assert.equal(managedResultFilledFields({
    ...base,
    extracted: [
      { selector: '#country', label: 'filled_field:phone_country', value: '+971', expectedValueDigits: '971' },
      { selector: '#phone', label: 'filled_field:phone', value: '0567417451', expectedValueDigits: '0567417451' },
    ],
  }).includes('phone'), false);
  assert.equal(managedResultFilledFields({
    ...base,
    capabilities: [MANAGED_EXTRACT_ASSERTIONS_CAPABILITY],
    extracted: [
      { selector: '#country', label: 'filled_field:phone_country', value: '+971', expectedValueDigits: '971' },
      { selector: '#phone', label: 'filled_field:phone', value: '050 123 4567', expectedValueDigits: '0567417451' },
    ],
  }).includes('phone'), false);
  assert.equal(managedResultFilledFields({
    ...base,
    capabilities: [MANAGED_EXTRACT_ASSERTIONS_CAPABILITY],
    extracted: [
      { selector: '#country', label: 'filled_field:phone_country', value: 'United Arab Emirates +971', expectedValueDigits: '971' },
      { selector: '#phone', label: 'filled_field:phone', value: '056 741 7451', expectedValueDigits: '0567417451' },
    ],
  }).includes('phone'), true);
  assert.equal(managedResultFilledFields({
    ...base,
    capabilities: [MANAGED_EXTRACT_ASSERTIONS_CAPABILITY],
    extracted: [
      { selector: '#country', label: 'filled_field:phone_country', value: 'United States +1', expectedValueDigits: '1' },
      { selector: '#phone', label: 'filled_field:phone', value: '(213) 574-6270', expectedValueDigits: '2135746270' },
    ],
  }).includes('phone'), true);
});

test('managed cover-letter detection requires an actual file input extraction', () => {
  const selector = coverLetterUploadSelector('greenhouse');
  assert.equal(managedResultHasCoverLetterUpload({ title: 'Apply', url: 'https://example.com', text: 'Cover letter is optional', extracted: [{ selector, value: 'file' }] }, 'greenhouse'), true);
  assert.equal(managedResultHasCoverLetterUpload({ title: 'Apply', url: 'https://example.com', text: 'Cover letter is optional', extracted: [{ selector: '#cover', label: 'cover_letter_capability', value: 'file' }] }, 'greenhouse'), true);
  assert.equal(managedResultHasCoverLetterUpload({ title: 'Apply', url: 'https://example.com', text: 'Cover letter is optional', extracted: [{ selector: '#resume', value: 'file' }] }, 'greenhouse'), false);
  assert.equal(managedResultHasCoverLetterUpload({ title: 'Apply', url: 'https://example.com', text: 'Cover letter is optional', extracted: [] }, 'greenhouse'), false);
  assert.equal(managedResultHasCoverLetterUpload(null, 'greenhouse'), false);
});

/* WHETHER THE EMPLOYER REQUIRES A COVER LETTER, read off the run's own required-field scan.
 *
 * cover_letter_supported answers "can Litos attach a PDF here" and nothing else, so something had
 * to answer "does this employer want one". Rather than a new browser capability, this reuses the
 * one list the product already trusts to say which fields an employer marked required: the same
 * blockers that carry native `required`, aria-required, Ashby's `_required_` label class and
 * Greenhouse's asterisk. The fill run never attaches an unapproved letter, so on a form that
 * requires one the control is empty when the scan runs and the scan names it.
 */
test('a required-field blocker naming the cover letter is what makes it required', () => {
  assert.equal(blockersRequireCoverLetter(['"Cover Letter" is required and is still empty']), true);
  assert.equal(blockersRequireCoverLetter(['"Cover letter" is required']), true);
  // The provider's own spelling, before sanitizeProviderBlockers has rewritten it.
  assert.equal(blockersRequireCoverLetter(['Cover Letter is required']), true);
  // A complete Cresta-shaped run: other fields, no cover letter line.
  assert.equal(blockersRequireCoverLetter([]), false);
  assert.equal(blockersRequireCoverLetter(['"Discipline" is required and is still empty']), false);
  assert.equal(blockersRequireCoverLetter(undefined), false);
  /* The two sentences that mention a cover letter and do not require one. The first is a live
     Greenhouse form's own page text, which is exactly the wording that would have made a naive
     substring match read "optional" as "required"; the second is the run's degrade notice, which
     rides in attention_reason next to the blockers. */
  assert.equal(blockersRequireCoverLetter(['Cover letter is optional']), false);
  assert.equal(blockersRequireCoverLetter([
    'We could not write your cover letter for this one, so it is not attached. Everything else is filled in, and you can write or retry a cover letter from your dashboard.',
  ]), false);
});

test('both run paths write the cover letter requirement and what they attached', () => {
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  // Measured on both providers, and only where there is a control to measure. A portal with no
  // cover-letter control leaves the field undefined, which the send gate reads as "not measured".
  const measured = runner.match(/cover_letter_required: blockersRequireCoverLetter\(/g) ?? [];
  assert.equal(measured.length, 2, 'the managed and direct paths must both measure it');
  const attached = runner.match(/cover_letter_attached: Boolean\(packet\.coverLetter\)/g) ?? [];
  assert.equal(attached.length, 2, 'both paths must record what the run actually carried');
  // The managed measurement reads the discovery pass too: that pass sees the form before the fill
  // and is where a required-and-empty control is most visible.
  assert.match(runner, /blockersRequireCoverLetter\(\[\s*\.\.\.blockers,\s*\.\.\.\(discoveryResult\?\.blockers \?\? \[\]\),/);
});

test('every portal detects a cover-letter file control, not optional wording alone', () => {
  for (const portal of ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'controlled_test'] as const) {
    const selector = coverLetterUploadSelector(portal);
    assert.match(selector, /type="file"/);
    assert.match(selector, /cover/i);
  }
});

test('SmartRecruiters managed actions open the application form before filling', () => {
  const actions = buildManagedPortalActions('smartrecruiters', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  // The JD page and the actual form are different URLs on SmartRecruiters (confirmed live,
  // 2026-07-24) - the first action must be the optional, bounded click that opens the form, so a
  // run started on the JD page still reaches the fields below it.
  assert.equal(actions[0].type, 'click');
  assert.equal(actions[0].optional, true);
  const fillSelectors = actions.filter((a) => a.type === 'fill').map((a) => a.selector);
  assert.ok(fillSelectors.includes('spl-input#first-name-input input'));
  assert.ok(fillSelectors.includes('spl-input#email-input input'));
  assert.ok(fillSelectors.includes('spl-input#confirm-email-input input'));
  assert.equal(fillSelectors.some((selector) => selector?.includes('[id="first-name-input"]')), false);
});

test('opens Ashby directly on its application tab for managed filling', () => {
  const databricksUrl = 'https://databricks.com/company/careers/open-positions/job?gh_jid=6883068002';
  const canonical = 'https://boards.greenhouse.io/embed/job_app?token=6883068002';
  assert.equal(detectPortal(databricksUrl), 'greenhouse');
  assert.equal(canonicalSupportedPortalUrl(databricksUrl, 'greenhouse'), canonical);
  assert.equal(portalApplicationUrl('greenhouse', canonical), canonical);
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

test('Ashby fills split custom first and last name fields when present', () => {
  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Mehek Mandal',
    email: 'mehek@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });

  assert.ok(actions.some((action) => action.type === 'fillByLabelText' && action.text === 'First Name' && action.value === 'Mehek'));
  assert.ok(actions.some((action) => action.type === 'fillByLabelText' && action.text === 'Last Name / Surname' && action.value === 'Mandal'));
});

test('rejects insecure and lookalike portal URLs', () => {
  assert.throws(() => detectPortal('http://boards.greenhouse.io/acme/jobs/123'), /secure link/);
  assert.throws(() => detectPortal('https://databricks.com/company/careers/open-positions/job'), /cannot fill in/);
  assert.throws(() => detectPortal('https://databricks.com/company/careers/open-positions/job?gh_jid=abc'), /cannot fill in/);
  assert.throws(() => detectPortal('https://databricks.com/company/careers/open-positions?gh_jid=6883068002'), /cannot fill in/);
  assert.throws(() => detectPortal('https://www.databricks.com/company/careers/product/product-management-intern-summer-2027-111?gh_jid=6883068002'), /cannot fill in/);
  assert.throws(() => detectPortal('https://www.fivetran.com/careers/job?gh_jid=1'), /cannot fill in/);
  assert.throws(() => detectPortal('https://nuro.ai/careers?gh_jid=4512345'), /cannot fill in/);
  assert.throws(() => detectPortal('https://greenhouse.io.attacker.example/acme'), /cannot fill in/);
  assert.throws(() => detectPortal('https://example.com/apply'), /cannot fill in/);
});

test('controlled portal is gated by an explicit server flag', () => {
  const previous = {
    enabled: process.env.LITOS_ENABLE_TEST_PORTAL,
    nodeEnv: process.env.NODE_ENV,
  };
  try {
    process.env.NODE_ENV = 'test';
    delete process.env.LITOS_ENABLE_TEST_PORTAL;
    assert.throws(() => detectPortal('http://localhost:3000/qa/portal-submission'), /secure link|cannot fill in/);
    process.env.LITOS_ENABLE_TEST_PORTAL = 'true';
    assert.equal(detectPortal('http://localhost:3000/qa/portal-submission'), 'controlled_test');
    assert.equal(detectPortal('http://localhost:3000/qa/portal-submission?board=lever'), 'controlled_lever');
    assert.equal(detectPortal('http://localhost:3000/qa/portal-submission?board=ashby'), 'controlled_ashby');
    assert.equal(
      detectPortal('http://localhost:3000/qa/portal-submission?board=smartrecruiters'),
      'controlled_smartrecruiters',
    );
    assert.equal(detectPortal('http://localhost:3000/qa/portal-submission/lever/lever-02'), 'controlled_lever');
    assert.equal(detectPortal('http://localhost:3000/qa/portal-submission/ashby/ashby-03'), 'controlled_ashby');
    assert.equal(
      detectPortal('http://localhost:3000/qa/portal-submission/smartrecruiters/smartrecruiters-04'),
      'controlled_smartrecruiters',
    );
  } finally {
    if (previous.enabled === undefined) delete process.env.LITOS_ENABLE_TEST_PORTAL;
    else process.env.LITOS_ENABLE_TEST_PORTAL = previous.enabled;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
  }
});

test('a signed non-production portal tunnel reaches the controlled adapter and nothing else does', () => {
  const saved = {
    enabled: process.env.LITOS_ENABLE_TEST_PORTAL,
    origin: process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN,
    secret: process.env.LITOS_TEST_PORTAL_BINDING_SECRET,
    nodeEnv: process.env.NODE_ENV,
  };
  try {
    process.env.LITOS_ENABLE_TEST_PORTAL = 'true';
    process.env.NODE_ENV = 'test';
    process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN = 'https://qa-tunnel.example.test';
    process.env.LITOS_TEST_PORTAL_BINDING_SECRET = '0123456789abcdef0123456789abcdef';
    const unsigned = 'https://qa-tunnel.example.test/qa/portal-submission?board=greenhouse&shape=security-code&case=run-1';
    const signed = new URL(unsigned);
    signed.searchParams.set(
      CONTROLLED_PORTAL_BINDING_PARAM,
      controlledPortalBinding(unsigned, process.env.LITOS_TEST_PORTAL_BINDING_SECRET),
    );
    assert.equal(detectPortal(signed.toString()), 'controlled_test');
    assert.throws(() => detectPortal(unsigned), /cannot fill in/);
    assert.throws(() => detectPortal(signed.toString().replace('run-1', 'run-2')), /cannot fill in/);
    assert.throws(() => detectPortal(signed.toString().replace('qa-tunnel', 'employer')), /cannot fill in/);
  } finally {
    if (saved.enabled === undefined) delete process.env.LITOS_ENABLE_TEST_PORTAL;
    else process.env.LITOS_ENABLE_TEST_PORTAL = saved.enabled;
    if (saved.origin === undefined) delete process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN;
    else process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN = saved.origin;
    if (saved.secret === undefined) delete process.env.LITOS_TEST_PORTAL_BINDING_SECRET;
    else process.env.LITOS_TEST_PORTAL_BINDING_SECRET = saved.secret;
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
  }
});

test('controlled portal variants exercise every real adapter selector family', () => {
  const packet = {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+1 213 555 0100',
    city: 'Los Angeles',
    linkedinUrl: 'https://linkedin.com/in/taylor',
    githubUrl: 'https://github.com/taylor',
    portfolioUrl: 'https://taylor.example',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  };
  const selectors = new Map([
    ['controlled_test', '#first_name'],
    ['controlled_lever', 'input[name="name"]'],
    ['controlled_ashby', 'input[name="_systemfield_name"]'],
    ['controlled_smartrecruiters', '[id="first-name-input"]'],
  ] as const);
  for (const [portal, expected] of selectors) {
    const actions = buildManagedPortalActions(portal, packet, true);
    assert.ok(actions.some((action) => action.type === 'fill' && action.selector?.includes(expected)));
    // A submit click is appended only where the portal can actually finish. SmartRecruiters moved
    // out of that group on 2026-07-28: it was always step-one-only, and used to rely on the weaker
    // guarantee that clickFinalSubmit would find nothing to press. Once the jobs board started
    // deriving what to SHOW from portalCanAutoSubmit, a predicate that lied about SmartRecruiters
    // would have surfaced postings the student could never complete.
    assert.equal(
      actions.at(-1)?.type === 'confirmAndSubmit',
      portalCanAutoSubmit(portal),
      `${portal}: a submit click must appear if and only if the portal can finish alone`,
    );
  }
});

test('the jobs board may only source from portals Litos can finish alone', () => {
  // The guarantee behind "only surface jobs we can complete autonomously". POLLABLE_JOB_BOARDS is
  // constrained to AutonomousPortalFamily at compile time; this asserts the runtime lists agree, so
  // a widening that somehow slips past the type checker still fails here.
  for (const board of POLLABLE_JOB_BOARDS) {
    assert.equal(portalCanAutoSubmit(board), true, `${board} is polled but cannot finish alone`);
    assert.ok(isAutonomousPortalFamily(board), board);
  }
  // The portals that must never reach the board, and why.
  for (const blocked of ['smartrecruiters', 'jazzhr', 'paylocity'] as const) {
    assert.equal(portalCanAutoSubmit(blocked), false, blocked);
    assert.equal(isAutonomousPortalFamily(blocked), false, blocked);
    assert.equal((POLLABLE_JOB_BOARDS as readonly string[]).includes(blocked), false, blocked);
  }
  // Workable can finish alone and has a public-board fetcher, so it belongs on the jobs board.
  assert.equal(isAutonomousPortalFamily('workable'), true);
  assert.equal((POLLABLE_JOB_BOARDS as readonly string[]).includes('workable'), true);
});

test('managed controlled-portal actions include reviewed fields, resume upload, and final submit', () => {
  const actions = buildManagedPortalActions('controlled_test', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [{ question: 'Why this role?', answer: 'I enjoy systems work.' }],
  }, true);
  assert.deepEqual(
    actions
      .filter((action) =>
        action.type !== 'select'
        && !isGreenhousePreflightClick(action)
        && !isGreenhouseFixedCandidatePrivacyClick(action))
      .map((action) => action.type),
    [
      'waitForSelector',
      'waitForSelector',
      'fill',
      'fill',
      'fillByLabelText',
      'fillByLabelText',
      'fill',
      'upload',
      'upload',
      'upload',
      'fillByLabelText',
      'confirmAndSubmit',
    ],
  );
  assert.ok(actions.some((action) => action.type === 'select' && action.label?.startsWith('question_select:')));
  assert.equal(actions.find((action) => action.type === 'upload')?.file?.base64, 'cGRm');
  const hydration = actions.find((action) => action.label === 'controlled_portal_hydrated');
  assert.deepEqual(hydration, {
    type: 'waitForSelector',
    selector: 'form[data-litos-controlled-portal][data-litos-qa-ready="1"]',
    label: 'controlled_portal_hydrated',
    optional: false,
    timeout: 10_000,
  });
  assert.ok(actions.indexOf(hydration!) < actions.findIndex((action) => action.label === 'first_name'));
  assert.ok(actions.indexOf(hydration!) < actions.findIndex((action) => action.type === 'confirmAndSubmit'));
});

test('controlled hydration survives every budget trim before preview, submit, and discovery mutations', () => {
  const packet = {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: Array.from({ length: 100 }, (_, index) => ({
      question: `Why are you interested in area ${index + 1}?`,
      answer: `Grounded answer ${index + 1}`,
    })),
  };
  const lists = {
    preview: buildManagedPortalActions('controlled_test', packet, false),
    submit: buildManagedPortalActions('controlled_test', packet, true),
    discovery: buildManagedDiscoveryActions('controlled_test', packet),
  };
  const mutationTypes = new Set(['click', 'fill', 'fillByLabelText', 'upload', 'select', 'press', 'confirmAndSubmit']);
  for (const [name, actions] of Object.entries(lists)) {
    assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `${name} exceeded the managed action budget`);
    const hydrationIndex = actions.findIndex((action) => action.label === 'controlled_portal_hydrated');
    const firstMutationIndex = actions.findIndex((action) => mutationTypes.has(action.type));
    assert.equal(hydrationIndex, 0, `${name} lost or moved the hydration barrier`);
    assert.ok(firstMutationIndex > hydrationIndex, `${name} can mutate the SSR form before hydration`);
    assert.equal(actions[hydrationIndex]?.optional, false, `${name} hydration barrier must fail closed`);
  }
  const submitActions = lists.submit;
  assert.ok(submitActions.findIndex((action) => action.type === 'confirmAndSubmit') > 0);
});

test('managed portals upload a tailored cover letter without replacing the resume', () => {
  for (const portal of ['greenhouse', 'lever', 'ashby'] as const) {
    const actions = buildManagedPortalActions(portal, {
      fullName: 'Taylor Example',
      email: 'taylor@example.com',
      resume: Buffer.from('resume-pdf'),
      resumeName: 'resume.pdf',
      coverLetter: Buffer.from('cover-pdf'),
      coverLetterName: 'cover-letter.pdf',
      questions: [],
    });
    const uploads = actions.filter((action) => action.type === 'upload');
    const resumeUploads = uploads.filter((action) => action.label === 'resume');
    const coverLetterUploads = uploads.filter((action) => action.label === 'cover_letter');
    assert.ok(resumeUploads.length >= 1);
    assert.equal(coverLetterUploads.length, 1);
    assert.ok(resumeUploads.every((action) => action.file?.name === 'resume.pdf'));
    assert.equal(coverLetterUploads[0]?.file?.name, 'cover-letter.pdf');
    assert.ok(resumeUploads.every((action) => action.selector !== coverLetterUploads[0]?.selector));
    if (portal === 'greenhouse') assert.doesNotMatch(coverLetterUploads[0]?.selector ?? '', /(^|,\s*)#cover_letter/);
    if (portal === 'ashby') assert.doesNotMatch(resumeUploads[0]?.selector ?? '', /cover/i);
  }
});

test('Ashby targets its real resume and optional cover-letter input ids', () => {
  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    coverLetter: Buffer.from('cover-pdf'),
    coverLetterName: 'cover-letter.pdf',
    questions: [],
  });
  const uploads = actions.filter((action) => action.type === 'upload');
  assert.match(uploads[0]?.selector ?? '', /#_systemfield_resume/);
  assert.doesNotMatch(uploads[0]?.selector ?? '', /input\[type="file"\]$/);
  assert.match(uploads[1]?.selector ?? '', /#cover_letter/);
  assert.match(coverLetterUploadSelector('ashby'), /#cover_letter/);
});

test('Ashby targets live phone and label-bound profile fields', () => {
  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '5550100000',
    linkedinUrl: 'https://linkedin.com/in/taylor-example',
    portfolioUrl: 'https://example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const fills = actions.filter((action) => action.type === 'fill');
  assert.match(fills.find((action) => action.label === 'phone')?.selector ?? '', /#phone/);
  assert.match(fills.find((action) => action.label === 'linkedin')?.selector ?? '', /LinkedIn Profile/);
  assert.match(fills.find((action) => action.label === 'portfolio')?.selector ?? '', /Website/);
});

test('phone fills recognize safe semantic phone controls without matching prose text inputs', () => {
  // Regression: ISSUE-001, live Deepgram and CTC forms left Phone empty even though the saved
  // profile contained a value. Those forms expose the control through type, autocomplete, or its
  // visible phone label instead of the small set of exact ids and names previously recognized.
  // Found by /qa on 2026-07-25.
  // Report: outputs/litos-10-application-trials-2026-07-25.md
  for (const portal of ['greenhouse', 'ashby'] as const) {
    const actions = buildManagedPortalActions(portal, {
      fullName: 'Taylor Example',
      email: 'taylor@example.com',
      phone: '+971 50 123 4567',
      resume: Buffer.from('resume-pdf'),
      resumeName: 'resume.pdf',
      questions: [],
    });
    const selector = actions.find((action) => action.type === 'fill' && action.label === 'phone')?.selector ?? '';
    assert.match(selector, /input\[type="tel"/);
    assert.match(selector, /autocomplete\*="tel"/);
    assert.match(selector, /Phone/);
    assert.doesNotMatch(selector, /input\[type="text"\](?:,|$)/);
  }
});

test('Rippling phone widget receives only the national number', () => {
  const packet = {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 567417451',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  };
  const value = buildManagedPortalActions('rippling', packet)
    .find((action) => action.type === 'fill' && action.label === 'phone')?.value;
  assert.equal(value, '567417451');
});

test('single phone-input portals keep the saved international phone value', () => {
  const packet = {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 567417451',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  };
  for (const portal of ['greenhouse', 'ashby', 'smartrecruiters', 'lever'] as const) {
    const value = buildManagedPortalActions(portal, packet)
      .find((action) => action.type === 'fill' && action.label === 'phone')?.value;
    assert.equal(value, '+971 567417451', portal);
  }
});

test('Greenhouse managed fill selects phone country and city comboboxes', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 50 123 4567',
    city: 'Dubai',
    country: 'United Arab Emirates',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const phoneCountryIndex = actions.findIndex((action) => action.label === 'phone_country');
  assert.ok(phoneCountryIndex >= 0);
  assert.deepEqual(actions.slice(phoneCountryIndex, phoneCountryIndex + 2), [
    {
      type: 'fill',
      selector: '#country',
      value: 'United Arab Emirates',
      label: 'phone_country',
      optional: true,
      timeout: 10_000,
    },
    {
      type: 'press',
      selector: '#country',
      value: 'Enter',
      label: 'phone_country_select',
      optional: true,
      timeout: 10_000,
    },
  ]);

  const locationIndex = actions.findIndex((action) => action.label === 'location');
  assert.ok(locationIndex >= 0);
  assert.deepEqual(actions.slice(locationIndex, locationIndex + 2), [
    {
      type: 'fill',
      selector: '#candidate-location, input[autocomplete="address-level2"]',
      value: 'Dubai, United Arab Emirates',
      label: 'location',
      optional: true,
      timeout: 10_000,
    },
    {
      type: 'press',
      selector: '#candidate-location, input[autocomplete="address-level2"]',
      value: 'Enter',
      label: 'location_select',
      optional: true,
      timeout: 10_000,
    },
  ]);
});

function directFillPage(
  selectors: string[],
  behavior: {
    isVisible?: (selector: string, present: boolean) => boolean;
    getAttribute?: (selector: string, name: string) => string | null;
    onPress?: (selector: string, key: string, values: Map<string, string>) => void;
  } = {},
) {
  const values = new Map<string, string>();
  const makeLocator = (selector: string, index?: number): any => {
    const present = selectors.includes(selector);
    return {
      first: () => makeLocator(selector, 0),
      nth: (nextIndex: number) => makeLocator(selector, nextIndex),
      count: async () => (present ? 1 : 0),
      isVisible: async () => behavior.isVisible?.(selector, present) ?? present,
      fill: async (value: string) => {
        if (present) values.set(selector, value);
      },
      press: async (key: string) => {
        if (present) {
          values.set(`${selector}::press`, key);
          behavior.onPress?.(selector, key, values);
        }
      },
      selectOption: async (option: string | { label?: string }) => {
        if (!present) return [];
        const value = typeof option === 'string' ? option : option.label;
        if (!value) return [];
        values.set(selector, value);
        return [value];
      },
      getAttribute: async (name: string) => behavior.getAttribute?.(selector, name) ?? null,
      inputValue: async () => values.get(selector) ?? '',
      locator: () => makeLocator(`${selector} child`, 0),
      evaluate: async () => false,
      waitFor: async () => undefined,
      click: async () => undefined,
    };
  };
  const page = {
    values,
    page: {
      locator: (selector: string) => makeLocator(selector),
      getByText: () => makeLocator('missing text'),
    } as unknown as Page,
  };
  return page;
}

test('direct Rippling fill writes only the national phone number', async () => {
  const { page, values } = directFillPage([
    '[data-testid="input-first_name"]',
    '[data-testid="input-last_name"]',
    '[data-testid="input-email"]',
    '[data-testid="input-phone_number"]',
  ]);
  await fillPortal(page, 'rippling', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 567417451',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  assert.equal(values.get('[data-testid="input-phone_number"]'), '567417451');
});

test('direct single phone-input fill keeps the saved international phone value', async () => {
  const { page, values } = directFillPage(['input[name="name"]', 'input[name="email"]', 'input[name="phone"]']);
  await fillPortal(page, 'lever', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 567417451',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  assert.equal(values.get('input[name="phone"]'), '+971 567417451');
});

test('direct Greenhouse fill confirms phone country and city comboboxes', async () => {
  const { page, values } = directFillPage([
    '#first_name',
    '#last_name',
    '#email',
    '#country',
    '#phone',
    '#candidate-location',
  ]);
  await fillPortal(page, 'greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 50 123 4567',
    city: 'Dubai',
    country: 'United Arab Emirates',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  assert.equal(values.get('#country'), 'United Arab Emirates');
  assert.equal(values.get('#country::press'), 'Enter');
  assert.equal(values.get('#phone'), '+971 50 123 4567');
  assert.equal(values.get('#candidate-location'), 'Dubai, United Arab Emirates');
  assert.equal(values.get('#candidate-location::press'), 'Enter');
});

test('direct Greenhouse reviewed graduation fill prefers packet date over stale reviewed answer', async () => {
  const graduationSelector = 'input[id="question_123"]';
  const { page, values } = directFillPage([
    '#first_name',
    '#last_name',
    '#email',
    graduationSelector,
  ]);
  await fillPortal(page, 'greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    graduationDate: 'May 2028',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'What is your graduation date?',
        answer: 'May 2027',
        portalSelector: graduationSelector,
      },
    ],
  });
  assert.equal(values.get(graduationSelector), 'May 2028');
});

test('direct Greenhouse replay replaces a stale company-site answer with evidenced Job board', async () => {
  const referralSelector = 'input[id="question_referral"]';
  const { page, values } = directFillPage([
    '#first_name',
    '#last_name',
    '#email',
    referralSelector,
  ]);
  await fillPortal(page, 'greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    referralSourceDefault: 'Job board',
    referralSourceEvidence: JOB_BOARD_REFERRAL_EVIDENCE,
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [{
      question: 'How did you hear about this role?',
      answer: 'Company website',
      portalSelector: referralSelector,
    }],
  });
  assert.equal(values.get(referralSelector), 'Job board');
});

function absentWorkableLocator(): any {
  const locator: any = {
    first: () => locator,
    nth: () => absentWorkableLocator(),
    count: async () => 0,
    isVisible: async () => false,
    inputValue: async () => '',
    innerText: async () => '',
    textContent: async () => '',
    getAttribute: async () => null,
    locator: () => absentWorkableLocator(),
    getByLabel: () => absentWorkableLocator(),
    getByRole: () => absentWorkableLocator(),
    getByText: () => absentWorkableLocator(),
    evaluate: async () => false,
    press: async () => undefined,
    click: async () => undefined,
    fill: async () => undefined,
    uncheck: async () => undefined,
    isChecked: async () => false,
  };
  return locator;
}

function oneWorkableLocator(overrides: Record<string, unknown> = {}): any {
  const locator: any = {
    count: async () => 1,
    isVisible: async () => true,
    inputValue: async () => '',
    innerText: async () => '',
    textContent: async () => '',
    getAttribute: async () => null,
    locator: () => absentWorkableLocator(),
    getByLabel: () => absentWorkableLocator(),
    getByRole: () => absentWorkableLocator(),
    getByText: () => absentWorkableLocator(),
    evaluate: async () => false,
    press: async () => undefined,
    click: async () => undefined,
    fill: async () => undefined,
    check: async () => undefined,
    uncheck: async () => undefined,
    isChecked: async () => false,
    ...overrides,
  };
  locator.first = () => locator;
  locator.nth = (index: number) => index === 0 ? locator : absentWorkableLocator();
  return locator;
}

function workablePhoneUploadFixture(
  countryOptionCount = 1,
  overwritePhoneAfterMs?: number,
  overwritePhoneValue = '',
  requiredCityPhoneOverwrite?: string,
  lateCookieModal = false,
  cookieDeclineClears = true,
  usCountryOptionCount = 1,
) {
  const events: string[] = [];
  const queriedSelectors: string[] = [];
  let phoneValue = '';
  let countryText = '+1';
  let countryMenuOpen = false;
  let countryOptionClicks = 0;
  let elapsedAfterPhoneFill = 0;
  let cookieDialogPresent = false;
  let cookieBackdropPresent = false;

  const phone = oneWorkableLocator({
    getAttribute: async (name: string) => {
      if (name === 'type') return 'tel';
      if (name === 'name') return 'phone';
      return null;
    },
    inputValue: async () => phoneValue,
    fill: async (value: string) => {
      phoneValue = value;
      elapsedAfterPhoneFill = 0;
      events.push(`phone:${value}`);
    },
  });
  const countryTrigger = oneWorkableLocator({
    innerText: async () => countryText,
    textContent: async () => countryText,
    click: async () => {
      if (cookieDialogPresent || cookieBackdropPresent) {
        events.push('country:blocked-by-cookie');
        throw new Error('cookie overlay intercepted the country trigger');
      }
      countryMenuOpen = true;
      events.push('country:open');
    },
  });
  const countryOptions = Array.from({ length: countryOptionCount }, () => oneWorkableLocator({
    isVisible: async () => countryMenuOpen,
    click: async () => {
      countryOptionClicks += 1;
      countryText = '+971';
      countryMenuOpen = false;
      events.push('country:ae');
    },
  }));
  const countryOptionLocator: any = {
    count: async () => countryOptions.length,
    first: () => countryOptions[0] ?? absentWorkableLocator(),
    nth: (index: number) => countryOptions[index] ?? absentWorkableLocator(),
  };
  const usCountryOptions = Array.from({ length: usCountryOptionCount }, () => oneWorkableLocator({
    isVisible: async () => countryMenuOpen,
    click: async () => {
      countryOptionClicks += 1;
      countryText = '+1';
      countryMenuOpen = false;
      events.push('country:us');
    },
  }));
  const usCountryOptionLocator: any = {
    count: async () => usCountryOptions.length,
    first: () => usCountryOptions[0] ?? absentWorkableLocator(),
    nth: (index: number) => usCountryOptions[index] ?? absentWorkableLocator(),
  };
  const resume = oneWorkableLocator({
    getAttribute: async (name: string) => name === 'type' ? 'file' : null,
    setInputFiles: async () => {
      phoneValue = '';
      countryText = '+1';
      events.push('resume:upload-and-autofill');
      if (lateCookieModal) {
        cookieDialogPresent = true;
        cookieBackdropPresent = true;
        events.push('cookie:late-open');
      }
    },
  });
  const cookieDialog = oneWorkableLocator({
    count: async () => cookieDialogPresent ? 1 : 0,
    isVisible: async () => cookieDialogPresent,
  });
  const cookieBackdrop = oneWorkableLocator({
    count: async () => cookieBackdropPresent ? 1 : 0,
    isVisible: async () => cookieBackdropPresent,
  });
  const declineCookies = oneWorkableLocator({
    count: async () => cookieDialogPresent ? 1 : 0,
    isVisible: async () => cookieDialogPresent,
    click: async () => {
      if (!cookieDialogPresent) throw new Error('cookie dialog is absent');
      events.push('cookie:decline');
      if (cookieDeclineClears) {
        cookieDialogPresent = false;
        cookieBackdropPresent = false;
        events.push('cookie:cleared');
      }
    },
  });
  const cookieOverlayCleared = oneWorkableLocator({
    count: async () => cookieDialogPresent || cookieBackdropPresent ? 0 : 1,
    isVisible: async () => !cookieDialogPresent && !cookieBackdropPresent,
    waitFor: async () => {
      events.push('cookie:wait-cleared');
      if (cookieDialogPresent || cookieBackdropPresent) {
        throw new Error('cookie overlay did not clear');
      }
    },
  });
  let cityValue = '';
  const city = oneWorkableLocator({
    getAttribute: async (name: string) => {
      if (name === 'type') return 'text';
      if (name === 'name') return 'city';
      return null;
    },
    inputValue: async () => cityValue,
    evaluate: async () => 'INPUT',
    fill: async (value: string) => {
      cityValue = value;
      phoneValue = requiredCityPhoneOverwrite ?? phoneValue;
      if (requiredCityPhoneOverwrite !== undefined) countryText = '+1';
      events.push(`required-city:${value}:phone:${phoneValue}`);
    },
  });
  const requiredFields = requiredCityPhoneOverwrite === undefined ? [phone] : [phone, city];
  const requiredLocator: any = {
    count: async () => requiredFields.length,
    first: () => requiredFields[0] ?? absentWorkableLocator(),
    nth: (index: number) => requiredFields[index] ?? absentWorkableLocator(),
  };
  const page: any = {
    locator: (selector: string) => {
      queriedSelectors.push(selector);
      if (selector === 'input[name="phone"]'
        || selector === 'input[name="phone"][type="tel"]:visible') return phone;
      if (selector === 'input[required], textarea[required], select[required]') return requiredLocator;
      if (selector === 'div[role="dialog"][data-ui="cookie-consent"][aria-label="Cookie Consent"]') {
        return cookieDialog;
      }
      if (selector === 'div[data-ui="backdrop"]') return cookieBackdrop;
      if (selector === 'div[role="dialog"][data-ui="cookie-consent"][aria-label="Cookie Consent"] button:has-text("Decline all")') {
        return declineCookies;
      }
      if (selector === 'body:not(:has(div[role="dialog"][data-ui="cookie-consent"][aria-label="Cookie Consent"])):not(:has(div[data-ui="backdrop"]))') {
        return cookieOverlayCleared;
      }
      if (selector === 'div[role="combobox"][aria-label="Telephone country code"][aria-controls]:visible') {
        return countryTrigger;
      }
      if (selector === '[role="option"][data-country-code="ae"][data-dial-code="971"][id$="__item-ae"]:visible') {
        return countryOptionLocator;
      }
      if (selector === '[role="option"][data-country-code="us"][data-dial-code="1"][id$="__item-us"]:visible') {
        return usCountryOptionLocator;
      }
      if (selector === 'input[type="file"][data-ui="resume"]') return resume;
      return absentWorkableLocator();
    },
    waitForTimeout: async (milliseconds: number) => {
      if (!overwritePhoneAfterMs || phoneValue !== '0567417451') return;
      elapsedAfterPhoneFill += milliseconds;
      if (elapsedAfterPhoneFill >= overwritePhoneAfterMs) {
        phoneValue = overwritePhoneValue;
        events.push(overwritePhoneValue
          ? `phone:delayed-autofill-overwrite:${overwritePhoneValue}`
          : 'phone:delayed-autofill-clear');
      }
    },
  };

  return {
    page,
    events,
    queriedSelectors,
    countryOptionClicks: () => countryOptionClicks,
    countryText: () => countryText,
    phoneValue: () => phoneValue,
    cityValue: () => cityValue,
  };
}

test('direct Workable phone is selected and refilled after resume autofill clears it', async () => {
  const fixture = workablePhoneUploadFixture();
  const result = await fillPortal(fixture.page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 567417451',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });

  const uploadIndex = fixture.events.indexOf('resume:upload-and-autofill');
  const cookieClearedIndex = fixture.events.indexOf('cookie:wait-cleared');
  const openIndex = fixture.events.indexOf('country:open');
  const optionIndex = fixture.events.indexOf('country:ae');
  const phoneIndex = fixture.events.indexOf('phone:0567417451');
  assert.ok(uploadIndex >= 0);
  assert.ok(cookieClearedIndex > uploadIndex, fixture.events.join(', '));
  assert.ok(openIndex > cookieClearedIndex, fixture.events.join(', '));
  assert.equal(fixture.events.includes('cookie:decline'), false, fixture.events.join(', '));
  assert.ok(openIndex > uploadIndex, fixture.events.join(', '));
  assert.ok(optionIndex > openIndex, fixture.events.join(', '));
  assert.ok(phoneIndex > optionIndex, fixture.events.join(', '));
  assert.equal(fixture.countryText(), '+971');
  assert.equal(fixture.phoneValue(), '0567417451');
  assert.ok(fixture.queriedSelectors.includes(
    'div[role="combobox"][aria-label="Telephone country code"][aria-controls]:visible',
  ));
  assert.equal(fixture.queriedSelectors.includes(
    'button[aria-label="Telephone country code"][aria-controls]:visible',
  ), false);
  assert.ok(result.filledFields.includes('phone'));
  assert.equal(result.blockers.some((blocker) => /phone/i.test(blocker)), false);
});

test('direct Workable phone declines a cookie modal that appears after resume parsing', async () => {
  const fixture = workablePhoneUploadFixture(1, undefined, '', undefined, true);
  const result = await fillPortal(fixture.page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 567417451',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });

  const uploadIndex = fixture.events.indexOf('resume:upload-and-autofill');
  const lateOpenIndex = fixture.events.indexOf('cookie:late-open');
  const declineIndex = fixture.events.indexOf('cookie:decline');
  const clearedIndex = fixture.events.indexOf('cookie:cleared');
  const clearedProofIndex = fixture.events.indexOf('cookie:wait-cleared');
  const countryIndex = fixture.events.indexOf('country:open');
  assert.ok(lateOpenIndex > uploadIndex, fixture.events.join(', '));
  assert.ok(declineIndex > lateOpenIndex, fixture.events.join(', '));
  assert.ok(clearedIndex > declineIndex, fixture.events.join(', '));
  assert.ok(clearedProofIndex > clearedIndex, fixture.events.join(', '));
  assert.ok(countryIndex > clearedProofIndex, fixture.events.join(', '));
  assert.equal(fixture.events.includes('country:blocked-by-cookie'), false, fixture.events.join(', '));
  assert.equal(fixture.countryText(), '+971');
  assert.equal(fixture.phoneValue(), '0567417451');
  assert.ok(result.filledFields.includes('phone'));
  assert.equal(result.blockers.some((blocker) => /phone/i.test(blocker)), false);
});

test('direct Workable US phone selects United States and writes exact national digits', async () => {
  const fixture = workablePhoneUploadFixture(1, undefined, '', undefined, true);
  const result = await fillPortal(fixture.page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+1 213 574 6270',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });

  const lateOpenIndex = fixture.events.indexOf('cookie:late-open');
  const declineIndex = fixture.events.indexOf('cookie:decline');
  const clearedProofIndex = fixture.events.indexOf('cookie:wait-cleared');
  const countryIndex = fixture.events.indexOf('country:us');
  const phoneIndex = fixture.events.indexOf('phone:2135746270');
  assert.ok(declineIndex > lateOpenIndex, fixture.events.join(', '));
  assert.ok(clearedProofIndex > declineIndex, fixture.events.join(', '));
  assert.ok(countryIndex > clearedProofIndex, fixture.events.join(', '));
  assert.ok(phoneIndex > countryIndex, fixture.events.join(', '));
  assert.equal(fixture.events.includes('country:ae'), false, fixture.events.join(', '));
  assert.equal(fixture.countryText(), '+1');
  assert.equal(fixture.phoneValue(), '2135746270');
  assert.ok(result.filledFields.includes('phone'));
  assert.equal(result.blockers.some((blocker) => /phone/i.test(blocker)), false);
});

test('direct Workable phone fails closed for malformed and unsupported international numbers', async () => {
  for (const phone of ['+442071234567', '+1 213', '+971 50', '+abc']) {
    const fixture = workablePhoneUploadFixture();
    const result = await fillPortal(fixture.page, 'workable', {
      fullName: 'Taylor Example',
      email: 'taylor@example.com',
      phone,
      resume: Buffer.from('resume-pdf'),
      resumeName: 'resume.pdf',
      questions: [],
    });

    assert.equal(fixture.events.includes('country:open'), false, phone);
    assert.equal(fixture.events.includes('country:ae'), false, phone);
    assert.equal(fixture.events.includes('country:us'), false, phone);
    assert.equal(fixture.phoneValue(), '', phone);
    assert.equal(result.filledFields.includes('phone'), false, phone);
    assert.ok(result.blockers.some((blocker) => /phone/i.test(blocker)), `${phone}: ${result.blockers}`);
  }
});

test('direct Workable phone fails closed when the late cookie backdrop does not unmount', async () => {
  const fixture = workablePhoneUploadFixture(1, undefined, '', undefined, true, false);
  const result = await fillPortal(fixture.page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 567417451',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });

  assert.ok(fixture.events.includes('cookie:decline'), fixture.events.join(', '));
  assert.ok(fixture.events.includes('cookie:wait-cleared'), fixture.events.join(', '));
  assert.equal(fixture.events.includes('country:open'), false, fixture.events.join(', '));
  assert.equal(fixture.phoneValue(), '');
  assert.equal(result.filledFields.includes('phone'), false);
  assert.ok(result.blockers.some((blocker) => /phone/i.test(blocker)), JSON.stringify(result.blockers));
});

test('direct Workable phone runs after a required City fallback overwrites the widget', async () => {
  const fixture = workablePhoneUploadFixture(1, undefined, '', '0501234567');
  const result = await fillPortal(fixture.page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 567417451',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    applicationProfile: { address_city: 'Dubai' },
    questions: [],
  });

  const cityIndex = fixture.events.findIndex((event) => event === 'required-city:Dubai:phone:0501234567');
  const countryIndex = fixture.events.findIndex((event) => event === 'country:ae');
  const finalPhoneIndex = fixture.events.findIndex((event) => event === 'phone:0567417451');
  assert.ok(cityIndex >= 0, fixture.events.join(', '));
  assert.ok(countryIndex > cityIndex, fixture.events.join(', '));
  assert.ok(finalPhoneIndex > countryIndex, fixture.events.join(', '));
  assert.equal(fixture.cityValue(), 'Dubai');
  assert.equal(fixture.countryText(), '+971');
  assert.equal(fixture.phoneValue(), '0567417451');
  assert.ok(result.filledFields.includes('phone'));
  assert.equal(result.blockers.some((blocker) => /phone/i.test(blocker)), false);
});

test('direct Workable phone refuses an ambiguous exact UAE option', async () => {
  const fixture = workablePhoneUploadFixture(2);
  const result = await fillPortal(fixture.page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 567417451',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });

  assert.equal(fixture.countryOptionClicks(), 0);
  assert.equal(fixture.phoneValue(), '');
  assert.equal(result.filledFields.includes('phone'), false);
  assert.ok(result.blockers.some((blocker) => /phone/i.test(blocker)), JSON.stringify(result.blockers));
});

test('direct Workable phone fails closed when delayed autofill clears an initially successful refill', async () => {
  const fixture = workablePhoneUploadFixture(1, 900);
  const result = await fillPortal(fixture.page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 567417451',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });

  assert.ok(fixture.events.includes('phone:0567417451'), fixture.events.join(', '));
  assert.ok(fixture.events.includes('phone:delayed-autofill-clear'), fixture.events.join(', '));
  assert.equal(fixture.phoneValue(), '');
  assert.equal(result.filledFields.includes('phone'), false);
  assert.ok(result.blockers.some((blocker) => /phone/i.test(blocker)), JSON.stringify(result.blockers));
});

test('direct Workable phone fails closed when delayed autofill overwrites the refill with a wrong nonempty value', async () => {
  const fixture = workablePhoneUploadFixture(1, 900, '0501234567');
  const result = await fillPortal(fixture.page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 567417451',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });

  assert.ok(fixture.events.includes('phone:0567417451'), fixture.events.join(', '));
  assert.ok(
    fixture.events.includes('phone:delayed-autofill-overwrite:0501234567'),
    fixture.events.join(', '),
  );
  assert.equal(fixture.phoneValue(), '');
  assert.equal(result.filledFields.includes('phone'), false);
  assert.ok(result.blockers.some((blocker) => /phone/i.test(blocker)), JSON.stringify(result.blockers));
});

test('direct Workable replay checks the exact reviewed option inside its ARIA-linked question group', async () => {
  const questionText = 'Which programming languages can you work in?';
  let checked = false;
  let decoyChecked = false;
  const decoy = oneWorkableLocator({
    evaluate: async () => ['JavaScript'],
    check: async () => { decoyChecked = true; },
    click: async () => { decoyChecked = true; },
    isChecked: async () => decoyChecked,
  });
  const choice = oneWorkableLocator({
    evaluate: async () => ['Python'],
    check: async () => { checked = true; },
    click: async () => { checked = true; },
    isChecked: async () => checked,
  });
  const controls: any = {
    count: async () => 2,
    nth: (index: number) => index === 0 ? decoy : choice,
  };
  const group = oneWorkableLocator({
    getAttribute: async (name: string) => name === 'aria-labelledby' ? 'QA_42_label' : null,
    locator: (selector: string) => {
      assert.equal(selector, 'input[type="checkbox"]');
      return controls;
    },
  });
  const question = oneWorkableLocator({
    getAttribute: async (name: string) => name === 'id' ? 'QA_42_label' : null,
    innerText: async () => `* ${questionText}`,
  });
  const page = {
    locator: (selector: string) => {
      if (selector === '[role="group"][aria-labelledby], [role="radiogroup"][aria-labelledby], fieldset[aria-labelledby]') return group;
      if (selector === '[id="QA_42_label"]') return question;
      return absentWorkableLocator();
    },
    getByText: () => absentWorkableLocator(),
  } as unknown as Page;

  const result = await fillPortal(page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [{
      question: questionText,
      answer: 'Python',
      portalInputType: 'checkbox',
    }],
  });
  assert.equal(checked, true);
  assert.equal(decoyChecked, false);
  assert.ok(result.filledFields.includes(`question_checkbox:${questionText}`));
});

test('direct Workable replay checks every exact value in a reviewed multi-select answer', async () => {
  const questionText = 'Which languages do you speak?';
  const checked = new Set<string>();
  const languages = ['English', 'Hindi', 'Arabic', 'French'];
  const choices = languages.map((language) => oneWorkableLocator({
    evaluate: async () => [language],
    check: async () => { checked.add(language); },
    click: async () => { checked.add(language); },
    isChecked: async () => checked.has(language),
  }));
  const controls: any = {
    count: async () => choices.length,
    nth: (index: number) => choices[index] ?? absentWorkableLocator(),
  };
  const group = oneWorkableLocator({
    getAttribute: async (name: string) => name === 'aria-labelledby' ? 'QA_languages_label' : null,
    locator: (selector: string) => {
      assert.equal(selector, 'input[type="checkbox"]');
      return controls;
    },
  });
  const question = oneWorkableLocator({ innerText: async () => `* ${questionText}` });
  const page = {
    locator: (selector: string) => {
      if (selector === '[role="group"][aria-labelledby], [role="radiogroup"][aria-labelledby], fieldset[aria-labelledby]') return group;
      if (selector === '[id="QA_languages_label"]') return question;
      return absentWorkableLocator();
    },
    getByText: () => absentWorkableLocator(),
  } as unknown as Page;

  const result = await fillPortal(page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [{
      question: questionText,
      answer: languages.join(', '),
      portalInputType: 'checkbox',
    }],
  });
  assert.deepEqual([...checked], languages);
  assert.ok(result.filledFields.includes(`question_checkbox:${questionText}`));
});

test('direct Workable multi-select rolls back partial state and remains fail closed', async () => {
  const questionText = 'Which languages do you speak?';
  let englishChecked = false;
  let hindiChecked = false;
  let unconfirmed = false;
  const english = oneWorkableLocator({
    evaluate: async () => ['English'],
    check: async () => { englishChecked = true; },
    click: async () => { englishChecked = true; },
    uncheck: async () => { englishChecked = false; },
    isChecked: async () => englishChecked,
  });
  const hindi = oneWorkableLocator({
    evaluate: async () => ['Hindi'],
    check: async () => { throw new Error('provider check failed'); },
    click: async () => undefined,
    uncheck: async () => { hindiChecked = false; },
    isChecked: async () => hindiChecked,
  });
  const controls: any = {
    count: async () => 2,
    nth: (index: number) => index === 0 ? english : hindi,
  };
  const group = oneWorkableLocator({
    getAttribute: async (name: string) => name === 'aria-labelledby' ? 'QA_languages_atomic_label' : null,
    evaluate: async (_callback: unknown, state: { active: boolean }) => {
      unconfirmed = state.active;
    },
    locator: () => controls,
  });
  const question = oneWorkableLocator({ innerText: async () => `* ${questionText}` });
  const page = {
    locator: (selector: string) => {
      if (selector === '[role="group"][aria-labelledby], [role="radiogroup"][aria-labelledby], fieldset[aria-labelledby]') return group;
      if (selector === '[id="QA_languages_atomic_label"]') return question;
      return absentWorkableLocator();
    },
    getByText: () => absentWorkableLocator(),
  } as unknown as Page;

  const result = await fillPortal(page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [{
      question: questionText,
      answer: 'English, Hindi',
      portalInputType: 'checkbox',
    }],
  });

  assert.equal(englishChecked, false, 'the first selection must be rolled back');
  assert.equal(hindiChecked, false);
  assert.equal(unconfirmed, true, 'readiness must reject the partially replayed group');
  assert.ok(!result.filledFields.includes(`question_checkbox:${questionText}`));
});

test('direct Workable multi-select aborts when partial state cannot be rolled back', async () => {
  const questionText = 'Which languages do you speak?';
  let englishChecked = false;
  const english = oneWorkableLocator({
    evaluate: async () => ['English'],
    check: async () => { englishChecked = true; },
    click: async () => { englishChecked = true; },
    uncheck: async () => { throw new Error('provider rollback failed'); },
    isChecked: async () => englishChecked,
  });
  const hindi = oneWorkableLocator({
    evaluate: async () => ['Hindi'],
    check: async () => { throw new Error('provider check failed'); },
    click: async () => undefined,
    isChecked: async () => false,
  });
  const controls: any = {
    count: async () => 2,
    nth: (index: number) => index === 0 ? english : hindi,
  };
  const group = oneWorkableLocator({
    getAttribute: async (name: string) => name === 'aria-labelledby' ? 'QA_languages_abort_label' : null,
    evaluate: async () => undefined,
    locator: () => controls,
  });
  const question = oneWorkableLocator({ innerText: async () => `* ${questionText}` });
  const page = {
    locator: (selector: string) => {
      if (selector === '[role="group"][aria-labelledby], [role="radiogroup"][aria-labelledby], fieldset[aria-labelledby]') return group;
      if (selector === '[id="QA_languages_abort_label"]') return question;
      return absentWorkableLocator();
    },
    getByText: () => absentWorkableLocator(),
  } as unknown as Page;

  await assert.rejects(
    fillPortal(page, 'workable', {
      fullName: 'Taylor Example',
      email: 'taylor@example.com',
      resume: Buffer.from('resume-pdf'),
      resumeName: 'resume.pdf',
      questions: [{
        question: questionText,
        answer: 'English, Hindi',
        portalInputType: 'checkbox',
      }],
    }),
    /could not restore its previous selection state/,
  );
  assert.equal(englishChecked, true, 'the provider left partial state, so the run must abort');
});

test('managed Workable replay expands a reviewed multi-select only from exact live options', () => {
  const questionText = 'Which languages do you speak?';
  const portalSelector = 'input[id="input_QA_languages_english"]';
  const languages = ['English', 'Hindi', 'Arabic', 'French'];
  const actions = buildManagedPortalActions('workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    fieldOptions: { input_QA_languages_english: languages },
    questions: [{
      question: questionText,
      answer: languages.join(', '),
      portalSelector,
      portalInputType: 'checkbox',
    }],
  });
  assert.deepEqual(
    actions.filter((action) => action.type === 'fillByLabelText' && action.text === questionText)
      .map((action) => action.value),
    languages,
  );

  const commaLabel = buildManagedPortalActions('workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    fieldOptions: { input_QA_location_cairo: ['Cairo, Egypt', 'Dubai'] },
    questions: [{
      question: 'Which office can you work from?',
      answer: 'Cairo, Egypt',
      portalSelector: 'input[id="input_QA_location_cairo"]',
      portalInputType: 'checkbox',
    }],
  });
  assert.deepEqual(
    commaLabel.filter((action) => action.type === 'fillByLabelText' && action.text === 'Which office can you work from?')
      .map((action) => action.value),
    ['Cairo, Egypt'],
  );
});

test('direct Workable choice replay refuses duplicate exact question labels', async () => {
  const questionText = 'Which programming languages can you work in?';
  const question = oneWorkableLocator({ innerText: async () => questionText });
  const group = oneWorkableLocator({
    getAttribute: async (name: string) => name === 'aria-labelledby' ? 'QA_42_label' : null,
  });
  const duplicateGroups: any = {
    count: async () => 2,
    nth: () => group,
  };
  const page = {
    locator: (selector: string) => {
      if (selector === '[role="group"][aria-labelledby], [role="radiogroup"][aria-labelledby], fieldset[aria-labelledby]') return duplicateGroups;
      if (selector === '[id="QA_42_label"]') return question;
      return absentWorkableLocator();
    },
    getByText: () => absentWorkableLocator(),
  } as unknown as Page;

  const result = await fillPortal(page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [{
      question: questionText,
      answer: 'Python',
      portalInputType: 'checkbox',
    }],
  });
  assert.equal(result.filledFields.includes(`question_checkbox:${questionText}`), false);
});

test('direct Workable readonly combobox selects and verifies one exact option in its declared listbox', async () => {
  const questionText = 'Are you currently based in Japan?';
  const portalSelector = 'input[id="input_QA_42_input"]';
  let opened = false;
  let selected = false;
  let valueReads = 0;
  let rawFillAttempted = false;
  let unconfirmed = false;
  const widget = oneWorkableLocator({
    evaluate: async (_callback: unknown, state: { active: boolean }) => {
      unconfirmed = state.active;
    },
  });
  const option = oneWorkableLocator({
    click: async () => { selected = true; },
    getAttribute: async () => null,
  });
  const listbox = oneWorkableLocator({
    isVisible: async () => opened,
    getByRole: (role: string, options: { name: RegExp }) => {
      assert.equal(role, 'option');
      assert.equal(options.name.test('Yes'), true);
      return option;
    },
  });
  const field = oneWorkableLocator({
    click: async () => { opened = true; },
    fill: async () => { rawFillAttempted = true; throw new Error('readonly'); },
    getAttribute: async (name: string) => {
      if (name === 'role') return 'combobox';
      if (name === 'readonly') return '';
      if (name === 'id') return 'input_QA_42_input';
      if (name === 'aria-controls') return opened ? 'input_QA_42_listbox' : null;
      return null;
    },
    inputValue: async () => {
      valueReads += 1;
      return selected && valueReads >= 3 ? 'Yes' : '';
    },
    locator: (selector: string) => {
      assert.equal(selector, 'xpath=ancestor::*[@data-input-type="select"][1]');
      return widget;
    },
  });
  const page = {
    locator: (selector: string) => {
      if (selector === portalSelector) return field;
      if (selector === '[id="input_QA_42_listbox"][role="listbox"]') return listbox;
      return absentWorkableLocator();
    },
    getByText: () => absentWorkableLocator(),
  } as unknown as Page;

  const result = await fillPortal(page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [{
      question: questionText,
      answer: 'Yes',
      portalSelector,
      portalInputType: 'combobox',
    }],
  });
  assert.equal(selected, true);
  assert.ok(valueReads >= 3, 'verification must poll until the React selection is committed');
  assert.equal(rawFillAttempted, false);
  assert.equal(unconfirmed, false);
  assert.ok(result.filledFields.includes(`question:${questionText}`));
});

test('direct Workable readonly combobox refuses two exact options in its own listbox', async () => {
  const questionText = 'Are you currently based in Japan?';
  const portalSelector = 'input[id="input_QA_42_input"]';
  let optionClicks = 0;
  let escaped = false;
  let unconfirmed = false;
  const widget = oneWorkableLocator({
    evaluate: async (_callback: unknown, state: { active: boolean }) => {
      unconfirmed = state.active;
    },
  });
  const option = oneWorkableLocator({ click: async () => { optionClicks += 1; } });
  const duplicateOptions: any = {
    count: async () => 2,
    nth: () => option,
  };
  const listbox = oneWorkableLocator({
    getByRole: () => duplicateOptions,
  });
  const field = oneWorkableLocator({
    click: async () => undefined,
    press: async (key: string) => { escaped = key === 'Escape'; },
    getAttribute: async (name: string) => {
      if (name === 'role') return 'combobox';
      if (name === 'aria-controls') return 'input_QA_42_listbox';
      return null;
    },
    locator: () => widget,
  });
  const page = {
    locator: (selector: string) => {
      if (selector === portalSelector) return field;
      if (selector === '[id="input_QA_42_listbox"][role="listbox"]') return listbox;
      return absentWorkableLocator();
    },
    getByText: () => absentWorkableLocator(),
  } as unknown as Page;

  const result = await fillPortal(page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [{
      question: questionText,
      answer: 'Yes',
      portalSelector,
      portalInputType: 'combobox',
    }],
  });
  assert.equal(optionClicks, 0);
  assert.equal(escaped, true);
  assert.equal(unconfirmed, true);
  assert.equal(result.filledFields.includes(`question:${questionText}`), false);
});

test('direct Workable combobox keeps readiness closed when an exact click leaves a stale prior selection', async () => {
  const questionText = 'Are you currently based in Japan?';
  const portalSelector = 'input[id="input_QA_stale_input"]';
  let unconfirmed = false;
  let optionClicks = 0;
  const staleSelection = 'No';
  const option = oneWorkableLocator({
    click: async () => { optionClicks += 1; },
    getAttribute: async () => null,
  });
  const listbox = oneWorkableLocator({
    getByRole: () => option,
  });
  const field = oneWorkableLocator({
    click: async () => undefined,
    inputValue: async () => '',
    evaluate: async (_callback: unknown, state: { active: boolean }) => {
      unconfirmed = state.active;
    },
    getAttribute: async (name: string) => {
      if (name === 'role') return 'combobox';
      if (name === 'aria-controls') return 'input_QA_stale_listbox';
      if (name === 'aria-valuetext') return staleSelection;
      return null;
    },
    // This valid role=combobox shape has no data-input-type select ancestor. The unresolved marker
    // must fall back to the field itself so its stale prior value cannot satisfy readiness.
    locator: () => absentWorkableLocator(),
  });
  const page = {
    locator: (selector: string) => {
      if (selector === portalSelector) return field;
      if (selector === '[id="input_QA_stale_listbox"][role="listbox"]') return listbox;
      return absentWorkableLocator();
    },
    getByText: () => absentWorkableLocator(),
  } as unknown as Page;

  const result = await fillPortal(page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [{
      question: questionText,
      answer: 'Yes',
      portalSelector,
      portalInputType: 'combobox',
    }],
  });

  assert.equal(optionClicks, 1);
  assert.equal(staleSelection, 'No');
  assert.equal(unconfirmed, true, 'a stale prior value must not satisfy readiness');
  assert.equal(result.filledFields.includes(`question:${questionText}`), false);
});

test('managed referral replay emits only the packet-evidenced Job board channel', () => {
  const runtimeSelector = '[data-litos-discovered-4]';
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    referralSourceDefault: 'Job board',
    referralSourceEvidence: JOB_BOARD_REFERRAL_EVIDENCE,
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [{
      question: 'How did you hear about this role?',
      answer: 'Company website',
      portalSelector: runtimeSelector,
      portalInputType: 'select',
    }],
  });
  const referralActions = actions.filter((action) => (
    action.selector === runtimeSelector
    || action.label?.startsWith('greenhouse_referral_')
    || /how did you hear/i.test(action.label ?? '')
  ));
  const values = referralActions.map((action) => action.value).filter((value): value is string => Boolean(value));
  assert.ok(values.includes('Job board'), values.join(' | '));
  assert.equal(values.some((value) => /company\s+website|career|other/i.test(value)), false, values.join(' | '));
});

test('managed referral replay fails closed for ambiguous Website and Careers answers', () => {
  for (const answer of ['Website', 'Careers']) {
    const actions = buildManagedPortalActions('greenhouse', {
      fullName: 'Taylor Example',
      email: 'taylor@example.com',
      resume: Buffer.from('resume-pdf'),
      resumeName: 'resume.pdf',
      questions: [{
        question: 'How did you hear about this role?',
        answer,
        portalSelector: '[data-litos-discovered-4]',
        portalInputType: 'select',
      }],
    });
    assert.equal(
      actions.some((action) => /referral|how did you hear/i.test(action.label ?? '') && Boolean(action.value)),
      false,
      answer,
    );
  }
});

test('direct Greenhouse fill selects saved demographic choices', async () => {
  const genderSelector = '.field:has(label:has-text("What gender identity do you most closely identify with?")) select';
  const orientationSelector = '.field:has(label:has-text("What sexual orientation do you most closely identify with?")) select';
  const raceSelector = '.field:has(label:has-text("Please select up to 2 ethnicities that you most closely identify with.")) select';
  const { page, values } = directFillPage([
    genderSelector,
    orientationSelector,
    raceSelector,
  ]);
  await fillPortal(page, 'greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    eeoPrefs: {
      gender: 'Female',
      sexual_orientation: 'Heterosexual',
      race: 'White',
    },
    questions: [],
  });
  assert.equal(values.get(genderSelector), 'Female');
  assert.equal(values.get(orientationSelector), 'Heterosexual');
  assert.equal(values.get(raceSelector), 'White');
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
  assert.throws(() => readManagedReceipt({ title: 'Form', url: 'https://example.com', text: 'Apply now' }), /confirmation we could check/);
});

test('choice-shaped questions are recognised by their wording', () => {
  for (const q of [
    'Please select all fields of study that closely align with your education background',
    'Have you completed any internships?',
    'Do you have any outstanding offers or deadlines?',
    'Will you require sponsorship?',
    'Are you legally eligible to work in the United States?',
    'What year are you expected to graduate?',
    'Which of the following best describes you?',
  ]) {
    assert.equal(isChoiceQuestion(q), true, `"${q}" should be treated as a choice control`);
  }
});

test('genuinely free-text questions are still typed', () => {
  for (const q of [
    'What are your annualized total compensation expectations?',
    'What is your Github username?',
    'Why do you want to work here?',
    'Tell us about a project you are proud of',
    'Current Location',
  ]) {
    assert.equal(isChoiceQuestion(q), false, `"${q}" should still be filled`);
  }
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
  // Both questions are sent now that the runner dispatches on control type (stratus PR #6), and
  // both stay optional so a control it still cannot handle degrades to a blocker rather than
  // taking the whole run down and discarding the fields already filled.
  const questionActions = actions.filter((action) => action.type === 'fillByLabelText' && action.label?.startsWith('question:'));
  assert.equal(questionActions.length, 2);
  for (const action of questionActions) {
    assert.equal(action.optional, true, `"${action.text}" must not be able to abort the run`);
  }
  // first_name, last_name, preferred names, email (phone and location are omitted from this fixture), resume, then
  // the two optional reviewed questions, then the nine core-field evidence extracts and the five
  // CAPTCHA evidence reads (data-size, the invisible widget's own sitekey, the sitekey of a widget
  // that has NOT declared itself invisible, anchor src, bframe src) the prepare run carries so the
  // runner's CAPTCHA verdict can be corroborated instead of believed. The two sitekey reads are
  // what make an invisible finding belong to a widget rather than to the whole page, and the
  // rendered one is the half that survives the runner echoing one entry per selector.
  assert.deepEqual(
    actions
      .filter((a) =>
        a.type !== 'select'
        && !isGreenhousePreflightClick(a)
        && !isGreenhouseFixedCandidatePrivacyClick(a))
      .map((a) => a.type),
    [
      'waitForSelector',
      'fill',
      'fill',
      'fillByLabelText',
      'fillByLabelText',
      'fill',
      'upload',
      'upload',
      'upload',
      'fillByLabelText',
      'fillByLabelText',
      'extract',
      'extract',
      'extract',
      'extract',
      'extract',
      'extract',
      'extract',
      'extract',
      'extract',
      'extract',
      'extract',
      'extract',
      'extract',
      'extract',
    ],
  );
  assert.ok(actions.some((a) => a.type === 'select' && a.label?.startsWith('question_select:')));
});

test('managed Greenhouse question fills prefer rediscovered selectors over label text', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'Please indicate your overall GPA.',
        answer: '3.89',
        portalSelector: 'textarea[name="job_application[answers_attributes][0][text_value]"]',
      },
    ],
  });
  const questionAction = actions.find((action) => action.label === 'question:Please indicate your overall GPA.');
  assert.equal(questionAction?.type, 'fill');
  assert.equal(questionAction?.selector, 'textarea[name="job_application[answers_attributes][0][text_value]"]');
  assert.equal(questionAction?.value, '3.89');
  assert.equal(actions.some((action) => action.type === 'fillByLabelText' && action.text === 'Please indicate your overall GPA.'), false);
});

test('managed Greenhouse durable textarea selectors do not get live select retries', () => {
  const questions = Array.from({ length: 35 }, (_, index) => ({
    question: `Describe project ${index + 1}`,
    answer: `Project answer ${index + 1}`,
    portalSelector: `textarea[name="job_application[answers_attributes][${index}][text_value]"]`,
    portalInputType: 'textarea',
  }));
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions,
  }, true);

  assert.equal(actions.some((action) => action.label?.startsWith('question_select_live:')), false);
  assert.equal(actions.some((action) => action.type === 'select' && action.label?.startsWith('question')), false);
  assert.ok(actions.some((action) =>
    action.type === 'fill'
    && action.selector === 'textarea[name="job_application[answers_attributes][0][text_value]"]'
    && action.value === 'Project answer 1'));
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${actions.length}`);
});

test('managed Greenhouse academic questions confirm rediscovered autocomplete selectors', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'School',
        answer: 'University of Southern California',
        portalSelector: 'input[name="job_application[educations_attributes][0][school_name_id]"]',
      },
      {
        question: 'Degree',
        answer: 'Bachelor of Science in Computer Science',
        portalSelector: 'input[name="job_application[educations_attributes][0][degree_id]"]',
      },
    ],
  });

  assert.ok(actions.some((action) => action.type === 'press' && action.label === 'question_confirm:School' && action.value === 'Enter'));
  assert.ok(actions.some((action) => action.type === 'press' && action.label === 'question_confirm:Degree' && action.value === 'Enter'));
});

test('managed question fills fall back to label text when a discovered selector exceeds the provider limit', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'Please indicate your overall GPA.',
        answer: '3.89',
        portalSelector: `textarea[name="${'x'.repeat(501)}"]`,
      },
    ],
  });
  const questionAction = actions.find((action) => action.label === 'question:Please indicate your overall GPA.');
  assert.equal(questionAction?.type, 'fillByLabelText');
  assert.equal(questionAction?.text, 'Please indicate your overall GPA.');
  assert.equal(questionAction?.value, '3.89');
});

test('managed question actions skip empty labels and cap long discovered text', () => {
  const longLabel = `Why Samsara? ${'Describe a systems project you are proud of '.repeat(30)}`;
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      { question: 'required field', answer: 'ignored' },
      { question: '56f41b98-0250-4e12-a2d1-aa038a33af27', answer: 'ignored' },
      { question: longLabel, answer: 'I built a reliable workflow system.' },
    ],
  });
  const questionActions = actions.filter((action) => action.type === 'fillByLabelText' && action.label?.startsWith('question:'));
  assert.equal(questionActions.length, 1);
  const [questionAction] = questionActions;
  assert.ok(questionAction);
  assert.ok((questionAction.text ?? '').length <= 500);
  assert.equal(longLabel.toLowerCase().startsWith((questionAction.text ?? '').toLowerCase()), true);
});

test('managed paylocity traversal also sends provider-safe reviewed question text', () => {
  const longLabel = `Why this program? ${'Share one relevant implementation detail '.repeat(30)}`;
  const actions = buildManagedPortalActions('paylocity', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [{ question: longLabel, answer: 'I like applied engineering work.' }],
  }, true);
  const questionActions = actions.filter((action) => action.type === 'fillByLabelText');
  assert.ok(questionActions.length > 1);
  for (const action of questionActions) {
    const text = action.text ?? '';
    assert.ok(text.length <= 500);
    assert.equal(longLabel.toLowerCase().startsWith(text.toLowerCase()), true);
  }
});

test('the Ashby branch fills LinkedIn, GitHub, and portfolio from the packet', () => {
  // Live regression, 2026-07-24: a real Ashby run reported "'LinkedIn Profile' is required and is
  // still empty" even though the account's profile had linkedin_url set, because this branch had no
  // URL fills at all (the Lever branch did). It must now emit them when the packet carries them.
  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+1 555 0100',
    city: 'Los Angeles',
    linkedinUrl: 'https://www.linkedin.com/in/taylor',
    githubUrl: 'https://github.com/taylor',
    portfolioUrl: 'https://taylor.dev',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const filledLabels = actions.filter((a) => a.type === 'fill').map((a) => a.label);
  assert.ok(filledLabels.includes('linkedin'), 'Ashby must fill LinkedIn when the packet has it');
  assert.ok(filledLabels.includes('github'), 'Ashby must fill GitHub when the packet has it');
  assert.ok(filledLabels.includes('portfolio'), 'Ashby must fill portfolio when the packet has it');
  // The URL selectors are substring/attribute matches so they find Ashby's custom UUID-named fields.
  const linkedin = actions.find((a) => a.label === 'linkedin');
  assert.match(linkedin?.selector ?? '', /linkedin/i);
});

test('the Ashby branch omits URL fills the packet does not carry', () => {
  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const filledLabels = actions.filter((a) => a.type === 'fill').map((a) => a.label);
  assert.ok(!filledLabels.includes('linkedin'));
  assert.ok(!filledLabels.includes('github'));
  assert.ok(!filledLabels.includes('portfolio'));
});

test('Ashby reviewed essay questions retry nearby textareas when labels are not associated', () => {
  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: "Tell us about something you've built that you're proud of. What was hard about it?",
        answer: 'I built a fast evaluation harness for AI agents.',
      },
    ],
  });

  assert.ok(actions.some((action) =>
    action.type === 'fillByLabelText'
    && action.text === "Tell us about something you've built that you're proud of. What was hard about it?",
  ));
  const fallbacks = actions.filter((action) => action.label?.startsWith('question_text:'));
  assert.ok(fallbacks.some((action) => action.type === 'fill' && action.selector?.includes('label:has-text')));
  assert.ok(fallbacks.some((action) => action.type === 'fill' && action.selector?.includes('/parent::*/parent::*[not(self::form)')));
  assert.ok(fallbacks.some((action) => action.type === 'fill' && action.selector?.startsWith('xpath=')));
  assert.equal(fallbacks.length, 9);
  assert.equal(fallbacks.some((action) => action.type === 'fill' && action.selector?.includes('following::')), false);
  assert.equal(fallbacks.some((action) => action.type === 'fill' && action.selector?.includes('ancestor::')), false);
  assert.ok(fallbacks.every((action) => action.value === 'I built a fast evaluation harness for AI agents.'));
  assert.ok(fallbacks.every((action) => action.optional === true));
});

test('Ashby nested-label textarea fallback stays scoped to its question container', () => {
  const markup = `
    <form>
      <div class="question">
        <div><label>First essay prompt</label></div>
        <div><textarea id="first"></textarea></div>
      </div>
      <div class="question">
        <div><label>Second essay prompt</label></div>
        <div><textarea id="second"></textarea></div>
      </div>
    </form>
  `;

  assert.equal(nearestNonFormTextareaId(markup, 'First essay prompt'), 'first');
  assert.equal(nearestNonFormTextareaId(markup, 'Second essay prompt'), 'second');

  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      { question: 'First essay prompt', answer: 'First answer' },
      { question: 'Second essay prompt', answer: 'Second answer' },
    ],
  });
  const xpaths = actions
    .filter((action) => action.type === 'fill' && action.label?.startsWith('question_text:') && action.selector?.startsWith('xpath='))
    .map((action) => action.selector ?? '');
  assert.ok(xpaths.some((selector) => selector.includes('First essay prompt') && selector.includes('/parent::*/parent::*[not(self::form)')));
  assert.ok(xpaths.some((selector) => selector.includes('Second essay prompt') && selector.includes('/parent::*/parent::*[not(self::form)')));
  assert.equal(xpaths.some((selector) => selector.includes('following::') || selector.includes('ancestor::')), false);
  assert.equal(xpaths.every((selector) => selector.includes('[not(self::form)')), true);
});

test('Ashby long reviewed questions retry the visible prompt stem inside the same fallback budget', () => {
  const question = 'What is the most impressive thing you’ve personally built or automated with AI? Describe exactly what you did, how it worked, and why it mattered.';
  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question,
        answer: 'I built a fast evaluation harness for AI agents.',
      },
    ],
  });

  const fallbacks = actions.filter((action) => action.label?.startsWith('question_text:'));
  assert.equal(fallbacks.length, 9);
  assert.ok(fallbacks.some((action) =>
    action.type === 'fill'
    && action.selector?.includes('What is the most impressive thing you’ve personally built or automated with AI?')
    && !action.selector.includes('Describe exactly what you did')));
  assert.ok(fallbacks.some((action) =>
    action.type === 'fill'
    && action.selector?.startsWith('xpath=')
    && action.selector.includes('What is the most impressive thing you’ve personally built or automated with AI?')));
  assert.ok(fallbacks.some((action) =>
    action.type === 'fill'
    && action.selector?.includes('What is the most impressive thing you’ve personally built or automated with AI?')
    && action.selector.includes('/parent::*/parent::*[not(self::form)')));
  assert.ok(fallbacks.some((action) =>
    action.type === 'fill'
    && action.selector?.includes('What is the most impressive thing you’ve personally built or automated with AI?')
    && action.selector.includes('/parent::*/parent::*/parent::*[not(self::form)')));
  assert.equal(fallbacks.some((action) => action.type === 'fill' && action.selector?.includes('following::')), false);
  assert.ok(fallbacks.every((action) => action.value === 'I built a fast evaluation harness for AI agents.'));
});

test('Ashby reviewed essay packet stays inside the Stratus action budget', () => {
  const questions = Array.from({ length: 10 }, (_, index) => ({
    question: `Essay prompt ${index + 1}`,
    answer: `Answer ${index + 1}`,
  }));
  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    linkedinUrl: 'https://www.linkedin.com/in/mehekmandal/',
    githubUrl: 'https://github.com/mehek-builds',
    portfolioUrl: 'https://github.com/mehek-builds',
    resume: Buffer.from('pdf'),
    resumeName: 'Mehek_Mandal_Engineering_Intern_Resume.pdf',
    questions,
  }, true);

  assert.ok(actions.every((action) => (action.selector?.length ?? 0) <= 500));
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${actions.length}`);
});

function nearestNonFormTextareaId(markup: string, labelText: string): string | undefined {
  const doc = new DOMParser().parseFromString(markup, 'text/html');
  const labels = Array.from(doc.getElementsByTagName('label'));
  const label = labels.find((candidate) => candidate.textContent?.replace(/\s+/g, ' ').trim() === labelText);
  let node = label?.parentNode as any;
  while (node && String(node.nodeName).toLowerCase() !== 'form') {
    const textareas = typeof node.getElementsByTagName === 'function'
      ? Array.from(node.getElementsByTagName('textarea') as ArrayLike<any>)
      : [];
    const id = textareas[0]?.getAttribute?.('id');
    if (id) return id;
    node = node.parentNode;
  }
  return undefined;
}

test('Greenhouse core identity fields degrade gracefully instead of a 30s hard timeout', () => {
  // Live regression, 2026-07-24: Jump Trading serves its Greenhouse posting through a branded
  // redirect whose form lacks the classic `job_application[...]` selectors, so a required fill on
  // first_name waited the full 30s Playwright default and then aborted the whole run. These fills
  // must now be optional (a miss becomes a required-field blocker) and time-bounded (well under 30s).
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  for (const label of ['first_name', 'last_name', 'email']) {
    const action = actions.find((a) => a.label === label);
    assert.equal(action?.optional, true, `${label} must not be able to abort the run on a selector miss`);
    assert.ok((action?.timeout ?? Infinity) < 30_000, `${label} must be bounded under the 30s default`);
  }
});

test('Greenhouse fills academic fields from the submission packet', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    school: 'University of Southern California',
    degree: 'Bachelor of Science in Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    major: 'Computer Science',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const byLabel = actions.filter(
    (action) =>
      action.type === 'fillByLabelText'
      && action.label?.startsWith('first_name') !== true
      && action.label?.startsWith('last_name') !== true
      && action.label?.startsWith('email') !== true,
  );
  assert.deepEqual(
    byLabel.map((action) => [action.text, action.value, action.label]),
    [
      ['Preferred First Name', 'Taylor', 'preferred_first_name'],
      ['Preferred Last Name', 'Example', 'preferred_last_name'],
      ['What is your graduation date?', 'May 2028', 'graduation_date'],
      ['Graduation Date', 'May 2028', 'graduation_date_label'],
      ['Expected Graduation Date', 'May 2028', 'graduation_date_expected'],
      ['End date month', 'May', 'education_end_month'],
      ['End date year', '2028', 'education_end_year'],
      ['Graduation Month', 'May', 'education_graduation_month'],
      ['Graduation Year', '2028', 'education_graduation_year'],
      ['What is your expected graduation year?', '2028', 'education_expected_graduation_year'],
      ['Discipline', 'Computer Science', 'education_discipline_label'],
      ['GPA', '3.89', 'gpa'],
      ['What is your GPA?', '3.89', 'gpa_question'],
    ],
  );
  assert.ok(byLabel.every((action) => action.optional === true));
  assert.ok(byLabel.every((action) => (action.timeout ?? Infinity) < 30_000));
  assert.equal(
    actions.some((action) => action.type === 'fillByLabelText' && action.text === 'Degree'),
    false,
  );
  assert.equal(
    actions.some((action) => action.type === 'fillByLabelText' && action.text === 'School'),
    false,
  );
  const comboFills = actions.filter((action) => action.type === 'fill' && action.label?.startsWith('education_'));
  assert.ok(comboFills.some((action) => action.label?.startsWith('education_school_combo') && action.value === 'University of Southern California'));
  assert.equal(comboFills.some((action) => action.selector?.includes('label:has-text("School")')), false);
  const schoolOpenIndex = actions.findIndex((action) => action.type === 'click' && action.label?.startsWith('education_school_combo'));
  const schoolFillIndex = actions.findIndex((action) => action.type === 'fill' && action.label?.startsWith('education_school_combo'));
  assert.ok(schoolOpenIndex >= 0);
  assert.ok(schoolFillIndex > schoolOpenIndex);
  assert.ok(comboFills.some((action) => action.selector === '#degree--0' && action.value === 'Bachelor\'s Degree'));
  assert.equal(comboFills.some((action) => action.selector?.includes('label:has-text("Degree")')), false);
  assert.ok(comboFills.some((action) => action.label?.startsWith('education_graduation_date_combo:') && action.value === 'May 2028'));
  assert.ok(actions.some((action) => action.type === 'click' && action.selector === '#react-select-school--0-option-0' && action.label?.startsWith('education_school_combo')));
  assert.ok(actions.some((action) => action.type === 'click' && action.selector === '#react-select-degree--0-option-0' && action.label?.startsWith('education_degree_combo')));
  assert.ok(comboFills.some((action) => action.label?.startsWith('education_graduation_date_combo:') && action.value === 'Spring 2028'));
});

test('Greenhouse fixed education combobox questions are not replayed as reviewed text', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    major: 'Computer Science',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      { question: 'school* school--0', answer: 'University of Southern California, Viterbi School of Engineering' },
      { question: 'degree* degree--0', answer: 'Bachelor\'s Degree' },
      { question: 'discipline* discipline--0', answer: 'Computer Science' },
    ],
  });

  const reviewedQuestionActions = actions.filter((action) => action.label?.startsWith('question:'));
  assert.equal(reviewedQuestionActions.length, 0);
  const schoolFills = actions.filter((action) => action.type === 'fill' && action.selector === '#school--0');
  assert.equal(schoolFills.length, 1);
  assert.equal(schoolFills[0]?.value, 'University of Southern California');
  assert.ok(actions.some((action) => action.label?.startsWith('education_school_combo:')));
  assert.ok(actions.some((action) => action.label?.startsWith('education_degree_combo:')));
  assert.ok(actions.some((action) => action.label?.startsWith('education_discipline_combo:')));
});

test('Greenhouse replays Faire option-style choices through React-select buckets', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    city: 'Dubai',
    country: 'United Arab Emirates',
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    coverLetter: Buffer.from('cover'),
    coverLetterName: 'cover-letter.pdf',
    referralSourceDefault: 'Company website',
    referralSourceEvidence: EMPLOYER_SITE_REFERRAL_EVIDENCE,
    eeoPrefs: {
      gender: 'Female',
      transgender_status: 'Decline to self-identify',
      sexual_orientation: 'Heterosexual',
      disability_status: 'Decline to self-identify',
      veteran_status: 'Decline to self-identify',
      race: 'White',
    },
    questions: [
      { question: 'Which team opening are you most interested in?', answer: 'Search & Recommendation' },
      { question: 'Are you currently enrolled in a Masters or PhD program?', answer: 'No' },
      {
        question: 'If yes, please provide your program and expected graduation date.',
        answer: 'N/A, I am currently an undergraduate at USC Viterbi and expect to graduate in May 2028.',
      },
      { question: 'Do you currently reside in San Francisco?', answer: 'No' },
      { question: 'How familiar are you with Faire?', answer: 'Somewhat familiar' },
      { question: 'Do you identify as LGBTQIA+?', answer: 'No' },
      { question: 'Which category best describes you?', answer: 'White' },
      { question: 'Gender Identity', answer: 'Female' },
      { question: 'Veteran Status', answer: 'Decline to self-identify' },
      { question: 'Faire Candidate Privacy Policy acknowledgment', answer: 'Yes' },
    ],
  });

  const comboFills = actions.filter((action) =>
    action.type === 'fill'
    && action.label?.startsWith('question_combo_label:'));
  for (const value of [
    'Search & Recommendation',
    'No',
    'White',
    'Woman',
    'Decline to self-identify',
  ]) {
    assert.ok(comboFills.some((action) => action.value === value), value);
  }
  assert.ok(actions.some((action) =>
    action.label?.startsWith('greenhouse_referral_combo_label:')
    && action.value === 'Company website'));
  // The alias is the employer-agnostic PREFIX now, not "How did you hear about Faire?". Naming one
  // employer is what left Anduril's "How did you hear about Anduril?" and Virtu's "How did you hear
  // about this internship?" unanswered on real runs; :has-text() is a substring match, so the
  // prefix scopes to all three.
  assert.ok(actions.some((action) =>
    action.label?.startsWith('greenhouse_referral_combo_label:')
    && action.label.includes('How did you hear about')
    && action.value === 'Company website'));
  assert.equal(actions.some((action) =>
    action.label?.startsWith('greenhouse_referral_combo_label:')
    && /faire|about us\b|this job/i.test(action.label)), false);
  assert.equal(actions.some((action) =>
    action.label?.startsWith('greenhouse_demographic:')
    && action.label.includes('Gender')), false);
  assert.equal(actions.some((action) =>
    action.label?.startsWith('greenhouse_demographic:')
    && action.label.includes('veteran')), false);
  assert.equal(comboFills.some((action) => action.label?.includes('Candidate Privacy Policy')), false);
  assert.equal(actions.some((action) =>
    action.text === 'Faire Candidate Privacy Policy acknowledgment'
    || action.label?.includes('Faire Candidate Privacy Policy acknowledgment')), true);
  assert.ok(comboFills.every((action) => (action.selector?.length ?? Infinity) <= 500));
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${actions.length}`);
});

test('Greenhouse demographic aliases keep race fallback for unrelated category questions', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    eeoPrefs: {
      race: 'White',
    },
    questions: [
      { question: 'Which product category are you most interested in?', answer: 'Search' },
    ],
  });

  assert.ok(actions.some((action) =>
    action.label?.startsWith('greenhouse_demographic_select:')
    && action.value === 'White'));
  assert.ok(actions.some((action) =>
    action.label?.startsWith('greenhouse_demographic_combo:')
    && action.value === 'White'));
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${actions.length}`);
});

test('Greenhouse trims low-priority fallbacks before exceeding the managed action budget', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    city: 'Dubai',
    country: 'United Arab Emirates',
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    major: 'Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    coverLetter: Buffer.from('cover'),
    coverLetterName: 'cover-letter.pdf',
    referralSourceDefault: 'Company website',
    referralSourceEvidence: EMPLOYER_SITE_REFERRAL_EVIDENCE,
    eeoPrefs: {
      gender: 'Female',
      transgender_status: 'Decline to self-identify',
      sexual_orientation: 'Heterosexual',
      disability_status: 'Decline to self-identify',
      veteran_status: 'Decline to self-identify',
      race: 'White',
    },
    questions: [
      { question: 'Which team opening are you most interested in?', answer: 'Search & Recommendation' },
      { question: 'How familiar are you with Faire?', answer: 'Somewhat familiar' },
      { question: 'Are you currently eligible to legally work in the United States?', answer: 'Yes' },
      { question: 'Will you now or in the future require immigration support or sponsorship?', answer: 'Yes' },
      { question: 'Are you able to work onsite in our San Francisco office 5 days a week?', answer: 'Yes' },
      { question: 'Which product category are you most interested in?', answer: 'Search' },
      { question: 'Which opening are you most interested in?', answer: 'Data Science' },
      { question: 'Which location are you most interested in?', answer: 'San Francisco, California' },
      { question: 'What is your graduation date?', answer: 'May 2028' },
      { question: 'What is your GPA?', answer: '3.89' },
    ],
  }, true);

  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${actions.length}`);
  assert.equal(actions.at(-1)?.type, 'confirmAndSubmit');
  assert.ok(actions.some((action) => action.label === 'phone_country'));
  assert.ok(actions.some((action) => action.label === 'location'));
  assert.ok(actions.some((action) => action.label?.startsWith('question_combo_label:') && action.label.includes('team opening')));
  assert.ok(actions.some((action) => action.label === 'education_graduation_year'));
  assert.ok(actions.some((action) => action.label === 'education_discipline_combo:0'));
  assert.equal(actions.some((action) => action.label?.includes('sexual orientation')), false);
  assert.ok(actions.some((action) => action.type === 'upload' && action.label === 'resume'));
  assert.ok(actions.some((action) => action.type === 'upload' && action.label === 'cover_letter'));
  const bases = actions
    .filter((action) => action.label?.startsWith('question_combo_label:'))
    .map((action) => action.label?.replace(/_(?:open|option_value|option|select)$/, ''));
  for (const base of new Set(bases)) {
    const group = actions.filter((action) => action.label?.replace(/_(?:open|option_value|option|select)$/, '') === base);
    const hasValueOption = group.some((action) => action.label?.endsWith('_option_value'));
    assert.equal(hasValueOption, group.some((action) => action.type === 'fill'));
  }
});

test('Greenhouse blocks before submit when reviewed answers exceed the managed action budget', () => {
  const packet = {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: Array.from({ length: 140 }, (_, index) => ({
      question: `Describe project ${index + 1}`,
      answer: `Project ${index + 1} answer`,
    })),
  };

  assert.throws(
    () => buildManagedPortalActions('greenhouse', packet, true),
    (error: unknown) => error instanceof ManagedActionBudgetError && error.submitActionAppended === false,
  );
});

test('large Greenhouse preview packets preserve core field evidence extracts inside the managed action budget', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: Array.from({ length: 8 }, (_, index) => ({
      question: `Describe project ${index + 1}`,
      answer: `Project ${index + 1} answer`,
    })),
  });

  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${actions.length}`);
  for (const label of ['first_name', 'last_name', 'email', 'resume']) {
    assert.ok(
      actions.some((action) => action.type === 'extract' && action.label === `filled_field:${label}`),
      `missing filled_field:${label}`,
    );
  }
});

test('Greenhouse replays Jump academic and referral choices without consent', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    referralSourceDefault: 'Company website',
    referralSourceEvidence: EMPLOYER_SITE_REFERRAL_EVIDENCE,
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      { question: 'Do you currently have any offers from other firms or deadlines we should be aware of?', answer: 'No' },
      { question: 'If you said yes above, please tell us about your offers and deadlines.', answer: 'N/A' },
      { question: 'Will you require sponsorship for work authorization in the future?', answer: 'Yes' },
      { question: 'Review our Notice at Collection to learn how we will process your personal data.', answer: 'I agree' },
    ],
  });

  const comboFills = actions.filter((action) => action.type === 'fill');
  assert.ok(comboFills.some((action) => action.selector === '#degree--0' && action.value === 'Bachelor\'s Degree'), 'degree level');
  assert.ok(actions.some((action) => action.label === 'education_graduation_month' && action.value === 'May'), 'graduation month');
  assert.ok(actions.some((action) => action.label === 'education_graduation_year' && action.value === '2028'), 'graduation year');
  assert.ok(actions.some((action) =>
    action.label?.startsWith('greenhouse_referral_combo_label:')
    && action.value === 'Company website'), 'referral combo');
  assert.ok(actions.some((action) =>
    action.label?.startsWith('question_combo_label:')
    && action.value === 'Yes'), 'sponsorship combo');
  assert.equal(actions.some((action) => action.text === 'Review our Notice at Collection to learn how we will process your personal data.'), true, 'privacy text filled');
  assert.ok(actions.some((action) => action.label === 'education_graduation_month' && action.value === 'May'), 'graduation month');
  assert.ok(actions.some((action) => action.label === 'education_graduation_year' && action.value === '2028'), 'graduation year');
  assert.ok(actions.every((action) => !action.selector || action.selector.length <= 500), 'selector length');
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${actions.length}`);
});

test('Greenhouse profile-backed academic questions replay through label-scoped comboboxes', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    school: 'University of Southern California',
    degree: 'Bachelor of Science in Computer Science',
    major: 'Computer Science',
    graduationDate: 'May 2027',
    gpa: '3.89/4.0',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    referralSourceDefault: 'Company website',
    referralSourceEvidence: EMPLOYER_SITE_REFERRAL_EVIDENCE,
    questions: [
      { question: 'Degree', answer: 'Bachelor of Science in Computer Science' },
      { question: 'Discipline', answer: 'Computer Science' },
      { question: 'What is your latest field of study?', answer: 'Computer Science' },
      { question: 'What is your current academic performance rating?', answer: '3.89/4.0' },
      { question: 'Expected Graduation semester', answer: 'Spring 2027' },
      { question: 'Which university are you currently enrolled in?', answer: 'University of Southern California' },
      { question: 'What is the current year of your studies?', answer: 'Third year' },
      { question: 'How did you hear about us?', answer: 'Company website' },
      { question: 'What country are you currently residing?', answer: 'United States' },
    ],
  });

  const comboLabels = actions
    .filter((action) => action.type === 'fill' && action.label?.startsWith('question_combo_label:'))
    .map((action) => `${action.label}:${action.value}`);
  assert.ok(comboLabels.some((label) => label.includes('Degree') && label.endsWith('Bachelor\'s Degree')));
  assert.ok(comboLabels.some((label) => label.includes('Discipline') && label.endsWith('Computer Science')));
  assert.ok(comboLabels.some((label) => label.includes('latest field of study') && label.endsWith('Computer Science')));
  assert.ok(comboLabels.some((label) => label.includes('academic performance rating') && label.endsWith('3.6 or above (out of 4.0)')));
  assert.ok(comboLabels.some((label) => label.includes('Expected Graduation semester') && label.endsWith('Earlier than Fall 2027')));
  assert.ok(comboLabels.some((label) => label.includes('Which university are you currently enrolled') && label.endsWith('University of Southern California')));
  assert.ok(comboLabels.some((label) => label.includes('current year of your studies') && label.endsWith('Third')));
  assert.ok(comboLabels.some((label) => label.includes('How did you hear about us') && label.endsWith('Company website')));
  assert.ok(comboLabels.some((label) => label.includes('country are you currently residing') && label.endsWith('United States')));
});

test('Greenhouse replays Cloudflare graduation and degree choice buckets', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekman@usc.edu',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    referralSourceDefault: 'Company website',
    referralSourceEvidence: EMPLOYER_SITE_REFERRAL_EVIDENCE,
    questions: [
      {
        question: 'How did you hear about this job?',
        answer: 'Company website',
      },
      {
        question: 'Please review and acknowledge Cloudflare\'s Candidate Privacy Policy (cloudflare.com/candidate-privacy-notice/).',
        answer: 'Yes',
      },
      {
        question: 'If you are currently enrolled in a university or program, when do you expect to graduate or complete your program? (Select the closest date.)',
        answer: 'May 2028',
      },
      {
        question: 'If you are enrolled in university, what degree are you currently pursuing?',
        answer: 'Bachelor of Science in Computer Science & Business Administration, Finance Emphasis',
      },
      {
        question: 'Are you available for a 12-week full-time (40 hours per week) internship between September - December 2026?',
        answer: 'Yes',
      },
      {
        question: '1st choice: Area of interest in Software Engineering',
        answer: 'Backend/Systems',
      },
    ],
  });

  const comboLabels = actions
    .filter((action) => action.type === 'fill' && action.label?.startsWith('question_combo_label:'))
    .map((action) => `${action.label}:${action.value}`);
  assert.ok(comboLabels.some((label) => (
    label.toLowerCase().includes('how did you hear about this job')
    && label.endsWith('Company website')
  )));
  assert.ok(
    comboLabels.some((label) => label.toLowerCase().includes('when do you expect to') && label.endsWith('June 2028')),
    comboLabels.join('\n'),
  );
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('degree are you currently pursuing') && label.endsWith('Bachelor\'s')));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('are you available for a 12-week') && label.endsWith('Yes')));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('area of interest in software engineering') && label.endsWith('Backend/Systems')));
  const audit = actions.map((action) => `${action.type}:${action.label}:${action.selector}:${action.value}`).join('\n');
  const privacyClicks = actions.filter((action) =>
    action.type === 'click'
    && (action.label?.includes('Candidate Privacy Policy') || action.label === 'greenhouse_candidate_privacy_acknowledgement'));
  /* THE MEASURED CLOUDFLARE DEFECT, pinned.
   *
   * Four separate click actions used to land on input#question_68005616[]_731478256: the blind
   * candidate-privacy tick, the discovered id, the :left-of alternative and the name-shape
   * alternative. Verified against the live form on 2026-08-09 - all four resolve to that one
   * element, and clicking it four times leaves it unchecked, which is exactly what the packet's
   * preview screenshot shows and what the employer's validator called "required and is still
   * empty". One box, one click, alternatives inside it. */
  assert.equal(privacyClicks.length, 1, audit);
  assert.ok(privacyClicks[0]!.label?.startsWith('question_checkbox:'), audit);
  assert.ok(privacyClicks[0]!.selector?.includes('label:has-text("Acknowledge/Confirm") input[type="checkbox"]'), audit);
  assert.ok(privacyClicks[0]!.selector?.includes('input[type="checkbox"][name^="question_"][name$="[]"]'), audit);
});

test('Greenhouse replays Roblox required select buckets with exact live options', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekman@usc.edu',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    degree: 'Bachelor of Science in Computer Science',
    jdText: 'Roblox is hiring a software engineering intern.',
    referralSourceDefault: 'Company website',
    referralSourceEvidence: EMPLOYER_SITE_REFERRAL_EVIDENCE,
    questions: [
      { question: 'degree* degree--0', answer: 'Bachelor\'s Degree' },
      {
        question: 'If you were to join us for a technical interview, what is your preferred coding language when answering general coding questions? You may interview in any coding language of your preference.',
        answer: 'Python is my strongest language.',
      },
      { question: 'How did you first hear about this role?', answer: 'Company website' },
      { question: 'Please review and acknowledge Roblox\'s Job Applicant Privacy Notice', answer: 'Yes' },
      { question: 'How would you describe your gender identity?', answer: 'Female' },
    ],
  });

  const comboLabels = actions
    .filter((action) => action.type === 'fill' && action.label?.startsWith('question_combo_label:'))
    .map((action) => `${action.label}:${action.value}`);
  assert.ok(actions.some((action) => action.type === 'fill' && action.label === 'education_degree_combo:0' && action.value === 'Bachelor\'s Degree'));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('preferred coding') && label.endsWith('Python 3')));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('first hear about this role') && label.endsWith('Roblox Careers Site')));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('job applicant privacy notice') && label.endsWith('I acknowledge that I have read and understood Roblox\'s Job Applicant Privacy Notice.')));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('gender identity') && label.endsWith('Woman')));
});

test('Greenhouse Roblox-specific select labels stay scoped to Roblox context', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekman@usc.edu',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    referralSourceDefault: 'Company website',
    referralSourceEvidence: EMPLOYER_SITE_REFERRAL_EVIDENCE,
    questions: [
      { question: 'How did you first hear about this role?', answer: 'Company website' },
      { question: 'Please review and acknowledge Acme\'s Job Applicant Privacy Notice', answer: 'Yes' },
    ],
  });

  const comboLabels = actions
    .filter((action) => action.type === 'fill' && action.label?.startsWith('question_combo_label:'))
    .map((action) => `${action.label}:${action.value}`);
  assert.equal(comboLabels.some((label) => label.endsWith('Roblox Careers Site')), false);
  assert.equal(comboLabels.some((label) => label.endsWith('I acknowledge that I have read and understood Roblox\'s Job Applicant Privacy Notice.')), false);
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('first hear about this role') && label.endsWith('Company website')));
});

test('Greenhouse replays Samsara required selects with exact live options', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehek@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    jdText: 'Samsara is hiring a Software Engineer I New Grad.',
    referralSourceDefault: 'Company website',
    referralSourceEvidence: EMPLOYER_SITE_REFERRAL_EVIDENCE,
    questions: [
      { question: 'Processing of Personal Data', answer: 'Acknowledge/Confirm' },
      { question: 'How did you hear about this opportunity?', answer: 'Company website' },
      {
        question: 'Where have you learned about Samsara? Select all that apply.',
        answer: 'Company website',
        portal_selector: '[data-litos-discovered-23]',
        portal_input_type: 'text',
      },
      { question: 'When are you expecting to graduate from your degree?', answer: 'May 2028' },
      { question: 'Are you majoring in STEM (Computer Science, Electrical Engineering, Data Science, Cog Sci, Information Management/Systems, Mathematics, Machine Learning, etc.)?', answer: 'Yes' },
      { question: 'AI Policy for Interviewers', answer: 'Yes' },
      { question: 'How do you identify? (gender identity)', answer: 'Female', portal_selector: '[data-litos-discovered-25]', portal_input_type: 'text' },
      { question: 'How do you identify? (race/ethnicity)', answer: 'Decline to self-identify', portal_selector: '[data-litos-discovered-26]', portal_input_type: 'text' },
      { question: 'If you are based in the US, what is your veteran status?', answer: 'No', portal_selector: '[data-litos-discovered-27]', portal_input_type: 'text' },
      {
        question: 'Do you have a physical or mental disability, impairment, or condition that substantially limits major life activity?',
        answer: 'No',
        portal_selector: '[data-litos-discovered-28]',
        portal_input_type: 'text',
      },
    ],
  });

  const comboLabels = actions
    .filter((action) => action.type === 'fill' && action.label?.startsWith('question_combo_label:'))
    .map((action) => `${action.label}:${action.value}`);
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('processing of personal data') && label.endsWith('Acknowledge/Confirm')));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('how did you hear about this opportunity') && label.endsWith('Samsara Careers Site')));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('where have you learned about samsara') && label.endsWith('Samsara blog or website')));
  assert.equal(actions.some((action) => action.type === 'select'
    && action.selector?.startsWith('[data-litos-discovered-')), false,
  'temporary selectors from a stateless discovery run must never be replayed on the fresh fill page');
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('gender identity') && label.endsWith('Woman')));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('race/ethnicity') && label.endsWith('Decline To Self Identify')));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('veteran status') && label.endsWith('I am not a protected veteran')));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('physical or mental disability')
    && label.endsWith('No, I do not have a disability and have not had one in the past')));
  assert.ok(actions.some((action) => action.type === 'fillByLabelText' && action.text === 'Preferred First Name' && action.value === 'Mehek'));
  assert.ok(actions.some((action) => action.type === 'fillByLabelText' && action.text === 'Preferred Last Name' && action.value === 'Mandal'));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('expecting to graduate') && label.endsWith('2028')));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('majoring in stem') && label.endsWith('Yes')));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('ai policy for interviewers') && label.endsWith('Yes')));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('gender identity') && label.endsWith('Woman')));
});

/* THE MOST-REPEATED UNSUBMITTABLE PACKET IN THE CORPUS, pinned at the action list.
 *
 * Twenty prod packets across eight employers reported, for the control discovered as
 * "are you hispanic/latino? hispanic_ethnicity":
 *
 *   no option matched "Decline to self-identify", left for you to choose
 *
 * Its list reads ["Yes", "No", "Decline To Self Identify"], so the answer and the option are the
 * same refusal one hyphen apart. This question gets ONE attempt - comboboxValueLimit is 1 and every
 * alias after the first is never sent - so the assertion that matters is not that the right spelling
 * is somewhere in the ladder, it is that it is the value that actually goes out. */
test('the one attempt at a self-identification opt-out uses the list\'s own spelling', () => {
  // The answer as the resolver now produces it. The measured packet stored "#hispanic_ethnicity"
  // with input type text, so the action that reaches the page is a single fill of this string and
  // there is no second attempt behind it.
  assert.deepEqual(
    resolveKnownAnswer('are you hispanic/latino? hispanic_ethnicity', 'text', { eeo_prefs: {} }, undefined),
    { value: 'Decline To Self Identify' },
  );
  assert.deepEqual(
    resolveKnownAnswer('veteran status veteran_status', 'text', { eeo_prefs: {} }, undefined),
    { value: "I don't wish to answer" },
  );
  assert.deepEqual(
    resolveKnownAnswer('disability status disability_status', 'text', { eeo_prefs: {} }, undefined),
    { value: 'I do not want to answer' },
  );
  // A stated answer is untouched: the substitution only ever swaps one refusal for the same refusal.
  assert.deepEqual(
    resolveKnownAnswer('gender', 'text', { eeo_prefs: { gender: 'Female' } }, undefined),
    { value: 'Female' },
  );

  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehek@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    jdText: 'Together AI is hiring a Systems Research Engineer Intern.',
    questions: [
      {
        question: 'are you hispanic/latino? hispanic_ethnicity',
        answer: 'Decline To Self Identify',
        portal_selector: '#hispanic_ethnicity',
        portal_input_type: 'text',
      },
      { question: 'gender', answer: 'Decline to self-identify' },
    ],
  });
  const valuesFor = (question: string) => actions
    .filter((action) => typeof action.label === 'string' && action.label.toLowerCase().includes(question))
    .map((action) => action.value)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  const hispanic = valuesFor('hispanic_ethnicity');
  assert.ok(hispanic.length > 0, 'nothing was attempted at the hispanic/latino question');
  assert.deepEqual([...new Set(hispanic)], ['Decline To Self Identify']);
  // The combobox ladder gets the same treatment, and it matters there for the same reason: the
  // value limit is one, so the first candidate is the only candidate.
  assert.ok(valuesFor(':gender').includes('Decline To Self Identify'));
});

test('Greenhouse replays Databricks choice questions through React-select buckets', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    jdText: 'Databricks Product Management Intern application.',
    questions: [
      {
        question: "Please choose the single location that you're the most interested in, and we will discuss more with you as you move through the process.",
        answer: 'San Francisco, California',
        portalSelector: 'input[id="question_32707214002"]',
      },
      {
        question: 'What is your graduation date?',
        answer: 'May 2028',
        portalSelector: 'input[id="question_24505242002"]',
      },
      {
        question: 'What is your GPA?',
        answer: '3.89',
        portalSelector: 'input[id="question_32698502002"]',
      },
      {
        question: 'Do you currently or have you previously worked for Databricks in the past?',
        answer: 'I have not previously worked for or currently work at Databricks. My PM and AI engineering experience so far has been at SoFi, Traeco, and through building Tonee, but none of it has been with Databricks.',
        portalSelector: 'input[id="question_30149518002"]',
      },
    ],
  });

  const comboActions = actions.filter((action) => action.label?.startsWith('question_combo:'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector === 'input[id="question_32707214002"]' && action.value === 'San Francisco, CA'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector === 'input[id="question_24505242002"]' && action.value === 'Spring 2028'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector === 'input[id="question_24505242002"]' && action.value === 'June 2028'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector === 'input[id="question_24505242002"]' && action.value === 'May 2028'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector === 'input[id="question_32698502002"]' && action.value === '3.6 or above (out of 4.0)'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector === 'input[id="question_30149518002"]' && action.value === 'No'));
  assert.ok(comboActions.some((action) => action.type === 'click' && action.selector === 'input[id="question_32707214002"]' && action.label?.endsWith('_open')));
  assert.ok(comboActions.some((action) => action.type === 'click' && action.selector?.includes(':has-text("San Francisco, CA")')));
  assert.ok(comboActions.some((action) => action.type === 'click' && action.selector === '[id^="react-select-"][id$="-option-0"]:visible'));
  assert.ok(actions.some((action) => action.type === 'press' && action.selector === 'input[id="question_32707214002"]' && action.label?.startsWith('question_combo')));
  assert.ok(actions.some((action) => action.type === 'press' && action.selector === 'input[id="question_24505242002"]' && action.label?.startsWith('question_combo')));
  assert.ok(actions.some((action) => action.type === 'press' && action.selector === 'input[id="question_32698502002"]' && action.label?.startsWith('question_combo')));
  assert.ok(actions.some((action) => action.type === 'press' && action.selector === 'input[id="question_30149518002"]' && action.label?.startsWith('question_combo')));
});

test('Greenhouse replays Databricks React-select buckets without portal selectors', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    jdText: 'Databricks Product Management Intern application.',
    questions: [
      {
        question: "Please choose the single location that you're the most interested in, and we will discuss more with you as you move through the process.",
        answer: 'San Francisco, California',
      },
      {
        question: 'What is your graduation date?',
        answer: 'May 2028',
      },
      {
        question: 'What is your GPA?',
        answer: '3.89',
      },
      {
        question: 'Do you currently or have you previously worked for Databricks in the past?',
        answer: 'I have not previously worked for or currently work at Databricks. My PM and AI engineering experience so far has been at SoFi, Traeco, and through building Tonee, but none of it has been with Databricks.',
      },
    ],
  });

  const comboActions = actions.filter((action) => action.label?.startsWith('question_combo_label:'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector?.includes('label:has-text("Please choose the single location') && action.value === 'San Francisco, CA'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector?.includes('label:has-text("What is your graduation date?")') && action.value === 'Spring 2028'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector?.includes('label:has-text("What is your graduation date?")') && action.value === 'June 2028'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector?.includes('label:has-text("What is your graduation date?")') && action.value === 'May 2028'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector?.includes('label:has-text("What is your GPA?")') && action.value === '3.6 or above (out of 4.0)'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector?.includes('label:has-text("Do you currently or have you previously worked for Databricks') && action.value === 'No'));
  assert.equal(comboActions.filter((action) => action.type === 'click' && action.label?.endsWith('_open')).length, 6);
  assert.equal(comboActions.filter((action) => action.type === 'click' && action.label?.endsWith('_option_value')).length, 6);
  assert.equal(comboActions.filter((action) => action.type === 'click' && action.selector === '[id^="react-select-"][id$="-option-0"]:visible').length, 6);
  for (const action of comboActions.filter((candidate) => candidate.type === 'fill')) {
    const index = actions.indexOf(action);
    assert.equal(actions[index - 1]?.type, 'click');
    assert.equal(actions[index - 1]?.selector, action.selector);
    assert.equal(actions[index + 1]?.type, 'click');
    assert.match(actions[index + 1]?.selector ?? '', /\[id\^="react-select-"\]\[id\*="-option-"\]:has-text/);
    assert.equal(actions[index + 2]?.type, 'click');
    assert.equal(actions[index + 2]?.selector, '[id^="react-select-"][id$="-option-0"]:visible');
    assert.equal(actions[index + 3]?.type, 'press');
    assert.equal(actions[index + 3]?.selector, action.selector);
  }
  assert.ok(actions.some((action) => action.type === 'press' && action.label?.startsWith('question_combo_label:') && action.value === 'Enter'));
  assert.ok(actions.every((action) => (action.selector?.length ?? 0) <= 500));
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${actions.length}`);
});

test('Greenhouse routes Akuna reviewed dropdown blockers through label-scoped React-selects', () => {
  const packet = {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    referralSourceDefault: 'Company website',
    referralSourceEvidence: EMPLOYER_SITE_REFERRAL_EVIDENCE,
    jdText: 'Akuna Capital software engineer internship',
    questions: [
      {
        question: 'By submitting this application and answering "yes" below, I acknowledge that this role is my top preference.',
        answer: 'Yes',
      },
      { question: 'Which University do/did you attend?', answer: 'University of Southern California, Viterbi School of Engineering' },
      { question: 'What education level are you currently pursuing?', answer: 'Bachelor\'s Degree' },
      { question: 'Graduation Month', answer: 'May' },
      { question: 'Graduation Year', answer: '2028' },
      { question: 'What is your GPA?', answer: '3.89' },
      { question: 'Have you ever applied to a full time or internship position with Akuna in the past?', answer: "I have not applied to Akuna in the past." },
      { question: 'Have you applied to this role at Akuna previously?', answer: 'I have not applied to this role at Akuna previously.' },
      { question: 'How did you hear about this job?', answer: 'Company website' },
      { question: 'Do you have any offer deadlines that we should be aware of?', answer: "I don't have any offer deadlines right now." },
      { question: 'Do you have prior experience working at an options market making trading firm?', answer: "I don't have prior experience at an options market making firm." },
      {
        question: 'Disclaimer: Akuna Capital is a global company which wants to attract the highest quality talent. We will sponsor any qualified candidate for US work authorization if we are legally able.',
        answer: 'Yes',
      },
      {
        question: 'Do you now, or will you in the future, require visa sponsorship to continue working in the United States (e.g. H-1B, TN, E-3)?',
        answer: 'Yes',
      },
      {
        question: 'If you answered “Yes” above to requiring visa sponsorship now or in the future for work authorization, please respond to the following questions. What is your current immigration status/basis of your current work authorization?',
        answer: 'F-1 CPT',
      },
      { question: 'Do you live in New York or California?', answer: 'No' },
      {
        question: 'I certify that all information I have provided in order to apply for this position with Akuna is true, complete, and accurate.',
        answer: 'Yes',
      },
      { question: 'I acknowledge that my resume must be submitted in PDF format to be considered.', answer: 'Yes' },
      {
        question: 'To be considered for this role, you must have earned a high school diploma (or an equivalent degree). Please confirm the month and year that most accurately reflects your high school graduation.',
        answer: '',
      },
    ],
  };
  // The full form is deliberately larger than Akuna's 100-action ceiling. Exercise every mapped
  // question in safe chunks so this routing test does not require the unsafe behavior that the
  // action-budget blocker now forbids.
  const routedQuestions = packet.questions.filter((item) => !/prior experience working at an options market making/i.test(item.question));
  const actionRuns = Array.from({ length: Math.ceil(routedQuestions.length / 4) }, (_, index) =>
    buildManagedPortalActions('greenhouse', {
      ...packet,
      questions: routedQuestions.slice(index * 4, index * 4 + 4),
    }));
  const actions = actionRuns.flat();

  const comboFills = actions.filter((action) => action.type === 'fill' && /(?:question|greenhouse_known_question|greenhouse_fixed_question|greenhouse_akuna_attestation)_combo_label:/.test(action.label ?? ''));
  const valuesFor = (text: string) => Array.from(new Set(comboFills
      .filter((action) => action.label?.toLowerCase().includes(text.toLowerCase()))
      .map((action) => action.value)));
  assert.ok(valuesFor('Which University do/did you attend?').includes('University of Southern California'));
  assert.ok(actions.some((action) =>
    action.type === 'fill'
    && action.label?.startsWith('greenhouse_known_question_combo_label:')
    && action.label.includes('top preference')
    && action.value === 'Yes'));
  assert.deepEqual(valuesFor('What education level are you currently pursuing?'), ['Bachelors']);
  assert.deepEqual(valuesFor('Graduation Month'), ['May']);
  assert.deepEqual(valuesFor('Graduation Year'), ['2028']);
  assert.deepEqual(valuesFor('Do you have prior experience working at an options market making'), []);
  assert.equal(comboFills.some((action) => action.label?.includes('high school diploma')), false);
  assert.ok(comboFills.some((action) => action.selector?.includes('What is your GPA?') && action.value === '3.9'));
  const knownComboFills = actions.filter((action) => action.type === 'fill' && action.label?.startsWith('greenhouse_known_question_combo_label:'));
  assert.ok(knownComboFills.some((action) => action.selector?.includes('this role is my top preference')));
  assert.ok(knownComboFills.some((action) => action.selector?.includes('Have you ever applied to a full time or internship position with Akuna in the past?') && action.value === 'No'));
  assert.ok(knownComboFills.some((action) => action.selector?.includes('Have you applied to this role at Akuna previously?') && action.value === 'No'));
  assert.ok(actions.some((action) => (
    action.type === 'fill'
    && action.label?.startsWith('greenhouse_referral_combo_label:')
    && action.value === 'Company website'
  )));
  assert.ok(knownComboFills.some((action) => action.selector?.includes('Do you have any offer deadlines')));
  assert.ok(knownComboFills.some((action) => action.label?.includes('Disclaimer: Akuna Capital is a global company') && action.value === 'Yes'));
  assert.ok(knownComboFills.some((action) => action.selector?.includes('Do you now, or will you in the future, require visa sponsorship')));
  assert.ok(knownComboFills.some((action) => action.selector?.includes('current immigration status') && action.value === 'F-1 CPT'));
  assert.ok(knownComboFills.some((action) => action.selector?.includes('live in New York or California')));
  assert.equal(actions.some((action) => action.type === 'fillByLabelText' && action.label === 'gpa'), false);
  assert.equal(actions.some((action) => action.type === 'fillByLabelText' && action.label === 'gpa_question'), false);
  const orderedActions = buildManagedPortalActions('greenhouse', {
    ...packet,
    questions: [packet.questions[0]!, packet.questions[12]!],
  });
  const topPreferenceIndex = orderedActions.findIndex((action) => action.type === 'fill' && action.selector?.includes('this role is my top preference'));
  const sponsorshipIndex = orderedActions.findIndex((action) => action.type === 'fill' && action.selector?.includes('require visa sponsorship'));
  assert.ok(topPreferenceIndex >= 0 && topPreferenceIndex < sponsorshipIndex);
  assert.equal(actions.some((action) => action.label?.startsWith('education_school_combo:')), false);
  assert.equal(actions.some((action) => action.label === 'education_graduation_year'), false);
  // The Akuna-specific 100-action carve-out is retired; the one ceiling is the runner's real one.
  for (const run of actionRuns) assert.ok(run.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${run.length}`);

  for (const action of comboFills.filter((item) => item.label?.startsWith('question_combo_label:'))) {
    const index = actions.indexOf(action);
    assert.equal(actions[index - 1]?.type, 'click');
    assert.equal(actions[index - 1]?.selector, action.selector);
    assert.equal(actions[index + 1]?.type, 'click');
    assert.match(actions[index + 1]?.selector ?? '', /\[id\^="react-select-"\]\[id\*="-option-"\]:has-text/);
    assert.equal(actions[index + 2]?.type, 'click');
    assert.equal(actions[index + 2]?.selector, '[id^="react-select-"][id$="-option-0"]:visible');
    assert.equal(actions[index + 3]?.type, 'press');
  }
});

test('Greenhouse promotes canonical Akuna prior-application no answers into early React-selects', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    school: 'University of Southern California',
    degree: 'Bachelor of Science in Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    jdText: 'Akuna Capital software engineer internship',
    questions: [
      { question: 'Have you ever applied to a full time or internship position with Akuna in the past?', answer: 'No' },
      { question: 'Have you applied to this role at Akuna previously?', answer: 'No' },
    ],
  });

  const knownComboFills = actions.filter((action) => action.type === 'fill' && action.label?.startsWith('greenhouse_known_question_combo_label:'));
  assert.ok(knownComboFills.some((action) => action.selector?.includes('Have you ever applied to a full time or internship position with Akuna in the past?') && action.value === 'No'));
  assert.ok(knownComboFills.some((action) => action.selector?.includes('Have you applied to this role at Akuna previously?') && action.value === 'No'));
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${actions.length}`);
});

/* Measured on Akuna packet 41f0b79d, 2026-08-18: the tail truncation dropped the five education
 * controls, both attestations and the referral source - eight REQUIRED controls - while optional
 * EEO questions and a "potential master's graduation date" kept their chains. When whole questions
 * must go, the ones the form itself marks optional go first. */
test('an over-budget Greenhouse prepare drops explicitly optional questions before required ones', () => {
  const required = Array.from({ length: 16 }, (_, index) => ({
    question: `required screener question number ${index} about this role?`,
    answer: 'Yes',
    required: true,
    portalSelector: `#question_required_${index}`,
    portalInputType: 'combobox',
  }));
  const optional = Array.from({ length: 8 }, (_, index) => ({
    question: `optional demographic question number ${index} (mark all that apply)`,
    answer: 'Decline to self-identify',
    required: false,
    portalSelector: `#question_optional_${index}`,
    portalInputType: 'combobox',
  }));
  const packet = {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    jdText: 'A Greenhouse posting with more questions than one pass can hold',
    questions: [...required, ...optional],
  };
  const actions = buildManagedPortalActions('greenhouse', packet);
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${actions.length}`);
  const dropped = budgetDroppedReviewedQuestions(packet, actions);
  assert.ok(dropped.length > 0, 'the fixture must actually overflow the budget');
  for (const question of dropped) {
    assert.match(question, /^optional demographic/, `a required question was dropped while optional ones remained: ${question}`);
  }
});

/* The measured 2026-08-18 Akuna shape (packet 41f0b79d): 34 discovery-merged questions, most of
 * them required react-selects with exact #question_ selectors. This pins the commit's own claim:
 * at MANAGED_ACTION_LIMIT with optionals shed first, the five custom education controls and both
 * attestations keep an attempt, and the only required controls the budget may still drop are the
 * arithmetic floor of the five-action react-select chain (graduation year, GPA, referral source).
 * If an action-cost change pushes any OTHER required control back into the shortfall, this fails. */
test('the measured Akuna question shape keeps every education control and attestation attempted', () => {
  const combo = (question: string, answer: string, required: boolean, id: number) => ({
    question, answer, required, portalSelector: `#question_${id}`, portalInputType: 'combobox',
  });
  const text = (question: string, answer: string, required: boolean, id: number) => ({
    question, answer, required, portalSelector: `#question_${id}`, portalInputType: 'text',
  });
  const questions = [
    text('what is your legal first name? (please also ensure that you input your legal first name in the first name field above)', 'Mehek', true, 1),
    text('do you have a preferred name, other than the name indicated above? if yes, please indicate that name below', 'Mehek', true, 2),
    combo('by submitting this application and answering yes below, i acknowledge that this role is my top preference and i will not be considered for other tech and/or quant roles at akuna for this recruiting season.', 'Yes', true, 3),
    combo('if you are an undergraduate considering a master\'s degree following graduation, when is your potential master\'s graduation date?', 'Spring/Summer 2028', false, 4),
    combo('to be considered for this role, you must have earned a high school diploma (or an equivalent degree). please confirm the month and year of your graduation', 'Spring/Summer 2023', true, 5),
    combo('have you ever applied to a full time or internship position with akuna in the past?', 'No', true, 6),
    combo('have you applied to this role at akuna previously?', 'No', true, 7),
    combo('do you have any offer deadlines that we should be aware of?', 'No', true, 8),
    combo('do you have prior experience working at an options market making trading firm?', 'No', true, 9),
    text('linkedin profile', 'https://example.com/in/profile', false, 10),
    combo('disclaimer: akuna capital is a global company which wants to attract the highest quality talent. we will sponsor any qualified candidate for us work authorization if we are legally able.', 'Yes', true, 11),
    combo('do you now, or will you in the future, require visa sponsorship to continue working in the united states (e.g. h-1b, tn, e-3)?', 'Yes', true, 12),
    combo('if you answered yes above to requiring visa sponsorship now or in the future for work authorization, what is your current immigration status?', 'F-1 CPT/OPT', true, 13),
    text('if you have a current work authorization/status, when does it expire?', 'Duration of status', true, 14),
    text('if applicable, please list any extension options for your current work authorization status.', 'F-1 CPT/OPT', true, 15),
    text('please provide additional detail about your sponsorship needs or current work authorization status.', 'F-1 student', true, 16),
    combo('do you live in new york or california?', 'No', true, 17),
    text('we care about addressing everyone correctly. to help us get it right, please write out how your name is pronounced phonetically', 'MAY-hek', true, 18),
    { question: 'we care about addressing everyone correctly. add your personal pronouns below to share with the hiring team.', answer: 'she/her', required: true, portalSelector: '#question_19\\[\\]_1', portalInputType: 'checkbox' },
    text('if you selected self-describe, please specify your pronouns', 'she/her', false, 20),
    combo('i certify that all information i have provided in order to apply for this position with akuna is true, complete, and accurate.', 'Yes', true, 21),
    combo('i acknowledge that my resume must be submitted in pdf format to be considered.', 'Yes', true, 22),
    combo('how would you describe your gender identity? (mark all that apply)', 'Female', false, 23),
    combo('how would you describe your racial/ethnic background? (mark all that apply)', 'South Asian', false, 24),
    combo('how would you describe your sexual orientation? (mark all that apply)', 'Heterosexual', false, 25),
    combo('do you identify as transgender?', 'Decline to self-identify', false, 26),
    combo('do you have a disability or chronic condition (physical, visual, auditory, cognitive, mental, emotional, or other) that substantially limits one or more of your major life activities?', 'No', false, 27),
    combo('are you a veteran or active member of the united states armed forces?', 'No', false, 28),
    combo('Which University do/did you attend?', 'University of Southern California', true, 29),
    combo('What education level are you currently pursuing?', "Bachelor's Degree", true, 30),
    combo('Graduation Month', 'May', true, 31),
    combo('graduation year', '2028', true, 32),
    combo('what is your gpa?', '3.8', true, 33),
    combo('how did you hear about this job?', 'Other', true, 34),
  ];
  const packet = {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971000000000',
    school: 'University of Southern California',
    degree: "Bachelor's Degree",
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.8',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    jdText: 'Akuna Capital Software Engineer Intern',
    questions,
  };
  const actions = buildManagedPortalActions('greenhouse', packet);
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${actions.length}`);
  const dropped = budgetDroppedReviewedQuestions(packet, actions);
  const requiredByLabel = new Map(questions.map((item) => [item.question.toLowerCase(), item.required]));
  const arithmeticFloor = new Set(['graduation year', 'what is your gpa?', 'how did you hear about this job?']);
  for (const question of dropped) {
    const required = requiredByLabel.get(question.toLowerCase());
    if (required === false) continue;
    assert.ok(arithmeticFloor.has(question.toLowerCase()),
      `a required control outside the react-select arithmetic floor was dropped: ${question}`);
  }
  for (const surviving of ['Which University do/did you attend?', 'What education level are you currently pursuing?', 'Graduation Month', 'i certify that all information', 'resume must be submitted in pdf format']) {
    assert.ok(!dropped.some((question) => question.toLowerCase().startsWith(surviving.toLowerCase().slice(0, 30))),
      `${surviving} lost its attempt`);
  }
});

test('Greenhouse never invents Akuna attestations when discovery misses them', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    jdText: 'Akuna Capital software engineer internship',
    questions: [],
  });

  const fills = actions.filter((action) => action.type === 'fill' && action.label?.startsWith('greenhouse_akuna_attestation_combo_label:'));
  assert.equal(fills.length, 0);
  assert.equal(actions.some((action) => action.selector?.includes('I certify that all information I have provided')), false);
  assert.equal(actions.some((action) => action.selector?.includes('resume must be submitted in PDF format')), false);
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${actions.length}`);
});

test('Greenhouse replays fixed Akuna graduation month and year when discovery misses them', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    graduationMonth: 'May',
    graduationYear: '2028',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    jdText: 'Akuna Capital software engineer internship',
    questions: [
      { question: 'What is your GPA?', answer: '3.89' },
    ],
  });

  const fixedComboFills = actions.filter((action) => action.type === 'fill' && action.label?.startsWith('greenhouse_fixed_question_combo_label:'));
  assert.ok(fixedComboFills.some((action) => action.selector?.includes('Graduation Month') && action.value === 'May'));
  assert.ok(fixedComboFills.some((action) => action.selector?.includes('Graduation Year') && action.value === '2028'));
  assert.ok(fixedComboFills.every((action) => action.selector?.startsWith('.field-wrapper:has(label:has-text(')));
});

test('Greenhouse Akuna fixed combobox selector follows the live nested field-wrapper shape', () => {
  const liveNestedMarkup = new DOMParser().parseFromString(`
    <div class="field-wrapper">
      <div class="select">
        <div class="select__container">
          <label for="question_67727951">Graduation Month</label>
          <div class="select-shell">
            <div class="select__control">
              <input id="question_67727951" role="combobox" aria-autocomplete="list" />
            </div>
          </div>
        </div>
      </div>
    </div>
  `, 'text/html');
  const label = Array.from(liveNestedMarkup.getElementsByTagName('label'))
    .find((element) => element.textContent === 'Graduation Month');
  const combobox = Array.from(liveNestedMarkup.getElementsByTagName('input'))
    .find((element) => element.getAttribute('role') === 'combobox');
  const fieldWrapper = label?.parentNode?.parentNode?.parentNode;

  assert.equal(fieldWrapper?.nodeName, 'div');
  assert.equal((fieldWrapper as Element).getAttribute('class'), 'field-wrapper');
  assert.equal(fieldWrapper, combobox?.parentNode?.parentNode?.parentNode?.parentNode?.parentNode);

  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    graduationMonth: 'May',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    jdText: 'Akuna Capital software engineer internship',
    questions: [],
  });

  const monthFill = actions.find((action) =>
    action.type === 'fill'
    && action.label?.startsWith('greenhouse_fixed_question_combo_label:')
    && action.selector?.includes('Graduation Month'));
  assert.equal(monthFill?.selector, '.field-wrapper:has(label:has-text("Graduation Month")) input[role="combobox"]');
});

test('Greenhouse uses preserved combobox portal selectors without raw-filling React-select inputs', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    jdText: 'Akuna Capital software engineer internship',
    questions: [
      {
        question: 'What education level are you currently pursuing?',
        answer: 'Bachelor\'s Degree',
        portalSelector: 'input[id="question_123"]',
        portalInputType: 'combobox',
      },
    ],
  });

  const scoped = actions.filter((action) => action.label?.startsWith('question_combo:'));
  assert.ok(scoped.some((action) => action.type === 'fill' && action.selector === 'input[id="question_123"]' && action.value === 'Bachelors'));
  assert.equal(actions.some((action) => action.label?.startsWith('question:What education level')), false);
  assert.ok(scoped.some((action) => action.type === 'click' && action.label?.endsWith('_option_value')));
  assert.ok(scoped.some((action) => action.type === 'press' && action.label?.endsWith('_select')));
});

test('Greenhouse keeps generic education level labels outside Akuna context', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'What education level are you currently pursuing?',
        answer: 'Bachelor\'s Degree',
      },
    ],
  });
  const fill = actions.find((action) =>
    action.type === 'fill'
    && action.label?.startsWith('question_combo_label:')
    && action.label.includes('What education level are you currently pursuing?'));
  assert.equal(fill?.value, 'Bachelor\'s');
});

test('Greenhouse work authorization React-select respects negative reviewed answers', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'Are you legally authorized to work in the country in which you are applying?',
        answer: 'No',
      },
    ],
  });

  const comboFills = actions.filter((action) =>
    action.type === 'fill'
    && action.label?.startsWith('question_combo_label:')
    && action.label?.includes('Are you legally authorized'));
  assert.equal(comboFills.length, 1);
  assert.equal(comboFills[0]?.value, 'No');
  assert.equal(
    actions.some((action) =>
      action.type === 'fill'
      && action.label?.startsWith('question_combo_label:')
      && action.label?.includes('Are you legally authorized')
      && action.value === 'Yes'),
    false,
  );
});

test('Greenhouse Databricks academic and reviewed question packet stays inside the action budget', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    major: 'Computer Science',
    roleLocation: 'Bellevue, Washington; Mountain View, California; San Francisco, California',
    roleLocations: ['Bellevue, Washington', 'Mountain View, California', 'San Francisco, California'],
    linkedinUrl: 'https://www.linkedin.com/in/mehekmandal/',
    portfolioUrl: 'https://github.com/mehek-builds',
    resume: Buffer.from('pdf'),
    resumeName: 'Mehek_Mandal_Product_Management_Intern_Resume.pdf',
    eeoPrefs: {
      gender: 'Female',
      sexual_orientation: 'Heterosexual',
      race: 'White',
      veteran_status: 'Decline to self-identify',
      disability_status: 'Decline to self-identify',
    },
    questions: [
      { question: 'LinkedIn Profile', answer: 'https://www.linkedin.com/in/mehekmandal/' },
      { question: 'Website', answer: 'https://github.com/mehek-builds' },
      { question: 'How did you hear about this job?', answer: 'Company website' },
      { question: 'Are you legally authorized to work in the country in which you are applying?', answer: 'Yes' },
      { question: 'Do you now or will you in the future need sponsorship for employment visa status', answer: 'Yes' },
      { question: 'Gender', answer: 'Female' },
      {
        question: "Please choose the single location that you're the most interested in, and we will discuss more with you as you move through the process.",
        answer: 'San Francisco, California',
      },
      { question: 'What is your graduation date?', answer: 'May 2027' },
      { question: 'What is your GPA?', answer: '3.89' },
      {
        question: 'Do you currently or have you previously worked for Databricks in the past?',
        answer: 'I have not previously worked for or currently work at Databricks. My PM and AI engineering experience so far has been at SoFi, Traeco, and through building Tonee, but none of it has been with Databricks.',
      },
      {
        question: 'Please confirm whether any of the below applies to you. Select all that apply. Note: This information will only be used to ensure compliance with U.S. sanctions and export controls.',
        answer: 'None of the above',
      },
      {
        question: 'If you selected a response to the prior question other than none of the above, please confirm whether any of the following also applies to you. Select all that apply.',
        answer: 'Not applicable (i.e., I selected none of the above for the prior question)',
      },
    ],
  }, true);

  assert.ok(actions.some((action) => action.label?.startsWith('question_combo_label:')), 'question combo action');
  assert.ok(actions.some((action) =>
    action.type === 'fill'
    && action.label?.startsWith('question_combo_label:')
    && action.label?.includes('Are you legally authorized')
    && action.value === 'Yes'), 'work authorization yes');
  assert.ok(actions.some((action) =>
    action.type === 'fill'
    && action.selector === '#end-month--0'
    && action.value === 'May'), 'graduation month exact');
  assert.ok(actions.some((action) =>
    action.type === 'fill'
    && action.selector === '#end-year--0'
    && action.value === '2028'), 'graduation year exact');
  assert.ok(actions.some((action) =>
    action.type === 'fillByLabelText'
    && action.label === 'databricks_graduation_date'
    && action.value === 'May 2028'), 'graduation date label fill survives budget trim');
  assert.ok(actions.some((action) =>
    action.type === 'fill'
    && action.label?.startsWith('databricks_graduation_date_combo:')
    && action.value === 'Spring 2028'), 'graduation date combobox fallback survives budget trim');
  assert.ok(actions.some((action) =>
    action.type === 'fill'
    && action.label?.startsWith('question_combo_label:')
    && action.label.includes('What is your graduation date?')
    && action.value === 'Spring 2028'), 'reviewed graduation uses packet date bucket');
  assert.equal(
    actions.some((action) =>
      action.type === 'fill'
      && action.label?.startsWith('question_combo_label:')
      && action.label.includes('What is your graduation date?')
      && action.value === 'Spring 2027'),
    false,
    'stale reviewed graduation date is not preferred over packet date',
  );
  assert.ok(actions.some((action) =>
    action.type === 'fill'
    && action.label?.startsWith('preferred_location_combo:')
    && action.value === 'San Francisco, CA'), 'preferred location exact');
  assert.equal(
    actions.some((action) =>
      action.label?.startsWith('question_select:')
      && action.selector?.includes('What is your GPA?')),
    false,
  );
  assert.ok(actions.every((action) => (action.selector?.length ?? 0) <= 500));
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${actions.length}`);
});

test('Greenhouse replays Databricks export-control checkbox answers by exact option', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'Please confirm whether any of the below applies to you. Select all that apply. Note: This information will only be used to ensure compliance with U.S. sanctions and export controls.',
        answer: 'None of the above',
        portalSelector: 'input[id="question_35110536002[]_221056618002"]',
        portalInputType: 'checkbox',
      },
      {
        question: 'If you selected a response to the prior question other than none of the above, please confirm whether any of the following also applies to you. Select all that apply.',
        answer: 'Not applicable (i.e., I selected none of the above for the prior question)',
        portalSelector: 'input[id="question_35114221002[]_221073825002"]',
        portalInputType: 'checkbox',
      },
    ],
  });

  const checkboxClicks = actions.filter((action) => action.label?.startsWith('question_checkbox:'));
  assert.equal(actions.some((action) => action.label?.startsWith('question_choice:')), false);
  // ONE CLICK PER BOX. A click is a toggle, so the alternatives ride in a single comma-joined
  // selector and the runner takes the first that resolves - the same shape managedFill has always
  // used. Two questions here, so two clicks and no more: four clicks on one export-control box
  // would tick it, untick it, tick it and untick it.
  assert.equal(checkboxClicks.length, 2, `expected one click per checkbox, got ${checkboxClicks.length}`);
  const exportControl = checkboxClicks.find((action) => action.selector?.includes('Please confirm whether any of the below'));
  const priorQuestion = checkboxClicks.find((action) => action.selector?.includes('If you selected a response to the prior question'));
  assert.ok(exportControl?.type === 'click' && exportControl.selector?.includes('None of the above'));
  assert.ok(priorQuestion?.type === 'click' && priorQuestion.selector?.includes('Not applicable'));
  // The discovered id leads each one, and the label-scoped alternatives follow it inside the same
  // selector rather than as extra toggles.
  assert.ok(exportControl?.selector?.startsWith('input[id="question_35110536002[]_221056618002"], '));
  assert.ok(priorQuestion?.selector?.startsWith('input[id="question_35114221002[]_221073825002"], '));
  assert.ok(checkboxClicks.every((action) => action.optional === true));
  assert.ok(checkboxClicks.every((action) => (action.timeout ?? Infinity) < 30_000));
  // browserbase.ts drops an optional action whose selector is over 500 characters, which would
  // take the tick with it. The ladder is truncated to fit rather than allowed to overflow.
  assert.ok(checkboxClicks.every((action) => (action.selector?.length ?? 0) <= 500));
});

test('Greenhouse keeps the exact option hook when there is no discovered checkbox selector', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'Please confirm whether any of the below applies to you. Select all that apply. Note: This information will only be used to ensure compliance with U.S. sanctions and export controls.',
        answer: 'None of the above',
      },
    ],
  });

  const checkboxClicks = actions.filter((action) => action.label?.startsWith('question_checkbox:'));
  assert.equal(checkboxClicks.length, 1);
  // All four alternatives fit here, so none of them is lost - including the exact name/value hook
  // that is the last and most literal of them.
  assert.ok(checkboxClicks[0]!.selector?.includes('input[name="question_35110536002[]"][value="221056618002"]'));
  assert.ok(checkboxClicks[0]!.selector?.includes('label:has-text("None of the above") input[type="checkbox"]'));
});

test('Greenhouse ticks a reviewed checkbox once, with the durable selector leading', () => {
  const selector = 'input[id="question_35110536002[]_221056618002"]';
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'Please confirm whether any of the below applies to you. Select all that apply. Note: This information will only be used to ensure compliance with U.S. sanctions and export controls.',
        answer: 'None of the above',
        portalSelector: selector,
        portalInputType: 'checkbox',
      },
    ],
  });

  const clicks = actions.filter((action) => action.type === 'click' && action.selector?.includes(selector));
  assert.equal(clicks.length, 1, `a checkbox may be clicked once, got ${clicks.length}`);
  // The id read off this very form leads, because it beats every shape-based guess after it, and
  // the guesses are still there behind it as alternatives rather than as extra toggles.
  assert.ok(clicks[0]!.selector?.startsWith(selector));
  assert.ok(clicks[0]!.selector?.includes('label:has-text("None of the above") input[type="checkbox"]'));
  assert.ok(clicks[0]!.label?.startsWith('question_checkbox:'));
  assert.equal(actions.some((action) => action.label?.startsWith('question_choice_selector:')), false);
});

test('Greenhouse school aliases do not strip comma-separated campus names generically', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    school: 'University of California, Berkeley',
    degree: 'Bachelor of Science in Computer Science',
    major: 'Computer Science',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const schoolValues = actions
    .filter((action) => action.type === 'fill' && action.selector === '#school--0')
    .map((action) => action.value);
  assert.deepEqual(schoolValues, ['University of California, Berkeley']);
});

test('Greenhouse school aliases drop a school-inside-the-institution, for anyone, not just USC', () => {
  // An ATS school list holds INSTITUTIONS, so "University of Southern California, Viterbi School of
  // Engineering" matches nothing and the field came back required-and-empty. This used to be fixed
  // by testing for the literal string "University of Southern California", which is the one school
  // the one person testing it attends. The rule is now what the tail SAYS it is: a clause naming a
  // school, college, faculty or department is a unit inside the institution and comes off; a campus
  // name is part of the institution and stays (see the test above - dropping ", Berkeley" would
  // name a different university).
  const schoolValuesFor = (school: string) => buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    school,
    degree: 'Bachelor of Science in Computer Science',
    major: 'Computer Science',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  })
    .filter((action) => action.type === 'fill' && action.selector === '#school--0')
    .map((action) => action.value);

  assert.deepEqual(
    schoolValuesFor('University of Southern California, Viterbi School of Engineering'),
    ['University of Southern California'],
  );
  assert.deepEqual(
    schoolValuesFor('New York University, Tandon School of Engineering'),
    ['New York University'],
  );
  // One of each. Only the last clause may go.
  assert.deepEqual(
    schoolValuesFor('University of California, Berkeley, College of Engineering'),
    ['University of California, Berkeley'],
  );
  // A plain institution is left exactly as stored.
  assert.deepEqual(schoolValuesFor('Boston College'), ['Boston College']);
});

// A Greenhouse packet big enough that the budget trim has to run, shaped like the live DRW Software
// Developer Intern packet: many screener questions, EEO preferences and a stored referral source.
// Those last two are what a hand-built test packet leaves out and what a real profile always
// supplies, and they are worth 39 actions on their own.
function overBudgetGreenhousePacket(extraQuestions: Array<{ question: string; answer: string }> = []) {
  // Worded so each one is recognised as a React Select, because that is what makes a real screener
  // expensive: a plain text question is one action, a combobox is five. DRW's live packet reached
  // 231 raw actions this way, and 231 is the number that made the trim reach the education row.
  const screeners = Array.from({ length: 8 }, (_, index) => ({
    question: `Which team opening are you most interested in for area ${index + 1}?`,
    answer: 'Core platform',
  }));
  return {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    city: 'Dubai',
    country: 'United Arab Emirates',
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    major: 'Computer Science & Business Administration, Finance Emphasis',
    roleLocation: 'Chicago',
    referralSourceDefault: 'Company website',
    referralSourceEvidence: EMPLOYER_SITE_REFERRAL_EVIDENCE,
    eeoPrefs: {
      gender: 'Female',
      race: 'Asian',
      veteran_status: 'I am not a protected veteran',
      disability_status: 'No, I do not have a disability',
      sexual_orientation: 'Heterosexual',
      transgender_status: 'No',
    },
    jdText: 'Software Developer Intern',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [...screeners, ...extraQuestions],
  };
}

test('the budget may never delete the fixed education row, however large the form', () => {
  // THE REGRESSION, measured against the live DRW packet on 2026-08-09. Its raw action list is 231
  // actions against a 120 budget. The trim walked its priority list, reached
  // `education_discipline_combo:` and `education_discipline_label`, and deleted both, so the run
  // never touched the Discipline control at all and the applicant was told
  // '"Discipline" is required and is still empty' about a field whose answer had been resolved
  // correctly and simply never sent. Everything else on that form was fine.
  //
  // School, Degree, Discipline and End date month are one known block of four controls and sixteen
  // actions, present and required on every Greenhouse board, and each has exactly one attempt. There
  // is no budget saving worth deleting a required field's only attempt, so they are protected
  // outright rather than merely ranked low.
  const actions = buildManagedPortalActions('greenhouse', overBudgetGreenhousePacket() as never);
  assert.ok(actions.length <= 120, `the budget must still be respected, got ${actions.length}`);
  const fillFor = (selector: string) => actions
    .filter((action) => action.type === 'fill' && action.selector === selector)
    .map((action) => action.value);
  assert.deepEqual(fillFor('#school--0'), ['University of Southern California']);
  assert.deepEqual(fillFor('#degree--0'), ["Bachelor's Degree"]);
  assert.deepEqual(fillFor('#discipline--0'), ['Computer Science'], 'Discipline is the field that was being deleted');
  assert.deepEqual(fillFor('#end-month--0'), ['May']);
  assert.ok(actions.some((action) => action.selector === '#end-year--0'));
});

/* R-118. The fill run warms Greenhouse's education taxonomies before it types into them.
 *
 * School, Degree and Discipline fetch their option lists over the network when their menu is first
 * opened. The discovery pass gets a warming round for free, because buildManagedDiscoveryActions
 * asks for `probeOptions` and those probes are pushed AHEAD of the education fills. The fill run
 * asks for no probe, so its education fill was the first thing on a fresh page to touch those
 * controls and was racing that fetch with the runner's 1200ms allowance and nothing in front of it.
 *
 * Measured on the live Flow Traders form, 2026-08-09: cold, Degree's menu answered a typed search
 * after 965ms; warmed, after 603ms. Production lost that race on Point72, Flow Traders and Together
 * AI on 2026-08-09 and reported `no option matched "Bachelor's Degree"` on a control whose list
 * holds exactly that string.
 */
test('the fill run opens the education taxonomies once before it fills them', () => {
  const actions = buildManagedPortalActions('greenhouse', andurilPacket());
  const labels = actions.map((action) => action.label ?? '');
  for (const inputId of ['school--0', 'degree--0', 'discipline--0']) {
    const warm = labels.indexOf(`education_taxonomy_warm:${inputId}`);
    const close = labels.indexOf(`education_taxonomy_warm_close:${inputId}`);
    assert.ok(warm >= 0, `${inputId} is never warmed`);
    assert.equal(close, warm + 1, `${inputId} must be closed by the action after it opens it`);
    assert.equal(actions[close]!.value, 'Escape', 'Escape, so the control is left exactly as it was found');
    assert.equal(actions[warm]!.optional, true);
  }
  // Before the fills it exists for, and before the name/email/phone/resume actions whose round trips
  // are what turn two actions of warming into a second of real elapsed time.
  assert.ok(
    labels.indexOf('education_taxonomy_warm:school--0') < labels.indexOf('first_name'),
    'the warm-up must precede the fixed fields, not sit next to the fills it is warming',
  );
  assert.ok(labels.indexOf('education_taxonomy_warm:discipline--0') < labels.indexOf('education_school_combo:0'));
  // End date month renders its twelve rows from the document, so it is not warmed.
  assert.ok(!labels.some((label) => label.startsWith('education_taxonomy_warm:end-month')));
});

test('a control the packet cannot answer is not warmed, and the discovery pass is not warmed twice', () => {
  // No stored degree means no degree fill, so two actions of warming would buy nothing.
  const labels = buildManagedPortalActions('greenhouse', andurilPacket({ degree: undefined }))
    .map((action) => action.label ?? '');
  assert.ok(!labels.includes('education_taxonomy_warm:degree--0'));
  assert.ok(labels.includes('education_taxonomy_warm:school--0'));
  // The discovery pass already opens all four controls twice, to READ them. Warming them a third
  // time would spend six actions of a list that has measured at exactly the 120 ceiling.
  const discovery = buildManagedDiscoveryActions('greenhouse', andurilPacket()).map((action) => action.label ?? '');
  assert.ok(!discovery.some((label) => label.startsWith('education_taxonomy_warm')));
  assert.ok(discovery.some((label) => label.startsWith('option_probe_open:school--0')));
});

test('the budget trim may not take the education warm-up', () => {
  // Same claim as the fixed education row above, and for a sharper reason: a trimmed FILL leaves the
  // control visibly empty, while a trimmed WARM-UP leaves the fill running against a menu that has
  // not loaded, so the run reports "no option matched" about an answer that was correct.
  const actions = buildManagedPortalActions('greenhouse', overBudgetGreenhousePacket() as never);
  assert.ok(actions.length <= 120, `the budget must still be respected, got ${actions.length}`);
  for (const inputId of ['school--0', 'degree--0', 'discipline--0']) {
    assert.ok(
      actions.some((action) => action.label === `education_taxonomy_warm:${inputId}`),
      `${inputId} lost its warm-up to the trim`,
    );
  }
});

test('a control whose label offers "Other if not listed" gets that option, last and only last', () => {
  // Measured read-only on the live Virtu Software Engineer Internship form, 2026-08-09. Its question
  // "Which university are you currently attending? Select "Other" if not listed" is not the
  // Greenhouse school taxonomy: it is a curated list of fifteen schools plus "Other", and the
  // applicant's university is genuinely absent. Every candidate matched nothing and the field came
  // back required-and-empty on a form that had said in its own label what to do about it.
  //
  // "Other" is not a near-miss here, it is the accurate answer. It must still be LAST, so it can only
  // be reached once every real value has failed to match.
  // Deliberately a SMALL packet: this is about which values are generated, not about the budget, and
  // an over-budget packet would trim the question away before the assertion could see it.
  const valuesForQuestion = (question: string, answer: string, match: RegExp) => buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [{ question, answer }],
  } as never)
    .filter((action) => action.type === 'fill' && match.test(action.label ?? ''))
    .map((action) => action.value);

  assert.deepEqual(
    valuesForQuestion(
      'Which university are you currently attending? Select "Other" if not listed',
      'University of Southern California, Viterbi School of Engineering',
      /which university are you currently attending/i,
    ),
    ['University of Southern California', 'Other'],
    'the real school is tried first and the escape hatch only after it',
  );

  // And a question that does not advertise an escape hatch never gets one, however "other" reads in
  // its wording.
  assert.ok(!valuesForQuestion(
    'Do you have any other offers outstanding?',
    'No',
    /other offers outstanding/i,
  ).includes('Other'));
});

test('a redundant second guess at one control is given up before the only guess at another', () => {
  // The referral source fires at five label wordings, the graduation date at nine, the preferred
  // location at three, because only one of each can exist on a board. That is 85 of DRW's 231
  // actions. Before this, the trim gave up the referral question, the demographics and the education
  // row while keeping all 45 graduation-date guesses at a control DRW does not have.
  const actions = buildManagedPortalActions('greenhouse', overBudgetGreenhousePacket() as never);
  const bases = actions.map((action) => (action.label ?? '').replace(/_(?:open|option_value|option|select)$/, ''));
  const alternateReferralWordings = bases.filter((base) => /^greenhouse_referral_combo_(?:label|select):\d+:(?:How did you first hear|Where did you hear|Where have you learned|Referral source)/.test(base));
  assert.deepEqual(alternateReferralWordings, [], 'the four alternate referral wordings go first');
  const alternateGraduationGuesses = bases.filter((base) => /^education_graduation_date_combo:[1-9]/.test(base));
  assert.deepEqual(alternateGraduationGuesses, [], 'so do the eight alternate graduation-date guesses');
  // And what the freed budget bought: the education row, which used to be what paid for them.
  assert.ok(actions.some((action) => action.selector === '#discipline--0' && action.type === 'fill'));
});

test('no managed action can burn the 30s default — every fill, upload, and question is bounded', () => {
  // Live Jump Trading retry, 2026-07-24: after the core-field fix the run cleared name/email and
  // then died on `locator.setInputFiles: Timeout 30000ms exceeded` at the resume input, because the
  // upload action was neither optional nor bounded. Same latent 30s trap sat on phone/location and
  // the question fills. Every managed action must now be time-bounded so one wrong selector can't
  // eat the run's budget, and the resume upload must be optional so a missing file input degrades
  // to a blocker card instead of failing the run.
  for (const portal of ['greenhouse', 'lever', 'ashby'] as const) {
    const actions = buildManagedPortalActions(portal, {
      fullName: 'Taylor Example',
      email: 'taylor@example.com',
      phone: '+1 555 0100',
      city: 'Los Angeles',
      resume: Buffer.from('pdf'),
      resumeName: 'resume.pdf',
      questions: [{ question: 'Why this role?', answer: 'I enjoy systems work.' }],
    });
    for (const action of actions) {
      assert.ok(
        (action.timeout ?? Infinity) < 30_000,
        `${portal} ${action.type} (${action.label ?? action.text}) must be bounded under the 30s default`,
      );
    }
    const upload = actions.find((a) => a.type === 'upload');
    assert.equal(upload?.optional, true, `${portal} resume upload must degrade to a blocker, not fail the run`);
    assert.ok((upload?.timeout ?? Infinity) < 30_000, `${portal} resume upload must be bounded`);
  }
});

test('both providers may be sent reviewed questions', () => {
  // False for 'managed' only while its runner threw on checkboxes and ignored `optional`.
  assert.equal(canFillReviewedQuestions('managed'), true);
  assert.equal(canFillReviewedQuestions('direct'), true);
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
  const clicks = actions.filter((action) =>
    action.type === 'click'
    && !isGreenhousePreflightClick(action)
    && !isGreenhouseFixedCandidatePrivacyClick(action));
  assert.equal(clicks.length, 0, 'no click action may be synthesized from an answer string');
});

test('Greenhouse managed actions never include demographic data consent', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  assert.equal(actions.some((action) => action.label === 'greenhouse_demographic_data_consent_checkbox'), false);
  assert.equal(actions.some((action) => action.label === 'greenhouse_demographic_data_consent'), false);
});

test('Greenhouse managed actions never acknowledge a Candidate Privacy notice without its exact reviewed answer', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });

  assert.equal(actions.some((action) => action.label === 'greenhouse_candidate_privacy_acknowledgement'), false);
  assert.equal(actions.some((action) => action.selector?.includes('Candidate Privacy Policy')), false);
  assert.equal(actions.some((action) => action.label === 'greenhouse_demographic_data_consent_checkbox'), false);
});

test('Greenhouse managed actions replay routine applicant consent controls', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      { question: 'Yes, I consent', answer: 'Yes, I consent' },
      {
        question: 'Do you consent to Brex processing your personal information for the purpose of assessing your candidacy for this position?',
        answer: 'Yes',
      },
    ],
  });
  assert.ok(actions.some((action) => action.type === 'fillByLabelText' && action.text === 'Yes, I consent' && action.value === 'Yes, I consent'));
  assert.ok(actions.some((action) =>
    action.type === 'fillByLabelText'
    && action.text === 'Do you consent to Brex processing your personal information for the purpose of assessing your candidacy for this position?'
    && action.value === 'Yes'));
});

test('Greenhouse managed actions include explicitly saved demographic choices', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    eeoPrefs: {
      gender: 'Female',
      transgender_status: 'Decline to self-identify',
      sexual_orientation: 'Heterosexual',
      disability_status: 'Decline to self-identify',
      veteran_status: 'Decline to self-identify',
      race: 'White',
    },
    questions: [],
  });
  assert.deepEqual(
    actions
      .filter((action) => action.label?.startsWith('greenhouse_demographic:'))
      .map((action) => [action.text, action.value]),
    [
      ['What gender identity do you most closely identify with?', 'Female'],
      ['Are you a person of transgender experience?', 'Decline to self-identify'],
      ['What sexual orientation do you most closely identify with?', 'Heterosexual'],
      ['Do you live with a disability (as outlined by the ADA)?', 'Decline to self-identify'],
      ['Are you a veteran/have you served in the military?', 'Decline to self-identify'],
      ['Please select up to 2 ethnicities that you most closely identify with.', 'White'],
    ],
  );
});

test('question wording alone cannot predict a control type', () => {
  // Recorded because it is the lesson that cost three deploys: this reads like free text and is a
  // checkbox group on Aquatic's Greenhouse form. The heuristic is a helper, never the guard.
  assert.equal(isChoiceQuestion('How did you hear about this job?'), true);
});

// ─── Workable / JazzHR / Paylocity (added 2026-07-28) ─────────────────────────
// Every assertion below encodes something read off a LIVE form that day, not a naming pattern.
// See litos-ats-dom-capture-2026-07-28.md. The point of each is to fail if someone "simplifies" a
// selector back to the obvious-but-wrong version.

const capturePacket = {
  fullName: 'Taylor Example',
  email: 'taylor@example.com',
  phone: '+971500000000',
  city: 'Dubai',
  linkedinUrl: 'https://linkedin.com/in/taylor',
  githubUrl: 'https://github.com/taylor',
  portfolioUrl: 'https://taylor.example',
  resume: Buffer.from('pdf'),
  resumeName: 'resume.pdf',
  questions: [],
};

test('the three captured application hosts are detected', () => {
  assert.equal(detectPortal('https://apply.workable.com/suade/j/9C43981D17/apply'), 'workable');
  assert.equal(detectPortal('https://utilidata.applytojob.com/apply/jobs/details/VSeisrJblO'), 'jazzhr');
  assert.equal(detectPortal('https://2000recruiting.paylocity.com/Recruiting/Jobs/Apply/44457'), 'paylocity');
});

test('Workable uploads the resume by data-ui, never by id or a bare file selector', () => {
  // The live form randomises the resume input's id per render AND ships a second file input for the
  // profile photo (data-ui="avatar") that appears FIRST in the DOM. A bare input[type="file"] or any
  // id-based match files the student's resume as her headshot.
  const actions = buildManagedPortalActions('workable', capturePacket, true);
  const upload = actions.find((action) => action.type === 'upload' && action.label === 'resume');
  assert.ok(upload, 'Workable must push a resume upload');
  assert.match(upload!.selector!, /data-ui="resume"/);
  assert.doesNotMatch(upload!.selector!, /input_files_input/, 'must not match the per-render random id');
  assert.notEqual(upload!.selector, 'input[type="file"]');
});

test('managed Workable phone selects exact UAE and verifies the final post-upload value', () => {
  const actions = buildManagedPortalActions('workable', {
    ...capturePacket,
    phone: '+971 567417451',
    transcript: Buffer.from('transcript-pdf'),
    transcriptName: 'transcript.pdf',
  });
  const uploadIndexes = actions
    .map((action, index) => action.type === 'upload' ? index : -1)
    .filter((index) => index >= 0);
  const addressIndexes = actions
    .map((action, index) => action.label?.startsWith('location') ? index : -1)
    .filter((index) => index >= 0);
  const lateCookieDeclineIndex = actions.findIndex(
    (action) => action.label === 'workable_cookie_final_decline',
  );
  const lateCookieClearedIndex = actions.findIndex(
    (action) => action.label === 'workable_cookie_final_cleared',
  );
  const countryOpenIndex = actions.findIndex((action) => action.label === 'phone_country_open');
  const capabilityIndex = actions.findIndex((action) => action.type === 'requireCapability');
  const countryOptionIndex = actions.findIndex((action) => action.label === 'phone_country_option');
  const phoneIndex = actions.findIndex((action) => action.type === 'fill' && action.label === 'phone');
  const countryProofIndex = actions.findIndex((action) => action.label === 'filled_field:phone_country');
  const phoneProofIndex = actions.findIndex((action) => action.label === 'filled_field:phone');

  assert.ok(capabilityIndex > Math.max(...uploadIndexes, ...addressIndexes));
  assert.equal(lateCookieDeclineIndex, capabilityIndex + 1);
  assert.equal(lateCookieClearedIndex, lateCookieDeclineIndex + 1);
  assert.equal(countryOpenIndex, lateCookieClearedIndex + 1);
  assert.ok(countryOptionIndex > countryOpenIndex);
  assert.ok(phoneIndex > countryOptionIndex);
  assert.ok(countryProofIndex > phoneIndex);
  assert.ok(phoneProofIndex > countryProofIndex);
  assert.deepEqual(actions[countryOpenIndex], {
    type: 'click',
    selector: 'div[role="combobox"][aria-label="Telephone country code"][aria-controls]:visible',
    label: 'phone_country_open',
    optional: false,
    timeout: 10_000,
    requireUnique: true,
  });
  assert.deepEqual(actions[lateCookieDeclineIndex], {
    type: 'click',
    selector: 'div[role="dialog"][data-ui="cookie-consent"][aria-label="Cookie Consent"] button:has-text("Decline all")',
    label: 'workable_cookie_final_decline',
    optional: true,
    timeout: 10_000,
    requireUnique: true,
  });
  assert.deepEqual(actions[lateCookieClearedIndex], {
    type: 'waitForSelector',
    selector: 'body:not(:has(div[role="dialog"][data-ui="cookie-consent"][aria-label="Cookie Consent"])):not(:has(div[data-ui="backdrop"]))',
    label: 'workable_cookie_final_cleared',
    optional: false,
    timeout: 10_000,
  });
  assert.deepEqual(actions[capabilityIndex], {
    type: 'requireCapability',
    value: MANAGED_EXTRACT_ASSERTIONS_CAPABILITY,
    label: 'workable_phone_assertion_capability',
    optional: false,
  });
  assert.deepEqual(actions[countryOptionIndex], {
    type: 'click',
    selector: '[role="option"][data-country-code="ae"][data-dial-code="971"][id$="__item-ae"]:visible',
    label: 'phone_country_option',
    optional: false,
    timeout: 10_000,
    requireUnique: true,
  });
  assert.equal(actions[phoneIndex]?.selector, 'input[name="phone"][type="tel"]:visible');
  assert.equal(actions[phoneIndex]?.value, '0567417451');
  assert.equal(actions[phoneIndex]?.requireUnique, true);
  assert.equal(actions[phoneIndex]?.optional, false);
  assert.equal(actions[countryProofIndex]?.expectedValueIncludes, '+971');
  assert.equal(actions[countryProofIndex]?.expectedValueDigits, '971');
  assert.equal(
    actions[countryProofIndex]?.selector,
    'div[role="combobox"][aria-label="Telephone country code"][aria-controls]:visible',
  );
  assert.equal(actions[countryProofIndex]?.requireNonEmpty, true);
  assert.equal(actions[countryProofIndex]?.requireUnique, true);
  assert.equal(actions[countryProofIndex]?.stabilityWindowMs, 1_200);
  assert.equal(actions[phoneProofIndex]?.attribute, 'value');
  assert.equal(actions[phoneProofIndex]?.requireNonEmpty, true);
  assert.equal(actions[phoneProofIndex]?.expectedValueDigits, '0567417451');
  assert.equal(actions[phoneProofIndex]?.requireUnique, true);
  assert.equal(actions[phoneProofIndex]?.stabilityWindowMs, 1_200);
});

test('managed Workable US phone selects exact United States and proves national digits', () => {
  const actions = buildManagedPortalActions('workable', {
    ...capturePacket,
    phone: '+1 213 574 6270',
  });
  const lateCookieDeclineIndex = actions.findIndex(
    (action) => action.label === 'workable_cookie_final_decline',
  );
  const lateCookieClearedIndex = actions.findIndex(
    (action) => action.label === 'workable_cookie_final_cleared',
  );
  const countryOpenIndex = actions.findIndex((action) => action.label === 'phone_country_open');
  const countryOptionIndex = actions.findIndex((action) => action.label === 'phone_country_option');
  const phoneIndex = actions.findIndex((action) => action.type === 'fill' && action.label === 'phone');
  const countryProofIndex = actions.findIndex((action) => action.label === 'filled_field:phone_country');
  const phoneProofIndex = actions.findIndex((action) => action.label === 'filled_field:phone');

  assert.equal(lateCookieClearedIndex, lateCookieDeclineIndex + 1);
  assert.equal(countryOpenIndex, lateCookieClearedIndex + 1);
  assert.equal(countryOptionIndex, countryOpenIndex + 1);
  assert.deepEqual(actions[countryOptionIndex], {
    type: 'click',
    selector: '[role="option"][data-country-code="us"][data-dial-code="1"][id$="__item-us"]:visible',
    label: 'phone_country_option',
    optional: false,
    timeout: 10_000,
    requireUnique: true,
  });
  assert.equal(actions[phoneIndex]?.value, '2135746270');
  assert.equal(actions[phoneIndex]?.requireUnique, true);
  assert.equal(actions[countryProofIndex]?.expectedValueIncludes, '+1');
  assert.equal(actions[countryProofIndex]?.expectedValueDigits, '1');
  assert.equal(actions[countryProofIndex]?.requireUnique, true);
  assert.equal(actions[countryProofIndex]?.stabilityWindowMs, 1_200);
  assert.equal(actions[phoneProofIndex]?.expectedValueDigits, '2135746270');
  assert.equal(actions[phoneProofIndex]?.requireUnique, true);
  assert.equal(actions[phoneProofIndex]?.stabilityWindowMs, 1_200);
});

test('managed Workable submit is gated by invalid nonempty phones but not an absent phone', () => {
  const invalidPhones = [
    '+442071234567',
    '+1 213',
    '+971 50',
    '+abc',
  ];
  for (const phone of invalidPhones) {
    const actions = buildManagedPortalActions('workable', { ...capturePacket, phone }, true);
    assert.equal(
      actions.some((action) => action.type === 'confirmAndSubmit'),
      false,
      phone,
    );
    assert.equal(actions.some((action) => action.label === 'phone_country_open'), false, phone);
    assert.equal(actions.some((action) => action.label === 'phone'), false, phone);
  }

  for (const phone of ['+1 213 574 6270', '+971 56 741 7451']) {
    const actions = buildManagedPortalActions('workable', { ...capturePacket, phone }, true);
    assert.equal(actions.filter((action) => action.type === 'confirmAndSubmit').length, 1, phone);
  }
  for (const phone of [undefined, '']) {
    const actions = buildManagedPortalActions('workable', { ...capturePacket, phone }, true);
    assert.equal(actions.filter((action) => action.type === 'confirmAndSubmit').length, 1);
  }
});

test('managed Workable final cookie boundary handles both a late modal and no modal', () => {
  const actions = buildManagedPortalActions('workable', {
    ...capturePacket,
    phone: '+971 567417451',
  });
  const boundaryLabels = new Set([
    'workable_cookie_final_decline',
    'workable_cookie_final_cleared',
    'phone_country_open',
  ]);
  const boundary = actions.filter((action) => boundaryLabels.has(action.label ?? ''));

  const replay = (appearsLate: boolean) => {
    let dialogPresent = appearsLate;
    let backdropPresent = appearsLate;
    const events: string[] = [];
    for (const action of boundary) {
      if (action.label === 'workable_cookie_final_decline') {
        if (dialogPresent) {
          dialogPresent = false;
          backdropPresent = false;
          events.push('decline');
        } else {
          assert.equal(action.optional, true);
          events.push('optional-miss');
        }
      } else if (action.label === 'workable_cookie_final_cleared') {
        assert.equal(dialogPresent, false);
        assert.equal(backdropPresent, false);
        events.push('cleared');
      } else if (action.label === 'phone_country_open') {
        assert.equal(dialogPresent || backdropPresent, false, 'cookie overlay would intercept the phone trigger');
        events.push('country-open');
      }
    }
    return events;
  };

  assert.deepEqual(replay(true), ['decline', 'cleared', 'country-open']);
  assert.deepEqual(replay(false), ['optional-miss', 'cleared', 'country-open']);
});

/* The 2026-07-29 Rippling capture was taken at .../jobs/<id>/apply; a posting saved from the JD
   page lacks the suffix, and a runner sent there finds no controls at all. Measured live
   2026-08-19: the run parked with "did not record an email field / a resume upload / the
   applicant name fields". The mapping is bounded to the two-segment posting shape, so a deeper or
   already-canonical path is left alone. */
test('a Breezy posting URL maps to its /apply form, and an /apply URL passes through', () => {
  const posting = 'https://transparent-hiring.breezy.hr/p/4d5a1d20f0ce-hr-assistant-intern-m-f-d-remote';
  const application = `${posting}/apply`;
  assert.equal(portalApplicationUrl('breezy', posting), application);
  assert.equal(portalApplicationUrl('breezy', application), application);
});

test('a Rippling posting URL maps to its /apply form, and an /apply URL passes through', () => {
  const posting = 'https://ats.rippling.com/easy-dynamics-corporation/jobs/0eb836b2-6719-48e0-89c9-6c589063a225';
  const application = `${posting}/apply`;
  assert.equal(portalApplicationUrl('rippling', posting), application);
  assert.equal(portalApplicationUrl('rippling', application), application);
});

/* Measured live 2026-08-20: a managed run sent to a bare Lever posting page filled nothing and
   parked with "could not confirm it reached this company's application form". Every earlier Lever
   send went through the extension, so the runner had never been handed this URL shape. The
   mapping is bounded to the tenant-plus-uuid posting shape: a board root, a deeper path, or an
   already-canonical /apply URL passes through unchanged. */
test('a Lever posting URL maps to its /apply form, and everything else passes through', () => {
  const posting = 'https://jobs.lever.co/dga/d93550cc-8533-4d4e-b0c1-ee6376a34843';
  const application = `${posting}/apply`;
  assert.equal(portalApplicationUrl('lever', posting), application);
  assert.equal(portalApplicationUrl('lever', application), application);
  assert.equal(portalApplicationUrl('lever', `${posting}/`), application);
  const boardRoot = 'https://jobs.lever.co/dga';
  assert.equal(portalApplicationUrl('lever', boardRoot), boardRoot);
});

test('Workable opens the exact application route and clears optional-cookie overlays before filling', () => {
  const posting = 'https://apply.workable.com/mercari/j/EC5A1078C4/';
  const application = 'https://apply.workable.com/mercari/j/EC5A1078C4/apply';
  assert.equal(portalApplicationUrl('workable', posting), application);
  assert.equal(portalApplicationUrl('workable', application), application);

  const actions = buildManagedPortalActions('workable', capturePacket, true);
  const declineIndex = actions.findIndex((action) => action.label === 'workable_cookie_preflight');
  const readyIndex = actions.findIndex((action) => action.label === 'workable_application_form_ready');
  const firstNameIndex = actions.findIndex((action) => action.label === 'first_name');
  assert.ok(declineIndex >= 0, 'Workable must dismiss the cookie overlay without accepting optional cookies');
  assert.equal(actions[declineIndex]?.selector, 'button:has-text("Decline all")');
  assert.ok(readyIndex > declineIndex, 'Workable must wait for the candidate form after cookie preflight');
  assert.ok(firstNameIndex > readyIndex, 'Workable form readiness must precede fixed-field filling');
});

test('direct Workable preparation reaches the same form and declines optional cookies', async () => {
  let currentUrl = 'https://apply.workable.com/mercari/j/EC5A1078C4/';
  const events: string[] = [];
  const fakePage = {
    url: () => currentUrl,
    goto: async (destination: string) => {
      currentUrl = destination;
      events.push(`goto:${destination}`);
    },
    locator: (selector: string) => ({
      first: () => selector === 'button:has-text("Decline all")'
        ? {
          count: async () => 1,
          isVisible: async () => true,
          click: async () => { events.push('decline'); },
        }
        : {
          waitFor: async () => { events.push('ready'); },
        },
    }),
  } as unknown as Page;

  await navigateToApplicationForm(fakePage, 'workable');

  assert.equal(currentUrl, 'https://apply.workable.com/mercari/j/EC5A1078C4/apply');
  assert.deepEqual(events, [
    'goto:https://apply.workable.com/mercari/j/EC5A1078C4/apply',
    'decline',
    'ready',
  ]);
});

test('Workable never ticks the GDPR consent checkbox', () => {
  const actions = buildManagedPortalActions('workable', capturePacket, true);
  assert.equal(actions.some((action) => JSON.stringify(action).includes('gdpr')), false);
});

test('JazzHR fills the form but is never allowed to auto-submit, because of reCAPTCHA', () => {
  // Every JazzHR application form carries a live g-recaptcha-response field. Filling is fine;
  // submitting is not, and that stop is policy, not a missing selector.
  assert.equal(portalCanAutoSubmit('jazzhr'), false);
  const actions = buildManagedPortalActions('jazzhr', capturePacket, true);
  assert.ok(actions.some((action) => action.type === 'fill' && action.selector?.includes('resumator-firstname-value')));
  assert.notEqual(actions.at(-1)?.type, 'click', 'a submit click must NOT be appended');
  assert.equal(actions.some((action) => action.type === 'click'), false);
});

test('JazzHR never answers the voluntary EEO questions', () => {
  const actions = buildManagedPortalActions('jazzhr', capturePacket, true);
  assert.equal(actions.some((action) => JSON.stringify(action).includes('eeo_')), false);
});

test('Paylocity matches its dotted ids by attribute, since #info.firstName is invalid CSS', () => {
  const actions = buildManagedPortalActions('paylocity', capturePacket, true);
  const first = actions.find((action) => action.label === 'first_name');
  assert.ok(first);
  assert.equal(first!.selector, '[id="info.firstName"]');
  assert.doesNotMatch(first!.selector!, /#info\./, 'a #id selector cannot match an id containing a dot');
});

test('Paylocity walks its wizard, but every click is label-scoped and can never hit the terminal submit', () => {
  // Paylocity reuses the id #btn-submit for BOTH "Next Step" and the final submit, so an advance
  // selector that matches on the id alone would press Submit on the last step. Scoping by visible
  // text is what makes the traversal structurally unable to submit, rather than relying on a step
  // count staying in sync with Paylocity's own wizard logic.
  assert.equal(portalCanAutoSubmit('paylocity'), false);
  const actions = buildManagedPortalActions('paylocity', capturePacket, true);
  const clicks = actions.filter((action) => action.type === 'click');
  assert.ok(clicks.length > 0, 'Paylocity must advance through its wizard');
  for (const click of clicks) {
    assert.match(click.selector!, /:has-text\("Next Step"\)/, 'every click must be label-scoped');
    assert.equal(click.optional, true, 'a missing advance button must be a no-op, not an error');
  }
  // The generic terminal submit selector used by single-step portals must never appear.
  assert.equal(actions.some((a) => a.selector === 'button[type="submit"], input[type="submit"]'), false);
});

test('Paylocity fills work history from the parsed resume, and only the first row', () => {
  const withRole = { ...capturePacket, mostRecentRole: { company: 'Traeco', title: 'Founding Engineer', summary: 'Built the ingest pipeline.', startDate: 'Jun 2025', endDate: 'Present' } };
  const actions = buildManagedPortalActions('paylocity', withRole, true);
  assert.equal(actions.find((a) => a.label === 'work_company')?.selector, '[id="workHistory.companyName.0"]');
  assert.equal(actions.find((a) => a.label === 'work_title')?.value, 'Founding Engineer');
  // Row 1 only - never creates additional rows it may not be able to complete.
  assert.equal(actions.some((a) => /workHistory\.\w+\.[1-9]/.test(a.selector ?? '')), false);
  assert.equal(actions.some((a) => /Add Work History/i.test(a.selector ?? '')), false);
});

test('a profile with no parsed experience simply skips the work-history fills', () => {
  const actions = buildManagedPortalActions('paylocity', capturePacket, true);
  assert.equal(actions.some((a) => a.label?.startsWith('work_')), false);
});

test('Paylocity re-runs the reviewed-question fills on every step, since screeners are not on page one', () => {
  const withQuestions = { ...capturePacket, questions: [{ question: 'Why this role?', answer: 'Because it is backend-heavy.' }] };
  const actions = buildManagedPortalActions('paylocity', withQuestions, true);
  const asked = actions.filter((a) => a.type === 'fillByLabelText' && a.text === 'Why this role?');
  // Once for step one, then once after each advance.
  assert.equal(asked.length, 4);
});

test('the notLastStep markers mean NOT the last step, so a step-one page is never the attestation page', () => {
  // Regression test for a real inversion caught in review. The marker ids end in `notLastStep`:
  // they are Paylocity's own negative flags, present precisely when the page is NOT terminal. The
  // first version treated their presence as proof of the terminal page, so it returned true on step
  // one - which would have told the student "one page left, and it needs you" on page one of four.
  const stepOne = '<div class="progress-header">Step 1 of 4</div>'
    + '<span id="acknowledgements.priorConviction.notLastStep"></span>'
    + '<span id="acknowledgements.authorizedToWorkInUS.notLastStep"></span>'
    + '<input id="info.firstName"><button id="btn-submit">Next Step</button>';
  assert.equal(isPaylocityTerminalStep(stepOne), false);

  // The terminal page: the negative markers are gone, the wizard's control is still there.
  const stepFour = '<div class="progress-header">Step 4 of 4</div>'
    + '<label>By submitting your application you hereby certify...</label>'
    + '<button id="btn-submit">Submit application</button>';
  assert.equal(isPaylocityTerminalStep(stepFour), true);

  // Not a wizard page at all (error, redirect, timeout) - absence of the markers alone is not proof.
  assert.equal(isPaylocityTerminalStep('<h1>Something went wrong</h1>'), false);
});

test('a portal that cannot auto-submit is stopped before either provider path, not inside the action builder', () => {
  // Regression test for the most serious review finding. The gate used to live ONLY inside
  // buildManagedPortalActions, which removed the click from the managed action list but did nothing
  // about (a) the code that then called readManagedReceipt and wrote status:'submitted' anyway, or
  // (b) the direct-Playwright path, which calls clickFinalSubmit(page) unconditionally. The real
  // guarantee has to be enforced by the caller, so assert the predicate the caller keys off.
  for (const portal of ['jazzhr', 'paylocity', 'controlled_jazzhr', 'controlled_paylocity'] as const) {
    assert.equal(portalCanAutoSubmit(portal), false, portal);
    assert.ok(portalHandoffReason(portal), `${portal} must explain the handoff to the student`);
  }
  for (const portal of ['workable', 'greenhouse', 'lever', 'ashby'] as const) {
    assert.equal(portalCanAutoSubmit(portal), true, portal);
  }
});

test('each handoff reason names its own cause rather than a generic stop', () => {
  const captcha = portalHandoffReason('jazzhr')!;
  const wizard = portalHandoffReason('paylocity')!;
  assert.match(captcha, /prove you are human/);
  assert.match(wizard, /last page/);
  assert.notEqual(captcha, wizard);
  assert.equal(portalHandoffReason('controlled_jazzhr'), captcha);
  assert.equal(portalHandoffReason('workable'), null);
});

test('the wizard is only walked on a real submit run, never on the preview that the human approves', () => {
  // prepare() builds actions with submit=false to capture the preview screenshot. Traversing there
  // advanced a real employer's wizard on a run that explicitly asked not to submit, and captured the
  // preview of step 4 - showing the student an empty attestation page as the thing she was approving.
  const preview = buildManagedPortalActions('paylocity', capturePacket, false);
  assert.equal(preview.some((a) => a.type === 'click'), false, 'a preview run must not advance the wizard');
  const real = buildManagedPortalActions('paylocity', capturePacket, true);
  assert.ok(real.some((a) => a.type === 'click'), 'a submit run still walks it');
});

test('direct required-field fallback treats unchecked required choices as empty', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile('src/lib/portalSubmission.ts', 'utf8'));
  const start = source.indexOf("const required = page.locator('input[required], textarea[required], select[required]')");
  assert.ok(start >= 0, 'required-field scanner is missing');
  const end = source.indexOf('blockers.push(...new Set(labelledBlockers))', start);
  assert.ok(end > start, 'could not bound required-field scanner');
  const scanner = source.slice(start, end);

  assert.match(scanner, /type === 'checkbox' \|\| type === 'radio'/);
  assert.match(scanner, /field\.isChecked\(\)/);
  assert.match(scanner, /fillResolvedRequiredField\(field, label, packet, filledFields\)/);
  assert.doesNotMatch(scanner, /const value = await field\.inputValue\(\)[\s\S]{0,80}if \(value\) continue;[\s\S]{0,80}type === 'checkbox'/);
});

test('the QA harness routes to each new controlled adapter, by query param and by path', () => {
  const previous = {
    enabled: process.env.LITOS_ENABLE_TEST_PORTAL,
    nodeEnv: process.env.NODE_ENV,
  };
  try {
    process.env.NODE_ENV = 'test';
    process.env.LITOS_ENABLE_TEST_PORTAL = 'true';
    for (const board of ['workable', 'jazzhr', 'paylocity'] as const) {
      assert.equal(detectPortal(`http://localhost:3000/qa/portal-submission?board=${board}`), `controlled_${board}`);
      assert.equal(detectPortal(`http://localhost:3000/qa/portal-submission/${board}/${board}-01`), `controlled_${board}`);
    }
  } finally {
    if (previous.enabled === undefined) delete process.env.LITOS_ENABLE_TEST_PORTAL;
    else process.env.LITOS_ENABLE_TEST_PORTAL = previous.enabled;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
  }
});

test('the new host rules reject marketing sites and the Paylocity employee login', () => {
  // access.paylocity.com is a CREDENTIAL page on the same host space as the job boards, and
  // www.workable.com is the vendor's marketing site. A bare host match claimed both, so a mistyped
  // portal_url became a "supported portal" and earned a fill run against a login form.
  assert.throws(() => detectPortal('https://access.paylocity.com/'), /cannot fill in/);
  assert.throws(() => detectPortal('https://www.paylocity.com/company/careers/'), /cannot fill in/);
  assert.throws(() => detectPortal('https://www.workable.com/'), /cannot fill in/);
  assert.throws(() => detectPortal('https://jobs.workable.com/search'), /cannot fill in/);
  // The real application pages still resolve.
  assert.equal(detectPortal('https://apply.workable.com/suade/j/9C43981D17/apply'), 'workable');
  assert.equal(detectPortal('https://2000recruiting.paylocity.com/Recruiting/Jobs/Apply/44457'), 'paylocity');
  assert.equal(detectPortal('https://recruiting.paylocity.com/recruiting/jobs/Details/4084914/X/Y'), 'paylocity');
});

test('each new adapter pushes the exact selector read off the live form', () => {
  // Mutation testing during review showed most of these were unpinned: changing the Workable phone
  // selector, the JazzHR email selector, or deleting the Paylocity location fill all kept the suite
  // green. A table is the cheap way to make every captured selector load-bearing.
  const withRole = {
    ...capturePacket,
    coverLetter: Buffer.from('pdf'),
    coverLetterName: 'cover.pdf',
    mostRecentRole: { company: 'Traeco', title: 'Founding Engineer', summary: 'Built it.', startDate: 'Jun 2025', endDate: 'Present' },
  };
  const expected: Record<string, Record<string, string>> = {
    workable: {
      first_name: 'input[name="firstname"]', last_name: 'input[name="lastname"]',
      email: 'input[name="email"]', phone: 'input[name="phone"][type="tel"]:visible',
      location: 'input[name="address"]:visible, body:not(:has(input[name="address"]:visible)) input[name="city"]:visible',
      resume: 'input[type="file"][data-ui="resume"]',
    },
    jazzhr: {
      first_name: 'input[name="resumator-firstname-value"]', last_name: 'input[name="resumator-lastname-value"]',
      email: 'input[name="resumator-email-value"]', phone: 'input[name="resumator-phone-value"]',
      location: 'input[name="resumator-city-value"]', linkedin: 'input[name="resumator-linkedin-value"]',
      resume: 'input[type="file"][name="resumator-resume-value"]',
    },
    paylocity: {
      first_name: '[id="info.firstName"]', last_name: '[id="info.lastName"]',
      email: '[id="info.email"]', phone: '[id="info.cellPhone"]', linkedin: '[id="info.linkedIn"]',
      location: '#public-site-address-city', resume: '#btn-resume', cover_letter: '#btn-coverLetter',
      work_company: '[id="workHistory.companyName.0"]', work_title: '[id="workHistory.position.0"]',
      work_summary: '[id="workHistory.responsibilities.0"]',
      work_start: '#txt-workHistory-startDate-0', work_end: '#txt-workHistory-endDate-0',
    },
  };
  for (const [portal, fields] of Object.entries(expected)) {
    const actions = buildManagedPortalActions(portal as 'workable', withRole, true);
    for (const [label, selector] of Object.entries(fields)) {
      assert.equal(actions.find((a) => a.label === label)?.selector, selector, `${portal}.${label}`);
    }
  }
});

test('Workable commits the visible address autocomplete after filling it', async () => {
  const managed = buildManagedPortalActions('workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    city: 'Dubai',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const locationIndex = managed.findIndex((action) => action.label === 'location');
  assert.ok(locationIndex >= 0);
  assert.deepEqual(managed.slice(locationIndex, locationIndex + 2), [
    {
      type: 'fill',
      selector: 'input[name="address"]:visible, body:not(:has(input[name="address"]:visible)) input[name="city"]:visible',
      value: 'Dubai',
      label: 'location',
      optional: true,
      timeout: 10_000,
    },
    {
      type: 'press',
      selector: 'input[name="address"]:visible, body:not(:has(input[name="address"]:visible)) input[name="city"]:visible',
      value: 'Enter',
      label: 'location_select',
      optional: true,
      timeout: 10_000,
    },
  ]);

  const { page, values } = directFillPage([
    'input[name="firstname"]',
    'input[name="lastname"]',
    'input[name="email"]',
    'input[name="address"]:visible',
    'input[name="city"]',
  ], {
    isVisible: (selector, present) => present && selector !== 'input[name="city"]',
    getAttribute: (selector, name) => selector === 'input[name="city"]' && name === 'type' ? 'hidden' : null,
    onPress: (selector, key, stored) => {
      if (selector === 'input[name="address"]:visible' && key === 'Enter') {
        stored.set('input[name="city"]', 'Dubai');
      }
    },
  });
  const committed = await fillPortal(page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    city: 'Dubai',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  assert.equal(values.get('input[name="address"]:visible'), 'Dubai');
  assert.equal(values.get('input[name="address"]:visible::press'), 'Enter');
  assert.equal(values.has('input[name="city"]:visible'), false);
  assert.ok(committed.filledFields.includes('location'));

  const legacy = directFillPage([
    'input[name="firstname"]',
    'input[name="lastname"]',
    'input[name="email"]',
    'input[name="address"]:visible',
    'input[name="city"]:visible',
  ]);
  const legacyResult = await fillPortal(legacy.page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    city: 'Dubai',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  assert.equal(legacy.values.get('input[name="address"]:visible'), '');
  assert.equal(legacy.values.get('input[name="city"]:visible'), 'Dubai');
  assert.equal(legacy.values.get('input[name="city"]:visible::press'), 'Enter');
  assert.ok(legacyResult.filledFields.includes('location'));

  const uncommitted = directFillPage([
    'input[name="firstname"]',
    'input[name="lastname"]',
    'input[name="email"]',
    'input[name="address"]:visible',
  ]);
  const uncommittedResult = await fillPortal(uncommitted.page, 'workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    city: 'Dubai',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  assert.equal(uncommitted.values.get('input[name="address"]:visible'), '');
  assert.equal(uncommittedResult.filledFields.includes('location'), false);
});

test('the Paylocity advance selector is exactly the label-scoped form, never the bare id', () => {
  const actions = buildManagedPortalActions('paylocity', capturePacket, true);
  const clicks = actions.filter((a) => a.type === 'click');
  assert.ok(clicks.length > 0);
  for (const click of clicks) assert.equal(click.selector, '#btn-submit:has-text("Next Step")');
});

test('Paylocity never answers EEO, OFCCP, the conviction question, or the attestation', () => {
  const actions = buildManagedPortalActions('paylocity', capturePacket, true);
  assert.ok(actions.some((a) => a.label === 'first_name'), 'sanity: the adapter actually ran');
  for (const marker of ['acknowledgements.', 'eeoGenderEthnicity', 'priorConviction', 'authorizedToWorkInUS', 'useAttachedResume']) {
    assert.equal(actions.some((a) => JSON.stringify(a).includes(marker)), false, marker);
  }
});

test('Paylocity picks the resume file input out of the three the form renders', () => {
  const actions = buildManagedPortalActions('paylocity', capturePacket, true);
  const upload = actions.find((action) => action.type === 'upload' && action.label === 'resume');
  assert.equal(upload?.selector, '#btn-resume');
});

test('Paylocity leaves the parse-my-resume checkbox alone so it cannot overwrite our fills', () => {
  const actions = buildManagedPortalActions('paylocity', capturePacket, true);
  assert.equal(actions.some((action) => JSON.stringify(action).includes('useAttachedResume')), false);
});

test('the portals that cannot auto-submit each explain why in plain language', () => {
  for (const portal of ['jazzhr', 'paylocity'] as const) {
    const reason = portalHandoffReason(portal);
    assert.ok(reason && reason.length > 0, `${portal} must explain its handoff`);
  }
  assert.equal(portalHandoffReason('workable'), null, 'a fully supported portal has nothing to explain');
});

test('every controlled variant maps to its real family and keeps that family’s guarantees', () => {
  for (const [controlled, live] of [
    ['controlled_workable', 'workable'],
    ['controlled_jazzhr', 'jazzhr'],
    ['controlled_paylocity', 'paylocity'],
  ] as const) {
    assert.equal(portalCanAutoSubmit(controlled), portalCanAutoSubmit(live));
    // The controlled fixture must exercise the SAME selectors as the live adapter, or the harness
    // proves nothing about production.
    const viaControlled = buildManagedPortalActions(controlled, capturePacket, false).map((a) => a.selector);
    const viaLive = buildManagedPortalActions(live, capturePacket, false).map((a) => a.selector);
    assert.deepEqual(viaControlled, viaLive);
  }
});

// ─── 2026-07-29: Rippling, BreezyHR, BambooHR, and the four account-walled platforms ──────────────

test('every autonomous family actually fills something before it is allowed to press submit', () => {
  // The structural hazard this whole file's type design creates, made into a test.
  //
  // AutonomousPortalFamily is derived by EXCLUSION - a family is autonomous unless someone remembers
  // to add it to the multi-step, CAPTCHA or account-walled sets. So a new family whose fill branch is
  // missing or misspelled does not fail to compile and does not fail any selector test. It quietly
  // becomes "autonomous", pushes zero fills, and the runner clicks submit on an empty form. That is
  // the same shape as the 2026-07-28 finding where a gate existed but did not gate.
  //
  // Requiring a real identity fill plus the click closes it for every present and future member.
  for (const family of AUTONOMOUS_PORTAL_FAMILIES) {
    const actions = buildManagedPortalActions(family, capturePacket, true);
    const fills = actions.filter((a) => a.type === 'fill');
    assert.ok(fills.length >= 2, `${family}: an autonomous portal that fills nothing would submit an empty form`);
    assert.ok(
      actions.some((a) => a.type === 'fill' && a.label === 'email'),
      `${family}: no email fill, so the form cannot identify the applicant`,
    );
    assert.ok(
      actions.some((a) => a.type === 'upload' && a.label === 'resume'),
      `${family}: no resume upload`,
    );
    assert.equal(actions.at(-1)?.type, 'confirmAndSubmit', `${family}: an autonomous portal must end in atomic confirmation and submit`);
  }
});

test('the account-walled four push no actions at all, because there is no form to act on', () => {
  // Jobvite/iCIMS/Oracle/UltiPro never reach an application field: a data-consent choice, a login
  // wall, or an emailed code comes first. Firing optional fills at those pages would miss and produce
  // a blocker card implying the form was found and merely refused, when it was never reached.
  for (const portal of ['jobvite', 'icims', 'oraclecloud', 'ultipro'] as const) {
    assert.deepEqual(buildManagedPortalActions(portal, capturePacket, true), [], portal);
    assert.equal(portalCanAutoSubmit(portal), false, portal);
    assert.equal(isAutonomousPortalFamily(portal), false, portal);
    assert.ok(isAccountWalledFamily(portal), portal);
    assert.equal(
      (POLLABLE_JOB_BOARDS as readonly string[]).includes(portal),
      false,
      `${portal} must never reach the jobs board`,
    );
  }
});

test('an account-walled handoff never claims Litos filled a form it never reached', () => {
  // The CAPTCHA and wizard sentences both open with "Litos filled everything in" / "Litos filled in
  // this application", which is true for those families and a plain lie for these four. A student
  // told that would go hunting for filled fields that do not exist.
  for (const portal of ['jobvite', 'icims', 'oraclecloud', 'ultipro'] as const) {
    const reason = portalHandoffReason(portal)!;
    assert.ok(reason, portal);
    assert.doesNotMatch(reason, /filled everything in|filled in this application/i, portal);
  }
  // And each names its own cause, rather than sharing one vague sentence.
  const reasons = (['jobvite', 'icims', 'oraclecloud', 'ultipro'] as const).map((p) => portalHandoffReason(p)!);
  assert.equal(new Set(reasons).size, 4, 'each account-walled platform explains its own gate');
  assert.match(portalHandoffReason('jobvite')!, /privacy notice/i);
  assert.match(portalHandoffReason('icims')!, /make an account/i);
  assert.match(portalHandoffReason('oraclecloud')!, /code/i);
});

test('UKG and SuccessFactors remain typed capture-required holds, never managed attended portals', () => {
  for (const portal of ['ultipro', 'sap_successfactors'] as const) {
    assert.equal(isManagedAttendedAccountPortal(portal), false);
    assert.deepEqual(buildManagedAttendedAccountProbeActions(portal), []);
    assert.match(portalHandoffReason(portal)!, /live capture/i);
  }
});

test('BambooHR is CAPTCHA-gated, so it fills and stops however inviting its form looks', () => {
  // BambooHR's fields are the cleanest of the seven captured, which is exactly the trap: the form
  // looks like a one-run submit. Confirmed live 2026-07-29 - g-recaptcha-response present,
  // window.grecaptcha defined, badge rendered, api.js?render=explicit loaded.
  assert.equal(portalCanAutoSubmit('bamboohr'), false);
  assert.equal(portalCanAutoSubmit('controlled_bamboohr'), false);
  assert.equal(isAutonomousPortalFamily('bamboohr'), false);
  const actions = buildManagedPortalActions('bamboohr', capturePacket, true);
  assert.ok(actions.some((a) => a.type === 'fill'), 'it still fills what it can');
  const clicks = actions.filter((a) => a.type === 'click');
  // The ONLY click is the one that reveals the form. Never a submit.
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0]?.label, 'open application form');
  assert.match(portalHandoffReason('bamboohr')!, /prove you are human/);
});

test('BambooHR clicks the reveal button first, since the form does not exist until it is pressed', () => {
  // The form renders into the SAME url behind "Apply for This Job"; /careers/{id}/apply is blank.
  // If this click is not first, every fill below it races a form that is not in the DOM yet.
  const actions = buildManagedPortalActions('bamboohr', capturePacket, true);
  assert.equal(actions[0]?.type, 'click');
  assert.equal(actions[0]?.selector, 'button:has-text("Apply for This Job")');
  assert.equal(actions[0]?.optional, true, 'a tenant already showing the form must not fail the run');
});

test('each 2026-07-29 adapter pushes the exact selector read off the live form', () => {
  // Same mutation-testing lesson as the 07-28 table: without this, changing a captured selector
  // keeps the suite green and the regression only shows up on a real employer's form.
  const withCover = { ...capturePacket, coverLetter: Buffer.from('pdf'), coverLetterName: 'cover.pdf' };
  const expected: Record<string, Record<string, string>> = {
    // Both name and id are randomised per render on Rippling, so data-testid is the ONLY stable hook.
    rippling: {
      first_name: '[data-testid="input-first_name"]', last_name: '[data-testid="input-last_name"]',
      email: '[data-testid="input-email"]', phone: '[data-testid="input-phone_number"]',
      resume: 'input[type="file"][data-testid="input-resume"]',
      cover_letter: 'input[type="file"][data-testid="input-cover_letter"]',
    },
    // cName is ONE full-name field, not a first/last pair.
    breezy: {
      name: 'input[name="cName"]', email: 'input[name="cEmail"]',
      phone: 'input[name="cPhoneNumber"]', location: 'input[name="cAddress"]',
      resume: 'input[type="file"][name="cResume"]',
    },
    bamboohr: {
      first_name: 'input[name="firstName"]', last_name: 'input[name="lastName"]',
      email: 'input[name="email"]', phone: 'input[name="phone"]',
      location: 'input[name="city.value"]', linkedin: 'input[name="linkedinUrl"]',
      portfolio: 'input[name="websiteUrl"]',
      resume: 'input[type="file"][aria-label="file-input"]',
    },
  };
  for (const [portal, fields] of Object.entries(expected)) {
    const actions = buildManagedPortalActions(portal as 'breezy', withCover, true);
    for (const [label, selector] of Object.entries(fields)) {
      assert.equal(actions.find((a) => a.label === label)?.selector, selector, `${portal}.${label}`);
    }
  }
});

test('Breezy uses one full-name field and never splits it into first and last', () => {
  const actions = buildManagedPortalActions('breezy', capturePacket, true);
  assert.equal(actions.find((a) => a.label === 'name')?.value, 'Taylor Example');
  for (const label of ['first_name', 'last_name']) {
    assert.equal(actions.some((a) => a.label === label), false, `Breezy has no ${label} field`);
  }
});

test('Breezy touches neither its honeypot nor its two consent checkboxes', () => {
  // hp_<hex> is randomised per render AND defeats a naive visibility check: the input itself computes
  // to opacity 1 / visibility visible / 250x43, concealed only by a height:0 overflow:hidden
  // ancestor. This adapter is safe because it fills by explicit name, and this test keeps it that way.
  const actions = buildManagedPortalActions('breezy', capturePacket, true);
  const serialised = JSON.stringify(actions);
  for (const forbidden of ['hp_', 'smsConsent', 'gdprAgreement']) {
    assert.equal(serialised.includes(forbidden), false, forbidden);
  }
});

test('Rippling answers none of the three things that are the applicant’s alone', () => {
  // Its pronouns, phone-country and race controls all share ONE data-testid
  // ("input-select-search-input") and so cannot even be told apart by selector. Two of the three are
  // the applicant's own identity to declare or decline, so there is nothing here to type into.
  // sms_opt_in is a marketing consent radio.
  const actions = buildManagedPortalActions('rippling', capturePacket, true);
  const serialised = JSON.stringify(actions);
  for (const forbidden of ['input-select-search-input', 'sms_opt_in', 'aiOptOut', 'externalPlaceId', 'current_company']) {
    assert.equal(serialised.includes(forbidden), false, forbidden);
  }
});

test('BambooHR leaves its honeypot and the address fields the packet cannot know', () => {
  const serialised = JSON.stringify(buildManagedPortalActions('bamboohr', capturePacket, true));
  for (const forbidden of ['nickname_', 'streetAddress.value', 'zip.value', 'state.value', 'countryId.value', 'desiredPay']) {
    assert.equal(serialised.includes(forbidden), false, forbidden);
  }
});

test('the 2026-07-29 host rules reject every login, marketing and unrelated-product page on the same hosts', () => {
  // Every one of these is the access.paylocity.com hazard in a new coat: a host that also serves a
  // credential page, a marketing site, or - for Oracle - an entire unrelated product estate.
  const rejected = [
    'https://app.rippling.com/login',                      // Rippling's HR product, not its ATS
    'https://www.rippling.com/careers',
    'https://breezy.hr/',                                  // vendor marketing on the tenant host space
    'https://breezy.hr/pricing',
    'https://www.bamboohr.com/careers/application',        // BambooHR's OWN careers page (Greenhouse)
    'https://www.bamboohr.com/careers/engineering-it-team',
    'https://www.jobvite.com/',
    'https://www.icims.com/',
    'https://community.icims.com/s/article/anything',
    'https://ultipro.com/',                                // UKG employee login
    'https://recruiting.ultipro.com/',
    // The one that would be actively dangerous without a path check: oraclecloud.com hosts every
    // Oracle Cloud application there is, so a bare host match claims somebody's payroll or ERP login.
    'https://myfin.fa.us2.oraclecloud.com/fscmUI/faces/FuseWelcome',
    'https://login.oraclecloud.com/',
  ];
  for (const url of rejected) {
    assert.throws(() => detectPortal(url), /cannot fill in/, url);
  }
  // And the real application pages still resolve, including tenant subdomains.
  assert.equal(detectPortal('https://ats.rippling.com/rippling/jobs/875b2547-84de-4abd-a14e-34ab802e9b27/apply'), 'rippling');
  assert.equal(detectPortal('https://zinier.breezy.hr/p/7eefd4d49b75-platform-support-engineer-l1/apply'), 'breezy');
  assert.equal(detectPortal('https://recruiting.breezy.hr/p/05c7fcbfad27-welding-engineer/apply'), 'breezy');
  assert.equal(detectPortal('https://prentkeromich.bamboohr.com/careers/480'), 'bamboohr');
  assert.equal(detectPortal('https://jobs.jobvite.com/ness/job/o3mfAfwY/apply'), 'jobvite');
  assert.equal(detectPortal('https://jobs-express.icims.com/jobs/48173/sales-associate/job'), 'icims');
  assert.equal(
    detectPortal('https://fa-etxx-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/2850/'),
    'oraclecloud',
  );
  assert.equal(
    detectPortal('https://recruiting.ultipro.com/WIN1014WINDQ/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail?opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9'),
    'ultipro',
  );
});

test('Greenhouse fixed first name fill uses semantic selectors only', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const firstNameFill = actions.find((action) => action.label === 'first_name');
  assert.equal(firstNameFill?.type, 'fill');
  assert.match(firstNameFill?.selector ?? '', /autocomplete="given-name"/);
  assert.match(firstNameFill?.selector ?? '', /aria-label="First Name"/);
  assert.equal(actions.some((action) => action.label === 'first_name_label'), false);
});

test('Greenhouse managed actions open branded job pages and clear cookie overlays before filling', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const openFormIndex = actions.findIndex((action) => action.label === 'greenhouse_open_application_form');
  const firstNameIndex = actions.findIndex((action) => action.label === 'first_name');
  assert.ok(openFormIndex >= 0, 'Greenhouse managed run must click the branded apply button when present');
  assert.ok(firstNameIndex > openFormIndex, 'Greenhouse form entry must happen before fixed-field filling');
  assert.ok(actions.some((action) => action.selector === '#onetrust-accept-btn-handler'));
  assert.ok(actions.some((action) => action.selector?.includes('Allow All')));
  assert.ok(actions.some((action) => action.label === 'greenhouse_application_form_ready'));
});

test('Greenhouse fixed last name and email fills use semantic selectors only', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const lastNameFill = actions.find((action) => action.label === 'last_name');
  assert.equal(lastNameFill?.type, 'fill');
  assert.match(lastNameFill?.selector ?? '', /autocomplete="family-name"/);
  assert.match(lastNameFill?.selector ?? '', /aria-label="Last Name"/);
  assert.equal(actions.some((action) => action.label === 'last_name_label'), false);

  const emailFill = actions.find((action) => action.label === 'email');
  assert.equal(emailFill?.type, 'fill');
  assert.match(emailFill?.selector ?? '', /type="email"/);
  assert.match(emailFill?.selector ?? '', /autocomplete="email"/);
  assert.equal(actions.some((action) => action.label === 'email_label'), false);
});

test('Greenhouse resume upload includes modern semantic file-input fallbacks', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const upload = actions.find((action) => action.label === 'resume');
  assert.equal(upload?.type, 'upload');
  assert.match(upload?.selector ?? '', /id\*="resume"/);
  assert.match(upload?.selector ?? '', /name\*="resume"/);
  assert.match(upload?.selector ?? '', /aria-label\*="resume"/);
  assert.doesNotMatch(upload?.selector ?? '', /cover_letter/);
});

test('Greenhouse managed actions retry known yes-no work and onsite choices by exact portal labels', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      { question: 'Are you currently eligible to legally work in the US?', answer: 'Yes' },
      { question: 'Are you legally authorized to work in the country where the job is located?', answer: 'Yes' },
      { question: 'Will you now or in the future require immigration support/sponsorship?', answer: 'Yes' },
      { question: 'Are you able to work onsite in our San Francisco office 5 days a week?', answer: 'Yes' },
      {
        question:
          'Will you now, or will you in the future, require immigration sponsorship to work at this company in the United States?',
        answer: 'Yes',
      },
      { question: 'Do you consent to the terms?', answer: 'Yes' },
    ],
  });
  const aliasActions = actions.filter((action) => action.label?.startsWith('greenhouse_known_question:'));
  assert.ok(aliasActions.length >= 8);
  assert.ok(aliasActions.every((action) => action.type === 'fillByLabelText'));
  assert.ok(aliasActions.every((action) => action.value === 'Yes'));
  assert.ok(aliasActions.every((action) => action.optional === true));
  assert.ok(aliasActions.some((action) => action.text === 'Are you currently eligible to legally work in the United States?'));
  assert.ok(aliasActions.some((action) => action.text === 'Are you legally authorized to work in the country where the job is located?'));
  assert.ok(aliasActions.some((action) => action.text === 'Will you now or in the future require immigration support or sponsorship from Postman?'));
  assert.ok(aliasActions.some((action) => action.text === 'Are you able to work onsite in our San Francisco office 5 days a week?'));
  assert.equal(aliasActions.some((action) => action.text === 'Are you able to work onsite four days a week?'), false);
  assert.equal(aliasActions.some((action) => action.text === 'Do you consent to the terms?'), false);

  const selectActions = actions.filter((action) => action.label?.startsWith('greenhouse_known_select'));
  assert.equal(selectActions.length, 0);
  assert.equal(
    actions.filter((action) =>
      action.type === 'click'
      && !isGreenhousePreflightClick(action)
      && !isGreenhouseFixedCandidatePrivacyClick(action)
      && !action.label?.startsWith('education_school_combo_label')
      && !action.label?.startsWith('question_combo_label:')).length,
    0,
  );
});

test('managed reviewed questions replay stored answers into label-scoped choice controls', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    ...capturePacket,
    questions: [
      { question: 'Are you currently enrolled in a degree program?', answer: 'Yes' },
      { question: 'Graduation Year', answer: '2028' },
      { question: 'Are you able to work onsite 4 days a week?', answer: 'Yes' },
    ],
  });

  const scoped = actions.filter((action) => action.label?.startsWith('question:'));
  assert.ok(scoped.some((action) => action.type === 'fillByLabelText' && action.text === 'Are you currently enrolled in a degree program?'));
  assert.ok(scoped.some((action) => action.type === 'fillByLabelText' && action.text === 'Are you able to work onsite 4 days a week?'));
  assert.ok(actions.some((action) =>
    action.type === 'fill'
    && action.label?.startsWith('question_combo_label:')
    && action.label.includes('Graduation Year')
    && action.value === '2028'));

  const selects = actions.filter((action) => action.label?.startsWith('question_select:'));
  assert.ok(selects.some((action) => action.type === 'select' && action.value === '1'));
  assert.ok(selects.some((action) => action.type === 'select' && action.value === 'true'));
  assert.ok(selects.every((action) => (action.selector?.length ?? Infinity) <= 500));
  assert.ok(actions.some((action) =>
    action.label?.startsWith('question_combo_label:')
    && action.label.includes('Graduation Year')
    && action.value === '2028'));
});

test('Greenhouse managed actions stay inside the Stratus action budget on Reddit-style packets', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    city: 'Dubai, United Arab Emirates',
    country: 'United Arab Emirates',
    linkedinUrl: 'https://www.linkedin.com/in/mehekmandal',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'Mehek_Mandal_Staff_Product_Manager_Ads_Trust_and_Safety_Resume.pdf',
    coverLetter: Buffer.from('cover-pdf'),
    coverLetterName: 'Mehek_Mandal_Staff_Product_Manager_Ads_Trust_and_Safety_Cover_Letter.pdf',
    eeoPrefs: {
      gender: "I don't wish to answer",
      transgender_status: "I don't wish to answer",
      sexual_orientation: "I don't wish to answer",
      disability_status: "I don't wish to answer",
      veteran_status: "I don't wish to answer",
      race: "I don't wish to answer",
    },
    questions: [
      { question: 'How did you hear about this job?', answer: 'Company website' },
      {
        question: 'Briefly describe your experience with Ads Review/Ads Trust and Safety',
        answer: 'I have built and operated AI product workflows with review loops and operational controls.',
      },
      { question: 'Are you currently eligible to legally work in the United States?', answer: 'Yes' },
      { question: 'Will you now or in the future require immigration support or sponsorship?', answer: 'Yes' },
      { question: 'I agree to the Candidate Privacy Policy', answer: 'I agree' },
      { question: 'Are you a person of transgender experience?', answer: "I don't wish to answer" },
      { question: 'What gender identity do you most closely identify with?', answer: "I don't wish to answer" },
      { question: 'What sexual orientation do you most closely identify with?', answer: "I don't wish to answer" },
      { question: 'Do you live with a disability (as outlined by the ADA)?', answer: "I don't wish to answer" },
      { question: 'Are you a veteran/have you served in the military?', answer: "I don't wish to answer" },
      { question: 'Please select up to 2 ethnicities that you most closely identify with.', answer: "I don't wish to answer" },
    ],
  }, true);

  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${actions.length}`);
  assert.equal(actions.some((action) => action.label?.startsWith('greenhouse_known_select:')), false);
  assert.ok(actions.some((action) =>
    action.label?.startsWith('question_combo_label:')
    && action.label.includes('gender identity')));
  assert.equal(actions.some((action) => action.label?.startsWith('greenhouse_demographic_select:')), false);
  assert.equal(actions.some((action) =>
    action.text === 'I agree to the Candidate Privacy Policy'
    || action.label?.includes('I agree to the Candidate Privacy Policy')), true);
  assert.ok(
    actions.every((action) => !action.selector || action.selector.length <= 500),
    'Stratus rejects selector strings longer than 500 characters',
  );
});

test('Greenhouse managed actions stay inside the Stratus action budget on Nuro-style onsite packets', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    city: 'Dubai, United Arab Emirates',
    country: 'United Arab Emirates',
    linkedinUrl: 'https://www.linkedin.com/in/mehekmandal/',
    portfolioUrl: 'https://github.com/mehek-builds',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'Mehek_Mandal_Software_Engineer_AI_Platform_Intern_Resume.pdf',
    coverLetter: Buffer.from('cover-pdf'),
    coverLetterName: 'Mehek_Mandal_Software_Engineer_AI_Platform_Intern_Cover_Letter.pdf',
    questions: [
      { question: 'LinkedIn Profile', answer: 'https://www.linkedin.com/in/mehekmandal/' },
      { question: 'Website', answer: 'https://github.com/mehek-builds' },
      { question: 'Are you authorized to work in the country in which you are applying?', answer: 'Yes' },
      {
        question: 'Do you now, or will you in the future, require sponsorship for employment in the country which you are applying?',
        answer: 'Yes',
      },
      {
        question:
          'This position is hybrid and requires 4 days a week in office, including Thursdays in our Mountain View, CA headquarters and the remaining 3 days in either Mountain View or our San Francisco, CA office. Are you able to meet this requirement?',
        answer: 'Yes',
      },
    ],
  }, true);

  const onsiteAliases = actions.filter((action) =>
    action.label?.startsWith('greenhouse_known_question:')
    && /onsite|on-site/i.test(action.text ?? ''),
  );
  assert.equal(onsiteAliases.length, 4);
  assert.ok(onsiteAliases.every((action) => /four|4/.test(action.text ?? '')));
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `expected at most ${MANAGED_ACTION_LIMIT} actions, got ${actions.length}`);
});

test('the QA harness routes to the three new controlled adapters, by query param and by path', () => {
  const previous = {
    enabled: process.env.LITOS_ENABLE_TEST_PORTAL,
    nodeEnv: process.env.NODE_ENV,
  };
  try {
    process.env.NODE_ENV = 'test';
    process.env.LITOS_ENABLE_TEST_PORTAL = 'true';
    for (const board of ['rippling', 'breezy', 'bamboohr'] as const) {
      assert.equal(detectPortal(`http://localhost:3000/qa/portal-submission?board=${board}`), `controlled_${board}`);
      assert.equal(detectPortal(`http://localhost:3000/qa/portal-submission/${board}/${board}-01`), `controlled_${board}`);
    }
  } finally {
    if (previous.enabled === undefined) delete process.env.LITOS_ENABLE_TEST_PORTAL;
    else process.env.LITOS_ENABLE_TEST_PORTAL = previous.enabled;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
  }
});

test('the three new controlled variants exercise their live family’s selectors exactly', () => {
  // A fixture that drifts from the production selectors proves nothing about production.
  for (const [controlled, live] of [
    ['controlled_rippling', 'rippling'],
    ['controlled_breezy', 'breezy'],
    ['controlled_bamboohr', 'bamboohr'],
  ] as const) {
    assert.equal(portalCanAutoSubmit(controlled), portalCanAutoSubmit(live), controlled);
    assert.equal(portalHandoffReason(controlled), portalHandoffReason(live), controlled);
    assert.deepEqual(
      buildManagedPortalActions(controlled, capturePacket, false).map((a) => a.selector),
      buildManagedPortalActions(live, capturePacket, false).map((a) => a.selector),
      controlled,
    );
  }
});

test('no portal claims it can take a cover-letter file it has no input for', () => {
  // Breezy takes long-form text as textarea[name="cSummary"] and BambooHR's captured form had exactly
  // one file input (the resume). Declaring a real-looking cover-letter selector for either would make
  // hasCoverLetterUpload answer yes and attach a PDF to a control that cannot hold one - the same
  // reasoning as the JazzHR textarea note.
  for (const portal of ['breezy', 'bamboohr', 'jobvite', 'icims', 'oraclecloud', 'ultipro'] as const) {
    assert.match(coverLetterUploadSelector(portal), /DoesNotExist|noForm|NoForm/, portal);
  }
  // Rippling genuinely has one, read off the live form alongside the resume input.
  assert.equal(coverLetterUploadSelector('rippling'), 'input[type="file"][data-testid="input-cover_letter"]');
});

test('a third-party handoff is never mistaken for the submit button', () => {
  /* EVERY LABEL BELOW IS REAL, and the first two were read off SmartRecruiters' live first step on
     2026-08-04, before the applicant has typed anything. Greenhouse and Lever render the LinkedIn
     one and both are autonomous today, so this was a live risk rather than a hypothetical. */
  for (const label of [
    'Apply With Indeed',
    'Apply with SEEK',
    'Apply with LinkedIn',
    'Apply using LinkedIn',
    'Autofill with Greenhouse',
    'Sign in with Google',
    'Continue with LinkedIn',
    'Quick Apply',
    'One-click apply',
  ]) {
    assert.equal(chooseSubmitControl([label]), null, `${label} must not be pressed`);
  }
});

test('the real submit control is still found, and preferred over a bare Apply', () => {
  assert.equal(chooseSubmitControl(['Submit application']), 0);
  assert.equal(chooseSubmitControl(['Submit']), 0);
  assert.equal(chooseSubmitControl(['Apply']), 0);
  assert.equal(chooseSubmitControl(['Apply now']), 0);
  assert.equal(chooseSubmitControl(['Send my application']), 0);

  // A page carrying both: the explicit submit wins wherever it sits.
  assert.equal(chooseSubmitControl(['Apply with LinkedIn', 'Submit application']), 1);
  assert.equal(chooseSubmitControl(['Submit application', 'Apply with Indeed']), 0);
  assert.equal(chooseSubmitControl(['Apply', 'Submit application']), 1, 'explicit beats bare apply');
  // The form's real submit sits at its foot, so the last eligible control wins among equals.
  assert.equal(chooseSubmitControl(['Submit', 'Submit application']), 1);
});

test('a step that only offers Next is not submittable, which is the multi-step guarantee', () => {
  /* SmartRecruiters' first step, verbatim from the live DOM on 2026-08-04. There is no submit
     control here at all, and the only primary button says Next. A run that pressed anything on this
     page would either hand off to Indeed or advance a step while reporting a submission. */
  const smartRecruitersStepOne = [
    'Apply With Indeed', 'Apply with SEEK', 'Add', 'Add', 'Next', 'Cookies Settings',
  ];
  assert.equal(chooseSubmitControl(smartRecruitersStepOne), null);
  // Next and Continue are never submit controls anywhere.
  assert.equal(chooseSubmitControl(['Next']), null);
  assert.equal(chooseSubmitControl(['Continue']), null);
  assert.equal(chooseSubmitControl(['Next Step']), null, "Paylocity's #btn-submit reads Next Step");
});

test('labels that merely contain the word apply are not submit controls', () => {
  assert.equal(chooseSubmitControl(['Why do you want to apply?']), null);
  assert.equal(chooseSubmitControl(['Learn how to apply']), null);
  assert.equal(chooseSubmitControl([]), null);
  assert.equal(chooseSubmitControl(['', '   ']), null);
});

test('a provider name in the label is a handoff however the sentence is arranged', () => {
  /* The verb-shape test is escapable: a word between the verb and "with" defeats it, and
     "Apply now" is itself a legitimate submit label, so these sailed through into the eligible
     pool. Naming the providers cannot be worded around - no employer's own submit button carries
     a job board's name. */
  for (const label of [
    'Apply now with LinkedIn',
    'Apply Now with Indeed',
    'Submit with LinkedIn',
    'Submit your application via Indeed',
    'Apply through SEEK',
  ]) {
    assert.equal(chooseSubmitControl([label]), null, `${label} must not be pressed`);
  }
  // And the genuine ones are untouched by the provider backstop.
  assert.equal(chooseSubmitControl(['Apply now']), 0);
  assert.equal(chooseSubmitControl(['Submit your application']), 0);
});

test('an employer named after a job board still has a submit button', () => {
  /* HANDOFF_PROVIDER used to match a provider word ANYWHERE in the label, which rejected these.
     Several of those words are also employer names, and failing here costs a real submission. */
  assert.equal(chooseSubmitControl(['Submit your application to Apple']), 0);
  assert.equal(chooseSubmitControl(['Submit application to Google']), 0);
  assert.equal(chooseSubmitControl(['Submit application - Monster Beverage']), 0);
  // A provider in an actual handoff position is still rejected.
  assert.equal(chooseSubmitControl(['Apply with LinkedIn']), null);
  assert.equal(chooseSubmitControl(['Continue with Google']), null);
  assert.equal(chooseSubmitControl(['Quick Apply with MyGreenhouse']), null);
});

test('a support widget that says submit does not win over the application', () => {
  /* Intercom and Zendesk render these as [role=button] at the FOOT of the page, so they sort after
     the real control and the last-wins rule would hand them the click - which submits nothing and
     then tells the applicant to go check her email. Both labels are live on careers pages. */
  assert.equal(chooseSubmitControl(['Submit application', 'Submit feedback']), 0);
  assert.equal(chooseSubmitControl(['Submit application', 'Submit a request']), 0);
  assert.equal(chooseSubmitControl(['Submit', 'Submit your application']), 1,
    'naming the application beats a bare submit wherever it sits');
});

/* A local copy of SUBMIT_LABEL's shape, so the test can assert its own premise: that each label
   below really does reach the handoff filter rather than being rejected earlier. */
const SUBMIT_LABEL_FOR_TEST =
  /\bsubmit\b|\bsend (?:my )?application\b|^\s*apply\s*$|\bapply now\b|\bfinish (?:and|&) apply\b/i;

test('the handoff filters are load-bearing, not decoration', () => {
  /* THE PREVIOUS HANDOFF TESTS WERE TAUTOLOGICAL, which a review pass proved empirically: delete
     both THIRD_PARTY_HANDOFF and HANDOFF_PROVIDER from chooseSubmitControl and 69 of 70 tests still
     passed, because every label tested also failed SUBMIT_LABEL and so was rejected anyway.
     Every label below MATCHES SUBMIT_LABEL. The handoff filters are the only thing standing between
     them and a click, so deleting either regex has to fail this test. */
  for (const label of [
    'Submit application with LinkedIn',
    'Submit your application via SEEK',
    'Apply now using Indeed',
    'Apply now with LinkedIn',
    'Finish and apply with Greenhouse',
    'Submit application using Google',
  ]) {
    assert.match(label, SUBMIT_LABEL_FOR_TEST, `${label} must reach the handoff filter to test it`);
    assert.equal(chooseSubmitControl([label]), null, `${label} must not be pressed`);
  }
});

test('an icon button with no text is not a submit control', () => {
  /* HTMLButtonElement.type defaults to "submit" and its value to "", so keying the UA-default
     fallback off `type` alone made every text-free icon button read as "Submit" - chat launchers,
     scroll-to-top, cookie close - all of which sit at the FOOT of the page where last-wins looks. */
  assert.equal(chooseSubmitControl(['']), null);
  assert.equal(chooseSubmitControl(['Submit application', '']), 0);
});

test('a help-desk widget is never pressed, even when it is the only submit-ish control', () => {
  /* Excluding support widgets only inside the explicit tier left two holes. */
  assert.equal(chooseSubmitControl(['Apply now', 'Submit feedback']), 0,
    'a real control that never says "submit" still beats the widget');
  assert.equal(chooseSubmitControl(['Submit a request']), null,
    'a page whose only submit-ish control is a help desk has no submit control');
  assert.equal(chooseSubmitControl(['Submit feedback']), null);
});

test('a handoff to a platform we do not name by hand is still a handoff', () => {
  /* Pins THIRD_PARTY_HANDOFF specifically. The previous load-bearing test named a provider in every
     label, so deleting THIRD_PARTY_HANDOFF alone left the suite green and only HANDOFF_PROVIDER was
     actually covered. No label here names a listed provider, so the verb-shape rule is the only
     thing that can reject them. */
  for (const label of [
    'Apply now with Handshake',
    'Apply now using Symplicity',
    'Submit application with your university account',
  ]) {
    assert.equal(chooseSubmitControl([label]), null, `${label} must not be pressed`);
  }
});

test('a handoff to a board we never named is still a handoff', () => {
  /* THE REGRESSION THAT ROUND SIX CAUGHT. An earlier round required the handoff OBJECT to be a
     provider from a hard-coded list, which let every board not on it through - all of these were
     pressable. A roster of somebody-elses can only ever be incomplete; the closed set is the short
     list of things a button legitimately carries, which is your own documents. */
  for (const label of [
    'Apply now with Wellfound',
    'Apply now with Dice',
    'Apply now with our partner',
    'Apply now with Career Services',
    'Apply now with single sign-on',
    'Submit application with our recruiting partner',
  ]) {
    assert.equal(chooseSubmitControl([label]), null, `${label} must not be pressed`);
  }
});

test('a provider named far from the verb is still a handoff', () => {
  /* Pins HANDOFF_PROVIDER specifically. Once "submit" became a handoff verb, every provider label
     in the other tests was caught by the verb-shape rule instead, so deleting HANDOFF_PROVIDER left
     the suite green. These put enough words between the verb and the preposition that only the
     provider list can reject them. */
  for (const label of [
    'Submit your saved candidate profile with Handshake',
    'Submit the completed application form with LinkedIn',
  ]) {
    assert.equal(chooseSubmitControl([label]), null, `${label} must not be pressed`);
  }
  // And a branding tail, which names no verb at all.
  assert.equal(chooseSubmitControl(['Apply now - powered by Handshake']), null);
});

test('the student platforms are named, because those are the ones our users meet', () => {
  /* "Submit with your Handshake profile" passed BOTH filters: submit was not a handoff verb and
     Handshake was not a named provider. Handshake is the dominant platform for the students this
     product is for, so that was the worst possible gap to leave. */
  for (const label of [
    'Submit with your Handshake profile',
    'Submit application via Workable',
    'Submit application with SSO',
    'Apply with Symplicity',
  ]) {
    assert.equal(chooseSubmitControl([label]), null, `${label} must not be pressed`);
  }
});

test('help-desk wording is matched by word, not by exact phrase', () => {
  for (const widget of [
    'Submit a support request', 'Submit your question', 'Submit an issue',
    'Submit review', 'Submit rating', 'Submit a bug report',
  ]) {
    assert.equal(chooseSubmitControl(['Apply now', widget]), 0, `${widget} must not win`);
    assert.equal(chooseSubmitControl([widget]), null, `${widget} alone is not a submit control`);
  }
});

test('a primary "Apply now" outranks a bare footer "Apply"', () => {
  assert.equal(chooseSubmitControl(['Apply now', 'Apply']), 0);
  assert.equal(chooseSubmitControl(['Apply', 'Apply now']), 1);
});

test('READ_CONTROL_LABEL reads the element, and the tag gate is the load-bearing part', () => {
  /* Tested DIRECTLY, because every previous test sat downstream of the reader and would have
     passed unchanged if it regressed to calling every bare <button> "Submit". */
  const node = (over: Record<string, unknown>) => ({
    innerText: '', value: '', title: '', disabled: false, type: '', tagName: 'BUTTON',
    getAttribute: (name: string) => (over[name] as string | undefined) ?? null,
    getClientRects: () => ({ length: 1 }),
    parentElement: null,
    ownerDocument: {
      defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) },
      getElementById: () => null,
    },
    ...over,
  });

  // THE headline fix: HTMLButtonElement.type defaults to 'submit' and value to ''.
  assert.equal(READ_CONTROL_LABEL(node({ tagName: 'BUTTON', type: 'submit' })), '',
    'a text-free icon button is not labelled "Submit"');
  // The case the UA default exists for.
  assert.equal(READ_CONTROL_LABEL(node({ tagName: 'INPUT', type: 'submit' })), 'Submit');
  // input[type=image] takes its accessible name from alt.
  assert.equal(READ_CONTROL_LABEL(node({ tagName: 'INPUT', type: 'image', alt: 'Submit application' })),
    'Submit application');
  // aria-disabled is the only disabled a [role=button] div can express.
  assert.equal(READ_CONTROL_LABEL(node({
    tagName: 'DIV', innerText: 'Submit application', 'aria-disabled': 'true',
  })), '');
  // visibility:hidden keeps its client rects, so it needs its own check.
  assert.equal(READ_CONTROL_LABEL({
    ...node({ tagName: 'BUTTON', innerText: 'Submit application' }),
    ownerDocument: {
      defaultView: { getComputedStyle: () => ({ visibility: 'hidden' }) },
      getElementById: () => null,
    },
  }), '');
  // aria-hidden hides a whole subtree, not just the node carrying it.
  assert.equal(READ_CONTROL_LABEL({
    ...node({ tagName: 'BUTTON', innerText: 'Submit application' }),
    parentElement: { getAttribute: (n: string) => (n === 'aria-hidden' ? 'true' : null), parentElement: null },
  }), '');
  // And the ordinary case still reads.
  assert.equal(READ_CONTROL_LABEL(node({ innerText: 'Submit application' })), 'Submit application');
});

test('a legitimate submit label is not rejected as a handoff', () => {
  /* The widened handoff verbs (submit, send) turned "<verb> ... with|using|via" into a rejection,
     which caught perfectly ordinary buttons. None of these appear on the four portals we poll
     today, so it was latent rather than live - which is precisely why it needed a test before it
     became live on the next portal added. */
  for (const label of [
    'Submit application with attachments',
    'Submit your application with cover letter',
    'Submit with resume attached',
    'Send application from your profile',
    'Submit application for review',
    'Submit your application - Contact Center Agent',
  ]) {
    assert.notEqual(chooseSubmitControl([label]), null, `${label} must still be pressable`);
  }
  /* "Review and submit" is DELIBERATELY still rejected, and it is the one case worth arguing over.
     It reads like a submit, but on a multi-step form it is the button that leads to a review step -
     a Next wearing a submit's clothes, which is the single failure this module treats as worse than
     not supporting a portal at all. Failing safe here costs a handoff; guessing costs a "submitted"
     state for an application nobody received. */
  assert.equal(chooseSubmitControl(['Review and submit']), null);
});

test('the two application-wordings agree, because they used to be copies that drifted', () => {
  // SUBMIT_LABEL required "send my application" while APPLICATION_SUBMIT allowed "your", so this
  // failed eligibility outright even though the strongest tier would have taken it.
  assert.equal(chooseSubmitControl(['Send your application']), 0);
  assert.equal(chooseSubmitControl(['Send my application']), 0);
  assert.equal(chooseSubmitControl(['Send the application']), 0);
});

test('a help desk scoped to the application is still a help desk', () => {
  /* Exempting any label containing "application" put this back: the feedback widget reached the
     top tier on its prefix and, on last-wins, beat the real submit control. */
  assert.equal(chooseSubmitControl(['Submit application', 'Submit application feedback']), 0);
  assert.equal(chooseSubmitControl(['Submit application', 'Submit application survey']), 0);
  assert.equal(chooseSubmitControl(['Submit application feedback']), null);
  assert.equal(chooseSubmitControl(['Submit feedback on your application']), null);
  // And a job title carrying one of the widget nouns is still pressable.
  assert.equal(chooseSubmitControl(['Submit your application - Contact Center Agent']), 0);
});

test('your own saved profile is not somebody else’s platform', () => {
  // The bare possessive is your details on this site; an intervening name is the handoff.
  assert.notEqual(chooseSubmitControl(['Send application from your profile']), null);
  assert.notEqual(chooseSubmitControl(['Submit application with your saved details']), null);
  assert.equal(chooseSubmitControl(['Submit with your Handshake profile']), null);
  assert.equal(chooseSubmitControl(['Submit your saved candidate profile with Handshake']), null);
});

/* ─── the Anduril Greenhouse run of 2026-08-08 (submission_run_id 32823cf6) ───────────────────
 *
 * Every string below is verbatim from that run: the discovered labels as the managed provider
 * reported them, the blocker sentences the applicant was shown, and the option texts read off the
 * live control. The run filled 10 fields, hit no CAPTCHA, and still returned
 *   "Discipline" is required and is still empty
 *   "How did you hear about Anduril?" is required and is still empty
 * with both answers already resolved in the same packet.
 */

const ANDURIL_DISCIPLINE_LABEL = 'discipline* discipline--0';
const ANDURIL_REFERRAL_LABEL = 'how did you hear about anduril?* question_12114515007';
// The head of the real Greenhouse discipline taxonomy, read off the live listbox. The stored major
// ("Computer Science & Business Administration, Finance Emphasis") is not on it and never will be.
const GREENHOUSE_DISCIPLINE_OPTIONS = [
  'Accounting',
  'Actuarial/Risk Analysis',
  'Advertising',
  'Aerospace Engineering',
  'Business Administration',
  'Computer Science',
  'Computer/Software Engineering',
  'Finance',
  'Mathematics',
];

function andurilPacket(overrides: Record<string, unknown> = {}) {
  return {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    major: 'Computer Science & Business Administration, Finance Emphasis',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    referralSourceDefault: 'Job board',
    referralSourceEvidence: JOB_BOARD_REFERRAL_EVIDENCE,
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
    ...overrides,
  } as Parameters<typeof buildManagedPortalActions>[1];
}

test('a reviewed combobox answer is selected rather than left as uncommitted text', () => {
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    questions: [{
      question: 'Select your standardized test score type',
      answer: 'Other',
      portalSelector: '#question_9176667001',
      portalInputType: 'combobox',
    }],
  }));
  const group = actions.filter((action) => /standardized test score type/i.test(action.label ?? ''));
  assert.ok(group.some((action) => action.type === 'click' && action.label?.endsWith('_open')));
  assert.ok(group.some((action) => action.type === 'press' && action.value === 'Enter'));
  assert.equal(group.some((action) => action.type === 'fill' && action.label?.startsWith('question:')), false,
    'a dropdown must never use the plain text replay path');
});

test('a measured option answer stays a dropdown when an older runner stored text', () => {
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    questions: [
      {
        question: 'When is your anticipated graduation date - please select a Graduation Date range',
        answer: 'January 2028 - July 2028',
        answerOptionSource: 'May 2028',
        portalSelector: '#question_9170559101',
        portalInputType: 'text',
      },
      {
        question: 'Privacy statement',
        answer: 'I Agree',
        answerOptionSource: 'Yes',
        portalSelector: '#question_9170569101',
        portalInputType: 'text',
      },
    ],
  }));
  const group = actions.filter((action) => /anticipated graduation date/i.test(action.label ?? ''));
  assert.ok(group.some((action) => action.type === 'click' && action.label?.endsWith('_open')));
  assert.ok(group.some((action) => action.type === 'press' && action.value === 'Enter'));
  assert.equal(group.some((action) => action.type === 'fill' && action.label?.startsWith('question:')), false,
    'measured option provenance must bypass the plain text replay path');
  const privacyGroup = actions.filter((action) => /privacy statement/i.test(action.label ?? ''));
  assert.ok(privacyGroup.some((action) => action.type === 'click' && action.label?.endsWith('_open')));
  assert.ok(privacyGroup.some((action) => action.type === 'press' && action.value === 'Enter'));
});

test('Greenhouse demographics use durable label replay after stateless discovery', () => {
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    jdText: 'IMC Software Engineer Intern - Summer 2027',
    questions: [
      {
        question: 'What is your gender/gender identity?',
        answer: 'Female',
        portalSelector: '[data-litos-discovered-24]',
        portalInputType: 'text',
      },
      {
        question: 'What is your race/ethnicity?',
        answer: 'South Asian',
        portalSelector: '[data-litos-discovered-25]',
        portalInputType: 'text',
      },
    ],
  }));
  assert.equal(actions.some((action) => action.type === 'select'
    && action.selector?.startsWith('[data-litos-discovered-')), false,
  'the temporary discovery attribute does not exist on the separate managed fill page');
  const durable = actions.filter((action) => action.type === 'fill'
    && action.label?.startsWith('question_combo_label:'));
  assert.ok(durable.some((action) => /gender\/gender identity/i.test(action.label ?? '')
    && action.value === 'Female'));
  assert.ok(durable.some((action) => /race\/ethnicity/i.test(action.label ?? '')
    && action.value === 'South Asian'));
});

/* R-101. The discovery run fits inside the runner's ceiling, on every portal and every packet.
 *
 * stratus-browser-cloud rejects a run of more than MANAGED_ACTION_LIMIT actions with HTTP 400
 * TOO_MANY_ACTIONS, before it opens a browser. buildManagedPortalActions has trimmed itself for
 * that reason since Greenhouse first needed it; buildManagedDiscoveryActions never did, and once
 * the two option-probe rounds were added its Greenhouse list reached 145. Every managed Greenhouse
 * discovery call was rejected from then on, so `discovered` came back empty on every real run, so
 * no packet could carry a question record no matter what discoverAndResolveQuestions decided. DRW's
 * Software Developer Intern packet was measured at 27 required fields and 0 questions.
 *
 * The failure was silent, so a count is the only thing that can catch its return. */
/* Read off HOSTS, not written out. The hardcoded version of this list covered fourteen families and
 * stayed green while eleven more landed, so both ceiling tests below would have walked a stale set
 * and reported full coverage of a set they no longer covered. PORTAL_FAMILIES cannot drift: HOSTS is
 * a Record<PortalFamily, RegExp>, so a family with no key there does not compile. */
const EVERY_MANAGED_PORTAL = PORTAL_FAMILIES;

test('the discovery run never exceeds the runner action ceiling, on any portal', () => {
  for (const portal of EVERY_MANAGED_PORTAL) {
    const actions = buildManagedDiscoveryActions(portal, andurilPacket());
    assert.ok(
      actions.length <= MANAGED_ACTION_LIMIT,
      `${portal} discovery run is ${actions.length} actions, and the runner rejects anything over ${MANAGED_ACTION_LIMIT}`,
    );
  }
});

/* R-1xx. The FILL run fits inside the runner's ceiling too, on every portal and at any number of
 * reviewed questions.
 *
 * The test above covers the discovery run, which is a fixed list. This one covers the list that
 * grows per QUESTION, and only Greenhouse was ever trimmed against it. Measured on origin/main
 * (02648ba), Ashby costs 14 actions per reviewed question - one scoped fill plus thirteen
 * speculative selector guesses - so an eight-question posting built a 123-action list and every such
 * run was answered with HTTP 400 TOO_MANY_ACTIONS before a browser opened:
 *
 *     questions     |  0    4    6    8   10   30
 *     ashby submit  | 11   67   95  123  151  431
 *     ashby prepare | 15   71   99  127  155  435
 *
 * stratus-browser-cloud PR #22 is what made that reachable: `discover` began reporting choice
 * questions (radio, checkbox, select, Ashby pill groups) where it had reported only text-shaped
 * inputs, so the reviewed-question count on a live Ashby packet went up sharply. Paylocity is worse
 * still at 20 per question, because the wizard traversal repeats the fills once per step.
 *
 * The failure is silent on the discovery path - submissionRunner takes that run with
 * `.catch(() => null)` - so a count is again the only thing that can catch its return. And the fix
 * is a trim, never a higher MAX_ACTIONS: the last time a list was allowed to grow past the runner's
 * ceiling it rejected every managed run for weeks with nobody seeing it. */
test('the fill run never exceeds the runner action ceiling, on any portal at any question count', () => {
  /* 400 is here for the protected FLOOR, not for realism. The trims skip protected actions and the
     final truncation stops when only protected ones remain, so if that floor could itself exceed the
     ceiling, prepare would return an over-budget list and the runner would answer HTTP 400 - the
     original failure of this whole line of work, reached by a different route. The floor is fixed
     cost (core fills, evidence reads, option probes) and does not grow with the question count, so
     the way to demonstrate that is to push the question count far past anything real and show the
     list still lands inside the ceiling. */
  for (const questionCount of [0, 8, 30, 120, 400]) {
    const packet = andurilPacket({
      city: 'Los Angeles',
      country: 'United States',
      linkedinUrl: 'https://linkedin.com/in/mehekmandal',
      githubUrl: 'https://github.com/mehek',
      portfolioUrl: 'https://mehek.dev',
      questions: Array.from({ length: questionCount }, (_, index) => ({
        question: `Screener question number ${index + 1}: do you have experience with distributed systems?`,
        answer: index % 2 === 0 ? 'Yes' : 'No',
      })),
    });
    for (const portal of EVERY_MANAGED_PORTAL) {
      /* PREPARE MAY NOT THROW, asserted separately from submit rather than allowing either outcome
         on both. The looser version of this test accepted a budget error from either path, so it
         would have stayed green through a prepare run that stopped dead - which is the behaviour
         that costs the applicant her fixed fields, her preview and her evidence reads on exactly the
         packets big enough to need them. A prepare run has no submit button to withhold, so there is
         nothing for it to protect by refusing. */
      const prepared = buildManagedPortalActions(portal, packet, false);
      assert.ok(
        prepared.length <= MANAGED_ACTION_LIMIT,
        `${portal} prepare run with ${questionCount} questions is ${prepared.length} actions, and the runner rejects anything over ${MANAGED_ACTION_LIMIT}`,
      );

      // Submit is the path that may stop, because it is the one that can send.
      try {
        const actions = buildManagedPortalActions(portal, packet, true);
        assert.ok(
          actions.length <= MANAGED_ACTION_LIMIT,
          `${portal} submit run with ${questionCount} questions is ${actions.length} actions, and the runner rejects anything over ${MANAGED_ACTION_LIMIT}`,
        );
      } catch (error) {
        assert.ok(error instanceof ManagedActionBudgetError, `${portal} returned an unexpected budget failure`);
        assert.equal(error.submitActionAppended, false);
        assert.match(error.blocker, /did not press submit/i);
      }
    }
  }
});

/* WHAT PREPARE GIVES UP INSTEAD OF STOPPING, and the fact that it says so.
 *
 * The submit path refuses a packet whose reviewed questions cannot all fit, because sending an
 * application with an answer quietly missing from it is the failure this budget exists to prevent.
 * Prepare cannot send anything, so refusing there costs the applicant everything the run would have
 * given her - the fixed fields, the preview, the evidence reads - and protects nothing.
 *
 * So prepare drops questions. That is only acceptable while every dropped question is named, which
 * is what these assertions are for: the count that fits, the count that did not, and the guarantee
 * that the two together account for every question in the packet. A version of this that trimmed
 * quietly would pass a ceiling test and be the exact bug the ceiling test was written to catch.
 */
test('a prepare run too big to hold every question drops them visibly rather than stopping', () => {
  const questionCount = 200;
  const packet = andurilPacket({
    questions: Array.from({ length: questionCount }, (_, index) => ({
      question: `Screener question number ${index + 1}: do you have experience with distributed systems?`,
      answer: index % 2 === 0 ? 'Yes' : 'No',
    })),
  });

  // Submit stops, because it is the path that could send an application missing an answer.
  assert.throws(
    () => buildManagedPortalActions('greenhouse', packet, true),
    (error: unknown) => error instanceof ManagedActionBudgetError && error.submitActionAppended === false,
  );

  // Prepare does not, and still fits: an over-budget list is rejected by the runner with HTTP 400
  // before a browser opens, so "does not throw" would otherwise have become "does not run".
  const actions = buildManagedPortalActions('greenhouse', packet, false);
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `prepare returned ${actions.length} actions`);

  // And every question it could not attempt is named.
  const unattempted = reviewedQuestionsWithoutActions(packet, actions);
  assert.ok(unattempted.length > 0, 'a 200-question packet cannot fit, so something must be reported');
  for (const question of unattempted) {
    assert.ok(
      !actions.some((action) => (action.label ?? '').includes(question.slice(0, 60))),
      `"${question}" was reported as unattempted but has an action`,
    );
  }
  // Nothing is lost between the two counts: what fits plus what did not is the whole packet.
  const attempted = new Set(
    actions.flatMap((action) => {
      const match = /^question(?:_[a-z_]+)?:(?:\d+:)*(Screener question number \d+)/.exec(action.label ?? '');
      return match ? [match[1]!] : [];
    }),
  );
  assert.equal(attempted.size + unattempted.length, questionCount);
});

test('a packet that fits reports nothing unattempted, so the signal means something', () => {
  // The other half. A reporter that always returns something is as useless as one that never does.
  const packet = andurilPacket({
    questions: Array.from({ length: 6 }, (_, index) => ({
      question: `Screener question number ${index + 1}: do you have experience with distributed systems?`,
      answer: index % 2 === 0 ? 'Yes' : 'No',
    })),
  });
  for (const portal of EVERY_MANAGED_PORTAL) {
    const actions = buildManagedPortalActions(portal, packet, false);
    assert.deepEqual(
      budgetDroppedReviewedQuestions(packet, actions),
      [],
      `${portal} reported a budget drop on a packet that comfortably fits`,
    );
  }
});

/* THE SCOPE GAP IS NOT A BUDGET DROP, and conflating them would have been expensive.
 *
 * Thirteen families never attempt a reviewed question at any size - the multi-step ones fill page
 * one and stop, several newer adapters carry fixed fields only. reviewedQuestionsWithoutActions
 * reports every question on those, correctly and uselessly: it is answering "what has no action",
 * and the answer is "all of them, and it always was". Feeding that into the send gate would have
 * marked every SmartRecruiters, JazzHR, BambooHR, Jobvite, iCIMS, Oracle Cloud, UltiPro, Zoho,
 * Bullhorn, SuccessFactors, Taleo, ADP and Avature packet permanently unsendable over a scope limit
 * that predates this budget entirely.
 *
 * Both directions are pinned, because a discriminator that never fires is the same bug as one that
 * always does. */
test('a family that never fills questions is not reported as a budget drop', () => {
  const small = andurilPacket({
    questions: Array.from({ length: 6 }, (_, index) => ({
      question: `Screener question number ${index + 1}: do you have experience with distributed systems?`,
      answer: 'Yes',
    })),
  });
  const scopeLimited = buildManagedPortalActions('smartrecruiters', small, false);
  // It genuinely attempts none of them, so the raw reporter says so...
  assert.equal(reviewedQuestionsWithoutActions(small, scopeLimited).length, 6);
  // ...and the budget reporter does not, because nothing here was dropped to make room.
  assert.deepEqual(budgetDroppedReviewedQuestions(small, scopeLimited), []);

  // While a family that DOES fill questions and then runs out of room reports the ones it lost.
  const huge = andurilPacket({
    questions: Array.from({ length: 200 }, (_, index) => ({
      question: `Screener question number ${index + 1}: do you have experience with distributed systems?`,
      answer: 'Yes',
    })),
  });
  const dropped = budgetDroppedReviewedQuestions(huge, buildManagedPortalActions('greenhouse', huge, false));
  assert.ok(dropped.length > 0, 'a 200-question Greenhouse packet must report the questions it lost');
});

/* THE COUPLING THAT MAKES THE SUPPRESSION ABOVE SAFE, which nothing else records.
 *
 * budgetDroppedReviewedQuestions stays silent for a family that attempts no reviewed question at
 * all, because reporting every question on those would mark each of their packets permanently
 * unsendable over a scope limit that predates the budget. That silence is only harmless while none
 * of them can send by itself: an answered question that is never typed, on a family that then
 * auto-submits under standing consent, is an application going to an employer with an answer
 * missing and nothing anywhere saying so.
 *
 * Today that holds - all thirteen are multi-step or CAPTCHA-gated, and portalCanAutoSubmit refuses
 * every one - so the suppression is safe by luck rather than by construction. This is the assertion
 * that turns it into construction. If a future adapter learns to fill questions, this passes
 * unchanged; if one of these families is granted auto-submit while still filling none, this fails
 * and names the exact combination that would let an answer go missing quietly.
 */
test('a family that never fills reviewed questions is never allowed to submit by itself', () => {
  const packet = andurilPacket({
    questions: Array.from({ length: 4 }, (_, index) => ({
      question: `Screener question number ${index + 1}: do you have experience with distributed systems?`,
      answer: 'Yes',
    })),
  });
  const silent: string[] = [];
  for (const portal of EVERY_MANAGED_PORTAL) {
    const actions = buildManagedPortalActions(portal, packet, false);
    const attemptsAny = actions.some((action) => (action.label ?? '').startsWith('question'));
    if (attemptsAny) continue;
    silent.push(portal);
    assert.equal(
      portalCanAutoSubmit(portal),
      false,
      `${portal} attempts none of the reviewed questions AND can auto-submit, so a stored answer `
      + 'would reach the employer missing with nothing reported',
    );
  }
  // The set is not empty, so the assertion above is actually exercised rather than vacuous.
  assert.ok(silent.length > 0, 'expected some families to fill no reviewed questions');
});

function selectHeavyGreenhousePacket(questionCount: number) {
  return andurilPacket({
    questions: Array.from({ length: questionCount }, (_, index) => ({
      question: `Preferred location for placement choice ${String.fromCharCode(65 + index)}`,
      answer: index % 2 === 0 ? 'New York' : 'Chicago',
    })),
  });
}

function viableReviewedQuestionAttempt(
  actions: ReturnType<typeof buildManagedPortalActions>,
  question: string,
): boolean {
  const suffix = question.slice(0, 80);
  const groups = new Map<string, typeof actions>();
  for (const action of actions) {
    const base = action.label?.replace(/_(?:open|option_value|option|select)$/, '');
    if (!base || (!base.endsWith(`:${suffix}`) && base !== `question:${suffix}`)) continue;
    groups.set(base, [...(groups.get(base) ?? []), action]);
  }
  return Array.from(groups.entries()).some(([base, group]) => {
    if (base === `question:${suffix}`) return group.some((action) => action.type === 'fillByLabelText');
    if (/^question_checkbox:/.test(base)) return group.some((action) => action.type === 'click');
    return /^question_(?:combo(?:_label)?|select(?:_live)?):/.test(base)
      && group.some((action) => action.type === 'fill')
      && group.some((action) => action.type === 'press' || action.type === 'select');
  });
}

function assertGreenhouseCoreApplicationActions(actions: ReturnType<typeof buildManagedPortalActions>) {
  for (const label of ['first_name', 'last_name', 'email', 'phone'] as const) {
    assert.ok(
      actions.some((action) => action.type === 'fill' && action.label === label),
      `the action budget removed the ${label} fill`,
    );
  }
  assert.ok(
    actions.some((action) => action.type === 'upload' && action.label === 'resume'),
    'the action budget removed every resume upload',
  );
  const phoneCountry = actions.filter((action) => action.label?.replace(/_select$/, '') === 'phone_country');
  assert.ok(phoneCountry.some((action) => action.type === 'fill'), 'the phone country fill is missing');
  assert.ok(phoneCountry.some((action) => action.type === 'press'), 'the phone country confirmation is missing');

  for (const selector of ['#school--0', '#degree--0', '#discipline--0', '#end-month--0']) {
    const group = actions.filter((action) => action.selector === selector);
    assert.ok(group.some((action) => action.type === 'click'), `${selector} is missing its open action`);
    assert.ok(group.some((action) => action.type === 'fill'), `${selector} is missing its fill action`);
    assert.ok(group.some((action) => action.type === 'press'), `${selector} is missing its confirmation action`);
  }
  assert.ok(
    actions.some((action) => action.type === 'fill' && action.selector === '#end-year--0'),
    'the required education end year fill is missing',
  );
}

test('Greenhouse select-heavy prepare and submit keep one complete fill chain per question', () => {
  const packet = selectHeavyGreenhousePacket(4);
  for (const submit of [false, true]) {
    const actions = buildManagedPortalActions('greenhouse', packet, submit);
    assert.ok(actions.length <= MANAGED_ACTION_LIMIT);
    for (const item of packet.questions) {
      assert.ok(
        viableReviewedQuestionAttempt(actions, item.question),
        `${submit ? 'submit' : 'prepare'} lost every viable action chain for ${item.question}`,
      );
    }
    if (submit) assert.equal(actions.at(-1)?.type, 'confirmAndSubmit');
  }
});

test('Greenhouse select-heavy submit blocks before submit when safe chains cannot fit', () => {
  /* SUBMIT ONLY. This test asserted the same throw for prepare, and that was the behaviour until the
     prepare path stopped stopping: a prepare run cannot press the button, so refusing there bought
     nothing and cost the applicant the fixed fields, the preview and the evidence reads on the one
     packet shape big enough to need them. The refusal that matters - never send an application with
     an answer missing from it - is the submit half, and it is unchanged. What prepare does instead
     is asserted directly below. */
  const packet = selectHeavyGreenhousePacket(20);
  assert.throws(
    () => buildManagedPortalActions('greenhouse', packet, true),
    (error: unknown) => {
      assert.ok(error instanceof ManagedActionBudgetError);
      assert.equal(error.code, 'MANAGED_ACTION_BUDGET');
      assert.equal(error.submitActionAppended, false);
      assert.equal(error.blocker, error.message);
      assert.match(error.message, /20 reviewed questions/);
      return true;
    },
  );
});

test('Greenhouse select-heavy prepare fills what fits, keeps the core fields, and names the rest', () => {
  const packet = selectHeavyGreenhousePacket(20);
  const actions = buildManagedPortalActions('greenhouse', packet, false);
  // Fits, because an over-budget list is rejected by the runner before a browser opens.
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `prepare returned ${actions.length} actions`);
  // The fixed application fields survive the extra pass that gives up questions.
  assertGreenhouseCoreApplicationActions(actions);
  // And the questions it could not hold are named rather than dropped quietly.
  const dropped = budgetDroppedReviewedQuestions(packet, actions);
  assert.ok(dropped.length > 0, 'twenty select-heavy questions cannot fit, so some must be reported');
  for (const question of packet.questions) {
    const attempted = viableReviewedQuestionAttempt(actions, question.question);
    const reported = dropped.some((text) => question.question.toLowerCase().startsWith(text.toLowerCase().slice(0, 40)));
    assert.ok(
      attempted || reported,
      `"${question.question}" was neither attempted nor reported as dropped`,
    );
  }
});

test('Greenhouse 16 to 18 question boundaries preserve core fields on both paths', () => {
  /* The boundary where select-heavy questions stop fitting. The core application fields survive it
     on both paths, and that is the assertion this test exists for.
     What differs either side of the boundary is only what happens to the QUESTIONS: submit refuses
     the run, prepare gives some up and names them. Neither is allowed to cost a fixed field. */
  for (const questionCount of [16, 17, 18]) {
    const packet = selectHeavyGreenhousePacket(questionCount);

    const prepared = buildManagedPortalActions('greenhouse', packet, false);
    assert.ok(prepared.length <= MANAGED_ACTION_LIMIT);
    assertGreenhouseCoreApplicationActions(prepared);
    const dropped = budgetDroppedReviewedQuestions(packet, prepared);
    for (const item of packet.questions) {
      const attempted = viableReviewedQuestionAttempt(prepared, item.question);
      const reported = dropped.some((text) => item.question.toLowerCase().startsWith(text.toLowerCase().slice(0, 40)));
      assert.ok(
        attempted || reported,
        `${questionCount}-question prepare lost ${item.question} without reporting it`,
      );
    }

    try {
      const actions = buildManagedPortalActions('greenhouse', packet, true);
      assert.ok(actions.length <= MANAGED_ACTION_LIMIT);
      assertGreenhouseCoreApplicationActions(actions);
      for (const item of packet.questions) {
        assert.ok(
          viableReviewedQuestionAttempt(actions, item.question),
          `${questionCount}-question submit lost ${item.question}`,
        );
      }
      assert.equal(actions.at(-1)?.type, 'confirmAndSubmit');
    } catch (error) {
      assert.ok(error instanceof ManagedActionBudgetError);
      assert.equal(error.submitActionAppended, false);
      assert.match(error.blocker, /did not press submit/i);
    }
  }
});

test('the budget is spent on repeat guesses, and the submit click is reserved out of it', () => {
  /* WHAT the trim gives up, not just how much. A budget that keeps a question's ninth speculative
     selector and drops another question's only attempt is under the ceiling and still wrong. */
  const packet = andurilPacket({
    questions: Array.from({ length: 30 }, (_, index) => ({
      question: `Screener question number ${index + 1}: do you have experience with distributed systems?`,
      answer: index % 2 === 0 ? 'Yes' : 'No',
    })),
  });
  const actions = buildManagedPortalActions('ashby', packet, true);

  // Every question keeps the attempt that actually works on Ashby: the scoped fillByLabelText the
  // runner answers a pill group with. The thirteen guesses behind it are what paid for the trim.
  for (let index = 0; index < 30; index += 1) {
    const question = `Screener question number ${index + 1}:`;
    assert.ok(
      actions.some((action) => action.type === 'fillByLabelText' && action.label?.startsWith(`question:${question}`) === true),
      `question ${index + 1} lost its only real attempt`,
    );
  }

  // Degraded evenly rather than back to front. Attempt 1 of a chain comes off every question before
  // attempt 0 comes off any of them, so no question is stripped bare while another keeps all nine.
  const keptAttempts = (kind: string, attempt: number) =>
    actions.filter((action) => action.label?.startsWith(`question_${kind}:${attempt}:`) === true).length;
  for (const kind of ['text', 'select']) {
    assert.equal(keptAttempts(kind, 0), 30, `every question keeps its first ${kind} guess`);
    assert.ok(keptAttempts(kind, 1) < 30, `the trim is expected to have reached the second ${kind} guess`);
  }

  // And the submit click is inside the budget, not appended past it.
  assert.equal(actions.at(-1)?.type, 'confirmAndSubmit');
});

test('the trim takes fills, never the discover action or the reads it exists for', () => {
  // The packet that produced the 145-action list: every education and location alias applies.
  const actions = buildManagedDiscoveryActions('greenhouse', andurilPacket({
    city: 'Dubai',
    country: 'United Arab Emirates',
    linkedinUrl: 'https://linkedin.com/in/mehekmandal',
    githubUrl: 'https://github.com/mehek',
    portfolioUrl: 'https://mehek.dev',
    roleLocation: 'Chicago, IL',
    currentlyEnrolled: true,
    jdText: 'Software Developer Intern at DRW',
  }));
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT);
  // The one action the whole call exists to make.
  assert.equal(actions.filter((a) => a.type === 'discover').length, 1);
  // Both probe rounds survive intact, so the option snapping still has its lists.
  for (const inputId of GREENHOUSE_OPTION_PROBE_IDS) {
    for (const round of [1, 2] as const) {
      assert.ok(actions.some((a) => a.label === `option_probe_open:${inputId}:${round}`), `${inputId} round ${round} open`);
      assert.ok(actions.some((a) => a.label === `option_probe_close:${inputId}:${round}`), `${inputId} round ${round} close`);
    }
    assert.ok(actions.some((a) => a.label === `${MANAGED_OPTION_EXTRACT_PREFIX}${inputId}`), `${inputId} read`);
  }
  // And the evidence reads the run is judged by.
  for (const field of ['first_name', 'last_name', 'email', 'resume']) {
    assert.ok(actions.some((a) => a.label === `filled_field:${field}`), `${field} evidence read`);
  }
  assert.ok(actions.some((a) => a.label === 'cover_letter_capability'));
  assert.ok(actions.some((a) => a.label === 'greenhouse_open_application_form'));
  // What it gave up instead: speculative alias fills the real fill run attempts again anyway.
  assert.ok(
    !actions.some((a) => a.label?.startsWith('education_graduation_date_combo:8:') === true),
    'the last graduation-date alias is the kind of thing a trim is allowed to take',
  );
});

test('the managed discovery run reads every Greenhouse education combobox option list, twice', () => {
  const actions = buildManagedDiscoveryActions('greenhouse', andurilPacket());
  for (const inputId of GREENHOUSE_OPTION_PROBE_IDS) {
    for (const round of [1, 2] as const) {
      const open = actions.findIndex((a) => a.type === 'click' && a.label === `option_probe_open:${inputId}:${round}`);
      const close = actions.findIndex((a) => a.type === 'press' && a.label === `option_probe_close:${inputId}:${round}`);
      const read = actions.findIndex((a, index) =>
        index > open && a.type === 'extract' && a.label === `${MANAGED_OPTION_EXTRACT_PREFIX}${inputId}`);
      assert.ok(open >= 0, `${inputId} round ${round} is opened`);
      assert.ok(read > open, `${inputId} round ${round} is read after it is opened`);
      assert.ok(close > read, `${inputId} round ${round} is closed after it is read`);
      assert.equal(actions[read]!.selector, reactSelectListboxSelector(inputId));
      // No `attribute`: the provider returns innerText when none is asked for, and innerText of the
      // listbox is the option list. Asking for an attribute would return one node's attribute value.
      assert.equal(actions[read]!.attribute, undefined);
      assert.equal(actions[close]!.value, 'Escape');
      for (const index of [open, read, close]) assert.equal(actions[index]!.optional, true);
    }
  }
  // Round two comes after the DOM walk, which is the only thing in the list that takes real time.
  const discoverIndex = actions.findIndex((a) => a.type === 'discover');
  const secondRound = actions.findIndex((a) => a.label === `option_probe_open:${GREENHOUSE_OPTION_PROBE_IDS[0]}:2`);
  assert.ok(secondRound > discoverIndex);
});

test('the option probe runs before anything is typed into the form', () => {
  const actions = buildManagedDiscoveryActions('greenhouse', andurilPacket());
  const firstProbe = actions.findIndex((a) => a.label?.startsWith('option_probe_open:') === true);
  const firstFill = actions.findIndex((a) => a.type === 'fill');
  assert.ok(firstProbe >= 0 && firstFill > firstProbe,
    'a react-select that has already been filled shows a FILTERED menu, so the read has to come first');
  // The fill run does not pay for the reads again; it consumes what discovery brought back.
  assert.equal(
    buildManagedPortalActions('greenhouse', andurilPacket()).some((a) => a.label?.startsWith('option_probe_')),
    false,
  );
});

test('option lists come back keyed by control even though the provider drops the label', () => {
  // managed-browser.js pushes `{ selector, value }` and no label at all, so the selector has to be
  // enough on its own. Both shapes are accepted; neither may invent an entry.
  const parsed = managedResultFieldOptions({
    title: '', url: '', text: '',
    extracted: [
      { selector: reactSelectListboxSelector('discipline--0'), value: GREENHOUSE_DISCIPLINE_OPTIONS.join('\n') },
      { selector: reactSelectListboxSelector('degree--0'), label: `${MANAGED_OPTION_EXTRACT_PREFIX}degree--0`, value: "Bachelor's Degree\nMaster's Degree" },
      { selector: reactSelectListboxSelector('school--0'), value: '   ' },
      { selector: '[data-sitekey]', label: 'captcha_challenge', value: '6LcSomething' },
    ],
  });
  assert.deepEqual(parsed['discipline--0'], GREENHOUSE_DISCIPLINE_OPTIONS);
  assert.deepEqual(parsed['degree--0'], ["Bachelor's Degree", "Master's Degree"]);
  assert.equal('school--0' in parsed, false);
  assert.equal(Object.keys(parsed).length, 2);
});

test('managed Greenhouse discovery replays every exact reviewed checkbox option', () => {
  const question = 'In which settings have you used Python?';
  const offered = ['Personal Projects', 'Classwork', 'Internship/Workplace', 'Not Used'];
  const selected = offered.slice(0, 3);
  // Greenhouse gives each checkbox an id containing [] and a numeric option suffix. Discovery
  // records the first input as the durable selector and records the full group option list on it.
  const durableSelector = 'input[id="question_67998839[]_731437073"]';
  const discovered = {
    label: question,
    selector: durableSelector,
    durableSelector,
    inputType: 'checkbox',
    maxLength: null,
    options: offered,
    required: true,
  } satisfies ManagedDiscoveredQuestion;
  const analysis = managedOptionProbeAnalysis('greenhouse', [discovered], {}, []);
  const inventoryKey = managedOptionProbeControlId(discovered);

  assert.ok(inventoryKey, 'the durable Greenhouse checkbox selector must identify its option inventory');
  assert.deepEqual(analysis.options[inventoryKey], offered);
  assert.deepEqual(analysis.failures, []);
  assert.equal(analysis.failedIds.size, 0);

  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    fieldOptions: analysis.options,
    questions: [{
      question,
      answer: selected.join(', '),
      portalSelector: durableSelector,
      portalInputType: 'checkbox',
    }],
  });

  assert.deepEqual(
    actions.filter((action) => action.type === 'fillByLabelText' && action.text === question)
      .map((action) => action.value),
    selected,
  );
  assert.equal(
    actions.some((action) => action.type === 'click' && action.selector?.includes(durableSelector)),
    false,
    'a group selector click would choose only its first checkbox and ignore the reviewed values',
  );
});

test('managed Workable name-only choice inventory reaches exact multi-select replay', () => {
  const options = ['English', 'Hindi', 'Arabic', 'French'];
  const durableSelector = 'input[name="5854742"]';
  const analysis = managedOptionProbeAnalysis('workable', [{
    label: 'Which languages do you speak?',
    selector: '[data-litos-discovered-4]',
    durableSelector,
    inputType: 'checkbox',
    options,
    required: true,
  }], {}, []);

  assert.equal(managedOptionProbeControlId({
    label: 'Which languages do you speak?',
    selector: '[data-litos-discovered-4]',
    durableSelector,
  }), 'name:5854742');
  assert.deepEqual(analysis.options['name:5854742'], options);
  assert.deepEqual(analysis.failures, []);
  assert.equal(analysis.failedIds.size, 0);

  const actions = buildManagedPortalActions('workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    fieldOptions: analysis.options,
    questions: [{
      question: 'Which languages do you speak?',
      answer: options.join(', '),
      portalSelector: durableSelector,
      portalInputType: 'checkbox',
    }],
  });
  assert.deepEqual(
    actions.filter((action) => action.type === 'fillByLabelText' && action.text === 'Which languages do you speak?')
      .map((action) => action.value),
    options,
  );
});

test('Workable discovery resolution preserves every exact offered stored language through managed replay', () => {
  const offered = ['French', 'English', 'hindi', 'Arabic', 'HINDI'];
  const selected = ['French', 'English', 'hindi', 'Arabic'];
  const durableSelector = 'input[name="5854742"]';
  const discovered = {
    label: 'Which languages do you speak?',
    selector: '[data-litos-discovered-4]',
    durableSelector,
    inputType: 'checkbox',
    maxLength: null,
    options: offered,
    required: true,
  } satisfies ManagedDiscoveredQuestion;
  const analysis = managedOptionProbeAnalysis('workable', [discovered], {}, []);
  const [field] = attachManagedFieldOptions(
    [{ ...discovered, options: undefined }],
    analysis.options,
  );
  const resolved = resolveProfileField(
    { label: field!.label, inputType: field!.inputType, options: field!.options },
    { languages: ['English', 'Hindi', 'Arabic', 'French', 'German'] },
  );

  assert.equal(resolved?.value, selected.join(', '));
  assert.equal(resolved?.matchedOption, true);
  assert.equal(resolveProfileField(
    { label: field!.label, inputType: field!.inputType, options: ['Japanese'] },
    { languages: ['English', 'Hindi'] },
  ), null, 'a checkbox list with no exact stored-language intersection must decline');
  assert.notEqual(resolveProfileField(
    { label: field!.label, inputType: 'select', options: offered },
    { languages: ['English', 'Hindi', 'Arabic', 'French'] },
  )?.value, selected.join(', '), 'the multi-value behavior must not widen to a single-select');
  const actions = buildManagedPortalActions('workable', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    fieldOptions: analysis.options,
    questions: [{
      question: field!.label,
      answer: resolved!.value,
      portalSelector: durableSelector,
      portalInputType: field!.inputType,
    }],
  });
  assert.deepEqual(
    actions.filter((action) => action.type === 'fillByLabelText' && action.text === field!.label)
      .map((action) => action.value),
    selected,
  );
});

test('a probed option list reaches the control it was read from, by its own id', () => {
  const [discipline, unrelated] = attachManagedFieldOptions(
    [
      { label: ANDURIL_DISCIPLINE_LABEL, selector: '[data-litos-discovered-8]', inputType: 'text' },
      { label: 'website website question_12114508007', selector: '[data-litos-discovered-11]', inputType: 'text' },
    ] as ManagedDiscoveredQuestion[],
    { 'discipline--0': GREENHOUSE_DISCIPLINE_OPTIONS },
  );
  assert.deepEqual(discipline!.options, GREENHOUSE_DISCIPLINE_OPTIONS);
  assert.equal(unrelated!.options, undefined);
});

test('Discipline is filled with a real option, once, when the option list was read', () => {
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    fieldOptions: { 'discipline--0': GREENHOUSE_DISCIPLINE_OPTIONS },
  }));
  const disciplineFills = actions.filter((a) => a.type === 'fill' && a.selector === '#discipline--0');
  assert.deepEqual(disciplineFills.map((a) => a.value), ['Computer Science']);
  // Exactly one attempt. Measured live on this posting: a second attempt begins by clicking the
  // input again, which CLOSES the menu the first one opened, and a fill does not reopen it, so the
  // retry cannot select anything and the field is left empty.
  assert.equal(actions.filter((a) => a.type === 'click' && a.selector === '#discipline--0').length, 1);
  // And never the stored sentence, which is what filtered the real menu down to nothing.
  assert.equal(
    actions.some((a) => a.value === 'Computer Science & Business Administration, Finance Emphasis'),
    false,
  );
});

test('with no option list read, Discipline still leads with the taxonomy name, not the resume sentence', () => {
  const actions = buildManagedPortalActions('greenhouse', andurilPacket());
  const disciplineFills = actions.filter((a) => a.type === 'fill' && a.selector === '#discipline--0');
  assert.deepEqual(disciplineFills.map((a) => a.value), ['Computer Science']);
});

test('the referral question is scoped by a prefix, so it matches the employer that asked it', () => {
  const actions = buildManagedPortalActions('greenhouse', andurilPacket());
  const referral = actions.filter((a) => a.label?.startsWith('greenhouse_referral_combo_label:'));
  assert.ok(referral.length > 0);
  const scope = referral.find((a) => a.type === 'fill')!;
  assert.equal(scope.value, 'Job board');
  // Playwright's :has-text() is a case-insensitive substring match, so this scope is the one that
  // reaches "How did you hear about Anduril?" and "How did you hear about this internship?" alike.
  assert.ok(scope.selector?.includes('How did you hear about'), scope.selector);
  assert.equal(referral.some((a) => /faire/i.test(a.selector ?? '')), false);
});

test('a normalized Greenhouse education label still routes to the education combobox path', () => {
  // normalizeDiscoveredLabel strips `discipline--0` out of the stored question, and the education
  // combobox test used to key on exactly that handle, so the reviewed-question path silently
  // stopped running on the fields it exists for.
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    questions: [{ question: 'discipline', answer: 'Computer Science', portalSelector: '[data-litos-discovered-8]', portalInputType: 'text' }],
  }));
  assert.ok(actions.some((a) =>
    a.label?.startsWith('question_combo_label:')
    && a.label.includes('discipline')
    && a.value === 'Computer Science'));
});

test('provider result to snapped answer, the whole chain the Anduril run was missing', () => {
  // Exactly what the runner does: parse the discovery result's extracts, attach them to the
  // discovered controls, then resolve. Before this chain existed, resolveProfileField was handed
  // `options: undefined` on every managed control and PR #361's snapping could not fire at all.
  const discovery = {
    title: '', url: '', text: '',
    discovered: [{ label: ANDURIL_DISCIPLINE_LABEL, selector: '[data-litos-discovered-8]', inputType: 'text', maxLength: null }] as ManagedDiscoveredQuestion[],
    extracted: [{ selector: reactSelectListboxSelector('discipline--0'), value: GREENHOUSE_DISCIPLINE_OPTIONS.join('\n') }],
  };
  const [field] = attachManagedFieldOptions(discovery.discovered, managedResultFieldOptions(discovery));
  const resolved = resolveProfileField(
    { label: field!.label, inputType: field!.inputType, options: field!.options },
    { major: 'Computer Science & Business Administration, Finance Emphasis', degree: 'Bachelor of Science in Computer Science' },
  );
  assert.equal(resolved?.value, 'Computer Science');
  assert.equal(resolved?.matchedOption, true);
});

test('a listbox read mid-fetch contributes nothing, and never becomes an option', () => {
  // Measured on the live Anduril posting: Degree and Discipline load their taxonomies over the
  // network when the menu opens, and the first read comes back as the literal text "Loading...".
  // Snapping an answer onto that one-entry list would put the placeholder into the application.
  const parsed = managedResultFieldOptions({
    title: '', url: '', text: '',
    extracted: [
      { selector: reactSelectListboxSelector('discipline--0'), value: 'Loading...' },
      { selector: reactSelectListboxSelector('degree--0'), value: 'No options' },
      // The second round, once the fetch has landed.
      { selector: reactSelectListboxSelector('discipline--0'), value: GREENHOUSE_DISCIPLINE_OPTIONS.join('\n') },
    ],
  });
  assert.equal('degree--0' in parsed, false);
  assert.deepEqual(parsed['discipline--0'], GREENHOUSE_DISCIPLINE_OPTIONS);
  // And with only the placeholder read, the fill falls back to the ladder rather than to it.
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({ fieldOptions: { 'discipline--0': ['Loading...'] } }));
  assert.deepEqual(
    actions.filter((a) => a.type === 'fill' && a.selector === '#discipline--0').map((a) => a.value),
    ['Computer Science'],
  );
});

test('a windowed option read is discarded, so a saved answer past row 100 is not called missing', () => {
  // Greenhouse renders 100 rows into an unfiltered menu and searches the rest. Measured live:
  // School stops at 100 and "University of Southern California" is not among them, while typing
  // finds it. Treating that window as the list would skip the fill AND tell her the control does
  // not offer her own university.
  const window100 = Array.from({ length: 100 }, (_, i) => `University ${String(i).padStart(3, '0')}`);
  const parsed = managedResultFieldOptions({
    title: '', url: '', text: '',
    extracted: [
      { selector: reactSelectListboxSelector('school--0'), value: window100.join('\n') },
      { selector: reactSelectListboxSelector('degree--0'), value: ["Bachelor's Degree", "Master's Degree", 'Technical Diploma'].join('\n') },
    ],
  });
  assert.equal('school--0' in parsed, false);
  assert.equal(parsed['degree--0']?.length, 3);
});

test('a menu longer than the render cap is the whole list, not a window over it', () => {
  // Jane Street "How did you hear about us?", read live read-only 2026-08-16: the menu opens with
  // all 128 rows in the DOM, "3Blue1Brown" first and "VLDB" last, "University job board" at 76.
  // A list that runs PAST the cap was not truncated BY it. Reading the cap as ">= 100" called this
  // complete list a window and held the send on 55 of the owner's 167 blocked packets.
  const janeStreet = [
    '3Blue1Brown', 'Academic advisor', 'Academic department', 'Advent of Code',
    ...Array.from({ length: 71 }, (_, i) => `Source ${String(i).padStart(3, '0')}`),
    'University job board',
    ...Array.from({ length: 50 }, (_, i) => `Conference ${String(i).padStart(3, '0')}`),
    'VLDB',
  ];
  assert.equal(janeStreet.length, 127, 'fixture must exceed the 100-row cap');
  // And the exactly-100 read stays windowed: that one really did stop at the cap.
  const stoppedAtCap = Array.from({ length: 100 }, (_, i) => `University ${String(i).padStart(3, '0')}`);
  const parsed = managedResultFieldOptions({
    title: '', url: '', text: '',
    extracted: [
      { selector: reactSelectListboxSelector('hear--0'), value: janeStreet.join('\n') },
      { selector: reactSelectListboxSelector('school--0'), value: stoppedAtCap.join('\n') },
    ],
  });
  assert.equal(parsed['hear--0']?.length, 127, 'a 127-row menu is an option list');
  assert.ok(parsed['hear--0']?.includes('University job board'));
  assert.equal('school--0' in parsed, false, 'a read that stops exactly at the cap is still a window');
});

/* ---------------------------------------------------------------------------------------------
 * THE OPTION PROBE ON CONTROLS THIS REPO CANNOT NAME IN ADVANCE.
 *
 * Every option list quoted below was read off the live employer form on 2026-08-09, read-only, by
 * opening each react-select and extracting `#react-select-<inputId>-listbox`. Do not "correct" one
 * of these lists to something more sensible; they are what the employer offers.
 * ------------------------------------------------------------------------------------------- */

// Virtu, "Which university are you currently attending? Select "Other" if not listed". Fifteen
// entries, and the applicant's university is not one of them.
const VIRTU_UNIVERSITY_OPTIONS = [
  'Caltech', 'Carnegie Mellon', 'Georgia Tech', 'Harvard', 'Howard', 'Michigan', 'MIT', 'Princeton',
  'Rice', 'Tufts', 'UChicago', 'UT Austin', 'Waterloo', 'Yale', 'Other',
];
// Virtu, "Overall GPA". The stored answer is "3.89" and no control on that form accepts a number.
const VIRTU_GPA_OPTIONS = ['4.0-5.0', '3.5-3.9', '3.0-3.4', 'below 3.0', "I'd rather not disclose"];
// Point72, "What degree are you currently pursuing?". Three words, none of them the stored degree.
const POINT72_DEGREE_OPTIONS = ['Bachelors', 'Masters', 'PhD'];
// IMC, "When did you graduate from High School?". The stored answer is "May 2023".
const IMC_HIGH_SCHOOL_OPTIONS = ['Before 2021', '2021', '2022', '2023', '2024', '2025', '2026'];

test('the control id comes off the selector first and the label second', () => {
  // A custom Greenhouse question reaches discovery with its id in the SELECTOR.
  assert.equal(managedOptionProbeControlId({ label: 'Overall GPA*', selector: '#question_37228964002' }), 'question_37228964002');
  assert.equal(managedOptionProbeControlId({ label: 'School*', selector: '[id="school--0"]' }), 'school--0');
  // A demographic control reaches it as a data attribute, with the id left in the raw label. This is
  // the shape prod stored for Five Rings and IMC.
  assert.equal(
    managedOptionProbeControlId({ label: 'how would you describe your gender identity? 4001608008', selector: '[data-litos-discovered-21]' }),
    '4001608008',
  );
  assert.equal(managedOptionProbeControlId({ label: 'discipline* discipline--0', selector: '[data-litos-discovered-8]' }), 'discipline--0');
  assert.equal(managedOptionProbeControlId({ label: 'website website question_12114508007', selector: '[data-litos-discovered-11]' }), 'question_12114508007');
  // A checkbox GROUP has no listbox, and its selector is the escaped array name. Three actions spent
  // on it read nothing.
  assert.equal(managedOptionProbeControlId({ label: 'In which settings have you used C++?', selector: '#question_67998838\\[\\]_731437070' }), undefined);
  // A year inside a question is not a handle. Measured on Virtu: "Will you be ready for full-time
  // employment in 2028?".
  assert.equal(managedOptionProbeControlId({ label: 'Will you be ready for full-time employment in 2028?', selector: '[data-litos-discovered-4]' }), undefined);
  assert.equal(managedOptionProbeControlId({ label: '', selector: '' }), undefined);
});

/* R-118. Greenhouse's own four self-identification controls carry a NAMED id, not a numeric one.
 *
 * They reach discovery as `[data-litos-discovered-14]` with the id concatenated onto the visible
 * question, so neither the `question_<digits>` handle nor the six-digit one names them and the probe
 * pass skipped all four. Measured on the live Flow Traders form, 2026-08-09: hispanic_ethnicity
 * offers "Decline To Self Identify" and disability_status offers "I do not want to answer", and both
 * production runs that day reported `no option matched "Decline to self-identify"` on them.
 */
test('the probe can name Greenhouse\'s own self-identification controls', () => {
  const cases: Array<[string, string]> = [
    ['are you hispanic/latino? hispanic_ethnicity', 'hispanic_ethnicity'],
    ['gender gender', 'gender'],
    ['veteran status veteran_status', 'veteran_status'],
    ['disability status disability_status', 'disability_status'],
    ['Race Race', 'race'],
  ];
  for (const [label, expected] of cases) {
    assert.equal(managedOptionProbeControlId({ label, selector: '[data-litos-discovered-14]' }), expected, label);
  }
  // Not a general "last underscored word is an id" rule: that would read a control id off any
  // question whose text happens to end in one.
  assert.equal(
    managedOptionProbeControlId({ label: 'Which of these best describes your work_style?', selector: '[data-litos-discovered-9]' }),
    undefined,
  );
  // The id still has to be at the END of the label, where discovery concatenates it.
  assert.equal(
    managedOptionProbeControlId({ label: 'gender identity is asked about below', selector: '[data-litos-discovered-9]' }),
    undefined,
  );
  // And the probe pass therefore reads them.
  assert.deepEqual(
    managedOptionProbeTargets('greenhouse', [
      {
        label: 'are you hispanic/latino? hispanic_ethnicity',
        selector: '[data-litos-discovered-14]',
        inputType: 'text',
        role: 'combobox',
      },
      {
        label: 'disability status disability_status',
        selector: '[data-litos-discovered-16]',
        inputType: 'text',
        role: 'combobox',
      },
    ], {}, true),
    ['hispanic_ethnicity', 'disability_status'],
  );
});

test('the probe reads the controls discovery found, and never the four it already read', () => {
  const discovered = [
    { label: 'Overall GPA*', selector: '#question_37228964002', inputType: 'text', role: 'combobox', required: true },
    { label: 'Discipline*', selector: '#discipline--0', required: true },
    { label: 'School*', selector: '#school--0', required: true },
    { label: 'Country*', selector: '#country', required: true },
    { label: 'Location (City)*', selector: '#candidate-location', required: true },
    { label: 'How would you describe your gender identity? 4001608008', selector: '[data-litos-discovered-21]', role: 'combobox' },
    { label: 'Are you interested in our Women\'s Winternship program?*', selector: '#question_37228970002', inputType: 'text', role: 'combobox', required: true },
  ];
  const alreadyRead = { 'school--0': ['USC'], 'discipline--0': ['Computer Science'] };
  const targets = managedOptionProbeTargets('greenhouse', discovered, alreadyRead, true);
  // The education controls are skipped only when the earlier pass produced a usable list.
  assert.equal(targets.includes('school--0'), false);
  assert.equal(targets.includes('discipline--0'), false);
  // Structural controls the fixed-field pass owns. Country renders 244 rows (discarded at the render
  // cap) and the city control renders nothing until something is typed.
  assert.equal(targets.includes('country'), false);
  assert.equal(targets.includes('candidate-location'), false);
  // Required first, so a budget cut can only ever take an optional one.
  assert.deepEqual(targets, ['question_37228964002', 'question_37228970002', '4001608008']);
  // And a list already read is not read again.
  assert.deepEqual(
    managedOptionProbeTargets('greenhouse', discovered, { ...alreadyRead, question_37228964002: VIRTU_GPA_OPTIONS }, true),
    ['question_37228970002', '4001608008'],
  );
  assert.equal(managedOptionProbeTargets('greenhouse', discovered, {}).includes('school--0'), true,
    'a windowed hardcoded read must be retried and then fail closed');
  // Not a Greenhouse form, no react-select listbox convention to read.
  assert.deepEqual(managedOptionProbeTargets('lever', discovered), []);
});

test('the backend consumes the real Stratus text-plus-combobox-role wire shape', () => {
  const fromStratus: ManagedDiscoveredQuestion = {
    label: 'Overall GPA* question_37228964002',
    selector: '#question_37228964002',
    inputType: 'text',
    role: 'combobox',
    maxLength: null,
    options: null,
    required: true,
  };
  const advertised = {
    title: '', url: '', text: '', discovered: [fromStratus],
    capabilities: [MANAGED_DISCOVERY_ROLE_CAPABILITY],
  };
  assert.equal(managedResultSupportsDiscoveryRole(advertised), true);
  assert.equal(managedResultSupportsDiscoveryRole({ ...advertised, capabilities: [] }), false);
  assert.equal(managedResultSupportsDiscoveryRole({ ...advertised, capabilities: undefined }), false);
  assert.deepEqual(managedOptionProbeTargets('greenhouse', [fromStratus], {}, true), ['question_37228964002']);
  assert.deepEqual(managedOptionProbeTargets('greenhouse', [fromStratus]), [],
    'role metadata without the advertised runner capability cannot activate dynamic probing');
  assert.deepEqual(managedOptionProbeTargets('greenhouse', [{ ...fromStratus, role: null }], {}, true), [],
    'a dynamic text input is not closed unless the deployed runner reports its DOM role');
});

test('the probe keeps plain end-year text open while retaining its normal final fill', () => {
  const discovered = [
    { label: 'End date year* end-year--0', selector: '#end-year--0', inputType: 'text', required: true },
    { label: 'End date month* end-month--0', selector: '#end-month--0', inputType: 'text', role: 'combobox', required: true },
  ];
  assert.deepEqual(managedOptionProbeTargets('greenhouse', discovered), ['end-month--0']);
  const actions = buildManagedPortalActions('greenhouse', andurilPacket());
  assert.ok(actions.some((action) => action.type === 'fill'
    && action.selector === '#end-year--0'
    && action.value === '2028'
    && action.label === 'education_end_year_field'));
});

test('the probe pass opens, reads and closes each control, and cannot exceed the runner ceiling', () => {
  const discovered = Array.from({ length: 60 }, (_, i) => ({
    label: `Question ${i}*`,
    selector: `#question_9${String(i).padStart(6, '0')}`,
    inputType: 'text',
    role: 'combobox',
    required: true,
  }));
  const actions = buildManagedDiscoveredOptionProbeActions('greenhouse', discovered, {}, true);
  assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `${actions.length} actions is over the runner's ceiling`);
  assert.equal(actions.length % MANAGED_OPTION_PROBE_ACTIONS_PER_CONTROL, 0);
  // Nothing is typed, uploaded or sent. The identity read precedes two open / read / Escape rounds.
  assert.deepEqual([...new Set(actions.map((a) => a.type))], ['extract', 'click', 'press']);
  assert.equal(actions.every((a) => a.optional === true), true);
  const first = 'question_9000000';
  const identity = actions.findIndex((a) => a.label === `closed_control:${first}`);
  const open = actions.findIndex((a) => a.label === `option_probe_open:${first}:1`);
  const read = actions.findIndex((a) => a.label === `${MANAGED_OPTION_EXTRACT_PREFIX}${first}`);
  const close = actions.findIndex((a) => a.label === `option_probe_close:${first}:1`);
  assert.ok(identity >= 0 && open === identity + 1 && read === open + 1 && close === open + 2);
  assert.equal(actions[read]!.selector, reactSelectListboxSelector(first));
  assert.equal(actions[read]!.attribute, undefined);
  assert.equal(actions[close]!.value, 'Escape');
  // No targets, no call. The caller checks for an empty list rather than opening a browser to do
  // nothing on every Lever and Ashby posting.
  assert.deepEqual(buildManagedDiscoveredOptionProbeActions('lever', discovered), []);
  assert.deepEqual(buildManagedDiscoveredOptionProbeActions('greenhouse', []), []);
});

test('a real Greenhouse form fits the probe pass with room to spare', () => {
  // DRW's Software Developer Intern form, counted live on 2026-08-09: 31 react-selects, of which 25
  // are left for this pass once the four education controls and the two structural ones are removed.
  // This is the largest form in the owner's 25-application run, so 75 is close to the worst case.
  const drw = [
    ...['school--0', 'degree--0', 'discipline--0', 'start-month--0', 'end-month--0', 'country', 'candidate-location']
      .map((id) => ({
        label: `${id}*`,
        selector: `#${id}`,
        inputType: id === 'start-month--0' ? 'text' : undefined,
        role: id === 'start-month--0' ? 'combobox' : undefined,
        required: true,
      })),
    ...Array.from({ length: 24 }, (_, i) => ({ label: `Q${i}*`, selector: `#question_679988${String(i + 20).padStart(2, '0')}`, inputType: 'text', role: 'combobox', required: true })),
  ];
  const batches = buildManagedDiscoveredOptionProbeBatches('greenhouse', drw, {
    'school--0': ['USC'],
    'degree--0': ['Bachelors'],
    'discipline--0': ['Computer Science'],
    'end-month--0': ['May'],
  }, true);
  assert.equal(batches.flat().length, 25 * MANAGED_OPTION_PROBE_ACTIONS_PER_CONTROL);
  assert.ok(batches.length > 1, 'the async retry must batch rather than truncate a real select-heavy form');
  assert.equal(batches.every((batch) => batch.length <= MANAGED_ACTION_LIMIT), true);
});

test('a native select is read without clicking and resolves from its exact options', () => {
  const discovered = [{
    label: 'When did you graduate from High School?*',
    selector: '#question_12345678',
    inputType: 'select-one',
    required: true,
  }];
  const [batch] = buildManagedDiscoveredOptionProbeBatches('greenhouse', discovered, {}, true);
  assert.deepEqual(batch?.map((action) => action.type), ['extract']);
  assert.equal(batch?.[0]?.selector, '[id="question_12345678"]:is(select)');
  const analysis = managedOptionProbeAnalysis('greenhouse', discovered, {}, [{
    title: '', url: '', text: '',
    extracted: [{ selector: '[id="question_12345678"]:is(select)', value: IMC_HIGH_SCHOOL_OPTIONS.join('\n') }],
  }], [], true);
  assert.deepEqual(analysis.options.question_12345678, IMC_HIGH_SCHOOL_OPTIONS);
  assert.deepEqual(analysis.failures, []);
});

test('custom closed controls warm once, read twice, and fail closed when still loading', () => {
  const discovered = [{
    label: 'Overall GPA*',
    selector: '#question_37228964002',
    inputType: 'text',
    role: 'combobox',
    required: true,
  }];
  const [batch] = buildManagedDiscoveredOptionProbeBatches('greenhouse', discovered, {}, true);
  assert.equal(batch?.filter((action) => action.label?.startsWith('option_probe_open:')).length, 2);
  const analysis = managedOptionProbeAnalysis('greenhouse', discovered, {}, [{
    title: '', url: '', text: '',
    extracted: [
      { selector: '[id="question_37228964002"]:is([role="combobox"],[aria-haspopup="listbox"])', value: 'question_37228964002' },
      { selector: reactSelectListboxSelector('question_37228964002'), value: 'Loading...' },
      { selector: reactSelectListboxSelector('question_37228964002'), value: 'Loading...' },
    ],
  }], [], true);
  assert.equal(analysis.failedIds.has('question_37228964002'), true);
  assert.match(analysis.failures[0]?.reason ?? '', /still loading/);
  assert.equal(analysis.options.question_37228964002, undefined);
});

test('a successful async second read yields one evidence-backed option list', () => {
  const discovered = [{ label: 'Overall GPA*', selector: '#question_37228964002', inputType: 'text', role: 'combobox' }];
  const analysis = managedOptionProbeAnalysis('greenhouse', discovered, {}, [{
    title: '', url: '', text: '',
    extracted: [
      { selector: '[id="question_37228964002"]:is([role="combobox"],[aria-haspopup="listbox"])', value: 'question_37228964002' },
      { selector: reactSelectListboxSelector('question_37228964002'), value: 'Loading...' },
      { selector: reactSelectListboxSelector('question_37228964002'), value: VIRTU_GPA_OPTIONS.join('\n') },
    ],
  }], [], true);
  assert.deepEqual(analysis.options.question_37228964002, VIRTU_GPA_OPTIONS);
  assert.deepEqual(analysis.failures, []);
});

test('windowed, conflicting, duplicate, and failed referral probes cannot fall back to aliases', () => {
  const fields = [
    { label: 'Which university are you currently attending?*', selector: '#question_11111111', inputType: 'select-one', options: undefined as string[] | undefined },
    { label: 'What degree are you currently pursuing?*', selector: '#question_22222222', inputType: 'select-one', options: undefined as string[] | undefined },
    { label: 'Duplicate degree*', selector: '#question_22222222', inputType: 'select-one', options: undefined as string[] | undefined },
    { label: 'How did you hear about this job?*', selector: '#question_33333333', inputType: 'select-one', options: undefined as string[] | undefined },
  ];
  const hundred = Array.from({ length: 100 }, (_, index) => `School ${index}`).join('\n');
  const analysis = managedOptionProbeAnalysis('greenhouse', fields, {}, [
    { title: '', url: '', text: '', extracted: [
      { selector: '[id="question_11111111"]:is(select)', value: hundred },
      { selector: '[id="question_22222222"]:is(select)', value: 'Bachelors\nMasters' },
      { selector: '[id="question_22222222"]:is(select)', value: 'Bachelor\nMaster' },
    ] },
  ], [{ controlIds: ['question_33333333'], reason: 'provider timeout' }]);
  assert.equal(analysis.failedIds.has('question_11111111'), true);
  assert.equal(analysis.failedIds.has('question_22222222'), true);
  assert.equal(analysis.failedIds.has('question_33333333'), true);
  assert.equal(analysis.options.question_33333333, undefined, 'referral must not fall back to a channel alias');
  assert.match(analysis.failures.map((failure) => failure.reason).join(' '), /windowed|durable selector|provider timeout/);
  const attached = attachManagedFieldOptions(fields, { question_22222222: POINT72_DEGREE_OPTIONS });
  assert.equal(attached[1]?.options, undefined);
  assert.equal(attached[2]?.options, undefined);
});

test('option probing batches whole controls and explicitly fails beyond its global bound', () => {
  const discovered = Array.from({ length: MANAGED_OPTION_PROBE_MAX_CONTROLS + 1 }, (_, index) => ({
    label: `Question ${index}`,
    selector: `#question_8${String(index).padStart(7, '0')}`,
    inputType: 'text',
    role: 'combobox',
  }));
  const batches = buildManagedDiscoveredOptionProbeBatches('greenhouse', discovered, {}, true);
  assert.equal(batches.every((batch) => batch.length <= MANAGED_ACTION_LIMIT), true);
  assert.equal(batches.flat().length % MANAGED_OPTION_PROBE_ACTIONS_PER_CONTROL, 0);
  const analysis = managedOptionProbeAnalysis('greenhouse', discovered, {}, [], [], true);
  const overflowId = `question_8${String(MANAGED_OPTION_PROBE_MAX_CONTROLS).padStart(7, '0')}`;
  assert.equal(analysis.failedIds.has(overflowId), true);
  assert.match(analysis.failures.find((failure) => failure.controlId === overflowId)?.reason ?? '', /exceeded the bounded/);
});

test('two windowed school reads produce no USC fill or Enter in the final action list', () => {
  const school = [{ label: 'School* school--0', selector: '#school--0', inputType: 'combobox', required: true }];
  const window100 = Array.from({ length: 100 }, (_, index) => `University ${index}`).join('\n');
  const analysis = managedOptionProbeAnalysis('greenhouse', school, {}, [{
    title: '', url: '', text: '',
    extracted: [
      { selector: '[id="school--0"]:is([role="combobox"],[aria-haspopup="listbox"])', value: 'school--0' },
      { selector: reactSelectListboxSelector('school--0'), value: window100 },
      { selector: reactSelectListboxSelector('school--0'), value: window100 },
    ],
  }]);
  assert.equal(analysis.failedIds.has('school--0'), true);
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    failedFields: [{ controlId: 'school--0', label: 'School* school--0', selector: '#school--0', inputType: 'combobox' }],
  }));
  const schoolActions = actions.filter((action) => action.selector === '#school--0'
    || action.label?.startsWith('education_school_combo'));
  assert.deepEqual(schoolActions, []);
  assert.equal(actions.some((action) => action.selector === '#school--0' && action.value === 'Enter'), false);
  assert.equal(actions.some((action) => /University of Southern California/.test(action.value ?? '')), false);
});

test('a stale stored Overall GPA answer cannot produce a final action after probe failure', () => {
  const failedId = 'question_37228964002';
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    failedFields: [{ controlId: failedId, label: 'Overall GPA*', selector: `#${failedId}`, inputType: 'select-one' }],
    questions: [{
      question: 'Overall GPA',
      answer: '3.89',
      portalSelector: `#${failedId}`,
      portalInputType: 'select-one',
    }],
  }));
  const staleGpaActions = actions.filter((action) => action.value === '3.89');
  assert.deepEqual(staleGpaActions, []);
  assert.equal(actions.some((action) => action.selector?.includes(failedId)), false);
});

test('a referral probe 503 suppresses every final referral action for that control', () => {
  const failedId = 'question_33333333';
  const discovered = [{
    label: 'How did you hear about this job?*',
    selector: `#${failedId}`,
    inputType: 'select-one',
    required: true,
  }];
  const analysis = managedOptionProbeAnalysis('greenhouse', discovered, {}, [], [{
    controlIds: [failedId],
    reason: 'Stratus managed browser request failed with status 503',
  }]);
  assert.equal(analysis.failedIds.has(failedId), true);
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    failedFields: discovered.map((field) => ({ controlId: failedId, ...field })),
    questions: [{
      question: 'How did you hear about this job?',
      answer: 'Job board',
      portalSelector: `#${failedId}`,
      portalInputType: 'select-one',
    }],
  }));
  const referralActions = actions.filter((action) => action.label?.startsWith('greenhouse_referral')
    || /how did you hear/i.test(action.label ?? '')
    || action.selector?.includes(failedId));
  assert.deepEqual(referralActions, []);
  assert.ok(actions.some((action) => action.label?.startsWith('education_degree_combo')),
    'only the failed referral channel is suppressed; unrelated exact channels remain');
});

test('failed closed question families suppress Akuna and known aliases without suppressing unrelated success', () => {
  const cases = [
    {
      failed: 'current immigration status or basis of your current work authorization',
      question: 'Please provide your current immigration status or basis of your current work authorization.',
      answer: 'F-1 CPT',
      forbidden: /immigration status|work authorization/i,
    },
    {
      failed: 'Are you legally authorized to work in the United States?',
      question: 'Are you currently eligible to legally work in the United States?',
      answer: 'Yes',
      forbidden: /eligible to legally work|authorized to work/i,
    },
    {
      failed: 'Do you now, or will you in the future, require visa sponsorship?',
      question: 'Will you now or in the future require immigration support or sponsorship?',
      answer: 'Yes',
      forbidden: /visa sponsorship|immigration support or sponsorship/i,
    },
    {
      failed: 'Have you applied to this role at Akuna previously?',
      question: 'Have you applied to an Akuna position in the past?',
      answer: 'No',
      forbidden: /applied.*(?:past|previously)/i,
    },
    {
      failed: 'Do you have any offer deadlines that we should be aware of?',
      question: 'Do you have any offer deadlines?',
      answer: 'No',
      forbidden: /offer deadlines/i,
    },
  ];
  for (const [index, item] of cases.entries()) {
    const actions = buildManagedPortalActions('greenhouse', andurilPacket({
      jdText: 'Akuna Capital software engineer internship',
      failedFields: [{
        controlId: `question_9000000${index}`,
        label: item.failed,
        selector: `#question_9000000${index}`,
        inputType: 'combobox',
      }],
      questions: [
        { question: item.question, answer: item.answer },
        { question: 'Are you able to work onsite three days a week?', answer: 'Yes' },
      ],
    }));
    const failedAliasActions = actions.filter((action) => item.forbidden.test(`${action.text ?? ''} ${action.label ?? ''}`));
    assert.deepEqual(failedAliasActions, [], item.failed);
    assert.ok(actions.some((action) => /onsite three days/i.test(`${action.text ?? ''} ${action.label ?? ''}`)),
      `unrelated onsite answer was suppressed for ${item.failed}`);
  }
});

test('a failed demographic control suppresses its aliases while unrelated demographic fills remain', () => {
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    failedFields: [{
      controlId: '4001608008',
      label: 'What gender identity do you most closely identify with?',
      selector: '[data-litos-discovered-21]',
      inputType: 'combobox',
    }],
    eeoPrefs: { gender: 'Woman', veteran_status: 'I am not a protected veteran' },
  }));
  assert.equal(actions.some((action) => /greenhouse_demographic/.test(action.label ?? '')
    && /gender identity/i.test(`${action.text ?? ''} ${action.label ?? ''}`)), false);
  assert.ok(actions.some((action) => /greenhouse_demographic/.test(action.label ?? '')
    && /veteran|military/i.test(`${action.text ?? ''} ${action.label ?? ''}`)));
});

test('academic keywords in unrelated employer questions do not suppress applicant academic fields', () => {
  const cases = [
    { label: 'GPA requirement for scholarship', action: /^gpa(?:_|$)/ },
    { label: 'Degree comfortable onsite', action: /^education_degree/ },
    { label: 'University recruiting event', action: /^education_school/ },
  ];
  for (const [index, item] of cases.entries()) {
    const actions = buildManagedPortalActions('greenhouse', andurilPacket({
      failedFields: [{
        controlId: `question_8100000${index}`,
        label: item.label,
        selector: `#question_8100000${index}`,
        inputType: 'select-one',
      }],
    }));
    assert.ok(actions.some((action) => item.action.test(action.label ?? '')), item.label);
  }
});

test('failed Five Rings and measured applicant GPA variants suppress every final GPA alias', () => {
  const variants = [
    'Please indicate your overall GPA.',
    'Please provide your cumulative GPA',
    'Please select your GPA range',
    'What is your current grade point average?',
    'Overall GPA',
    'Please report your college GPA on a 4.0 scale',
  ];
  for (const [index, label] of variants.entries()) {
    const failedId = `question_8300000${index}`;
    const actions = buildManagedPortalActions('greenhouse', andurilPacket({
      failedFields: [{
        controlId: failedId,
        label,
        selector: `#${failedId}`,
        inputType: 'select-one',
      }],
      // A stale semantically equivalent record must not regenerate generic GPA or
      // "What is your GPA?" aliases after the exact live control failed.
      questions: [{ question: 'What is your GPA?', answer: '3.89' }],
    }));
    assert.equal(actions.some((action) => action.value === '3.89'), false, label);
    assert.equal(actions.some((action) => action.selector?.includes(failedId)), false, label);
    assert.ok(actions.some((action) => action.label?.startsWith('education_degree')),
      `unrelated degree fill was suppressed for ${label}`);
  }
});

test('failed exact applicant GPA, degree, and university controls still suppress their fallback families', () => {
  const cases = [
    { label: 'Overall GPA', forbidden: /^gpa(?:_|$)/ },
    { label: 'What degree are you currently pursuing?', forbidden: /^education_degree/ },
    { label: 'Which University do/did you attend?', forbidden: /^education_school/ },
  ];
  for (const [index, item] of cases.entries()) {
    const failedId = `question_8200000${index}`;
    const actions = buildManagedPortalActions('greenhouse', andurilPacket({
      failedFields: [{
        controlId: failedId,
        label: item.label,
        selector: `#${failedId}`,
        inputType: 'select-one',
      }],
    }));
    assert.equal(actions.some((action) => item.forbidden.test(action.label ?? '')), false, item.label);
    assert.equal(actions.some((action) => action.selector?.includes(failedId)), false, item.label);
    assert.ok(actions.some((action) => action.label === 'first_name'), 'unrelated core fill must remain');
  }
});

/* A SPECULATIVE ALIAS FIRED AT A CONTROL THAT WAS ALREADY ANSWERED CORRECTLY.
 *
 * The alias ladders push the RAW profile value at a label: "3.89" at "GPA", "May 2028" at
 * "Graduation Date". fillByLabelText resolves a label to its own container's input, so on a form
 * whose GPA control is a list of bands this lands in the SAME react-select the resolver has just
 * filled with the exact band, "3.81 - 3.9". The raw value is not on the employer's list, so the fill
 * fails, and the failure is then read back to her as `Litos could not leave an answer on the form:
 * no option matched "3.89"` about a field that is filled correctly.
 *
 * Measured across the five prod packets carrying that exact sentence, 2026-08-11: all five have the
 * GPA field present in filled_fields and none has a GPA required-and-empty blocker. Five false
 * alarms, zero real ones.
 *
 * The action is suppressed rather than the message, because a react-select gets ONE attempt: a raw
 * guess fired after the exact answer is a live risk to the answer, not only a lie about it. */
const PROBED_GPA_BANDS = ['Below 3.0', '3.0 - 3.5', '3.51 - 3.8', '3.81 - 3.9', '3.91 - 4.0'];
const PROBED_GRADUATION_WINDOWS = ['July 2027 - December 2027', 'January 2028 - July 2028'];

test('a speculative alias never fires at a control the resolver has already answered', () => {
  const answered = buildManagedPortalActions('greenhouse', andurilPacket({
    // The probe read both lists off the live page. That is what makes "3.89" and "May 2028"
    // provably unofferable here rather than merely redundant.
    fieldOptions: {
      question_5550001: PROBED_GPA_BANDS,
      question_9176667101: PROBED_GRADUATION_WINDOWS,
    },
    questions: [
      { question: 'What is your GPA?', answer: '3.81 - 3.9', portalSelector: '#question_5550001', portalInputType: 'combobox' },
      { question: 'Expected graduation date', answer: 'January 2028 - July 2028', portalSelector: '#question_9176667101', portalInputType: 'combobox' },
    ],
  }));
  assert.equal(answered.some((action) => action.value === '3.89'), false, 'raw GPA must not be guessed at an answered control');
  assert.equal(answered.some((action) => action.value === 'May 2028'), false, 'raw graduation date must not be guessed at an answered control');
  assert.deepEqual(answered.filter((action) => /^(?:gpa|gpa_question|graduation_date)/.test(action.label ?? '')), []);
  assert.deepEqual(answered.filter((action) => action.label?.startsWith('education_graduation_date_combo')), []);
  // The resolver's own attempts are untouched: suppressing the guess must not suppress the answer.
  assert.ok(answered.some((action) => action.selector === '#question_9176667101'));
  assert.ok(answered.some((action) => action.selector === '#question_5550001'));
});

test('the alias ladder still fires at a control the resolver did not answer', () => {
  // The other half of the same rule, and the reason the predicate is narrow. On a form whose
  // controls carry no label discovery can resolve, the ladder is the only thing that fills anything,
  // so an empty question list must leave it working exactly as it did.
  const unanswered = buildManagedPortalActions('greenhouse', andurilPacket({ questions: [] }));
  assert.ok(unanswered.some((action) => action.label === 'gpa' && action.value === '3.89'));
  assert.ok(unanswered.some((action) => action.label === 'gpa_question' && action.value === '3.89'));
  assert.ok(unanswered.some((action) => action.label === 'graduation_date_label' && action.value === 'May 2028'));
  assert.ok(unanswered.some((action) => action.label?.startsWith('education_graduation_date_combo')));

  // An unrelated answered question does not suppress an unrelated ladder either: the match is an
  // exact label or a shared closed-field family, never "this packet has some questions in it".
  const unrelated = buildManagedPortalActions('greenhouse', andurilPacket({
    fieldOptions: { question_5550003: ['Yes', 'No'] },
    questions: [{ question: 'Are you able to work onsite three days a week?', answer: 'Yes', portalSelector: '#question_5550003', portalInputType: 'combobox' }],
  }));
  assert.ok(unrelated.some((action) => action.label === 'gpa' && action.value === '3.89'));
  assert.ok(unrelated.some((action) => action.label === 'graduation_date_label' && action.value === 'May 2028'));

  /* NO PROBED LIST, NO SUPPRESSION, and this is the case that decides whether the rule is safe.
   *
   * Databricks' graduation date is a reviewed question with no durable selector, so the resolver
   * only ever attempts it as a scoped react-select. The plain fillByLabelText below is the only
   * thing that would fill it were the control a text input, and there is no read option list saying
   * otherwise. Dropping it would trade a false alarm for an actually empty field. */
  const answeredWithoutProbe = buildManagedPortalActions('greenhouse', andurilPacket({
    questions: [
      { question: 'What is your GPA?', answer: '3.81 - 3.9' },
      { question: 'What is your graduation date?', answer: 'January 2028 - July 2028' },
    ],
  }));
  assert.ok(answeredWithoutProbe.some((action) => action.label === 'gpa' && action.value === '3.89'));
  assert.ok(answeredWithoutProbe.some((action) => action.label === 'graduation_date' && action.value === 'May 2028'));

  // A guess that IS on the employer's list is not a guess. It stays, because it can succeed.
  const offeredGuess = buildManagedPortalActions('greenhouse', andurilPacket({
    fieldOptions: { question_5550004: ['3.89', '3.81 - 3.9'] },
    questions: [{ question: 'What is your GPA?', answer: '3.81 - 3.9', portalSelector: '#question_5550004', portalInputType: 'combobox' }],
  }));
  assert.ok(offeredGuess.some((action) => action.label === 'gpa' && action.value === '3.89'));

  /* A question this run will NOT attempt is not an answer. The failed-control filter drops the
   * resolver's fill, so the ladder would be the control's only remaining chance - which is why the
   * refusal here has to come from packetLabelFailed, the rule that says a control Litos could not
   * read must not be guessed at, rather than from the answered check. */
  const failedAndAnswered = buildManagedPortalActions('greenhouse', andurilPacket({
    failedFields: [{ controlId: 'question_5550002', label: 'Expected graduation date', selector: '#question_5550002', inputType: 'combobox' }],
    questions: [{ question: 'Expected graduation date', answer: 'January 2028 - July 2028', portalSelector: '#question_5550002', portalInputType: 'combobox' }],
  }));
  assert.equal(failedAndAnswered.some((action) => action.selector?.includes('question_5550002')), false);
  assert.equal(failedAndAnswered.some((action) => action.value === 'January 2028 - July 2028'), false);
});

test('two passes of reads become one map, and an empty read never overwrites a real list', () => {
  const merged = mergeManagedFieldOptions(
    { 'discipline--0': ['Computer Science'], 'degree--0': ["Bachelor's Degree"] },
    { question_37228964002: VIRTU_GPA_OPTIONS, 'degree--0': [] },
    null,
  );
  assert.deepEqual(merged['degree--0'], ["Bachelor's Degree"]);
  assert.deepEqual(merged['question_37228964002'], VIRTU_GPA_OPTIONS);
  assert.equal(Object.keys(merged).length, 3);
});

test('the probed list reaches the control by its selector, not only by its label', () => {
  // attachManagedFieldOptions used to match only on the id appearing INSIDE the raw label, which is
  // true of the four education controls ("discipline* discipline--0") and of nothing else. A custom
  // question carries its id in the selector, so a label-only match dropped every list this pass
  // reads and the whole chain would have been inert again.
  const [gpa, university] = attachManagedFieldOptions(
    [
      { label: 'Overall GPA*', selector: '#question_37228964002', inputType: 'text' },
      { label: 'Which university are you currently attending? Select "Other" if not listed*', selector: '#question_37228963002', inputType: 'text' },
    ] as ManagedDiscoveredQuestion[],
    { question_37228964002: VIRTU_GPA_OPTIONS, question_37228963002: VIRTU_UNIVERSITY_OPTIONS },
  );
  assert.deepEqual(gpa!.options, VIRTU_GPA_OPTIONS);
  assert.deepEqual(university!.options, VIRTU_UNIVERSITY_OPTIONS);
});

test('the five answers the blind alias ladder got wrong, resolved against the employer\'s own list', () => {
  // Each of these came back '"..." is required and is still empty' on 2026-08-08 with the answer
  // already resolved in the packet, because the control reached resolveProfileField with no options.
  const profile = {
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    major: 'Computer Science & Business Administration, Finance Emphasis',
    gpa: '3.89',
    gpa_scale: '4.0',
    grad_date: 'May 2028',
    grad_year: 2028,
    high_school_grad_date: 'May 2023',
  };
  const resolve = (label: string, options: string[]) =>
    resolveProfileField({ label, inputType: 'text', options }, profile);

  const gpa = resolve('Overall GPA*', VIRTU_GPA_OPTIONS);
  assert.equal(gpa?.value, '3.5-3.9');
  assert.equal(gpa?.matchedOption, true);

  const degree = resolve('What degree are you currently pursuing? *', POINT72_DEGREE_OPTIONS);
  assert.equal(degree?.value, 'Bachelors');
  assert.equal(degree?.matchedOption, true);

  const highSchool = resolve('When did you graduate from High School?*', IMC_HIGH_SCHOOL_OPTIONS);
  assert.equal(highSchool?.value, '2023');
  assert.equal(highSchool?.matchedOption, true);

  // IMC's GPA control is banded to one decimal place rather than in halves.
  const imcGpa = resolve('What is your GPA?*', ['Below 3.2', '3.21 - 3.3', '3.31 - 3.4', '3.41 - 3.5', '3.51 - 3.6', '3.61 - 3.7', '3.71 - 3.8', '3.81 - 3.9', '3.91 - 4.0', 'Above 4.0']);
  assert.equal(imcGpa?.value, '3.81 - 3.9');
  assert.equal(imcGpa?.matchedOption, true);

  // Five Rings bands the same number differently again, and the same stored "3.89" answers both.
  const fiveRingsGpa = resolve('Please indicate your overall GPA.*', ['< 3.0', '3.0 - 3.4', '3.5 - 3.9', '4.0 - 4.4', '4.5 - 5.0', 'First-Class Honours', 'Upper Second-Class Honours', 'Lower Second-Class Honours', 'Third-Class Honours', 'Other / Not Applicable']);
  assert.equal(fiveRingsGpa?.value, '3.5 - 3.9');
  assert.equal(fiveRingsGpa?.matchedOption, true);
});

test('a university the employer does not offer is reported as unmatched, not snapped to a near miss', () => {
  // Virtu's list is fifteen named schools and "Other"; USC is genuinely absent. The honest outcome
  // is matchedOption:false - and the fill run's own escape hatch, which fires on the label's
  // "Select "Other" if not listed", is what puts the correct answer on the form.
  const resolved = resolveProfileField(
    { label: 'Which university are you currently attending? Select "Other" if not listed*', inputType: 'text', options: VIRTU_UNIVERSITY_OPTIONS },
    { school: 'University of Southern California, Viterbi School of Engineering' },
  );
  assert.equal(resolved?.matchedOption, false);
  // And emphatically not one of the fourteen other universities.
  assert.equal(VIRTU_UNIVERSITY_OPTIONS.filter((o) => o !== 'Other').includes(resolved?.value ?? ''), false);
  assert.equal(escapeHatchOptionFor('Which university are you currently attending? Select "Other" if not listed*'), 'Other');
});

test('a value that was typed and never spoken of again is named as a defect', () => {
  // DRW, 2026-08-08. `question:legal first name` is one fill of "Mehek" into a plain visible
  // textarea, and the run reported it in neither filledFields nor skipped. Silence about a value
  // Litos actually typed reads exactly like success, and did.
  const actions = [
    { type: 'fill', selector: '#question_67998823', value: 'Mehek', label: 'question:legal first name' },
    { type: 'fill', selector: '#question_67998825', value: 'https://www.linkedin.com/in/mehekmandal/', label: 'question:linkedin profile' },
    { type: 'fill', selector: '#question_37228964002', value: '3.5-3.9', label: 'question:overall gpa' },
    // An alias ladder: several selectors, most expected to match nothing. Silence here is normal and
    // must not be reported, or a large Greenhouse packet reports a hundred non-defects.
    { type: 'fill', value: 'May 2028', label: 'graduation_date_expected' },
    { type: 'fill', selector: '#x', label: 'question:blank answer', value: '  ' },
  ] as Parameters<typeof managedUnreportedFillLabels>[0];
  const unreported = managedUnreportedFillLabels(actions, {
    filledFields: ['question:linkedin profile'],
    skipped: ['question:overall gpa: value did not persist after fill'],
  });
  assert.deepEqual(unreported, ['question:legal first name']);
  // A run that reports everything reports no defect.
  assert.deepEqual(
    managedUnreportedFillLabels(actions, { filledFields: ['question:linkedin profile', 'question:legal first name', 'question:overall gpa'], skipped: [] }),
    [],
  );
});

test('a mention that explains nothing does not count as having reported the loss', () => {
  /* R-122, and the reason the test above was passing while production was silent.
   *
   * The 25-application run of 2026-08-09 was the run this diagnostic was shipped to observe.
   * Deepgram's `question:expected graduation year` went missing exactly as predicted - a single
   * fill of "2028" in a 24-action list against a 120 budget, absent from filledFields - and the
   * diagnostic logged NOTHING, on any deployment. The only way that could happen is a skipped line
   * that starts with the label and explains nothing, because the suppression test was a bare
   * `startsWith`. managedAnswerLossReasons then dropped the same line as alias-ladder noise, so she
   * was told the field was empty with no reason at all.
   *
   * Now only a LOSS-SHAPED line discharges the label, and the two functions can no longer disagree
   * about whether a control was accounted for. */
  const actions = [
    { type: 'fill', selector: '[data-field-path="407cc864"]', value: '2028', label: 'question:expected graduation year' },
  ] as Parameters<typeof managedUnreportedFillLabels>[0];
  const noise = { filledFields: [], skipped: ['question:expected graduation year: nothing matched [data-field-path="407cc864"] input'] };
  assert.deepEqual(managedUnreportedFillLabels(actions, noise), ['question:expected graduation year']);
  // The provider's own words are kept, for these labels and no others.
  assert.deepEqual(managedUnexplainedAnswers(actions, noise)[0]?.rawMentions, [
    'question:expected graduation year: nothing matched [data-field-path="407cc864"] input',
  ]);
  // She is told the blank field is ours.
  assert.match(
    managedUnexplainedAnswerReasons(managedUnexplainedAnswers(actions, noise))[0]!,
    /Litos put an answer in this field and the form did not keep it.+expected graduation year/,
  );
  // A real explanation still discharges it, and still reaches her through managedAnswerLossReasons.
  const explained = { filledFields: [], skipped: ['question:expected graduation year: value did not persist after fill'] };
  assert.deepEqual(managedUnreportedFillLabels(actions, explained), []);
  assert.equal(managedAnswerLossReasons(explained).length, 1);
});

/* ---------------------------------------------------------------------------------------------
 * The three defects measured on the production run of 2026-08-08, each pinned against the live
 * DOM that produced it. Read the comments before relaxing any of these: every number here was
 * counted on a real employer's form, not reasoned about.
 * ------------------------------------------------------------------------------------------- */

test('each graduation question is answered at the precision its own control can hold', () => {
  /* Deepgram, 2026-08-08. The date branch of greenhouseReviewedQuestionAnswer matched
   * "expected graduat(ion)" first and so answered "Expected Graduation Year" and
   * "Graduation Month" with the whole date. Ordering the tests narrow-first fixed that, and the
   * month and date assertions below are the ones that pin it.
   *
   * WHAT CHANGED ON 2026-08-11, and why the year line moved. The first fix also replaced the year
   * answer with packet.graduationYear, on the reading that a control labelled "year" is a year
   * control. On the live Ashby form that control is a react-datepicker, and a bare year is the one
   * value it refuses: four consecutive production runs (bbf0115a, 59fb48ae, cd066fee, 4bfd5827)
   * reported "Expected Graduation Year" as required and still empty. questionDiscovery had already
   * settled the rule in graduationYearFieldAnswer - an open text control gets "May 2028", a closed
   * list and a number box get "2028", and a profile stating no month gets the year either way - and
   * this layer now defers to it instead of contradicting it one step later.
   *
   * These three controls are all reported as open text, which is why all three now carry the month
   * the profile really holds. The closed-list and no-reported-type cases are pinned in
   * portalSubmission.graduationYearControl.test.ts. */
  const packet = {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    questions: [
      { question: 'Expected Graduation Year', answer: 'May 2028', portalSelector: '#grad_year', portalInputType: 'text' },
      { question: 'Graduation Month', answer: 'May', portalSelector: '#grad_month', portalInputType: 'text' },
      { question: 'What is your graduation date?', answer: 'May 2028', portalSelector: '#grad_date', portalInputType: 'text' },
    ],
  };
  const valueFor = (selector: string) => buildManagedPortalActions('greenhouse', packet)
    .find((action) => action.type === 'fill' && action.selector === selector)?.value;
  assert.equal(valueFor('#grad_year'), 'May 2028');
  assert.equal(valueFor('#grad_month'), 'May');
  assert.equal(valueFor('#grad_date'), 'May 2028');
  // A profile that states no month still hands every one of them the year alone. No month is
  // invented for a date control here or anywhere else; the run reports the empty field instead.
  const yearOnly = { ...packet, graduationDate: undefined, graduationMonth: undefined };
  const yearOnlyValueFor = (selector: string) => buildManagedPortalActions('greenhouse', yearOnly)
    .find((action) => action.type === 'fill' && action.selector === selector)?.value;
  assert.equal(yearOnlyValueFor('#grad_year'), '2028');
});

test('an Ashby field handle is descended into, because it names the wrapper', () => {
  /* Read off the live Deepgram application form, 2026-08-09:
   *   [data-field-path="407cc864-..."] resolves to a DIV (_fieldEntry_1e3gg_28) whose label reads
   *   "Expected Graduation Year" and which contains exactly one input. Filling the div itself
   *   fails with "Element is not an <input>, <textarea>, <select> or [contenteditable]".
   * So the one action the packet produced could never have typed anything, and because a selector
   * was present the reviewed-question loop skipped the label fallback too. */
  const wrapper = '[data-field-path="407cc864-6d10-4427-bc5e-71598c5e593f"]';
  const descended = ashbyControlWithinFieldPath(wrapper);
  assert.ok(descended.startsWith(`${wrapper} input[role="combobox"]`));
  assert.ok(descended.includes(`${wrapper} input,`));
  assert.ok(descended.includes(`${wrapper} textarea`));
  assert.ok(descended.includes(`${wrapper} select`));
  // The wrapper stays as the last alternative rather than being dropped.
  assert.ok(descended.endsWith(wrapper));
  // Anything that is not a bare field-path selector is left exactly as it is.
  assert.equal(ashbyControlWithinFieldPath('#question_123'), '#question_123');
  assert.equal(
    ashbyControlWithinFieldPath('[data-field-path="x"] input'),
    '[data-field-path="x"] input',
  );

  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    graduationYear: '2028',
    questions: [
      { question: 'Expected Graduation Year', answer: '2028', portalSelector: wrapper, portalInputType: 'text' },
    ],
  });
  const fill = actions.find((action) => action.label === 'question:Expected Graduation Year');
  assert.ok(fill, actions.map((action) => `${action.type}:${action.label}`).join('\n'));
  assert.equal(fill!.value, '2028');
  assert.ok(fill!.selector?.includes(`${wrapper} input`));
  assert.ok((fill!.selector?.length ?? 0) <= 500);
});

test('the runner\'s own account of an answer that did not stick is passed on, and the noise is not', () => {
  /* stratus reports one `skipped` line per optional selector that matched nothing - well over a
   * hundred on a large Greenhouse packet - alongside a handful that mean something entirely
   * different: Litos had an answer, tried it, and the control did not keep it. This repo read
   * NEITHER, and wrote skipped_reasons: [] on every run, so Point72's degree question and both
   * Virtu university questions reached the applicant as a bare "is required and is still empty". */
  const reasons = managedAnswerLossReasons({
    skipped: [
      'question_combo:0:0:which university are you currently attending? select "other" if not listed: no option matched "University of Southern California", left for you to choose',
      'question:overall gpa: value did not persist after fill',
      'education_degree_combo:0: choice value did not persist after fill',
      'greenhouse_known_question:Are you authorized to work in the United States?: choice option not found',
      // Noise: an alternative that was never needed.
      'question_combo_label:0:How did you hear about this job?: nothing matched .field-wrapper:has(label:has-text("How did you hear about this job?")) input[role="combobox"]',
      'preferred_first_name: nothing matched input[name="preferred_first_name"]',
    ],
  });
  assert.equal(reasons.length, 4, reasons.join('\n'));
  assert.ok(reasons.some((reason) => reason.includes('which university are you currently attending')
    && reason.includes('no option matched')));
  assert.ok(reasons.some((reason) => reason.includes('overall gpa')));
  assert.ok(reasons.every((reason) => !reason.includes('nothing matched')));
  // The action-label scaffolding is stripped, so what she reads is the employer's own question.
  assert.ok(reasons.every((reason) => !reason.includes('question_combo:')));
  assert.ok(reasons.every((reason) => !reason.includes('education_degree_combo')));
  assert.deepEqual(managedAnswerLossReasons({ skipped: undefined }), []);
});

test('the label\'s "Other" escape hatch reaches a question that has a durable selector', () => {
  /* Virtu, "Which university are you currently attending? Select "Other" if not listed".
   *
   * Read live 2026-08-09: the control offers exactly fifteen options - Caltech, Carnegie Mellon,
   * Georgia Tech, Harvard, Howard, Michigan, MIT, Princeton, Rice, Tufts, UChicago, UT Austin,
   * Waterloo, Yale, Other - and the applicant's university is not among them. "Other" is the
   * accurate answer and the label says so.
   *
   * The hatch was added to the LABEL-scoped combobox builder only. Once discovery started reporting
   * a durable #question_... selector for this control, buildManagedPortalActions took the id-scoped
   * branch and returned, so the hatch became unreachable for exactly the questions that had one.
   * Not the action budget: for that packet the trimmed and untrimmed lists are identical here. */
  // Verbatim from spec._review on the production packet, lowercased the way discovery stores it.
  const question = 'which university are you currently attending? select "other" if not listed';
  const withSelector = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    school: 'University of Southern California, Viterbi School of Engineering',
    questions: [{
      question,
      answer: 'University of Southern California, Viterbi School of Engineering',
      portalSelector: '#question_37520460002',
      portalInputType: 'combobox',
    }],
  });
  const fills = withSelector
    .filter((action) => action.type === 'fill' && action.label?.includes('which university'))
    .map((action) => action.value);
  assert.ok(fills.includes('Other'), fills.join(' | '));
  // And the real value is still tried FIRST, so the hatch can only be reached after it misses.
  assert.ok(fills.indexOf('University of Southern California') < fills.indexOf('Other'), fills.join(' | '));

  // A question with no escape hatch in its label gets none.
  const plain = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [{
      question: 'which university are you currently attending?',
      answer: 'University of Southern California',
      portalSelector: '#question_1',
      portalInputType: 'combobox',
    }],
  });
  assert.equal(
    plain.some((action) => action.type === 'fill' && action.label?.includes('which university') && action.value === 'Other'),
    false,
  );
});

/* ---------------------------------------------------------------------------------------------
 * THE QUESTION, NOT ITS WORDING.
 *
 * Measured on the owner's 158 production packets, 2026-08-11. 22 packets were blocked with a GPA
 * field required and empty while the packet already carried "3.89". Ten of them asked "What is your
 * GPA?", which was in GREENHOUSE_REACT_SELECT_LITERALS and got a closed-list chain. Twelve asked
 * "Overall GPA" (Virtu, 7) or "Please indicate your overall GPA." (Five Rings, 5), which were not,
 * so their only attempt was a text fill into a control whose options read "3.5-3.9".
 * --------------------------------------------------------------------------------------------- */

function greenhouseQuestionActions(question: string, answer: string) {
  return buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [{ question, answer }],
  });
}

const closedListChain = (question: string, answer: string) =>
  greenhouseQuestionActions(question, answer).filter((action) => action.label?.startsWith('question_combo_label:'));

test('a closed-list chain is built from what the question ASKS, not from a wording someone typed here', () => {
  // The two labels that cost 12 packets, and the wording that always worked, all reach the chain.
  for (const label of ['Overall GPA', 'Please indicate your overall GPA.', 'What is your GPA?']) {
    assert.ok(closedListChain(label, '3.89').length > 0, `expected a closed-list chain for ${label}`);
  }
  // And the phrasings no employer in the corpus has used yet, which is the whole point of asking
  // the classifier instead of extending a list of strings.
  for (const label of ['Cumulative GPA', 'GPA (out of 4.0)', 'What was your undergraduate GPA?']) {
    assert.ok(closedListChain(label, '3.89').length > 0, `expected a closed-list chain for ${label}`);
  }
  // "Graduation Year" was in the literals; "Year of Graduation" was not, and Palantir asks it that
  // way on all 11 of the owner's packets. classifyField calls both graduation_year.
  for (const label of ['Graduation Year', 'Year of Graduation', 'Anticipated Year of Graduation', 'Class Year']) {
    assert.ok(closedListChain(label, '2028').length > 0, `expected a closed-list chain for ${label}`);
  }
});

test('widening what may be a closed list never takes a text fill away from a text control', () => {
  /* The strictly-additive property, and the reason there are two predicates rather than one.
   * isGreenhouseReactSelectQuestion still decides whether to WITHHOLD the scoped text fill, and it
   * is still literals-only; questionMayBeClosedList only ever decides to ALSO push a menu chain.
   * Five Rings' GPA control reports inputType text, so losing this fill would trade twelve packets
   * blocked on a menu for five blocked on a text box. */
  const actions = greenhouseQuestionActions('Please indicate your overall GPA.', '3.89');
  const textFill = actions.find((action) => action.label === 'question:Please indicate your overall GPA.');
  assert.equal(textFill?.type, 'fillByLabelText');
  assert.equal(textFill?.text, 'Please indicate your overall GPA.');
  assert.equal(textFill?.value, '3.89');
  assert.ok(actions.some((action) => action.label?.startsWith('question_combo_label:')));
});

test('a question that names no profile field gains no closed-list chain', () => {
  // False-capture guards. A wrong entry here spends action budget on a control with no menu, and on
  // a Greenhouse form under the Akuna budget that is spent instead of a required field's one shot.
  for (const label of [
    'What is the most impressive thing you have ever accomplished?',
    'What is your phone number?',
    'Desired salary',
    'LinkedIn Profile',
    'Please provide additional detail if appropriate.',
  ]) {
    assert.equal(closedListChain(label, 'something').length, 0, `did not expect a closed-list chain for ${label}`);
  }
});

/* An answer the applicant chose herself must be TYPED FIRST, ahead of a bucket computed from her
 * profile.
 *
 * These are react-selects: the value is typed to filter the menu, and comboboxValueLimit is 1, so
 * whatever leads is the only string the form ever sees. greenhouseGraduationBucket turns the
 * profile's "May 2028" into "Spring 2028", which is the right lead for a machine answer that has
 * never been near this control. It is the wrong lead here.
 *
 * Measured on Jump Trading packet 2e593ac5, 2026-08-17. The employer's list, read from
 * boards-api.greenhouse.io, offers "Spring/Summer 2028" - and "Spring/Summer 2028" does NOT contain
 * the substring "Spring 2028", so typing the bucket empties the menu and there is nothing to click.
 * The run reported `no option matched "Spring 2028", left for you to choose` on a question whose
 * answer was already correct and already on file.
 *
 * answerOptionSource cannot carry this: it records the profile value an answer was snapped from when
 * discovery read the list, and an answer she typed into the review was never snapped from anything.
 * Hence answerSource. */
test('an applicant-reviewed option leads the combobox, ahead of the computed bucket', () => {
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    graduationDate: 'May 2028',
    questions: [{
      question: 'What is your expected graduation date?',
      answer: 'Spring/Summer 2028',
      answerSource: 'applicant_review',
      portalSelector: '#question_67595189',
      portalInputType: 'combobox',
    }],
  }));
  // Scoped to the control bound to this question's own selector. The education_* chain alongside it
  // is a label-scoped fallback aimed at differently-labelled controls and is not this field.
  const typed = actions
    .filter((action) => action.type === 'fill' && action.label?.startsWith('question_combo:'))
    .map((action) => action.value);

  assert.ok(typed.length > 0, 'the control must be driven at all');
  assert.equal(typed[0], 'Spring/Summer 2028',
    `her own answer must be typed first, got ${JSON.stringify(typed)}`);
});

/* The SECOND half of the Jump Trading measurement, taken AFTER the ordering fix above deployed.
 *
 * Same packet, 2e593ac5, 2026-08-17 late: the reviewed answer "Spring/Summer 2028" is stored with
 * answer_source applicant_review and is verbatim on the employer's list, and the live run still
 * typed the profile-derived "May 2028" and reported `no option matched "May 2028"`. The ordering
 * fix never reached this control because the run's own option probe FAILED on it, and a failed
 * probe did three things at once:
 *
 *   1. packetQuestionFailed made the reviewed-question loop skip her answer entirely;
 *   2. managedActionTargetsFailedField stripped any question action that did survive;
 *   3. the speculative graduation-date ladder was NOT suppressed (its suppression needs the very
 *      option list the probe failed to read), and its label selectors substring-match the
 *      employer's real label, so raw profile values were the only thing the control ever saw.
 *
 * A failed probe means Litos could not READ the list. Her answer does not need the list read: she
 * chose it, and the fill types it verbatim and clicks the option whose text matches. So an
 * applicant-chosen answer survives the failed-control suppression, and the profile ladder stands
 * down at a control she has answered. */
test('a reviewed graduation answer on a probe-failed control is still the only value the form sees', () => {
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    graduationDate: 'May 2028',
    failedFields: [{
      controlId: 'question_67595189',
      label: 'What is your expected graduation date?',
      selector: '#question_67595189',
      inputType: 'combobox',
    }],
    questions: [{
      question: 'What is your expected graduation date?',
      answer: 'Spring/Summer 2028',
      answerSource: 'applicant_review',
      portalSelector: '#question_67595189',
      portalInputType: 'combobox',
    }],
  }));
  const graduationDateFills = actions.filter((action) =>
    (action.type === 'fill' || action.type === 'fillByLabelText')
    && /graduation\s+date/i.test(`${action.label ?? ''} ${action.selector ?? ''} ${action.text ?? ''}`));
  assert.ok(graduationDateFills.length > 0, 'her reviewed answer must drive the control at all');
  for (const action of graduationDateFills) {
    assert.equal(action.value, 'Spring/Summer 2028',
      `every value typed at the graduation-date control must be her own answer, got ${JSON.stringify(action.value)} via ${action.label}`);
  }
});

test('her answer to a custom question does not unlock a probe-failed fixed control in the same family', () => {
  // The exemption is identity-scoped on purpose: a family bucket spans different controls on one
  // form, and the fixed education builder types RAW profile values. If her custom graduation-year
  // answer erased the failed record for end-year--0, the profile year would be typed into a
  // react-select nobody read, one budget position before her own fill.
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    graduationYear: '2028',
    failedFields: [{
      controlId: 'end-year--0',
      label: 'Graduation Year',
      selector: '#end-year--0',
      inputType: 'combobox',
    }],
    questions: [{
      question: 'What is your expected graduation year?',
      answer: '2028 (first half)',
      answerSource: 'applicant_review',
      portalSelector: '#question_11',
      portalInputType: 'combobox',
    }],
  }));
  assert.equal(actions.some((action) => (action.selector ?? '').includes('end-year--0')), false,
    'the probe-failed fixed control must stay untouched');
});

test('her answer equal to the computed bucket still silences the ladder at her probe-failed control', () => {
  // greenhouseGraduationBucket("May 2028") is "Spring 2028". When her chosen answer happens to BE
  // that bucket, a candidate-by-candidate comparison would let the whole ladder fire, raw profile
  // date first, and reproduce the measured `no option matched "May 2028"` on the one-attempt
  // react-select her fill was about to commit.
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    graduationDate: 'May 2028',
    failedFields: [{
      controlId: 'question_67595189',
      label: 'What is your expected graduation date?',
      selector: '#question_67595189',
      inputType: 'combobox',
    }],
    questions: [{
      question: 'What is your expected graduation date?',
      answer: 'Spring 2028',
      answerSource: 'applicant_review',
      portalSelector: '#question_67595189',
      portalInputType: 'combobox',
    }],
  }));
  assert.equal(actions.some((action) => action.value === 'May 2028'), false,
    'the raw profile date must never be typed anywhere on this packet');
  const graduationDateFills = actions.filter((action) =>
    (action.type === 'fill' || action.type === 'fillByLabelText')
    && /graduation\s+date/i.test(`${action.label ?? ''} ${action.selector ?? ''} ${action.text ?? ''}`));
  assert.ok(graduationDateFills.length > 0, 'her reviewed answer must drive the control at all');
  for (const action of graduationDateFills) {
    assert.equal(action.value, 'Spring 2028',
      `every value typed at the graduation-date control must be her own answer, got ${JSON.stringify(action.value)} via ${action.label}`);
  }
});

test('a probe-failed control with no applicant answer still refuses every speculative guess at it', () => {
  // The suppression this file already promises: "Closed controls whose live option evidence failed.
  // No action builder may guess at these." Relaxing it for HER answer must not relax it for a
  // machine value, or the next probe failure submits a profile guess under a control nobody read.
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    graduationDate: 'May 2028',
    failedFields: [{
      controlId: 'question_67595189',
      label: 'What is your expected graduation date?',
      selector: '#question_67595189',
      inputType: 'combobox',
    }],
    questions: [{
      question: 'What is your expected graduation date?',
      answer: 'May 2028',
      portalSelector: '#question_67595189',
      portalInputType: 'combobox',
    }],
  }));
  const questionFills = actions.filter((action) =>
    action.type === 'fill' && action.label?.startsWith('question_combo:'));
  assert.equal(questionFills.length, 0,
    `a machine answer must stay suppressed at a failed control, got ${JSON.stringify(questionFills.map((action) => action.value))}`);
});

test('a machine answer with no option evidence still leads with the computed bucket', () => {
  // The case the bucket exists for, asserted so the fix above cannot quietly take it away: a profile
  // fact that has never been near this control is rarely spelled the way a closed list spells it.
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    graduationDate: 'May 2028',
    questions: [{
      question: 'What is your expected graduation date?',
      answer: 'May 2028',
      portalSelector: '#question_67595189',
      portalInputType: 'combobox',
    }],
  }));
  const typed = actions
    .filter((action) => action.type === 'fill' && action.label?.startsWith('question_combo:'))
    .map((action) => action.value);

  assert.equal(typed[0], 'Spring 2028',
    `an unproven machine answer must still lead with the bucket, got ${JSON.stringify(typed)}`);
});

/* The SECOND emitter of the raw profile date, measured after PR #583 deployed.
 *
 * DV Trading, packet e0a0eb84, 2026-08-18 ~00:00 GST. #583 made the graduation-date combobox
 * ladder lead with her reviewed answer, and the run receipt still carried BOTH lines: her
 * "January 2028 - July 2028" typed, and `no option matched "May 2028", left for you to choose`.
 *
 * The emitter is the plain label-fill trio in pushFixedFieldActions - graduation_date,
 * graduation_date_label, graduation_date_expected - which passed packet.graduationDate raw.
 * fillByLabelText resolves by label substring, so "Expected Graduation Date" lands in the same
 * react-select as the employer's "Please re-confirm your expected graduation date", a control her
 * answer had already driven. Its suppression gate could not stand it down: the control was never
 * probed and never failed, and packetAnswerOutranksAliasGuess deliberately keeps an unprobed
 * ladder alive because on a same-family form it may be a different control's only fill. So the
 * fill survives, and the fix is the same rule #583 established: her answer replaces the derived
 * value in the fill itself. */
test('the label-scoped graduation-date fills carry her reviewed answer, not the profile date', () => {
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    graduationDate: 'May 2028',
    questions: [{
      question: 'Please re-confirm your expected graduation date',
      answer: 'January 2028 - July 2028',
      answerSource: 'applicant_review',
      portalSelector: '#question_dv_graduation',
      portalInputType: 'combobox',
    }],
  }));
  const labelFills = actions.filter((action) => action.type === 'fillByLabelText'
    && /^(?:graduation_date|graduation_date_label|graduation_date_expected)$/.test(action.label ?? ''));
  assert.ok(labelFills.length > 0, 'the label-scoped graduation-date fills must still exist');
  for (const action of labelFills) {
    assert.equal(action.value, 'January 2028 - July 2028',
      `her reviewed answer must replace the profile date, got ${JSON.stringify(action.value)} via ${action.label}`);
  }
  assert.equal(actions.some((action) => action.type === 'fillByLabelText' && action.value === 'May 2028'), false,
    'no label-scoped fill may type the raw profile date on this packet');
});

test('the label-scoped graduation-date fills keep the profile date when no applicant answer exists', () => {
  // The other half of the rule: machine-resolved records are invisible to the applicant lookup, so
  // a packet whose graduation question was answered by the resolver changes nothing here.
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    graduationDate: 'May 2028',
    questions: [{
      question: 'Please re-confirm your expected graduation date',
      answer: 'January 2028 - July 2028',
      portalSelector: '#question_dv_graduation',
      portalInputType: 'combobox',
    }],
  }));
  const labelFills = actions.filter((action) => action.type === 'fillByLabelText'
    && /^(?:graduation_date|graduation_date_label|graduation_date_expected)$/.test(action.label ?? ''));
  assert.ok(labelFills.length > 0, 'the label-scoped graduation-date fills must still exist');
  for (const action of labelFills) {
    assert.equal(action.value, 'May 2028',
      `a machine-resolved record must not replace the profile date, got ${JSON.stringify(action.value)} via ${action.label}`);
  }
});

/* Her own referral choice must reach a list the synonym table does not know.
 *
 * DV Trading's Greenhouse list, read live 2026-08-17: LinkedIn / DV Recruitment / DV Employee /
 * DV Intern / DV Website / Student Organization / Campus Event / Word of Mouth / SHRM / Other. No
 * job-board entry exists at all, so her standing instruction lands on "Other".
 *
 * referralSourceOptionCandidates emits job-board wordings and does not recognise "Other", so it
 * returned an empty list and greenhouseComboboxValuesForQuestion turned that into NO actions - the
 * required control was never touched and the application could not be sent. */
test('an applicant-chosen referral answer is typed even when the synonym table does not know it', () => {
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    questions: [{
      question: 'How did you hear about DV Trading?',
      answer: 'Other',
      answerSource: 'applicant_review',
      portalSelector: '#question_referral_dv',
      portalInputType: 'combobox',
    }],
  }));
  const typed = actions
    .filter((action) => action.type === 'fill' && action.label?.startsWith('question_combo:'))
    .map((action) => action.value);

  assert.ok(typed.length > 0, 'the referral control must be driven at all');
  assert.equal(typed[0], 'Other', `her choice must lead, got ${JSON.stringify(typed)}`);
});

test('a bare stored referral default still goes through the synonym builder alone', () => {
  // The relay-never-generate rule: without provenance the stored value is not treated as a choice
  // she made about THIS list, so the job-board wordings are what get offered.
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    questions: [{
      question: 'How did you hear about us?',
      answer: 'Job board',
      portalSelector: '#question_referral_plain',
      portalInputType: 'combobox',
    }],
  }));
  const typed = actions
    .filter((action) => action.type === 'fill' && action.label?.startsWith('question_combo:'))
    .map((action) => action.value);
  assert.ok(typed.length > 0, 'a stored job-board default must still drive the control');
  assert.ok(/job\s*board/i.test(typed[0] ?? ''), `expected a job-board wording, got ${JSON.stringify(typed)}`);
});

/* The label-scoped referral pass runs LAST, so it decides what the employer receives.
 *
 * It typed packet.referralSourceDefault unconditionally, overwriting the question-scoped pass that
 * had already resolved this control from her own answer. Measured on Five Rings 2231fc73 and
 * DV Trading e0a0eb84, 2026-08-17: neither list carries a job-board entry, her answer was "Other"
 * with answer_source applicant_review, and the run still reported no option matched "Job board" on
 * a required control of an otherwise complete application. */
test('the trailing referral label pass types her choice, not the stored default', () => {
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    referralSourceDefault: 'Job board',
    questions: [{
      question: 'How did you first hear about Five Rings?',
      answer: 'Other',
      answerSource: 'applicant_review',
      portalSelector: '#question_17808234008',
      portalInputType: 'combobox',
    }],
  }));
  const labelTyped = actions
    .filter((action) => action.type === 'fill' && action.label?.startsWith('greenhouse_referral'))
    .map((action) => action.value);

  assert.ok(labelTyped.length > 0, 'the label pass must still drive referral labels');
  assert.equal(labelTyped.includes('Job board'), false,
    `the default must not be typed over her choice, got ${JSON.stringify(labelTyped.slice(0, 6))}`);
  assert.ok(labelTyped.includes('Other'), `her choice must be typed, got ${JSON.stringify(labelTyped.slice(0, 6))}`);
});

test('with no applicant referral answer the label pass still types the stored default', () => {
  // Every case this pass was written for: nothing she chose, so the default is what it has.
  const actions = buildManagedPortalActions('greenhouse', andurilPacket({
    referralSourceDefault: 'Job board',
    questions: [],
  }));
  const labelTyped = actions
    .filter((action) => action.type === 'fill' && action.label?.startsWith('greenhouse_referral'))
    .map((action) => action.value);
  assert.ok(labelTyped.some((value) => /job\s*board/i.test(value ?? '')),
    `expected the default, got ${JSON.stringify(labelTyped.slice(0, 6))}`);
});

test('an applicant-reviewed graduation answer leads the speculative date ladder', () => {
  // Measured on DV Trading e0a0eb84 and Jump Trading 2e593ac5, 2026-08-17 late: the stored
  // reviewed answer was on the employer's list verbatim, the control was never probed so the
  // ladder rightly still fired, and the ladder's FIRST value - the only one a react-select's
  // single attempt sees - was the profile-derived "May 2028", which is on neither board's list.
  // The run reported `no option matched "May 2028"` about a question she had already answered.
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    graduationDate: 'May 2028',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'please re-confirm your expected graduation date',
        answer: 'January 2028 - July 2028',
        answerSource: 'applicant_review',
      },
    ],
  });
  const dateFills = actions.filter(
    (action) => action.type === 'fill' && action.label?.startsWith('education_graduation_date_combo'),
  );
  assert.ok(dateFills.length > 0, 'the ladder must still fire on an unprobed control');
  assert.equal(dateFills[0].value, 'January 2028 - July 2028');
  // The derived forms stay on the ladder behind her answer, for the board that spells it that way.
  assert.ok(dateFills.some((action) => action.value === 'May 2028'));
});

test('the speculative date ladder is unchanged when no applicant answer exists', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    graduationDate: 'May 2028',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      // A machine-resolved record must not lead: only answer_source applicant_review carries her claim.
      { question: 'please re-confirm your expected graduation date', answer: 'January 2028 - July 2028' },
    ],
  });
  const dateFills = actions.filter(
    (action) => action.type === 'fill' && action.label?.startsWith('education_graduation_date_combo'),
  );
  assert.ok(dateFills.length > 0);
  assert.equal(dateFills[0].value, 'May 2028');
});

test('an applicant-reviewed GPA band leads the Akuna fixed-question ladder', () => {
  // Same class as the graduation ladder: 'What is your GPA?' was typed as the profile's "3.89"
  // while her reviewed band "3.6-4.0" sat on the packet, and the band list refused the number.
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    gpa: '3.89',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    jdText: 'Akuna Capital internship',
    questions: [
      {
        question: 'what is your gpa?',
        answer: '3.6-4.0',
        answerSource: 'applicant_review',
      },
    ],
  });
  const gpaFills = actions.filter(
    (action) => action.type === 'fill'
      && action.label?.startsWith('greenhouse_fixed_question')
      && /what is your gpa/i.test(action.label ?? ''),
  );
  assert.ok(gpaFills.length > 0, 'the Akuna GPA ladder must still fire');
  assert.equal(gpaFills[0].value, '3.6-4.0');
});

test('an answer-loss line names its field even with no employer question in the label', () => {
  /* Measured across the Greenhouse batch of 2026-08-18: seven packets blocked and every one led
   * with a bare "Litos could not leave an answer on the form", because managedActionLabelQuestion
   * strips a leading [a-z_]+ run and a label like `education_discipline_combo:0` IS that run.
   * DV Trading e0a0eb84 was hiding two distinct failures behind that one sentence. */
  const reasons = managedAnswerLossReasons({
    skipped: [
      'education_discipline_combo:0: no option matched "Computer Science", left for you to choose',
      'education_graduation_month: value did not persist after fill',
      'question:overall gpa: value did not persist after fill',
      'question_combo:0:0:which university: no option matched "USC", left for you to choose',
      'nothing matched #some-optional-selector',
    ],
  } as any);

  assert.ok(reasons.some((r) => r.includes('"education discipline"')), reasons.join('\n'));
  assert.ok(reasons.some((r) => r.includes('"education graduation month"')), reasons.join('\n'));
  // The employer's own wording still leads wherever the label carries one.
  assert.ok(reasons.some((r) => r.includes('"overall gpa"')), reasons.join('\n'));
  assert.ok(reasons.some((r) => r.includes('"which university"')), reasons.join('\n'));
  // A selector that simply matched nothing is still not an answer loss.
  assert.equal(reasons.some((r) => r.includes('some-optional-selector')), false);
  // And nothing falls back to the unnamed sentence when a name was recoverable.
  assert.equal(reasons.some((r) => r.startsWith('Litos could not leave an answer on the form:')), false);
});
