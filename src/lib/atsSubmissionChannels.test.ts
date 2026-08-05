import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessAtsSubmissionChannel,
  ashbyPostingFromUrl,
  configuredAtsSubmissionChannels,
  greenhousePostingFromUrl,
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

test('channel config resolves only allowlisted employers with referenced secrets', () => {
  const env = {
    LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON: JSON.stringify([
      { ats: 'greenhouse', board_token: 'reddit', api_key_env: 'GH_REDDIT_KEY' },
      { ats: 'ashby', organization: 'fluency', api_key_env: 'ASHBY_FLUENCY_KEY' },
      { ats: 'greenhouse', board_token: 'missing', api_key_env: 'MISSING_KEY' },
      { ats: 'lever', board_token: 'ignored', api_key_env: 'IGNORED_KEY' },
    ]),
    GH_REDDIT_KEY: 'gh-secret',
    ASHBY_FLUENCY_KEY: 'ashby-secret',
  };
  const channels = configuredAtsSubmissionChannels(env);
  assert.equal(channels.length, 2);
  assert.deepEqual(channels.map((item) => [item.ats, item.boardToken ?? item.organization]), [
    ['greenhouse', 'reddit'],
    ['ashby', 'fluency'],
  ]);
});

test('assesses Greenhouse and Ashby packets as unavailable when credentials are absent', () => {
  const greenhouse = assessAtsSubmissionChannel('https://boards.greenhouse.io/reddit/jobs/1234567', {});
  assert.equal(greenhouse?.provider, 'greenhouse');
  assert.equal(greenhouse?.status, 'unavailable');
  assert.match(greenhouse?.reason ?? '', /Missing employer-authorized Greenhouse/);

  const ashby = assessAtsSubmissionChannel('https://jobs.ashbyhq.com/fluency/f4436720-0c9a-44b1-b175-787bc0f8fa39', {});
  assert.equal(ashby?.provider, 'ashby');
  assert.equal(ashby?.status, 'unavailable');
  assert.match(ashby?.reason ?? '', /Missing employer-authorized Ashby/);
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
