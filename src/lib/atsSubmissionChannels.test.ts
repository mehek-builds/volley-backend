import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessAtsSubmissionChannel,
  ashbyPostingFromUrl,
  canonicalPublicPostingUrl,
  configuredAtsSubmissionChannels,
  genericKnownPosting,
  greenhousePostingFromUrl,
  leverPostingFromUrl,
  tryAtsSubmissionChannel,
} from './atsSubmissionChannels';
import type { SubmissionPacket } from './portalSubmission';

const basePacket = (): SubmissionPacket => ({
  fullName: 'Mehek Mandal',
  email: 'mehekmandal05@gmail.com',
  phone: '5551234567',
  city: 'Los Angeles',
  resume: Buffer.from('%PDF-1.4\nresume\n%%EOF\n'),
  resumeName: 'Mehek_Mandal_Software_Engineer_Resume.pdf',
  coverLetter: Buffer.from('%PDF-1.4\ncover\n%%EOF\n'),
  coverLetterName: 'Mehek_Mandal_Software_Engineer_Cover_Letter.pdf',
  questions: [],
});

test('parses Greenhouse board and job ids from supported job URLs', () => {
  assert.deepEqual(greenhousePostingFromUrl('https://boards.greenhouse.io/reddit/jobs/1234567'), {
    boardToken: 'reddit',
    jobId: '1234567',
  });
  assert.deepEqual(greenhousePostingFromUrl('https://job-boards.greenhouse.io/postman/jobs/7823417003'), {
    boardToken: 'postman',
    jobId: '7823417003',
  });
  assert.deepEqual(greenhousePostingFromUrl('https://job-boards.eu.greenhouse.io/imc/jobs/4829785101'), {
    boardToken: 'imc',
    jobId: '4829785101',
  });
  assert.deepEqual(greenhousePostingFromUrl('https://boards.greenhouse.io/embed/job_app?for=postman&token=7654321'), {
    boardToken: 'postman',
    jobId: '7654321',
  });
  assert.equal(greenhousePostingFromUrl('https://nuro.ai/careers?gh_jid=1234567'), null);
});

test('canonical public posting URLs preserve only validated provider identity fields', () => {
  assert.equal(
    canonicalPublicPostingUrl('https://boards.greenhouse.io/embed/job_app?for=postman&token=7654321&utm_source=secret'),
    'https://boards.greenhouse.io/postman/jobs/7654321',
  );
  const queryIdentityCases = [
    'https://acme.taleo.net/careersection/ext/jobdetail.ftl?job=456&utm_source=secret',
    'https://career5.successfactors.eu/career?company=acme&career_job_req_id=789&tracking=secret',
    'https://myjobs.adp.com/acme/cx/job-details/?reqId=12345&token=secret',
    'https://recruiting.ultipro.com/ACM1000/JobBoard/11111111-1111-1111-1111-111111111111/OpportunityDetail?opportunityId=22222222-2222-2222-2222-222222222222&session=secret',
    'https://www.indeed.com/viewjob?jk=abc123&utm_source=secret',
    'https://www.ziprecruiter.com/jobs/example?jid=33333333-3333-3333-3333-333333333333&token=secret',
  ];
  for (const raw of queryIdentityCases) {
    const canonical = canonicalPublicPostingUrl(raw);
    assert.ok(canonical);
    assert.deepEqual(genericKnownPosting(canonical), genericKnownPosting(raw));
    assert.equal(canonical.includes('secret'), false);
  }
  assert.equal(
    canonicalPublicPostingUrl('https://jobs.example.test/apply?token=secret#private'),
    'https://jobs.example.test/apply',
  );
  assert.equal(canonicalPublicPostingUrl('https://user:pass@jobs.example.test/apply'), null);
});

test('parses Ashby organization and posting id from job URLs', () => {
  assert.deepEqual(ashbyPostingFromUrl('https://jobs.ashbyhq.com/fluency/f4436720-0c9a-44b1-b175-787bc0f8fa39'), {
    organization: 'fluency',
    jobPostingId: 'f4436720-0c9a-44b1-b175-787bc0f8fa39',
  });
  assert.equal(ashbyPostingFromUrl('https://boards.greenhouse.io/fluency/jobs/123'), null);
});

test('parses Lever site and posting ids from supported job URLs', () => {
  assert.deepEqual(leverPostingFromUrl('https://jobs.lever.co/acme/abc-123'), {
    site: 'acme',
    postingId: 'abc-123',
  });
  assert.deepEqual(leverPostingFromUrl('https://jobs.eu.lever.co/acme/eu-123'), {
    site: 'acme',
    postingId: 'eu-123',
  });
  assert.equal(leverPostingFromUrl('https://jobs.example.com/acme/abc-123'), null);
});

