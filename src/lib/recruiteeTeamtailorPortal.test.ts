import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildManagedPortalActions,
  detectPortal,
  MANAGED_CONSENT_TICK_GUARD_LABEL,
  MANAGED_CONSENT_TICK_LABEL_PREFIX,
  managedConsentTickPlan,
  portalApplicationUrl,
  portalCanAutoSubmit,
  portalHandoffReason,
  readManagedReceipt,
} from './portalSubmission';
import { AUTOMATIC_CONSENT_ACCEPTANCE_VERSION } from './automationConsent';

const packet = {
  fullName: 'Taylor Example',
  email: 'taylor@example.com',
  phone: '+971500000000',
  resume: Buffer.from('pdf'),
  resumeName: 'Taylor_Example_Resume.pdf',
  coverLetter: Buffer.from('cover'),
  coverLetterName: 'Taylor_Example_Cover_Letter.pdf',
  questions: [],
};

test('detects two unrelated live Recruitee tenants and canonicalizes their form routes', () => {
  for (const url of [
    'https://rebuy.recruitee.com/o/acquisition-manager-paid-search-pla-focused-mfx',
    'https://optiweb.recruitee.com/o/apply-for-our-talent-pool-or-internship/c/new',
  ]) {
    assert.equal(detectPortal(url), 'recruitee');
  }
  assert.equal(
    portalApplicationUrl('recruitee', 'https://rebuy.recruitee.com/o/acquisition-manager-paid-search-pla-focused-mfx'),
    'https://rebuy.recruitee.com/o/acquisition-manager-paid-search-pla-focused-mfx/c/new',
  );
  assert.equal(
    portalApplicationUrl('recruitee', 'https://rebuy.recruitee.com/o/acquisition-manager-paid-search-pla-focused-mfx/c/new/'),
    'https://rebuy.recruitee.com/o/acquisition-manager-paid-search-pla-focused-mfx/c/new',
  );
  assert.throws(() => detectPortal('https://www.recruitee.com/o/not-a-tenant'));
});

test('pins the verified inline Recruitee route as a manual-submit exception', () => {
  const live = 'https://whitecoatglobal1.recruitee.com/o/software-engineer-intern';
  assert.equal(detectPortal(live), 'manual_recruitee');
  assert.equal(portalApplicationUrl('manual_recruitee', live), `${live}/c/new`);
  assert.equal(portalCanAutoSubmit('recruitee'), true);
  assert.equal(portalCanAutoSubmit('manual_recruitee'), false);
  assert.match(portalHandoffReason('manual_recruitee') ?? '', /review the form and send it yourself/i);
  assert.equal(
    buildManagedPortalActions('manual_recruitee', packet, true)
      .some((action) => action.type === 'click' && action.selector === 'button[type="submit"], input[type="submit"]'),
    false,
  );
  for (const url of [
    'https://other.recruitee.com/o/software-engineer-intern',
    'https://whitecoatglobal1.recruitee.com/o/other-role',
    'https://whitecoatglobal1.recruitee.com/o/software-engineer-intern/apply',
    'https://whitecoatglobal1.recruitee.com/o/software-engineer-intern%2Fc%2Fnew',
    'https://whitecoatglobal1.recruitee.com/o/software-engineer-intern?source=test',
    'https://whitecoatglobal1.recruitee.com/o/software_engineer_intern',
    'https://api.eu.recruitee.com/o/software-engineer-intern',
    'https://www.recruitee.com/o/software-engineer-intern',
  ]) assert.throws(() => detectPortal(url), url);
});

test('Recruitee actions map only captured fields and preserve safety controls', () => {
  const actions = buildManagedPortalActions('recruitee', {
    ...packet,
    questions: [{
      question: 'I want you to keep my information for all future positions I might be fit for.',
      answer: 'Yes',
      portalSelector: 'input[name="candidate.openQuestionAnswers.42.choice"]',
      portalInputType: 'radio',
    }],
  }, true);
  const serialized = JSON.stringify(actions);
  for (const selector of ['candidate.name', 'candidate.email', 'candidate.phone', 'candidate.cv']) {
    assert.match(serialized, new RegExp(selector.replace('.', '\\.')));
  }
  assert.doesNotMatch(serialized, /agreement|consent|hcaptcha|captcha|honeypot|hp_/i);
  assert.equal(actions.filter((action) => action.type === 'confirmAndSubmit').length, 1);
  assert.equal(portalCanAutoSubmit('recruitee'), true);
});

