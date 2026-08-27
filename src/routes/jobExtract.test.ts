import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  jobExtractBodySchema,
  clipJdText,
  jobDescriptionSourceUrl,
  MAX_JD_TEXT_CHARS,
} from './jobExtract';
import { leadRequirementCandidates } from '../engine/leadAlignment';

// POST /jobs/extract lets "New application" go from a pasted URL to a reviewable JD without a
// side-channel copy-paste step (2026-07-24 product decision). No live network/DB in the test env
// per this repo's convention, so these pin the two pure pieces: the request schema and the
// text-bounding helper the route applies to whatever the managed browser returns.

describe('jobExtractBodySchema', () => {
  test('accepts a valid https URL', () => {
    const r = jobExtractBodySchema.safeParse({ job_url: 'https://jobs.ashbyhq.com/ctgt/abc123' });
    assert.equal(r.success, true);
  });

  test('rejects a non-URL string', () => {
    const r = jobExtractBodySchema.safeParse({ job_url: 'not a url' });
    assert.equal(r.success, false);
  });

  test('rejects a missing job_url', () => {
    const r = jobExtractBodySchema.safeParse({});
    assert.equal(r.success, false);
  });

  test('rejects an over-length URL', () => {
    const long = 'https://example.com/' + 'a'.repeat(2000);
    const r = jobExtractBodySchema.safeParse({ job_url: long });
    assert.equal(r.success, false);
  });

  // http:// passes the schema's z.url() check; the route rejects it separately with an explicit
  // protocol check (new URL(...).protocol !== 'https:') so the managed browser is never pointed at
  // a plaintext origin. That check lives in the handler, not the schema, so it is not re-asserted
  // here.
});

describe('clipJdText', () => {
  test('trims surrounding whitespace', () => {
    assert.equal(clipJdText('  Software Engineer Intern  \n'), 'Software Engineer Intern');
  });

  test('passes short text through unchanged', () => {
    assert.equal(clipJdText('Short JD'), 'Short JD');
  });

  test('caps at MAX_JD_TEXT_CHARS so an oversized page cannot blow past resume/generate\'s jd_text cap', () => {
    const huge = 'x'.repeat(MAX_JD_TEXT_CHARS + 5000);
    const clipped = clipJdText(huge);
    assert.equal(clipped.length, MAX_JD_TEXT_CHARS);
  });

  test('undefined/null/empty all become an empty string, not a thrown error', () => {
    assert.equal(clipJdText(undefined), '');
    assert.equal(clipJdText(null), '');
    assert.equal(clipJdText(''), '');
  });
});

describe('jobDescriptionSourceUrl', () => {
  test('reads an exact Workable application URL from its job overview instead of the candidate form', () => {
    assert.equal(
      jobDescriptionSourceUrl('https://apply.workable.com/remote-recruitment/j/D4CA268A39/apply/'),
      'https://apply.workable.com/remote-recruitment/j/D4CA268A39/',
    );
  });

  test('drops application-form tracking state when moving to the Workable overview', () => {
    assert.equal(
      jobDescriptionSourceUrl(
        'https://apply.workable.com/remote-recruitment/j/D4CA268A39/apply?utm_source=board#application',
      ),
      'https://apply.workable.com/remote-recruitment/j/D4CA268A39/',
    );
  });

  test('reads an exact bare Workable account-feed application URL from its job overview', () => {
    assert.equal(
      jobDescriptionSourceUrl('https://apply.workable.com/j/57B10F8875/apply'),
      'https://apply.workable.com/j/57B10F8875/',
    );
  });

  test('drops query and fragment state from an exact bare Workable application URL', () => {
    assert.equal(
      jobDescriptionSourceUrl('https://apply.workable.com/j/57B10F8875/apply/?source=feed#application'),
      'https://apply.workable.com/j/57B10F8875/',
    );
  });

  /* LEVER, added 2026-08-27 on live evidence: a Belvedere Trading packet stored
     jobs.lever.co/{org}/{id}/apply as its portal_url and froze 20,000 characters of that form as
     its job description. Lever's overview is the same path without the trailing /apply. */
  test('reads a Lever application URL from its job overview instead of the candidate form', () => {
    assert.equal(
      jobDescriptionSourceUrl('https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0/apply'),
      'https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0',
    );
  });

  test('drops tracking state when moving to the Lever overview', () => {
    assert.equal(
      jobDescriptionSourceUrl('https://jobs.lever.co/acme/abc123/apply?lever-source=LinkedIn#form'),
      'https://jobs.lever.co/acme/abc123',
    );
  });

  test('reads a Lever EU application URL the same way', () => {
    assert.equal(
      jobDescriptionSourceUrl('https://jobs.eu.lever.co/acme/abc123/apply'),
      'https://jobs.eu.lever.co/acme/abc123',
    );
  });

  test('leaves a Lever overview URL alone, so a good URL is never rewritten', () => {
    const overview = 'https://jobs.lever.co/acme/abc123';
    assert.equal(jobDescriptionSourceUrl(overview), overview);
  });

  /* The rewrite is per ATS on purpose. A trailing /apply means whatever the board says it means, so
     a blanket strip would silently extract the wrong page on a host we have never checked. */
  test('does not strip a trailing apply segment on an unknown host', () => {
    const other = 'https://careers.example.com/engineering/123/apply';
    assert.equal(jobDescriptionSourceUrl(other), other);
  });

  test('does not rewrite a two-segment Lever path that is not an application route', () => {
    const notApply = 'https://jobs.lever.co/acme/apply';
    assert.equal(jobDescriptionSourceUrl(notApply), notApply);
  });

  test('does not rewrite non-form Workable paths or other origins', () => {
    for (const url of [
      'https://apply.workable.com/remote-recruitment/j/D4CA268A39/',
      'https://apply.workable.com/remote-recruitment/j/D4CA268A39/apply/extra',
      'https://apply.workable.com/j/57B10F8875/?source=feed#overview',
      'https://apply.workable.com/j/57B10F8875/apply/extra?source=feed#application',
      'https://apply.workable.com/remote-recruitment/jobs/view/D4CA268A39',
      'https://apply.workable.com:444/remote-recruitment/j/D4CA268A39/apply',
      'https://www.workable.com/remote-recruitment/j/D4CA268A39/apply',
      'https://example.com/remote-recruitment/j/D4CA268A39/apply',
    ]) {
      assert.equal(jobDescriptionSourceUrl(url), url);
    }
  });
});