test('known ATS identities keep listing and application routes equal while separating postings', () => {
  const cases = [
    {
      provider: 'workday',
      listing: 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Dubai/Product-Manager_JR123',
      application: 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Dubai/Product-Manager_JR123/apply',
      adjacent: 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Dubai/Product-Manager_JR124/apply',
      jobId: 'JR123',
    },
    {
      provider: 'icims',
      listing: 'https://jobs-express.icims.com/jobs/48173/sales-associate/job',
      application: 'https://jobs-express.icims.com/jobs/48173/sales-associate/login',
      adjacent: 'https://jobs-express.icims.com/jobs/48174/sales-associate/login',
      jobId: '48173',
    },
    {
      provider: 'jobvite',
      listing: 'https://jobs.jobvite.com/worldfirst/job/oknrAfws',
      application: 'https://jobs.jobvite.com/worldfirst/job/oknrAfws/apply',
      adjacent: 'https://jobs.jobvite.com/worldfirst/job/oknrAfwt/apply',
      jobId: 'oknrAfws',
    },
    {
      provider: 'recruitee',
      listing: 'https://rebuy.recruitee.com/o/acquisition-manager-paid-search-pla-focused-mfx',
      application: 'https://rebuy.recruitee.com/o/acquisition-manager-paid-search-pla-focused-mfx/c/new',
      adjacent: 'https://rebuy.recruitee.com/o/senior-acquisition-manager/c/new',
      jobId: 'acquisition-manager-paid-search-pla-focused-mfx',
    },
    {
      provider: 'teamtailor',
      listing: 'https://career.teamtailor.com/jobs/8124573-group-financial-controller',
      application: 'https://career.teamtailor.com/jobs/8124573-group-financial-controller/applications/new',
      adjacent: 'https://career.teamtailor.com/jobs/8124574-group-financial-controller/applications/new',
      jobId: '8124573',
    },
    {
      provider: 'pinpoint',
      listing: 'https://discogsinc.pinpointhq.com/en/postings/5bccb603-bbe0-4e1f-8f92-d983f78f77a7',
      application: 'https://discogsinc.pinpointhq.com/en/postings/5bccb603-bbe0-4e1f-8f92-d983f78f77a7/applications/new',
      adjacent: 'https://discogsinc.pinpointhq.com/en/postings/6bccb603-bbe0-4e1f-8f92-d983f78f77a7/applications/new',
      jobId: '5bccb603-bbe0-4e1f-8f92-d983f78f77a7',
    },
    {
      provider: 'jazzhr',
      listing: 'https://utilidata.applytojob.com/apply/jobs/details/VSeisrJblO',
      application: 'https://utilidata.applytojob.com/apply/VSeisrJblO/software-engineer',
      adjacent: 'https://utilidata.applytojob.com/apply/ZBfHaf2Nv9/software-engineer',
      jobId: 'VSeisrJblO',
    },
    {
      provider: 'paylocity',
      listing: 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/123456/Product-Manager',
      application: 'https://recruiting.paylocity.com/Recruiting/Jobs/Apply/123456/Product-Manager',
      adjacent: 'https://recruiting.paylocity.com/Recruiting/Jobs/Apply/123457/Product-Manager',
      jobId: '123456',
    },
    {
      provider: 'sap_successfactors',
      listing: 'https://career5.successfactors.eu/career?career_job_req_id=123456&company=acme',
      application: 'https://career5.successfactors.eu/sfcareer/jobreqcareer?jobId=123456&company=acme',
      adjacent: 'https://career5.successfactors.eu/sfcareer/jobreqcareer?jobId=123457&company=acme',
      jobId: '123456',
    },
    {
      provider: 'adp',
      listing: 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=ACME&jobId=123456',
      application: 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?jobId=123456&cid=ACME&source=apply',
      adjacent: 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=ACME&jobId=123457',
      jobId: '123456',
    },
    {
      provider: 'ukg',
      listing: 'https://recruiting.ultipro.com/ACM1000/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail?opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9',
      application: 'https://recruiting.ultipro.com/ACM1000/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail?source=apply&opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9',
      adjacent: 'https://recruiting.ultipro.com/ACM1000/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail?opportunityId=4fc30c2a-e2b3-42e0-bcaf-7805f741c04a',
      jobId: 'f6cd56f9-5b2f-4b53-9e86-2553b54524f9',
    },
    {
      provider: 'personio',
      listing: 'https://matrix42.jobs.personio.com/job/2663722',
      application: 'https://matrix42.jobs.personio.com/job/2663722/apply?language=en',
      adjacent: 'https://matrix42.jobs.personio.com/job/2663723/apply?language=en',
      jobId: '2663722',
    },
    {
      provider: 'comeet',
      listing: 'https://www.comeet.com/jobs/gett/A0.002/application-security-lead/46.A6A',
      application: 'https://www.comeet.co/jobs/A0.002/46.A6A/apply?token=public-token',
      adjacent: 'https://www.comeet.co/jobs/A0.002/47.A6A/apply?token=public-token',
      jobId: '46.A6A',
    },
  ] as const;

  for (const fixture of cases) {
    const listing = genericKnownPosting(fixture.listing);
    const application = genericKnownPosting(fixture.application);
    const adjacent = genericKnownPosting(fixture.adjacent);
    assert.equal(listing?.provider, fixture.provider, fixture.listing);
    assert.equal(listing?.jobId, fixture.jobId, fixture.listing);
    assert.deepEqual(application, listing, `${fixture.provider} application route must retain listing identity`);
    assert.equal(adjacent?.provider, fixture.provider, fixture.adjacent);
    assert.notEqual(adjacent?.jobId, listing?.jobId, `${fixture.provider} must separate adjacent postings`);
  }
});

