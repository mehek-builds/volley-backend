import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  jobExtractBodySchema,
  clipJdText,
  jobDescriptionSourceUrl,
  monitoredInventoryLookupKeys,
  monitoredJobDescriptionMatch,
  findMonitoredJobDescription,
  MAX_JD_TEXT_CHARS,
  type MonitoredInventoryJob,
} from './jobExtract';
import { leadRequirementCandidates } from '../engine/leadAlignment';
import { db } from '../db/index';

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

  test('the route serves a monitored inventory match before ever paying for a browser run', () => {
    const route = readFileSync(path.join(__dirname, 'jobExtract.ts'), 'utf8');
    assert.ok(
      route.indexOf('findMonitoredJobDescription(body.job_url)') < route.indexOf('runManagedBrowser(extractionUrl'),
      'the inventory lookup must sit ahead of the managed-browser run',
    );
    // The lookup may only short-circuit with a GOOD result: a lookup error or a stored description
    // that states no requirement must fall through to the browser, never become a new refusal.
    assert.match(route, /monitored inventory lookup failed; falling back to browser extraction/);
    assert.match(route, /monitored inventory description states no requirement; falling back to browser extraction/);
    // The same requirement bar the browser path applies, on the same clipped text.
    assert.match(route, /leadRequirementCandidates\(monitored\.jdText\)\.length > 0/);
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

/* THE INVENTORY-FIRST PATH, added 2026-09-01 on live evidence: POST /jobs/extract transiently
 * 502ed on https://alertalarm.breezy.hr/p/f6d5662ca263-alert-alarm-field-project-manager while
 * that exact posting sat in monitored_jobs with a full substantive description the board was
 * already serving. When the monitor holds the posting, the stored description is strictly better
 * than a fresh render, so the route now answers from inventory first and only falls back to the
 * managed browser.
 *
 * Matching is two-staged on purpose. String equality against apply_url/posting_url (over a small
 * set of paste-shape variants) only NOMINATES candidate rows; a candidate becomes a match only
 * when both its stored apply_url and the pasted URL canonicalize to the SAME application URL under
 * the row's source-owned family, board token, and external id - the exact bar
 * repairReviewPortalFromMonitoredJob applies to stored packet state. */

const BREEZY_POSTING_URL = 'https://alertalarm.breezy.hr/p/f6d5662ca263-alert-alarm-field-project-manager';
const BREEZY_DESCRIPTION = [
  'Alert Alarm is hiring a Field Project Manager.',
  'What we look for:',
  'You have 3+ years of experience managing field installation projects',
  'You are comfortable with scheduling software and Excel',
  'You hold a valid driver license and can travel across the region',
].join('\n');

function breezyJob(overrides: Partial<MonitoredInventoryJob> = {}): MonitoredInventoryJob {
  return {
    external_id: 'f6d5662ca263',
    apply_url: `${BREEZY_POSTING_URL}/apply`,
    posting_url: BREEZY_POSTING_URL,
    title: 'Field Project Manager',
    description: BREEZY_DESCRIPTION,
    ats_name: 'breezy',
    board_token: 'alertalarm',
    ...overrides,
  };
}

describe('monitoredInventoryLookupKeys', () => {
  test('always includes the raw pasted URL', () => {
    assert.ok(monitoredInventoryLookupKeys(BREEZY_POSTING_URL).includes(BREEZY_POSTING_URL));
  });

  test('covers trailing-slash and /apply paste shapes so either stored form is found', () => {
    const keys = monitoredInventoryLookupKeys(BREEZY_POSTING_URL);
    assert.ok(keys.includes(`${BREEZY_POSTING_URL}/`));
    assert.ok(keys.includes(`${BREEZY_POSTING_URL}/apply`));
  });

  test('a pasted /apply form also nominates the bare overview the monitor stores', () => {
    const keys = monitoredInventoryLookupKeys(`${BREEZY_POSTING_URL}/apply`);
    assert.ok(keys.includes(BREEZY_POSTING_URL));
  });

  test('strips tracking state so a copied link still nominates the stored row', () => {
    const keys = monitoredInventoryLookupKeys(`${BREEZY_POSTING_URL}?utm_source=board#detail`);
    assert.ok(keys.includes(BREEZY_POSTING_URL));
  });

  test('includes the per-ATS extraction rewrite, so a Workable form URL finds its overview row', () => {
    const keys = monitoredInventoryLookupKeys('https://apply.workable.com/acme/j/D4CA268A39/apply/');
    assert.ok(keys.includes('https://apply.workable.com/acme/j/D4CA268A39/'));
  });
});

describe('monitoredJobDescriptionMatch', () => {
  test('the live Breezy posting URL matches its monitored row and returns the stored description', () => {
    const match = monitoredJobDescriptionMatch(BREEZY_POSTING_URL, breezyJob());
    assert.ok(match);
    assert.equal(match.jdText, BREEZY_DESCRIPTION);
    assert.equal(match.pageTitle, 'Field Project Manager');
  });

  test('the /apply form of the same posting matches the same row', () => {
    assert.ok(monitoredJobDescriptionMatch(`${BREEZY_POSTING_URL}/apply`, breezyJob()));
  });

  test('the stored description passes the route requirement gate, as the live posting did', () => {
    assert.ok(leadRequirementCandidates(clipJdText(BREEZY_DESCRIPTION)).length > 0);
  });

  test('a different tenant on the same platform never matches', () => {
    assert.equal(
      monitoredJobDescriptionMatch(
        'https://othertenant.breezy.hr/p/f6d5662ca263-alert-alarm-field-project-manager',
        breezyJob(),
      ),
      undefined,
    );
  });

  test('a different posting under the same tenant never matches', () => {
    assert.equal(
      monitoredJobDescriptionMatch('https://alertalarm.breezy.hr/p/0a1b2c3d4e5f-office-manager', breezyJob()),
      undefined,
    );
  });

  test('a row whose source family is not autonomous fails closed to the browser path', () => {
    assert.equal(
      monitoredJobDescriptionMatch(BREEZY_POSTING_URL, breezyJob({ ats_name: 'jobvite' })),
      undefined,
    );
  });

  test('a row without an executable board token fails closed to the browser path', () => {
    assert.equal(monitoredJobDescriptionMatch(BREEZY_POSTING_URL, breezyJob({ board_token: null })), undefined);
    assert.equal(monitoredJobDescriptionMatch(BREEZY_POSTING_URL, breezyJob({ board_token: '' })), undefined);
  });

  /* THE COMMONEST PASTE SHAPE THERE IS. canonicalMonitoredPortalUrl refuses any query string
     outside Greenhouse, which is right for a stored provider-owned URL and wrong for one a student
     pasted: a link copied off LinkedIn or an aggregator carries `?utm_source=` or `?lever-source=`.
     Without the tracking-stripped second attempt, exactly those URLs missed the inventory and paid
     for a browser run. */
  test('a pasted URL carrying tracking state still matches its monitored row', () => {
    const match = monitoredJobDescriptionMatch(`${BREEZY_POSTING_URL}?utm_source=board#details`, breezyJob());
    assert.ok(match);
    assert.equal(match.jdText, BREEZY_DESCRIPTION);
  });

  test('a Lever URL carrying its source parameter still matches', () => {
    assert.ok(monitoredJobDescriptionMatch('https://jobs.lever.co/acme/abc123?lever-source=LinkedIn', {
      external_id: 'abc123',
      apply_url: 'https://jobs.lever.co/acme/abc123/apply',
      posting_url: 'https://jobs.lever.co/acme/abc123',
      title: 'Software Engineer Intern',
      description: BREEZY_DESCRIPTION,
      ats_name: 'lever',
      board_token: 'acme',
    }));
  });

  /* GREENHOUSE IS WHY THE RAW ATTEMPT COMES FIRST: its embed URL carries the posting's identity in
     the query, so a tracking-strip applied before the raw try would destroy the match outright. */
  test('a Greenhouse embed URL, whose identity lives in its query, still matches', () => {
    assert.ok(monitoredJobDescriptionMatch(
      'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=4012345',
      {
        external_id: '4012345',
        apply_url: 'https://boards.greenhouse.io/acme/jobs/4012345',
        posting_url: 'https://boards.greenhouse.io/acme/jobs/4012345',
        title: 'Data Engineer',
        description: BREEZY_DESCRIPTION,
        ats_name: 'greenhouse',
        board_token: 'acme',
      },
    ));
  });

  /* Stripping tracking state must not loosen identity: the tenant and posting id are still proven. */
  test('tracking state does not let a wrong-tenant URL through', () => {
    assert.equal(
      monitoredJobDescriptionMatch(
        'https://othertenant.breezy.hr/p/f6d5662ca263-alert-alarm-field-project-manager?utm_source=board',
        breezyJob(),
      ),
      undefined,
    );
  });

  test('a row with an empty stored description falls back to the browser', () => {
    assert.equal(monitoredJobDescriptionMatch(BREEZY_POSTING_URL, breezyJob({ description: '   ' })), undefined);
  });

  test('an oversized stored description is clipped to the same cap as browser text', () => {
    const match = monitoredJobDescriptionMatch(
      BREEZY_POSTING_URL,
      breezyJob({ description: `${BREEZY_DESCRIPTION}\n${'x'.repeat(MAX_JD_TEXT_CHARS + 5000)}` }),
    );
    assert.ok(match);
    assert.equal(match.jdText.length, MAX_JD_TEXT_CHARS);
  });

  test('a Lever overview URL matches a row whose stored apply_url is the /apply form', () => {
    const match = monitoredJobDescriptionMatch('https://jobs.lever.co/acme/10746b3d-1760-4573-9b63-b93f5a5e4fc0', {
      external_id: '10746b3d-1760-4573-9b63-b93f5a5e4fc0',
      apply_url: 'https://jobs.lever.co/acme/10746b3d-1760-4573-9b63-b93f5a5e4fc0/apply',
      posting_url: 'https://jobs.lever.co/acme/10746b3d-1760-4573-9b63-b93f5a5e4fc0',
      title: 'Software Engineer Intern',
      description: BREEZY_DESCRIPTION,
      ats_name: 'lever',
      board_token: 'acme',
    });
    assert.ok(match);
    assert.equal(match.pageTitle, 'Software Engineer Intern');
  });

  test('a Greenhouse board URL matches a row stored under the native board host', () => {
    const match = monitoredJobDescriptionMatch('https://job-boards.greenhouse.io/acme/jobs/4012345', {
      external_id: '4012345',
      apply_url: 'https://boards.greenhouse.io/acme/jobs/4012345',
      posting_url: 'https://boards.greenhouse.io/acme/jobs/4012345',
      title: 'Data Engineer',
      description: BREEZY_DESCRIPTION,
      ats_name: 'greenhouse',
      board_token: 'acme',
    });
    assert.ok(match);
  });
});

describe('findMonitoredJobDescription', () => {
  function mockInventory(rows: unknown[]) {
    return mock.method(db, 'select', (() => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => rows,
            }),
          }),
        }),
      }),
    })) as unknown as typeof db.select);
  }

  test('returns the first canonically matching candidate with its row id', async () => {
    const select = mockInventory([
      // Nominated by URL equality but canonically a different posting: must be skipped, not served.
      { id: 'aaaaaaaa-1111-4111-8111-111111111111', ...breezyJob({ external_id: 'somethingelse' }) },
      { id: 'bbbbbbbb-2222-4222-8222-222222222222', ...breezyJob() },
    ]);
    try {
      const found = await findMonitoredJobDescription(BREEZY_POSTING_URL);
      assert.ok(found);
      assert.equal(found.jobId, 'bbbbbbbb-2222-4222-8222-222222222222');
      assert.equal(found.jdText, BREEZY_DESCRIPTION);
      assert.equal(found.pageTitle, 'Field Project Manager');
    } finally {
      select.mock.restore();
    }
  });

  test('returns undefined when the inventory holds no candidate for the URL', async () => {
    const select = mockInventory([]);
    try {
      assert.equal(await findMonitoredJobDescription(BREEZY_POSTING_URL), undefined);
    } finally {
      select.mock.restore();
    }
  });

  test('returns undefined when every nominated candidate fails the canonical bar', async () => {
    const select = mockInventory([
      { id: 'cccccccc-3333-4333-8333-333333333333', ...breezyJob({ ats_name: 'jobvite' }) },
    ]);
    try {
      assert.equal(await findMonitoredJobDescription(BREEZY_POSTING_URL), undefined);
    } finally {
      select.mock.restore();
    }
  });
});

