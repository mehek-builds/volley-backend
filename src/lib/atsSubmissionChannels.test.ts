import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessAtsSubmissionChannel,
  ashbyPostingFromUrl,
  configuredAtsSubmissionChannels,
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
  assert.deepEqual(greenhousePostingFromUrl('https://boards.greenhouse.io/embed/job_app?for=postman&token=7654321'), {
    boardToken: 'postman',
    jobId: '7654321',
  });
  assert.equal(greenhousePostingFromUrl('https://nuro.ai/careers?gh_jid=1234567'), null);
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
    ['jazzhr', 'https://acme.applytojob.com/apply/abc123/Engineer'],
    ['paylocity', 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/123'],
    ['rippling', 'https://jobs.rippling.com/acme/jobs/abc123'],
    ['breezy', 'https://jobs.breezy.hr/acme/jobs/abc123'],
    ['oracle_taleo', 'https://acme.taleo.net/careersection/ex/jobdetail.ftl?job=123'],
    ['sap_successfactors', 'https://acme.jobs2web.com/successfactors/job/Engineer/123'],
    ['adp', 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?jobId=123'],
    ['ukg', 'https://recruiting.ultipro.com/ACM1000/JobBoard/123'],
    ['jobvite', 'https://jobs.jobvite.com/acme/job/abc123'],
    ['dayforce', 'https://acme.dayforcehcm.com/CandidatePortal/en-US/acme/Posting/View/123'],
    ['recruitee', 'https://acme.recruitee.com/o/engineer'],
    ['teamtailor', 'https://acme.teamtailor.com/jobs/123-engineer'],
    ['personio', 'https://acme.jobs.personio.com/job/123'],
    ['pinpoint', 'https://acme.pinpointhq.com/postings/abc123'],
    ['comeet', 'https://www.comeet.co/jobs/acme/123/engineer'],
    ['zoho_recruit', 'https://acme.zohorecruit.com/jobs/Careers/123/Engineer'],
    ['bullhorn', 'https://acme.bullhornstaffing.com/job/123'],
    ['indeed', 'https://www.indeed.com/viewjob?jk=abc123'],
    ['linkedin', 'https://www.linkedin.com/jobs/view/1234567890'],
    ['ziprecruiter', 'https://www.ziprecruiter.com/jobs/acme-123-engineer'],
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