test('known ATS identity parsing refuses unproven provider routes instead of keying control words', () => {
  const unproven = [
    'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Dubai/product-manager/apply',
    'https://jobs-express.icims.com/jobs/48173/sales-associate/apply',
    'https://jobs.jobvite.com/worldfirst/jobs',
    'https://rebuy.recruitee.com/o/product-manager/apply',
    'https://career.teamtailor.com/jobs/product-manager/applications/new',
    'https://discogsinc.pinpointhq.com/postings/abc123/applications/new',
    'https://utilidata.applytojob.com/apply/jobs',
    'https://recruiting.paylocity.com/Recruiting/Jobs/New/123456',
    'https://career5.successfactors.eu/sfcareer/jobreqcareer?jobId=123456',
    'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?jobId=123456',
    'https://recruiting.ultipro.com/ACM1000/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail',
    'https://matrix42.jobs.personio.com/job/new/apply',
    'https://www.comeet.com/jobs/gett/A0.002/application-security-lead/apply',
  ];
  for (const url of unproven) assert.equal(genericKnownPosting(url), null, url);
});

test('channel config resolves only allowlisted employers with referenced secrets', () => {
  const env = {
    LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON: JSON.stringify([
      { ats: 'greenhouse', board_token: 'reddit', api_key_env: 'GH_REDDIT_KEY' },
      { ats: 'ashby', organization: 'fluency', api_key_env: 'ASHBY_FLUENCY_KEY' },
      { ats: 'lever', site: 'acme', api_key_env: 'LEVER_ACME_KEY' },
      { ats: 'greenhouse', board_token: 'missing', api_key_env: 'MISSING_KEY' },
      { ats: 'lever', board_token: 'ignored', api_key_env: 'IGNORED_KEY' },
    ]),
    GH_REDDIT_KEY: 'gh-secret',
    ASHBY_FLUENCY_KEY: 'ashby-secret',
    LEVER_ACME_KEY: 'lever-secret',
  };
  const channels = configuredAtsSubmissionChannels(env);
  assert.equal(channels.length, 3);
  assert.deepEqual(channels.map((item) => [item.ats, item.boardToken ?? item.organization ?? item.site]), [
    ['greenhouse', 'reddit'],
    ['ashby', 'fluency'],
    ['lever', 'acme'],
  ]);
});

test('assesses submit-capable packets as unavailable when credentials are absent', () => {
  const greenhouse = assessAtsSubmissionChannel('https://boards.greenhouse.io/reddit/jobs/1234567', {});
  assert.equal(greenhouse?.provider, 'greenhouse');
  assert.equal(greenhouse?.status, 'unavailable');
  assert.match(greenhouse?.reason ?? '', /Missing employer-authorized Greenhouse/);

  const ashby = assessAtsSubmissionChannel('https://jobs.ashbyhq.com/fluency/f4436720-0c9a-44b1-b175-787bc0f8fa39', {});
  assert.equal(ashby?.provider, 'ashby');
  assert.equal(ashby?.status, 'unavailable');
  assert.match(ashby?.reason ?? '', /Missing employer-authorized Ashby/);

  const lever = assessAtsSubmissionChannel('https://jobs.lever.co/acme/abc-123', {});
  assert.equal(lever?.provider, 'lever');
  assert.equal(lever?.status, 'unavailable');
  assert.match(lever?.reason ?? '', /Missing employer-authorized Lever/);
});