test('detects two unrelated live Teamtailor tenants but stops before privacy consent', () => {
  for (const url of [
    'https://career.teamtailor.com/jobs/8124573-group-financial-controller/applications/new',
    'https://aicomspa-1736851116.teamtailor.com/jobs/7931279-techincal-tender-specialist',
  ]) {
    assert.equal(detectPortal(url), 'teamtailor');
  }
  assert.equal(
    portalApplicationUrl('teamtailor', 'https://career.teamtailor.com/jobs/8124573-group-financial-controller'),
    'https://career.teamtailor.com/jobs/8124573-group-financial-controller/applications/new',
  );
  assert.equal(
    portalApplicationUrl('teamtailor', 'https://career.teamtailor.com/jobs/8124573-group-financial-controller/applications/new/'),
    'https://career.teamtailor.com/jobs/8124573-group-financial-controller/applications/new',
  );
  for (const host of ['www.teamtailor.com', 'app.teamtailor.com', 'api.teamtailor.com']) {
    assert.throws(() => detectPortal(`https://${host}/jobs/1-role/applications/new`));
  }

  const actions = buildManagedPortalActions('teamtailor', {
    ...packet,
    questions: [{
      question: 'I agree to the applicant privacy policy and consent to processing my personal data.',
      answer: 'Yes',
      portalSelector: 'input[name="candidate[consent_given]"]',
      portalInputType: 'checkbox',
    }],
  }, true);
  const serialized = JSON.stringify(actions);
  assert.match(serialized, /candidate\[first_name\]/);
  assert.match(serialized, /candidate\[last_name\]/);
  assert.match(serialized, /upload_resume_field/);
  assert.doesNotMatch(serialized, /consent_given|future_jobs/);
  assert.equal(actions.some((action) => action.type === 'click' && action.selector === 'button[type="submit"], input[type="submit"]'), false);
  assert.equal(portalCanAutoSubmit('teamtailor'), false);
  assert.match(portalHandoffReason('teamtailor') ?? '', /privacy terms/i);
});

/* ---- the grant-conditional consent tick ---- */

const TEAMTAILOR_CONSENT_SELECTOR = 'input[name="candidate[consent_given]"]';
const CONSENT_GRANT = {
  granted_at: '2026-08-12T09:15:00.000Z',
  version: AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
};
const grantedProfile = { consent_acknowledgement_permission: CONSENT_GRANT };
const consentQuestion = {
  question: 'I agree to the applicant privacy policy and consent to processing my personal data.',
  answer: 'Yes',
  answerSource: 'consent_permission',
  portalSelector: TEAMTAILOR_CONSENT_SELECTOR,
  portalInputType: 'checkbox',
};

function consentTickClicks(actions: ReturnType<typeof buildManagedPortalActions>) {
  return actions.filter((action) => action.type === 'click'
    && action.label?.startsWith(`${MANAGED_CONSENT_TICK_LABEL_PREFIX}:`));
}

test('with the grant and the recorded acceptance, Teamtailor ticks once, guarded, then submits', () => {
  const actions = buildManagedPortalActions('teamtailor', {
    ...packet,
    applicationProfile: grantedProfile,
    questions: [consentQuestion],
  }, true);

  // Exactly ONE tick, on the exact captured control, required and uniqueness-asserted.
  const ticks = consentTickClicks(actions);
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].selector, TEAMTAILOR_CONSENT_SELECTOR);
  assert.equal(ticks[0].optional, false);
  assert.equal(ticks[0].requireUnique, true);

  // The honeypot guard runs BEFORE the tick: a required visible-unique read of the same control,
  // pinned to a runner that enforces the assertions rather than dropping them.
  const guardIndex = actions.findIndex((action) => action.label === MANAGED_CONSENT_TICK_GUARD_LABEL);
  const tickIndex = actions.indexOf(ticks[0]);
  assert.ok(guardIndex >= 0 && guardIndex < tickIndex);
  const guard = actions[guardIndex];
  assert.equal(guard.type, 'extract');
  assert.equal(guard.selector, TEAMTAILOR_CONSENT_SELECTOR);
  assert.equal(guard.optional, false);
  assert.equal(guard.requireUnique, true);
  assert.equal(guard.requireVisible, true);
  assert.equal(guard.requireNonEmpty, true);
  assert.ok(actions.slice(0, guardIndex).some((action) => action.type === 'requireCapability'));

  // The tick sits IMMEDIATELY before the one submit action, and nothing else touches the control:
  // the reviewed-question loop must not also fill it, or the toggle un-ticks it.
  const submits = actions.filter((action) => action.type === 'confirmAndSubmit');
  assert.equal(submits.length, 1);
  assert.equal(actions.indexOf(submits[0]), tickIndex + 1);
  const touching = actions.filter((action) =>
    (action.selector?.includes('candidate[consent_given]') ?? false)
    || (action.text?.includes('applicant privacy policy') ?? false));
  assert.deepEqual(touching, [guard, ticks[0]]);
  assert.doesNotMatch(JSON.stringify(actions), /consent_given_future_jobs/);
});

