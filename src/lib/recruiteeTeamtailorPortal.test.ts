import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildManagedPortalActions,
  detectPortal,
  portalApplicationUrl,
  portalCanAutoSubmit,
  portalHandoffReason,
  readManagedReceipt,
} from './portalSubmission';

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
  assert.equal(actions.filter((action) => action.type === 'click' && action.selector === 'button[type="submit"], input[type="submit"]').length, 1);
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