test('recognizes the 30 common ATS and job-board families with explicit API availability diagnostics', () => {
  const samples = [
    ['greenhouse', 'https://job-boards.greenhouse.io/reddit/jobs/8070669'],
    ['ashby', 'https://jobs.ashbyhq.com/fluency/2aced4e2-485b-4525-802c-763e62c91e88'],
    ['lever', 'https://jobs.lever.co/acme/abc-123'],
    ['smartrecruiters', 'https://jobs.smartrecruiters.com/acme/743999999999999-engineer'],
    ['workable', 'https://apply.workable.com/acme/j/ABC123DEF0/apply'],
    ['workday', 'https://acme.wd1.myworkdayjobs.com/External/job/Seattle/Engineer_JR123'],
    ['icims', 'https://careers-acme.icims.com/jobs/1234/engineer/job'],
    ['bamboohr', 'https://acme.bamboohr.com/careers/123'],
    ['jazzhr', 'https://acme.applytojob.com/apply/VSeisrJblO/Engineer'],
    ['paylocity', 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/123'],
    ['rippling', 'https://jobs.rippling.com/acme/jobs/abc123'],
    ['breezy', 'https://jobs.breezy.hr/acme/jobs/abc123'],
    ['oracle_taleo', 'https://acme.taleo.net/careersection/ex/jobdetail.ftl?job=123'],
    ['sap_successfactors', 'https://acme.jobs2web.com/successfactors/job/Engineer/123'],
    ['adp', 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=ACME&jobId=123'],
    ['ukg', 'https://recruiting.ultipro.com/ACM1000/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail?opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9'],
    ['jobvite', 'https://jobs.jobvite.com/acme/job/abc123'],
    ['dayforce', 'https://acme.dayforcehcm.com/CandidatePortal/en-US/acme/Posting/View/123'],
    ['recruitee', 'https://acme.recruitee.com/o/engineer'],
    ['teamtailor', 'https://acme.teamtailor.com/jobs/123-engineer'],
    ['personio', 'https://acme.jobs.personio.com/job/123'],
    ['pinpoint', 'https://acme.pinpointhq.com/postings/5bccb603-bbe0-4e1f-8f92-d983f78f77a7'],
    ['comeet', 'https://www.comeet.co/jobs/A0.002/46.A6A/apply?token=public-token'],
    ['zoho_recruit', 'https://acme.zohorecruit.com/jobs/Careers/123/Engineer'],
    ['bullhorn', 'https://acme.bullhornstaffing.com/job/123'],
    ['indeed', 'https://www.indeed.com/viewjob?jk=abc123'],
    ['linkedin', 'https://www.linkedin.com/jobs/view/1234567890'],
    ['ziprecruiter', 'https://www.ziprecruiter.com/jobs/acme-123-engineer?jid=4a4dc523-53be-4c14-9b89-8ac0e14ab030'],
    ['wellfound', 'https://wellfound.com/jobs/123-engineer'],
    ['handshake', 'https://app.joinhandshake.com/stu/jobs/123'],
  ] as const;

  for (const [provider, url] of samples) {
    const assessment = assessAtsSubmissionChannel(url, {});
    assert.equal(assessment?.provider, provider, url);
    assert.equal(assessment?.status, 'unavailable', url);
    assert.ok(assessment?.reason, url);
    assert.ok(assessment?.job_id, url);
  }
});

test('unknown URLs do not pretend to be Greenhouse', async () => {
  const result = await tryAtsSubmissionChannel('https://careers.example.com/jobs/123', basePacket(), {});
  assert.equal(result.kind, 'not_applicable');
  assert.equal(result.assessment.provider, 'unknown');
  assert.equal(result.assessment.status, 'unavailable');
});

test('configured channel refuses reviewed questions without durable ATS field mappings', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    questions: [
      { label: 'A different question', fields: [{ name: 'question_999' }] },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await tryAtsSubmissionChannel(
    'https://boards.greenhouse.io/reddit/jobs/1234567',
    {
      ...basePacket(),
      questions: [{ question: 'Why Reddit?', answer: 'Because the role fits.' }],
    },
    {
      env: {
        LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON: JSON.stringify([
          { ats: 'greenhouse', board_token: 'reddit', api_key_env: 'GH_REDDIT_KEY' },
        ]),
        GH_REDDIT_KEY: 'secret',
      },
      fetchImpl,
    },
  );
  assert.equal(result.kind, 'not_applicable');
  assert.equal(result.assessment.status, 'unavailable');
  assert.deepEqual(result.assessment.missing_fields, ['Why Reddit?']);
});

test('configured Ashby channel requires employer application form paths before posting', async () => {
  const result = await tryAtsSubmissionChannel(
    'https://jobs.ashbyhq.com/fluency/f4436720-0c9a-44b1-b175-787bc0f8fa39',
    basePacket(),
    {
      env: {
        LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON: JSON.stringify([
          { ats: 'ashby', organization: 'fluency', api_key_env: 'ASHBY_FLUENCY_KEY' },
        ]),
        ASHBY_FLUENCY_KEY: 'secret',
      },
    },
  );
  assert.equal(result.kind, 'not_applicable');
  assert.equal(result.assessment.status, 'unavailable');
  assert.deepEqual(result.assessment.missing_fields, ['name', 'email', 'resume']);
});

test('configured Greenhouse channel posts multipart application with auth and attachments', async () => {
  let requestUrl = '';
  let auth = '';
  let body: unknown;
  const fetchImpl: typeof fetch = async (url, init) => {
    requestUrl = String(url);
    auth = String(new Headers(init?.headers).get('authorization'));
    body = init?.body;
    return new Response('created', { status: 201, headers: { 'x-request-id': 'req-1' } });
  };
  const result = await tryAtsSubmissionChannel('https://boards.greenhouse.io/reddit/jobs/1234567', basePacket(), {
    env: {
      LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON: JSON.stringify([
        { ats: 'greenhouse', board_token: 'reddit', api_key_env: 'GH_REDDIT_KEY' },
      ]),
      GH_REDDIT_KEY: 'secret',
    },
    fetchImpl,
  });
  assert.equal(result.kind, 'submitted');
  assert.equal(requestUrl, 'https://boards-api.greenhouse.io/v1/boards/reddit/jobs/1234567');
  assert.equal(auth, `Basic ${Buffer.from('secret:').toString('base64')}`);
  assert.ok(body instanceof FormData);
  assert.equal(body.get('first_name'), 'Mehek');
  assert.equal(body.get('last_name'), 'Mandal');
  assert.equal((body.get('resume') as File).name, 'Mehek_Mandal_Software_Engineer_Resume.pdf');
  assert.equal((body.get('cover_letter') as File).name, 'Mehek_Mandal_Software_Engineer_Cover_Letter.pdf');
});

test('configured Greenhouse channel posts reviewed answers only when ATS field mappings exist', async () => {
  let body: FormData | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    body = init?.body as FormData;
    return new Response('created', { status: 201 });
  };
  const result = await tryAtsSubmissionChannel(
    'https://boards.greenhouse.io/reddit/jobs/1234567',
    {
      ...basePacket(),
      questions: [
        {
          question: 'Are you legally authorized to work in the United States?',
          answer: 'Yes',
          atsApiField: 'job_application[answers_attributes][0][boolean_value]',
        },
        {
          question: 'Optional blank answer',
          answer: '',
          atsApiField: 'job_application[answers_attributes][1][text_value]',
        },
      ],
    },
    {
      env: {
        LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON: JSON.stringify([
          { ats: 'greenhouse', board_token: 'reddit', api_key_env: 'GH_REDDIT_KEY' },
        ]),
        GH_REDDIT_KEY: 'secret',
      },
      fetchImpl,
    },
  );
  assert.equal(result.kind, 'submitted');
  assert.equal(body?.get('job_application[answers_attributes][0][boolean_value]'), 'Yes');
  assert.equal(body?.has('job_application[answers_attributes][1][text_value]'), false);
});

test('configured Greenhouse channel maps reviewed answers from public Job Board API questions', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let body: FormData | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (String(url).includes('questions=true')) {
      return new Response(JSON.stringify({
        questions: [
          { label: 'First Name', fields: [{ name: 'first_name', type: 'input_text' }] },
          { label: 'Last Name', fields: [{ name: 'last_name', type: 'input_text' }] },
          { label: 'Email', fields: [{ name: 'email', type: 'input_text' }] },
          { label: 'Resume/CV', fields: [{ name: 'resume', type: 'input_file' }] },
          {
            label: 'Are you currently eligible to legally work in the United States?\n',
            fields: [{ name: 'question_31609742003' }],
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    body = init?.body as FormData;
    return new Response('created', { status: 201, headers: { 'x-request-id': 'req-public-fields' } });
  };
  const result = await tryAtsSubmissionChannel(
    'https://job-boards.greenhouse.io/postman/jobs/7823417003',
    {
      ...basePacket(),
      questions: [
        {
          question: 'Are you currently eligible to legally work in the United States?',
          answer: 'Yes',
        },
      ],
    },
    {
      env: {
        LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON: JSON.stringify([
          { ats: 'greenhouse', board_token: 'postman', api_key_env: 'GH_POSTMAN_KEY' },
        ]),
        GH_POSTMAN_KEY: 'secret',
      },
      fetchImpl,
    },
  );
  assert.equal(result.kind, 'submitted');
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ['GET', 'https://boards-api.greenhouse.io/v1/boards/postman/jobs/7823417003?questions=true'],
    ['POST', 'https://boards-api.greenhouse.io/v1/boards/postman/jobs/7823417003'],
  ]);
  assert.equal(body?.get('question_31609742003'), 'Yes');
});

test('configured Lever channel posts multipart application with query key', async () => {
  let requestUrl = '';
  let body: FormData | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    requestUrl = String(url);
    body = init?.body as FormData;
    return new Response('created', { status: 201, headers: { 'x-request-id': 'lever-req-1' } });
  };
  const result = await tryAtsSubmissionChannel('https://jobs.lever.co/acme/abc-123', basePacket(), {
    env: {
      LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON: JSON.stringify([
        { ats: 'lever', site: 'acme', api_key_env: 'LEVER_ACME_KEY' },
      ]),
      LEVER_ACME_KEY: 'lever-secret',
    },
    fetchImpl,
  });
  assert.equal(result.kind, 'submitted');
  assert.equal(result.referenceId, 'lever-req-1');
  assert.equal(requestUrl, 'https://api.lever.co/v0/postings/acme/abc-123?key=lever-secret');
  assert.equal(body?.get('name'), 'Mehek Mandal');
  assert.equal(body?.get('email'), 'mehekmandal05@gmail.com');
  assert.equal((body?.get('resume') as File).name, 'Mehek_Mandal_Software_Engineer_Resume.pdf');
});

test('configured Ashby channel posts core paths and reviewed question mappings', async () => {
  let requestUrl = '';
  let auth = '';
  let body: FormData | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    requestUrl = String(url);
    auth = String(new Headers(init?.headers).get('authorization'));
    body = init?.body as FormData;
    return new Response('', { status: 200, headers: { 'x-request-id': 'ashby-req-1' } });
  };
  const result = await tryAtsSubmissionChannel(
    'https://jobs.ashbyhq.com/fluency/f4436720-0c9a-44b1-b175-787bc0f8fa39',
    {
      ...basePacket(),
      questions: [
        {
          question: 'Why Fluency?',
          answer: 'The role matches my product engineering work.',
          atsApiField: 'answers.whyFluency',
        },
      ],
    },
    {
      env: {
        LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON: JSON.stringify([
          {
            ats: 'ashby',
            organization: 'fluency',
            api_key_env: 'ASHBY_FLUENCY_KEY',
            field_paths: {
              name: 'person.name',
              email: 'person.email',
              phone: 'person.phone',
              resume: 'files.resume',
              cover_letter: 'files.coverLetter',
            },
          },
        ]),
        ASHBY_FLUENCY_KEY: 'ashby-secret',
      },
      fetchImpl,
    },
  );
  assert.equal(result.kind, 'submitted');
  assert.equal(result.referenceId, 'ashby-req-1');
  assert.equal(requestUrl, 'https://api.ashbyhq.com/applicationForm.submit');
  assert.equal(auth, `Basic ${Buffer.from('ashby-secret:').toString('base64')}`);
  assert.equal(body?.get('jobPostingId'), 'f4436720-0c9a-44b1-b175-787bc0f8fa39');
  assert.equal(body?.get('applicationForm[person.name]'), 'Mehek Mandal');
  assert.equal(body?.get('applicationForm[person.email]'), 'mehekmandal05@gmail.com');
  assert.equal(body?.get('applicationForm[person.phone]'), '5551234567');
  assert.equal((body?.get('applicationForm[files.resume]') as File).name, 'Mehek_Mandal_Software_Engineer_Resume.pdf');
  assert.equal((body?.get('applicationForm[files.coverLetter]') as File).name, 'Mehek_Mandal_Software_Engineer_Cover_Letter.pdf');
  assert.equal(body?.get('applicationForm[answers.whyFluency]'), 'The role matches my product engineering work.');
});

test('configured ATS submission channel accepts five distinct application packets end-to-end', async () => {
  const requests: Array<{ url: string; method: string; body: FormData; auth: string | null }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body as FormData,
      auth: new Headers(init?.headers).get('authorization'),
    });
    return new Response(`accepted-${requests.length}`, {
      status: 201,
      headers: { 'x-request-id': `ats-req-${requests.length}` },
    });
  };
  const env = {
    LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON: JSON.stringify([
      { ats: 'greenhouse', board_token: 'reddit', api_key_env: 'GH_REDDIT_KEY' },
      { ats: 'greenhouse', board_token: 'postman', api_key_env: 'GH_POSTMAN_KEY' },
      {
        ats: 'ashby',
        organization: 'fluency',
        api_key_env: 'ASHBY_FLUENCY_KEY',
        field_paths: {
          name: 'person.name',
          email: 'person.email',
          phone: 'person.phone',
          resume: 'files.resume',
          cover_letter: 'files.coverLetter',
        },
      },
      {
        ats: 'ashby',
        organization: 'deepgram',
        api_key_env: 'ASHBY_DEEPGRAM_KEY',
        field_paths: {
          name: 'candidate.name',
          email: 'candidate.email',
          resume: 'candidate.resume',
        },
      },
      { ats: 'lever', site: 'acme', api_key_env: 'LEVER_ACME_KEY' },
    ]),
    GH_REDDIT_KEY: 'reddit-secret',
    GH_POSTMAN_KEY: 'postman-secret',
    ASHBY_FLUENCY_KEY: 'fluency-secret',
    ASHBY_DEEPGRAM_KEY: 'deepgram-secret',
    LEVER_ACME_KEY: 'lever-secret',
  };
  const applications = [
    {
      url: 'https://boards.greenhouse.io/reddit/jobs/8070669',
      packet: { ...basePacket(), resumeName: 'Mehek_Mandal_Reddit_Resume.pdf' },
      expectedRequestUrl: 'https://boards-api.greenhouse.io/v1/boards/reddit/jobs/8070669',
      expectedResumeField: 'resume',
    },
    {
      url: 'https://job-boards.greenhouse.io/postman/jobs/7823417003',
      packet: { ...basePacket(), resumeName: 'Mehek_Mandal_Postman_Resume.pdf' },
      expectedRequestUrl: 'https://boards-api.greenhouse.io/v1/boards/postman/jobs/7823417003',
      expectedResumeField: 'resume',
    },
    {
      url: 'https://jobs.ashbyhq.com/fluency/2aced4e2-485b-4525-802c-763e62c91e88',
      packet: { ...basePacket(), resumeName: 'Mehek_Mandal_Fluency_Resume.pdf' },
      expectedRequestUrl: 'https://api.ashbyhq.com/applicationForm.submit',
      expectedResumeField: 'applicationForm[files.resume]',
    },
    {
      url: 'https://jobs.ashbyhq.com/deepgram/dc8693b5-72ce-4ca3-ab15-9c8434d35da1',
      packet: { ...basePacket(), resumeName: 'Mehek_Mandal_Deepgram_Resume.pdf', coverLetter: undefined, coverLetterName: undefined },
      expectedRequestUrl: 'https://api.ashbyhq.com/applicationForm.submit',
      expectedResumeField: 'applicationForm[candidate.resume]',
    },
    {
      url: 'https://jobs.lever.co/acme/abc-123',
      packet: { ...basePacket(), resumeName: 'Mehek_Mandal_Acme_Resume.pdf' },
      expectedRequestUrl: 'https://api.lever.co/v0/postings/acme/abc-123?key=lever-secret',
      expectedResumeField: 'resume',
    },
  ] as const;

  for (const application of applications) {
    const result = await tryAtsSubmissionChannel(application.url, application.packet, { env, fetchImpl });
    assert.equal(result.kind, 'submitted');
    assert.equal(result.referenceId, `ats-req-${requests.length}`);
    assert.equal(result.confirmationText, `accepted-${requests.length}`);
  }

  assert.equal(requests.length, 5);
  for (const [index, application] of applications.entries()) {
    const request = requests[index];
    assert.equal(request.method, 'POST');
    assert.equal(request.url, application.expectedRequestUrl);
    assert.ok(request.body instanceof FormData);
    assert.equal((request.body.get(application.expectedResumeField) as File).name, application.packet.resumeName);
  }
  assert.equal(requests[0].auth, `Basic ${Buffer.from('reddit-secret:').toString('base64')}`);
  assert.equal(requests[1].auth, `Basic ${Buffer.from('postman-secret:').toString('base64')}`);
  assert.equal(requests[2].auth, `Basic ${Buffer.from('fluency-secret:').toString('base64')}`);
  assert.equal(requests[3].auth, `Basic ${Buffer.from('deepgram-secret:').toString('base64')}`);
  assert.equal(requests[4].auth, null);
});