test('the audit provenance is the plan precondition: the licence rides the plan, and a non-consent_permission answer parks it', () => {
  const planned = managedConsentTickPlan('teamtailor', {
    ...packet,
    applicationProfile: grantedProfile,
    questions: [consentQuestion],
  });
  assert.ok(planned);
  assert.match(planned!.licence.version, /privacy_and_terms@/);
  assert.equal(planned!.licence.granted_at, CONSENT_GRANT.granted_at);

  // Her own reviewed tick is not a machine acceptance, and an unattributed answer proves nothing:
  // both park at today's handoff rather than being re-labelled as made under the permission.
  for (const answerSource of ['applicant_review', undefined] as const) {
    const actions = buildManagedPortalActions('teamtailor', {
      ...packet,
      applicationProfile: grantedProfile,
      questions: [{ ...consentQuestion, answerSource }],
    }, true);
    assert.equal(consentTickClicks(actions).length, 0, String(answerSource));
    assert.equal(actions.some((action) => action.type === 'confirmAndSubmit'), false, String(answerSource));
  }
});

test('no grant means today: no tick, no submit, hand off', () => {
  for (const applicationProfile of [undefined, {}]) {
    const actions = buildManagedPortalActions('teamtailor', {
      ...packet,
      ...(applicationProfile ? { applicationProfile } : {}),
      questions: [consentQuestion],
    }, true);
    assert.doesNotMatch(JSON.stringify(actions), /consent_given/);
    assert.equal(actions.some((action) => action.type === 'confirmAndSubmit'), false);
  }
});

test('a held declaration sitting in the consent control is never ticked, grant or no grant', () => {
  for (const question of [
    'I certify that the information provided in this application is true and complete.',
    'I authorize a background check and reference verification.',
    'I am legally authorized to work in the United States.',
  ]) {
    const actions = buildManagedPortalActions('teamtailor', {
      ...packet,
      applicationProfile: grantedProfile,
      questions: [{ ...consentQuestion, question }],
    }, true);
    assert.equal(consentTickClicks(actions).length, 0, question);
    assert.equal(actions.some((action) => action.type === 'confirmAndSubmit'), false, question);
  }
});

test('two consent-shaped controls mean park, not guess; the retention opt-in is never the tick', () => {
  // Two records claiming the one captured control: ambiguity, so park.
  const ambiguous = buildManagedPortalActions('teamtailor', {
    ...packet,
    applicationProfile: grantedProfile,
    questions: [
      consentQuestion,
      { ...consentQuestion, question: 'I consent to the processing of my personal data in accordance with the privacy policy.' },
    ],
  }, true);
  assert.equal(consentTickClicks(ambiguous).length, 0);
  assert.equal(ambiguous.some((action) => action.type === 'confirmAndSubmit'), false);

  // The future-jobs retention wording on the captured control is a different act: park.
  const retention = buildManagedPortalActions('teamtailor', {
    ...packet,
    applicationProfile: grantedProfile,
    questions: [{
      ...consentQuestion,
      question: 'I agree to the privacy policy and want you to keep my information for future jobs.',
    }],
  }, true);
  assert.equal(consentTickClicks(retention).length, 0);
  assert.equal(retention.some((action) => action.type === 'confirmAndSubmit'), false);

  // The sibling retention CONTROL is not a candidate at all - the plan still fires on the real one
  // and never touches the opt-in.
  const bothControls = buildManagedPortalActions('teamtailor', {
    ...packet,
    applicationProfile: grantedProfile,
    questions: [
      consentQuestion,
      {
        question: 'I want you to keep my information for all future positions I might be fit for.',
        answer: '',
        portalSelector: 'input[name="candidate[consent_given_future_jobs]"]',
        portalInputType: 'checkbox',
      },
    ],
  }, true);
  assert.equal(consentTickClicks(bothControls).length, 1);
  assert.doesNotMatch(JSON.stringify(bothControls), /consent_given_future_jobs/);
});

