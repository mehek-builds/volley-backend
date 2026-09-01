import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchSourceJobBatch,
  normalizeAshbyJobs,
  normalizeGreenhouseJobs,
  normalizeLeverJobs,
  normalizeRecruiteeJobs,
  validatedBreezyPostingUrl,
} from './jobMonitor';

const DESCRIPTION = 'Build and operate reliable production systems with the product engineering team.';

function greenhouse(absoluteUrl: string) {
  return {
    jobs: [{ id: 101, title: 'Platform Engineer', absolute_url: absoluteUrl, content: DESCRIPTION }],
  };
}

function lever(overrides: Record<string, unknown> = {}) {
  return [{
    id: 'lever-job-1',
    text: 'Platform Engineer',
    hostedUrl: 'https://jobs.lever.co/acme/lever-job-1',
    descriptionPlain: DESCRIPTION,
    categories: {},
    ...overrides,
  }];
}

function ashby(overrides: Record<string, unknown> = {}) {
  return { jobs: [{
    id: 'ashby-job-1',
    title: 'Platform Engineer',
    jobUrl: 'https://jobs.ashbyhq.com/acme/ashby-job-1',
    descriptionPlain: DESCRIPTION,
    ...overrides,
  }] };
}

function recruitee(overrides: Record<string, unknown> = {}) {
  return { offers: [{
    id: 202,
    slug: 'platform-engineer',
    title: 'Platform Engineer',
    careers_url: 'https://acme.recruitee.com/o/platform-engineer',
    description: DESCRIPTION,
    ...overrides,
  }] };
}

test('strict provider normalization emits only canonical first-party action routes', () => {
  const [greenhouseJob] = normalizeGreenhouseJobs(
    greenhouse('https://job-boards.eu.greenhouse.io/acme/jobs/101/'),
    'acme',
  );
  assert.equal(greenhouseJob.posting_url, 'https://job-boards.eu.greenhouse.io/acme/jobs/101');
  assert.equal(greenhouseJob.apply_url, greenhouseJob.posting_url);

  const [leverJob] = normalizeLeverJobs(lever({
    hostedUrl: 'https://jobs.eu.lever.co/acme/lever-job-1/',
  }), 'acme');
  assert.equal(leverJob.posting_url, 'https://jobs.eu.lever.co/acme/lever-job-1');
  assert.equal(leverJob.apply_url, 'https://jobs.eu.lever.co/acme/lever-job-1/apply');

  const [ashbyJob] = normalizeAshbyJobs(ashby(), 'acme');
  assert.equal(ashbyJob.posting_url, 'https://jobs.ashbyhq.com/acme/ashby-job-1');
  assert.equal(ashbyJob.apply_url, 'https://jobs.ashbyhq.com/acme/ashby-job-1/application');

  const [recruiteeJob] = normalizeRecruiteeJobs(recruitee(), 'acme');
  assert.equal(recruiteeJob.posting_url, 'https://acme.recruitee.com/o/platform-engineer');
  assert.equal(recruiteeJob.apply_url, 'https://acme.recruitee.com/o/platform-engineer/c/new');
});

test('Greenhouse drops off-host, cross-tenant, cross-job, and unsupported action URLs', () => {
  for (const url of [
    'https://attacker.example/acme/jobs/101',
    'https://job-boards.greenhouse.io.evil.example/acme/jobs/101',
    'https://job-boards.greenhouse.io/other/jobs/101',
    'https://job-boards.greenhouse.io/acme/jobs/999',
    'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=101',
    'https://job-boards.greenhouse.io/acme/jobs/101?source=custom',
  ]) {
    assert.deepEqual(normalizeGreenhouseJobs(greenhouse(url), 'acme'), [], url);
  }
});

test('Greenhouse accepts its own gh_jid tracking suffix and canonicalizes it away', () => {
  /* 2026-08-30: Greenhouse began decorating every absolute_url with ?gh_jid=<job id>. Rejecting it
     zeroed the entire 2,239-posting SpaceX board on a poll that reported success. The suffix is
     accepted only when its value is exactly this job's own id, and the stored URL never keeps it. */
  const [job] = normalizeGreenhouseJobs(
    greenhouse('https://boards.greenhouse.io/acme/jobs/101?gh_jid=101'),
    'acme',
  );
  assert.equal(job.posting_url, 'https://boards.greenhouse.io/acme/jobs/101');
  assert.equal(job.apply_url, job.posting_url);

  for (const url of [
    'https://boards.greenhouse.io/acme/jobs/101?gh_jid=999',
    'https://boards.greenhouse.io/acme/jobs/101?gh_jid=101&utm_source=linkedin',
    'https://boards.greenhouse.io/acme/jobs/101?gh_jid=101&gh_jid=101',
    'https://boards.greenhouse.io/acme/jobs/101?gh_src=abc123',
    /* Truthy url.search whose searchParams iterate nothing - not the declared parameter. */
    'https://boards.greenhouse.io/acme/jobs/101?&&&',
  ]) {
    assert.deepEqual(normalizeGreenhouseJobs(greenhouse(url), 'acme'), [], url);
  }
});