test('configured ATS channel surfaces API submission failures', async () => {
  const fetchImpl: typeof fetch = async () => new Response('invalid field', { status: 422 });
  await assert.rejects(
    tryAtsSubmissionChannel('https://boards.greenhouse.io/reddit/jobs/1234567', basePacket(), {
      env: {
        LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON: JSON.stringify([
          { ats: 'greenhouse', board_token: 'reddit', api_key_env: 'GH_REDDIT_KEY' },
        ]),
        GH_REDDIT_KEY: 'secret',
      },
      fetchImpl,
    }),
    /Greenhouse API submission failed with 422: invalid field/,
  );
});

/* THE GUESSED PART NAME, AND WHY IT IS TESTED AS A REFUSAL RATHER THAN AS A SPELLING.
 *
 * Greenhouse and Lever appended the transcript under the literal `'transcript'`. A multipart part an
 * API does not recognise is accepted at the HTTP level and dropped, so that submission returns 200,
 * files the application, and delivers no document - success everywhere a human or a log would look.
 * There is no assertion available that proves a part name is right; the only thing that can be
 * asserted is that this file never posts one nobody configured. Each pair below is the same channel
 * twice: once with no mapping, which must not reach the API at all, and once with one, which must
 * post under exactly that name and under no other.
 */