/* THE PLATFORM'S OWN DEFAULT WORDING, measured live 2026-08-20 on two unrelated tenants (Fully,
 * Uproar by Moburst). Teamtailor's stock candidate[consent_given] sentence embeds the TENANT'S
 * NAME mid-clause, so the fill-time licence re-derivation can only account for it when the packet
 * says who the employer is. packet.jdText is the raw posting prose and carries no frozen employer
 * line; packet.employerName is the job_context company buildPacket copies on, and the plan
 * composes the same frozen line the discovery resolver already used. No employer name on the
 * packet means the tenant name is unexplained and the plan parks, which is the direction this
 * feature fails in. */
test("Teamtailor's platform-default consent sentence plans the tick when the packet names the employer", () => {
  const liveDefault = (company: string) => ({
    ...consentQuestion,
    question: `By submitting this application, I agree that I have read the Privacy Policy and confirm that ${company} store my personal details to be able to process my job application.`,
  });
  for (const company of ['Fully', 'Uproar by Moburst']) {
    const planned = managedConsentTickPlan('teamtailor', {
      ...packet,
      employerName: company,
      jdText: 'Own the books. Ship the close.',
      applicationProfile: grantedProfile,
      questions: [liveDefault(company)],
    });
    assert.ok(planned, company);
    assert.equal(planned!.selector, TEAMTAILOR_CONSENT_SELECTOR);
    assert.equal(planned!.question, liveDefault(company).question);
    assert.match(planned!.licence.version, /privacy_and_terms@/);
    assert.equal(planned!.licence.granted_at, CONSENT_GRANT.granted_at);
  }

  // And the whole submit list follows: one guarded tick on the captured control, then the submit.
  const actions = buildManagedPortalActions('teamtailor', {
    ...packet,
    employerName: 'Fully',
    applicationProfile: grantedProfile,
    questions: [liveDefault('Fully')],
  }, true);
  const ticks = consentTickClicks(actions);
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].selector, TEAMTAILOR_CONSENT_SELECTOR);
  assert.equal(actions.filter((action) => action.type === 'confirmAndSubmit').length, 1);

  // Fail-closed: a packet that cannot say who the employer is cannot account for the tenant name
  // sitting inside the sentence, so it parks at today's handoff rather than guessing.
  const anonymous = managedConsentTickPlan('teamtailor', {
    ...packet,
    jdText: 'Own the books. Ship the close.',
    applicationProfile: grantedProfile,
    questions: [liveDefault('Fully')],
  });
  assert.equal(anonymous, null);
});

test('a fill run never ticks: the consent tick exists only on the submit list', () => {
  const actions = buildManagedPortalActions('teamtailor', {
    ...packet,
    applicationProfile: grantedProfile,
    questions: [consentQuestion],
  }, false);
  assert.doesNotMatch(JSON.stringify(actions), /consent_given/);
  assert.equal(actions.some((action) => action.type === 'confirmAndSubmit'), false);
});

/* MEASURED LIVE 2026-09-04, Covenant House International (application c24e48a2, portal
 * https://covenanthouseinternational.na.teamtailor.com/jobs/686133-intern-finance): a fill run
 * reported filled_fields: ["resume"] and an attention_reason naming every required control -
 * including first name, last name, email, phone, and the very upload filled_fields had just named -
 * "is required and is still empty". volley #954 (787cf4d) had already fixed HOSTS.teamtailor to
 * recognize this exact regional shape, so `portal` resolved to 'teamtailor' correctly; what this
 * test pins is the step after that one, which no existing test covered end to end: once a host -
 * bare tenant or regional - resolves to the 'teamtailor' family, the SAME plan has to be built for
 * it. buildManagedPortalActions takes the resolved family, never the host, so the two host shapes
 * below are asserted to produce byte-identical action lists - a future change that let anything here
 * key off the raw host string would fail this test before it ever reached production. */
