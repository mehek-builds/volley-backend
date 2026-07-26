import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthorizedAtsValidationError, authorizedGreenhouseRoute, buildGreenhouseApplicationBody, submitAuthorizedGreenhouseApplication } from './authorizedAts';
import type { SubmissionPacket } from './portalSubmission';

const packet: SubmissionPacket = {
  fullName: 'Mehek Mandal', email: 'mehek@example.com', phone: '+1 555 0100',
  linkedinUrl: 'https://linkedin.com/in/mehek', resume: Buffer.from('pdf'), resumeName: 'resume.pdf',
  questions: [{ question: 'Are you authorized to work?', answer: 'Yes' }],
};

test('routes only exact Greenhouse hosts with an employer-issued board key', () => {
  const registry = JSON.stringify({ acme: 'employer-secret' });
  assert.deepEqual(authorizedGreenhouseRoute('https://boards.greenhouse.io/acme/jobs/12345', registry), {
    channel: 'greenhouse_job_board_api', boardToken: 'acme', jobId: '12345', apiKey: 'employer-secret',
  });
  assert.equal(authorizedGreenhouseRoute('https://evilgreenhouse.io/acme/jobs/12345', registry), null);
  assert.equal(authorizedGreenhouseRoute('https://boards.greenhouse.io/other/jobs/12345', registry), null);
});

test('maps exact reviewed answers and reports every missing required question', () => {
  const prepared = buildGreenhouseApplicationBody({ id: 12345, questions: [
    { required: true, label: 'First Name', fields: [{ name: 'first_name', type: 'input_text' }] },
    { required: true, label: 'Resume', fields: [{ name: 'resume', type: 'input_file' }] },
    { required: true, label: 'Are you authorized to work?', fields: [{ name: 'question_7', type: 'multi_value_single_select', values: [{ value: 1, label: 'Yes' }, { value: 0, label: 'No' }] }] },
    { required: true, label: 'Security clearance', fields: [{ name: 'question_8', type: 'input_text' }] },
  ] }, packet);
  assert.equal(prepared.body.question_7, 1);
  assert.deepEqual(prepared.blockers, ['Security clearance is required by the employer']);
});

test('fails closed on legal consent and location coordinates it cannot truthfully infer', () => {
  const prepared = buildGreenhouseApplicationBody({
    id: 12345,
    location_questions: [{ required: true, label: 'Location', fields: [
      { name: 'location', type: 'input_text' },
      { name: 'latitude', type: 'input_hidden' },
      { name: 'longitude', type: 'input_hidden' },
    ] }],
    data_compliance: { requires_consent: true },
  }, packet);
  assert.deepEqual(prepared.blockers, [
    'Location requires verified location coordinates',
    'Employer data-processing consent requires an applicant decision',
  ]);
});

test('submits to the official endpoint with Basic Auth and never exposes the key in the body', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (input, init) => {
    requests.push({ url: String(input), init });
    if (!init?.method) return new Response(JSON.stringify({ id: 12345, questions: [] }), { status: 200 });
    return new Response(JSON.stringify({ application_id: 9876 }), { status: 200 });
  }) as typeof fetch;
  const route = authorizedGreenhouseRoute('https://boards.greenhouse.io/acme/jobs/12345', JSON.stringify({ acme: 'employer-secret' }))!;
  const receipt = await submitAuthorizedGreenhouseApplication(route, packet, fakeFetch);
  assert.equal(requests[1]?.url, 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/12345');
  assert.equal(new Headers(requests[1]?.init?.headers).get('Authorization'), `Basic ${Buffer.from('employer-secret:').toString('base64')}`);
  assert.equal(String(requests[1]?.init?.body).includes('employer-secret'), false);
  assert.equal(receipt.referenceId, '9876');
});

test('fails closed before POST when the official form has an unanswered required field', async () => {
  let postCount = 0;
  const fakeFetch = (async (_input, init) => {
    if (init?.method === 'POST') postCount += 1;
    return new Response(JSON.stringify({ id: 12345, questions: [{ required: true, label: 'Unanswered', fields: [{ name: 'question_9', type: 'input_text' }] }] }), { status: 200 });
  }) as typeof fetch;
  const route = authorizedGreenhouseRoute('https://boards.greenhouse.io/acme/jobs/12345', JSON.stringify({ acme: 'employer-secret' }))!;
  await assert.rejects(() => submitAuthorizedGreenhouseApplication(route, packet, fakeFetch), AuthorizedAtsValidationError);
  assert.equal(postCount, 0);
});