const transcriptPacket = (): SubmissionPacket => ({
  ...basePacket(),
  transcript: Buffer.from('%PDF-1.4\ntranscript\n%%EOF\n'),
  transcriptName: 'Mehek_Mandal_Software_Engineer_Transcript.pdf',
});

const GREENHOUSE_CHANNEL = { ats: 'greenhouse', board_token: 'reddit', api_key_env: 'GH_REDDIT_KEY' };
const ASHBY_PATHS = { name: 'person.name', email: 'person.email', resume: 'files.resume' };
const ASHBY_CHANNEL = { ats: 'ashby', organization: 'fluency', api_key_env: 'ASHBY_FLUENCY_KEY', field_paths: ASHBY_PATHS };
const LEVER_CHANNEL = { ats: 'lever', site: 'acme', api_key_env: 'LEVER_ACME_KEY' };
const CHANNEL_SECRETS = { GH_REDDIT_KEY: 'reddit-secret', ASHBY_FLUENCY_KEY: 'fluency-secret', LEVER_ACME_KEY: 'lever-secret' };

const GREENHOUSE_URL = 'https://boards.greenhouse.io/reddit/jobs/8070669';
const ASHBY_URL = 'https://jobs.ashbyhq.com/fluency/f4436720-0c9a-44b1-b175-787bc0f8fa39';
const LEVER_URL = 'https://jobs.lever.co/acme/abc-123';