test('a Teamtailor form with a custom question, the resume, and a guarded consent gets identical write actions on a bare and a regional host', () => {
  const referralQuestion = {
    question: 'Where did you find our job posting?',
    answer: 'LinkedIn',
    portalSelector: 'input[name="candidate[answers_attributes][0][answer]"]',
    portalInputType: 'text',
  };
  const packetForHost = () => ({
    ...packet,
    applicationProfile: grantedProfile,
    questions: [referralQuestion, consentQuestion],
  });

  const bareHost = 'https://fully.teamtailor.com/jobs/6360832-internship';
  const regionalHost = 'https://covenanthouseinternational.na.teamtailor.com/jobs/686133-intern-finance';
  const barePortal = detectPortal(bareHost);
  const regionalPortal = detectPortal(regionalHost);
  assert.equal(barePortal, 'teamtailor');
  assert.equal(regionalPortal, 'teamtailor');

  const bareActions = buildManagedPortalActions(barePortal, packetForHost(), true);
  const regionalActions = buildManagedPortalActions(regionalPortal, packetForHost(), true);
  // The whole point: nothing about the plan may depend on which host shape resolved to this family.
  assert.deepEqual(bareActions, regionalActions);

  for (const actions of [bareActions, regionalActions]) {
    const serialized = JSON.stringify(actions);
    // Identity: first/last/email/phone all reach the wire as real fills, not silently dropped.
    assert.match(serialized, /candidate\[first_name\]/);
    assert.match(serialized, /candidate\[last_name\]/);
    assert.match(serialized, /candidate\[email\]/);
    assert.match(serialized, /candidate\[phone\]/);
    assert.ok(
      actions.some((action) => action.type === 'fill' && action.selector === 'input[name="candidate[first_name]"]' && action.value === 'Taylor'),
      'first name is filled with the packet value, not merely mentioned',
    );
    assert.ok(
      actions.some((action) => action.type === 'fill' && action.selector === 'input[name="candidate[email]"]' && action.value === packet.email),
      'email is filled with the packet value',
    );
    // The custom question: a write action carrying the discovered control and the applicant's answer.
    assert.ok(
      actions.some((action) => action.selector === referralQuestion.portalSelector && 'value' in action && action.value === 'LinkedIn'),
      'the custom referral question is written, not skipped',
    );
    // The resume upload.
    assert.match(serialized, /upload_resume_field/);
    assert.ok(
      actions.some((action) => action.type === 'upload' && action.selector === '#upload_resume_field input[type="file"]'),
      'the resume upload targets the captured Teamtailor selector',
    );
    // The guarded consent tick, exactly once, and the submit press it exists to clear the way for.
    assert.equal(consentTickClicks(actions).length, 1);
    assert.equal(actions.filter((action) => action.type === 'confirmAndSubmit').length, 1);
  }
});

test('canonicalizes the verified Teamtailor detail route and rejects broad jobs pages', () => {
  const live = 'https://flanks.teamtailor.com/jobs/7847431-software-engineering-intern-web-scraping-data-acquisition';
  assert.equal(detectPortal(live), 'teamtailor');
  assert.equal(
    portalApplicationUrl('teamtailor', live),
    `${live}/applications/new`,
  );
  for (const url of [
    'https://other.teamtailor.com/jobs/7847431-software-engineering-intern-web-scraping-data-acquisition',
    'https://flanks.teamtailor.com/jobs/7847432-software-engineering-intern-web-scraping-data-acquisition',
    'https://flanks.teamtailor.com/jobs/7847431-other-role',
    'https://flanks.teamtailor.com/jobs',
    'https://flanks.teamtailor.com/jobs/software-engineering-intern',
    'https://flanks.teamtailor.com/jobs/7847431-software-engineering-intern/apply',
    'https://flanks.teamtailor.com/jobs/7847431-software-engineering-intern-web-scraping-data-acquisition%2Fapplications%2Fnew',
    'https://app.teamtailor.com/jobs/7847431-software-engineering-intern',
  ]) assert.throws(() => detectPortal(url), url);
});

test('receipt fixtures accept platform confirmations and reject an unchanged application form', () => {
  const recruitee = readManagedReceipt({
    title: 'Application',
    url: 'https://rebuy.recruitee.com/o/role/c/new',
    text: 'All done! Your application has been successfully submitted!',
  });
  assert.match(recruitee.confirmationText, /All done/);

  const teamtailor = readManagedReceipt({
    title: 'Application received',
    url: 'https://career.teamtailor.com/jobs/1-role/applications/new',
    text: 'Thanks for your application. We will be in touch.',
  });
  assert.match(teamtailor.confirmationText, /Thanks for your application/);

  assert.throws(() => readManagedReceipt({
    title: 'Apply',
    url: 'https://career.teamtailor.com/jobs/1-role/applications/new',
    text: 'Submit application. By submitting this application, I confirm that I read the Privacy Policy.',
  }), /never showed a confirmation/i);
});