/* A PAGE OF FORM LABELS IS NOT A JOB DESCRIPTION, and non-empty was the only bar until 2026-08-26.
 *
 * Packet 496cff97, a Jane Street Software Engineer Internship, was frozen with 3,696 characters and
 * 78 lines in which the posting contributed a title and a location. The rest was a consent banner,
 * the site's top nav, `* Required fields`, `Legal first name`, `Email confirmation`, the pronoun
 * list, `How did you hear about us?`, `Select an option`, and the legal footer. The review screen
 * scored it 0 of 5 with "Not much overlap", which a student reads as "your resume is a poor match"
 * when the truth is that the posting was never read.
 *
 * The route already rewrote Workable application URLs for this exact reason; company-hosted boards
 * reach the same shape by a path no URL rewrite recognises, so the check has to be on what came
 * back rather than on where it was asked for. */
describe('a form-only page is refused rather than frozen into a packet', () => {
  const JANE_STREET_FORM_ONLY = [
    'Jane Street Group, LLC uses cookies and similar technologies, including third-party cookies, on this Site to provide basic functionalities and perform analytics.',
    'ACCEPT ALL', 'REJECT ALL',
    'WHO WE ARE', 'WHAT WE DO', 'THE LATEST', 'CULTURE', 'JOIN JANE STREET',
    'OPEN ROLES', 'PROGRAMS AND EVENTS', 'INTERNSHIPS', 'INTERVIEWING',
    'Join Jane Street', 'Open roles', 'Job description', 'Apply',
    'Software Engineer Internship, May-August', 'New York, Summer Internship', 'Job description',
    '* Required fields', 'Legal first name *', 'Preferred first name', 'Legal last name *',
    'Email *', 'Email confirmation *', 'Phone *',
    'Pronouns (Select one or more.)', 'she/her/hers', 'he/him/his', 'they/them/theirs',
    'Current or most recent employer *', 'How did you hear about us? *', 'Select an option',
    'Have you interviewed with Jane Street before? *', 'Yes', 'No',
    'Submit', 'Jane Street is an Equal Opportunity Employer',
  ].join('\n');

  const REAL_POSTING = [
    'What we look for:',
    'Pursuing a bachelor degree in computer science or a related engineering field, graduating in 2028',
    'You have some first hand experience with SQL and/or Python',
    'You use analytical skills to make data-driven decisions',
  ].join('\n');

  const APPLICATION_FORM = [
    'Apply for this job', '* Required fields', 'First Name *', 'Last Name *', 'Email *',
    'Resume/CV *', 'LinkedIn Profile', 'How did you hear about us? *', 'Select an option',
    'Submit Application',
  ].join('\n');

  test('the live Jane Street page states no requirement at all', () => {
    assert.deepEqual(leadRequirementCandidates(JANE_STREET_FORM_ONLY), []);
  });

  test('a real posting does state requirements', () => {
    assert.ok(leadRequirementCandidates(REAL_POSTING).length > 0);
  });

  /* THE CASE THAT MUST NOT REGRESS. Most Greenhouse pages carry the description and the application
     form on one page, so a check that keyed on "are form labels present" would refuse nearly every
     posting the route is for. The predicate is whether any ask SURVIVES, not whether a form is
     there beside it. */
  test('a real posting is still accepted when its application form sits on the same page', () => {
    const withForm = `${REAL_POSTING}\n${APPLICATION_FORM}`;
    assert.ok(
      leadRequirementCandidates(withForm).length >= leadRequirementCandidates(REAL_POSTING).length,
      'appending a form must not remove asks',
    );
  });

  /* TRUNCATION IS A CO-CONSPIRATOR, confirmed on a second account the same night: a Lever posting
     filled all 20,000 characters with a `Name of School` dropdown of roughly three thousand
     university names, so the description never made it into the captured text at all. That is why
     the guard runs on the CLIPPED string rather than on what the browser returned: the clipped
     string is what gets frozen and scored, and validating the full text would let a page pass on
     requirements the cap then removes. */
  test('a page whose requirements are cut away by the cap is still refused', () => {
    const dropdown = Array.from({ length: 4000 }, (_, i) => `University Number ${i}`).join('\n');
    const page = `${APPLICATION_FORM}\n${dropdown}\n${REAL_POSTING}`;
    assert.ok(page.length > MAX_JD_TEXT_CHARS, 'fixture must exceed the cap to exercise this');
    // The full page does state requirements; the clipped one does not, and the clipped one is what
    // would be stored.
    assert.ok(leadRequirementCandidates(page).length > 0, 'full text should still contain the asks');
    assert.deepEqual(leadRequirementCandidates(clipJdText(page)), []);
  });

  /* THE REFUSAL MUST NOT ASSERT MORE THAN THE PREDICATE PROVES. leadRequirementCandidates returns
     nothing when it finds no stated requirement; a form is the usual cause but not the only one.
     splitClauses works on LINES and drops any over 300 chars, so a genuine posting written as
     flowing paragraphs lands here too - correctly refused, and previously told it was a form. */
  test('the refusal states what was found, and offers the form only as a possibility', () => {
    const route = readFileSync(path.join(__dirname, 'jobExtract.ts'), 'utf8');
    assert.match(route, /could not find a stated requirement on that page/);
    assert.match(route, /It may be the application form/);
    // The old sentence asserted it outright. It must not come back.
    assert.doesNotMatch(route, /looks like an application form rather than a job description/);
  });

  test('a cut-off description is explained as length, not as a form', () => {
    const route = readFileSync(path.join(__dirname, 'jobExtract.ts'), 'utf8');
    assert.match(route, /requirements sit past the amount of text Litos captures/);
  });

  /* The prose-paragraph shape this wording exists for, pinned so the claim in the comment stays
     true: a single long line states no ask, and a section heading above it does not rescue it. */
  test('a genuine posting written as one long line states no ask, heading or not', () => {
    const oneLongLine = 'At Databricks we build the best data and AI infrastructure platform. As a '
      + 'Product Management Intern you will learn how to be a successful PM. We are hiring across '
      + 'all of our teams, including AI Platform, Machine Learning, Databricks SQL, ETL and EDA. '
      + 'This is a 12 week paid summer internship. You will prototype and test early ideas with '
      + 'customers using Python.';
    assert.ok(oneLongLine.length > 300, 'fixture must exceed the clause cap to exercise this');
    assert.deepEqual(leadRequirementCandidates(oneLongLine), []);
    assert.deepEqual(leadRequirementCandidates(`What we look for:\n${oneLongLine}`), []);
  });

  test('the route separates a cut-off description from a page that never had one', () => {
    const route = readFileSync(path.join(__dirname, 'jobExtract.ts'), 'utf8');
    assert.match(route, /descriptionPushedPastCap/);
    assert.match(route, /job_extract_truncated_past_description/);
    // The distinction must be drawn from the FULL text, or it cannot tell the two apart at all.
    assert.match(route, /leadRequirementCandidates\(fullText\)\.length > 0/);
  });

  test('the route refuses on no stated requirement, using the documented paste-manually contract', () => {
    const route = readFileSync(path.join(__dirname, 'jobExtract.ts'), 'utf8');
    assert.match(route, /leadRequirementCandidates\(jdText\)\.length === 0/);
    assert.match(route, /'job_extract_no_requirements'/);
    // 502 is what the route's own docblock tells callers means "fall back to the manual paste field".
    assert.match(route, /job_extract_no_requirements[\s\S]{0,80}|status\(502\)[\s\S]{0,400}job_extract_no_requirements/);
    // The refusal must come AFTER the empty check, so an empty page keeps its own clearer message.
    assert.ok(
      route.indexOf("job_extract_empty") < route.indexOf("job_extract_no_requirements"),
      'the empty-page refusal must stay ahead of the form-only one',
    );
  });
});