const channelEnv = (channels: unknown[]) => ({
  LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON: JSON.stringify(channels),
  ...CHANNEL_SECRETS,
});

test('an attached document nothing has named refuses the channel instead of guessing a part name', async () => {
  const unmapped = [
    { provider: 'greenhouse', url: GREENHOUSE_URL, channels: [GREENHOUSE_CHANNEL] },
    { provider: 'ashby', url: ASHBY_URL, channels: [ASHBY_CHANNEL] },
    { provider: 'lever', url: LEVER_URL, channels: [LEVER_CHANNEL] },
  ] as const;
  for (const channel of unmapped) {
    let requests = 0;
    const fetchImpl: typeof fetch = async () => {
      requests += 1;
      return new Response('accepted', { status: 200 });
    };
    const result = await tryAtsSubmissionChannel(channel.url, transcriptPacket(), {
      env: channelEnv([...channel.channels]),
      fetchImpl,
    });
    assert.equal(result.kind, 'not_applicable', `${channel.provider} must not post an unnamed document`);
    if (result.kind !== 'not_applicable') return;
    assert.equal(result.assessment.provider, channel.provider);
    assert.equal(result.assessment.status, 'unavailable');
    assert.deepEqual(result.assessment.missing_fields, ['transcript'],
      `${channel.provider} must name what it could not map`);
    // Nothing at all is sent. A refusal that had already POSTed would have filed the application
    // without the document, which is the outcome the refusal exists to prevent.
    assert.equal(requests, 0, `${channel.provider} must refuse before it reaches the API`);
  }
});

