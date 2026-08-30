import assert from 'node:assert/strict';
import test from 'node:test';
import { readPostingSponsorship } from './sponsorship';
import { fetchSourceJobBatch, fetchSourceJobs, sourceEndpoint } from './jobMonitor';

const JOB_CODE = 'fy9xmctquz688dahdmafcmch7r';
const BROKEN_JOB_CODE = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';

function requestEnvelope(rawUrl: string): Record<string, unknown> {
  const encoded = new URL(rawUrl).searchParams.get('requestEnvelope');
  assert.ok(encoded, `requestEnvelope absent from ${rawUrl}`);
  return JSON.parse(encoded) as Record<string, unknown>;
}

test('Crelate source endpoint base64-encodes the slug on the first-party metadata route', () => {
  assert.equal(
    sourceEndpoint({ ats_name: 'crelate', board_token: 'Canon%2DRecruiting' }),
    'https://jobs.crelate.com/api/candidateportal/getclientvars?onv=Y2Fub24tcmVjcnVpdGluZw%3D%3D',
  );
});

test('Crelate fetches full first-party details and preserves country-aware sponsorship evidence', async () => {
  const requests: Array<{ url: string; method?: string }> = [];
  const fullDescription = [
    '<p><strong>Platform Engineer</strong></p>',
    '<p>This is a full-time remote role building reliable services for customers across Europe.</p>',
    '<p>Visa sponsorship is available for this role in Germany&mdash;this role&rsquo;s policy is explicit.</p>',
    `<p>${'You will design, ship, measure, and improve production systems with the engineering team. '.repeat(4)}</p>`,
  ].join('');

  const fetched = await fetchSourceJobBatch(
    { ats_name: 'crelate', board_token: 'canonrecruiting' },
    async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method });
      if (url.includes('/getclientvars?')) {
        return new Response(JSON.stringify({
          ORG_ID: 'fe1806f8-4ed1-439b-c664-18a941d2da08',
          ORG_NAME: 'canonrecruiting',
          ORG_DISPLAY_NAME: 'Canon Recruiting Group',
          BASE_URL: 'jobs.crelate.com',
          PORTAL_VERSION: '',
        }), { status: 200 });
      }
      if (url.includes('/GetAllJobs?')) {
        assert.deepEqual(requestEnvelope(url), {
          OrganizationId: 'fe1806f8-4ed1-439b-c664-18a941d2da08',
          Locations: null,
          SearchText: null,
          Tags: null,
        });
        return new Response(JSON.stringify({
          Jobs: [{
            Id: 'job-id-1',
            JobCode: JOB_CODE,
            Title: 'Platform Engineer',
            Description: 'This list description is deliberately truncated...',
            City: 'Berlin',
            Country: 'Germany',
            CompanyName: 'Canon Recruiting Group',
          }, {
            Id: 'job-id-2',
            JobCode: BROKEN_JOB_CODE,
            Title: 'Broken Detail',
          }, {
            Id: 'ignored',
            JobCode: 'not-a-public-job-code',
            Title: 'Invalid code',
          }],
          IsError: false,
          ErrorMessage: null,
        }), { status: 200 });
      }
      const envelope = requestEnvelope(url);
      if (envelope.JobCode === BROKEN_JOB_CODE) return new Response('unavailable', { status: 503 });
      assert.equal(envelope.JobCode, JOB_CODE);
      return new Response(JSON.stringify({
        Job: {
          Id: 'job-id-1',
          JobCode: JOB_CODE,
          Title: 'Platform Engineer',
          Description: fullDescription,
          City: 'Berlin',
          State: 'Berlin',
          Country: 'Germany',
          LastPostedOnDate: '2026-08-27T20:10:54.49Z',
          Tags: [{ Name: 'Engineering' }, { Name: 'Platform' }],
          CompanyName: 'Canon Recruiting Group',
        },
        IsError: false,
      }), { status: 200 });
    },
  );

  const jobs = fetched.jobs;
  assert.equal(jobs.length, 1, 'a failed detail is excluded without suppressing the healthy role');
  const [job] = jobs;
  assert.equal(job.external_id, JOB_CODE);
  assert.equal(job.title, 'Platform Engineer');
  assert.equal(job.location, 'Berlin, Berlin, Germany');
  assert.equal(job.portal_country, 'Germany');
  assert.equal(job.portal_company_name, 'Canon Recruiting Group');
  assert.equal(job.department, 'Engineering, Platform');
  assert.equal(job.employment_type, undefined, 'Crelate publishes no structured type, so full-time prose is not guessed');
  assert.equal(job.remote, true);
  assert.equal(job.posting_url, `https://jobs.crelate.com/portal/canonrecruiting/job/${JOB_CODE}`);
  assert.equal(job.apply_url, `https://jobs.crelate.com/portal/canonrecruiting/job/apply/${JOB_CODE}`);
  assert.match(job.description, /Visa sponsorship is available for this role in Germany/);
  assert.doesNotMatch(job.description, /deliberately truncated/);
  assert.doesNotMatch(job.description, /&(mdash|rsquo);/, 'Crelate named entities are decoded into readable text');
  assert.match(job.description, /Germany\u2014this role\u2019s policy is explicit/);
  assert.equal(readPostingSponsorship(job.description), 'offers');
  assert.equal(job.posted_at?.toISOString(), '2026-08-27T20:10:54.490Z');
  assert.equal(requests.length, 4, 'metadata, list, and one detail request per valid job code');
  assert.ok(requests.every((request) => request.method === undefined), 'the poller only performs reads');
});