describe('jobDescriptionSourceUrl on the boards whose form lives on its own route', () => {
  test('reads a Crelate application link from its posting page', () => {
    assert.equal(
      jobDescriptionSourceUrl('https://jobs.crelate.com/portal/themavengroup/job/apply/wtmao1bfqg9te5b5jo5jknskxo'),
      'https://jobs.crelate.com/portal/themavengroup/job/wtmao1bfqg9te5b5jo5jknskxo',
    );
  });

  test('reads a Recruitee application link from its offer page', () => {
    assert.equal(
      jobDescriptionSourceUrl('https://dsiinnovations.recruitee.com/o/junior-automation-engineer/c/new?utm_source=x'),
      'https://dsiinnovations.recruitee.com/o/junior-automation-engineer',
    );
  });

  test('reads Teamtailor and Pinpoint application links from their postings', () => {
    assert.equal(
      jobDescriptionSourceUrl('https://tixtrack.teamtailor.com/jobs/8287889-sr-software-engineer-ii-remote-us/applications/new'),
      'https://tixtrack.teamtailor.com/jobs/8287889-sr-software-engineer-ii-remote-us',
    );
    assert.equal(
      jobDescriptionSourceUrl('https://aplayers.na.teamtailor.com/jobs/690836-senior-software-engineer-frontend/applications/new/'),
      'https://aplayers.na.teamtailor.com/jobs/690836-senior-software-engineer-frontend',
    );
    assert.equal(
      jobDescriptionSourceUrl('https://coforma.pinpointhq.com/en/postings/4a295089-e9c6-4adf-8e7b-be9d2e8ba3c3/applications/new'),
      'https://coforma.pinpointhq.com/en/postings/4a295089-e9c6-4adf-8e7b-be9d2e8ba3c3',
    );
  });

  test('reads a Breezy application link from its posting', () => {
    assert.equal(
      jobDescriptionSourceUrl('https://alertalarm.breezy.hr/p/f6d5662ca263-alert-alarm-field-project-manager/apply#form'),
      'https://alertalarm.breezy.hr/p/f6d5662ca263-alert-alarm-field-project-manager',
    );
  });

  test('leaves the posting pages of those boards alone, and a stray path on those hosts untouched', () => {
    for (const posting of [
      'https://jobs.crelate.com/portal/themavengroup/job/wtmao1bfqg9te5b5jo5jknskxo',
      'https://dsiinnovations.recruitee.com/o/junior-automation-engineer',
      'https://tixtrack.teamtailor.com/jobs/8287889-sr-software-engineer-ii-remote-us',
      'https://confluence.pinpointhq.com/postings/c7fe935e-f408-4892-a204-dfd7fd2f70d8',
      'https://alertalarm.breezy.hr/p/f6d5662ca263-alert-alarm-field-project-manager',
      'https://acme.recruitee.com/careers',
    ]) {
      assert.equal(jobDescriptionSourceUrl(posting), posting);
    }
  });

  test('the inventory lookup keys carry the posting page for an apply link on those boards', () => {
    const keys = monitoredInventoryLookupKeys('https://jobs.crelate.com/portal/themavengroup/job/apply/wtmao1bfqg9te5b5jo5jknskxo');
    assert.ok(keys.includes('https://jobs.crelate.com/portal/themavengroup/job/wtmao1bfqg9te5b5jo5jknskxo'));
  });
});

describe('monitoredJobDescriptionMatch carries the posting identity', () => {
  test('a matched inventory row answers with its company and title beside the text', () => {
    const job = {
      external_id: '12345',
      apply_url: 'https://boards.greenhouse.io/acme/jobs/12345',
      posting_url: 'https://boards.greenhouse.io/acme/jobs/12345',
      title: '  Software Engineer, Intern ',
      company_name: ' Acme ',
      description: 'Requirements: Python. You will build dependable services.',
      ats_name: 'greenhouse',
      board_token: 'acme',
    };
    const match = monitoredJobDescriptionMatch('https://boards.greenhouse.io/acme/jobs/12345', job);
    assert.ok(match);
    assert.equal(match.pageTitle, 'Software Engineer, Intern');
    assert.equal(match.companyName, 'Acme');
  });
});