test('a named document is posted under the name it was given and under no other', async () => {
  const mapped = [
    {
      provider: 'greenhouse',
      url: GREENHOUSE_URL,
      channels: [{ ...GREENHOUSE_CHANNEL, field_paths: { transcript: 'question_31415926' } }],
      field: 'question_31415926',
    },
    {
      provider: 'ashby',
      url: ASHBY_URL,
      channels: [{ ...ASHBY_CHANNEL, field_paths: { ...ASHBY_PATHS, transcript: 'files.transcript' } }],
      field: 'applicationForm[files.transcript]',
    },
    {
      provider: 'lever',
      url: LEVER_URL,
      channels: [{ ...LEVER_CHANNEL, field_paths: { transcript: 'cards[transcript]' } }],
      field: 'cards[transcript]',
    },
  ] as const;
  for (const channel of mapped) {
    let body: FormData | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = init?.body as FormData;
      return new Response('accepted', { status: 200 });
    };
    const packet = transcriptPacket();
    const result = await tryAtsSubmissionChannel(channel.url, packet, {
      env: channelEnv([...channel.channels]),
      fetchImpl,
    });
    assert.equal(result.kind, 'submitted', channel.provider);
    const part = body?.get(channel.field);
    assert.ok(part instanceof File, `${channel.provider} must post the document under its configured name`);
    assert.equal((part as File).name, packet.transcriptName);
    assert.equal(await (part as File).text(), packet.transcript!.toString('utf8'));
    // The literal is what was there before. It is asserted absent by name, because a builder that
    // appends under both names posts a part no employer asked for and still passes the check above.
    assert.equal(body?.get('transcript'), null, `${channel.provider} must not also post the guess`);
    assert.equal(body?.getAll(channel.field).length, 1, `${channel.provider} must post the document once`);
  }
});

test('an application carrying no document is unaffected by the mapping it does not need', async () => {
  const unmapped = [
    { provider: 'greenhouse', url: GREENHOUSE_URL, channels: [GREENHOUSE_CHANNEL] },
    { provider: 'ashby', url: ASHBY_URL, channels: [ASHBY_CHANNEL] },
    { provider: 'lever', url: LEVER_URL, channels: [LEVER_CHANNEL] },
  ] as const;
  for (const channel of unmapped) {
    let body: FormData | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = init?.body as FormData;
      return new Response('accepted', { status: 200 });
    };
    const result = await tryAtsSubmissionChannel(channel.url, basePacket(), {
      env: channelEnv([...channel.channels]),
      fetchImpl,
    });
    assert.equal(result.kind, 'submitted', `${channel.provider} must still send an application with no document`);
    assert.equal(body?.get('transcript'), null, channel.provider);
  }
});