test('Crelate resumes its detail pass strictly after the prior JobCode', async () => {
  const jobCodes = ['a'.repeat(26), 'b'.repeat(26), 'c'.repeat(26)];
  const detailRequests: string[] = [];
  const fetched = await fetchSourceJobBatch(
    { ats_name: 'crelate', board_token: 'canonrecruiting' },
    async (input) => {
      const url = String(input);
      if (url.includes('/getclientvars?')) {
        return new Response(JSON.stringify({
          ORG_ID: 'org-id',
          ORG_NAME: 'canonrecruiting',
          BASE_URL: 'jobs.crelate.com',
        }), { status: 200 });
      }
      if (url.includes('/GetAllJobs?')) {
        return new Response(JSON.stringify({
          Jobs: [jobCodes[2], jobCodes[0], jobCodes[1]].map((JobCode) => ({ JobCode, Title: `Role ${JobCode[0]}` })),
          IsError: false,
        }), { status: 200 });
      }
      const jobCode = String(requestEnvelope(url).JobCode);
      detailRequests.push(jobCode);
      return new Response(JSON.stringify({
        Job: {
          JobCode: jobCode,
          Title: `Role ${jobCode[0]}`,
          Description: 'Build and operate reliable production services with the engineering team.',
        },
        IsError: false,
      }), { status: 200 });
    },
    { detail_fetch_limit: 1, detail_cursor_key: jobCodes[0] },
  );

  assert.deepEqual(detailRequests, [jobCodes[1]]);
  assert.deepEqual(fetched.jobs.map((job) => job.external_id), [jobCodes[1]]);
  assert.deepEqual(fetched.listed_external_ids, jobCodes);
  assert.equal(fetched.detail_progress?.cursor_key, jobCodes[0]);
  assert.equal(fetched.detail_progress?.next_cursor_key, jobCodes[1]);
});

test('Crelate rejects malformed list payloads instead of treating them as an empty board', async () => {
  await assert.rejects(
    fetchSourceJobs(
      { ats_name: 'crelate', board_token: 'canonrecruiting' },
      async (input) => String(input).includes('/getclientvars?')
        ? new Response(JSON.stringify({
          ORG_ID: 'org-id',
          ORG_NAME: 'canonrecruiting',
          BASE_URL: 'jobs.crelate.com',
        }), { status: 200 })
        : new Response(JSON.stringify({ IsError: false, Results: [] }), { status: 200 }),
    ),
    /invalid jobs payload/,
  );
});

test('Crelate accepts an explicit empty current-jobs collection', async () => {
  const fetched = await fetchSourceJobBatch(
    { ats_name: 'crelate', board_token: 'canonrecruiting' },
    async (input) => String(input).includes('/getclientvars?')
      ? new Response(JSON.stringify({
        ORG_ID: 'org-id',
        ORG_NAME: 'canonrecruiting',
        BASE_URL: 'jobs.crelate.com',
      }), { status: 200 })
      : new Response(JSON.stringify({ Jobs: [], IsError: false }), { status: 200 }),
  );
  assert.deepEqual(fetched.jobs, []);
});

test('Crelate fails closed on a custom host, versioned portal, or cross-job detail response', async () => {
  for (const vars of [{
    ORG_ID: 'org-id', ORG_NAME: 'canonrecruiting', BASE_URL: 'careers.example.com', PORTAL_VERSION: '',
  }, {
    ORG_ID: 'org-id', ORG_NAME: 'canonrecruiting', BASE_URL: 'jobs.crelate.com', PORTAL_VERSION: 'v2',
  }]) {
    await assert.rejects(
      fetchSourceJobs(
        { ats_name: 'crelate', board_token: 'canonrecruiting' },
        async () => new Response(JSON.stringify(vars), { status: 200 }),
      ),
      /unsupported portal route/,
    );
  }

  const fetched = await fetchSourceJobBatch(
    { ats_name: 'crelate', board_token: 'canonrecruiting' },
    async (input) => {
      const url = String(input);
      if (url.includes('/getclientvars?')) return new Response(JSON.stringify({
        ORG_ID: 'org-id', ORG_NAME: 'canonrecruiting', BASE_URL: 'jobs.crelate.com',
      }), { status: 200 });
      if (url.includes('/GetAllJobs?')) return new Response(JSON.stringify({
        Jobs: [{ JobCode: JOB_CODE, Title: 'Expected role' }], IsError: false,
      }), { status: 200 });
      return new Response(JSON.stringify({
        Job: { JobCode: BROKEN_JOB_CODE, Title: 'A different role', Description: 'Wrong job.' },
        IsError: false,
      }), { status: 200 });
    },
  );
  assert.deepEqual(fetched.jobs, [], 'a detail response for another JobCode is never attached to this role');
  assert.deepEqual(fetched.listed_external_ids, [JOB_CODE]);
  assert.deepEqual(fetched.preserve_external_ids, [JOB_CODE], 'the current list still protects its prior row');
});

test('Crelate metadata must resolve to the requested tenant', async () => {
  await assert.rejects(
    fetchSourceJobs(
      { ats_name: 'crelate', board_token: 'canonrecruiting' },
      async () => new Response(JSON.stringify({
        ORG_ID: 'org-id',
        ORG_NAME: 'anotherrecruiter',
        BASE_URL: 'jobs.crelate.com',
      }), { status: 200 }),
    ),
    /invalid organization metadata/,
  );
});