test('the dispatcher lists Workable raw shortcodes even when every action URL is rejected', async () => {
  /* Workable was the one single-fetch provider deriving listed_external_ids from the normalized
     jobs, so a board whose URLs all failed validation read as an EMPTY board (listedCount 0) and
     bypassed the fully-rejected-fetch guard in pollSource. The raw shortcode list keeps the two
     facts separate: the board listed postings, and none of them survived. */
  const fetched = await fetchSourceJobBatch(
    { ats_name: 'workable', board_token: 'acme' },
    async () => new Response(JSON.stringify({
      name: 'Acme',
      jobs: [
        { shortcode: 'AB12CD', title: 'Platform Engineer', url: 'https://careers.acme.example/j/AB12CD' },
        { shortcode: 'AB12CD', title: 'Platform Engineer', url: 'https://careers.acme.example/j/AB12CD' },
        { shortcode: 'EF34GH', title: 'Data Engineer', url: 'https://careers.acme.example/j/EF34GH' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  assert.deepEqual(fetched.listed_external_ids, ['AB12CD', 'EF34GH']);
  assert.deepEqual(fetched.jobs, []);
  assert.deepEqual(fetched.preserve_external_ids, []);
});

test('Lever binds both posting and apply URLs to one host, tenant, and external ID', () => {
  const cases = [
    { hostedUrl: 'https://attacker.example/acme/lever-job-1' },
    { hostedUrl: 'https://jobs.lever.co/other/lever-job-1' },
    { hostedUrl: 'https://jobs.lever.co/acme/other-job' },
    { hostedUrl: 'https://jobs.lever.co/acme/jobs/lever-job-1' },
    /* No allowedQuery is declared for Lever, so even a self-referential suffix stays rejected. */
    { hostedUrl: 'https://jobs.lever.co/acme/lever-job-1?gh_jid=lever-job-1' },
    { applyUrl: 'https://jobs.eu.lever.co/acme/lever-job-1/apply' },
    { applyUrl: 'https://jobs.lever.co/other/lever-job-1/apply' },
    { applyUrl: 'https://jobs.lever.co/acme/other-job/apply' },
    { applyUrl: 'https://jobs.lever.co/acme/lever-job-1/custom-apply' },
  ];
  for (const invalid of cases) {
    assert.deepEqual(normalizeLeverJobs(lever(invalid), 'acme'), [], JSON.stringify(invalid));
  }
});

test('Ashby binds both posting and application URLs to one tenant and external ID', () => {
  const cases = [
    { jobUrl: 'https://attacker.example/acme/ashby-job-1' },
    { jobUrl: 'https://jobs.ashbyhq.com/other/ashby-job-1' },
    { jobUrl: 'https://jobs.ashbyhq.com/acme/other-job' },
    { jobUrl: 'https://jobs.ashbyhq.com/acme/jobs/ashby-job-1' },
    { applyUrl: 'https://jobs.ashbyhq.com/other/ashby-job-1/application' },
    { applyUrl: 'https://jobs.ashbyhq.com/acme/other-job/application' },
    { applyUrl: 'https://jobs.ashbyhq.com/acme/ashby-job-1/apply' },
  ];
  for (const invalid of cases) {
    assert.deepEqual(normalizeAshbyJobs(ashby(invalid), 'acme'), [], JSON.stringify(invalid));
  }
});

test('Recruitee requires its documented slug and exact tenant-owned offer routes', () => {
  const cases = [
    { careers_url: 'https://attacker.example/o/platform-engineer' },
    { careers_url: 'https://other.recruitee.com/o/platform-engineer' },
    { careers_url: 'https://acme.recruitee.com/o/other-role' },
    { careers_url: 'https://acme.recruitee.com/jobs/platform-engineer' },
    { careers_apply_url: 'https://other.recruitee.com/o/platform-engineer/c/new' },
    { careers_apply_url: 'https://acme.recruitee.com/o/other-role/c/new' },
    { careers_apply_url: 'https://acme.recruitee.com/o/platform-engineer/apply' },
    { slug: undefined },
    { slug: 'platform_engineer' },
  ];
  for (const invalid of cases) {
    assert.deepEqual(normalizeRecruiteeJobs(recruitee(invalid), 'acme'), [], JSON.stringify(invalid));
  }
});

test('Breezy accepts only the exact posting or one slug segment for the verified list id', () => {
  assert.equal(
    validatedBreezyPostingUrl('https://acme.breezy.hr/p/job-1-platform-engineer', 'acme', 'job-1'),
    'https://acme.breezy.hr/p/job-1-platform-engineer',
  );
  for (const invalid of [
    'https://acme.breezy.hr/p/job-1/apply',
    'https://acme.breezy.hr/p/job-1/anything',
    'https://acme.breezy.hr/p/job-1-platform-engineer/apply',
    'https://acme.breezy.hr/p/job-1-platform-engineer/anything',
  ]) {
    assert.equal(validatedBreezyPostingUrl(invalid, 'acme', 'job-1'), null, invalid);
  }
});

test('the source-aware dispatcher keeps invalid action IDs in the raw list but never in jobs', async () => {
  const fetched = await fetchSourceJobBatch(
    { ats_name: 'greenhouse', board_token: 'acme' },
    async () => new Response(JSON.stringify(greenhouse('https://attacker.example/acme/jobs/101')), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  assert.deepEqual(fetched.listed_external_ids, ['101']);
  assert.deepEqual(fetched.jobs, []);
  assert.deepEqual(fetched.preserve_external_ids, []);
});
