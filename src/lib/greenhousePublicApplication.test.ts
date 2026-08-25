import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GREENHOUSE_PUBLIC_APPLICATION_SCHEMA_TIMEOUT_MS,
  greenhousePostingFromUrl,
  greenhousePublicApplicationSchema,
  greenhousePublicQuestionLabelKey,
  parseGreenhousePublicApplicationSchema,
} from './greenhousePublicApplication';

function coreQuestions(): unknown[] {
  return [
    { label: 'First Name', fields: [{ name: 'first_name', type: 'input_text', values: [] }] },
    { label: 'Last Name', fields: [{ name: 'last_name', type: 'input_text', values: [] }] },
    { label: 'Email', fields: [{ name: 'email', type: 'input_text', values: [] }] },
    {
      label: 'Resume/CV',
      fields: [
        { name: 'resume', type: 'input_file', values: [] },
        { name: 'resume_text', type: 'textarea', values: [] },
      ],
    },
  ];
}

function jumpSchemaFixture(): Record<string, unknown> {
  return {
    questions: [
      ...coreQuestions(),
      {
        label: 'Cover Letter',
        required: false,
        fields: [
          { name: 'cover_letter', type: 'input_file', values: [] },
          { name: 'cover_letter_text', type: 'textarea', values: [] },
        ],
      },
      {
        label: 'What degree are you currently pursuing?',
        required: true,
        fields: [{
          name: 'question_67595575[]',
          type: 'multi_value_multi_select',
          values: [
            { label: 'Bachelor’s', value: 728374210 },
            { label: 'Master’s', value: 728374211 },
            { label: 'PhD', value: 728374212 },
            { label: 'Postdoc', value: 728374213 },
          ],
        }],
      },
      {
        label: 'What is your expected graduation date?',
        required: true,
        fields: [{
          name: 'question_67595576',
          type: 'multi_value_single_select',
          values: [
            { label: 'Winter 2028', value: 728374222 },
            { label: 'Spring/Summer 2028', value: 728374223 },
            { label: 'Fall 2028', value: 728374224 },
          ],
        }],
      },
    ],
  };
}

test('Jump public schema supplies stable document capability and exact array-control options', () => {
  const parsed = parseGreenhousePublicApplicationSchema(jumpSchemaFixture());
  assert.ok(parsed);
  assert.equal(parsed.coverLetterSupported, true);
  assert.equal(parsed.transcriptSupported, false);
  assert.deepEqual(parsed.fieldOptions['question_67595575[]'], [
    'Bachelor’s', 'Master’s', 'PhD', 'Postdoc',
  ]);
  assert.deepEqual(parsed.optionsByLabel['what degree are you currently pursuing?'], [
    'Bachelor’s', 'Master’s', 'PhD', 'Postdoc',
  ]);
  assert.deepEqual(parsed.fieldOptions.question_67595576, [
    'Winter 2028', 'Spring/Summer 2028', 'Fall 2028',
  ]);
  assert.equal(
    parsed.fieldNamesByLabel['what degree are you currently pursuing?'],
    'question_67595575[]',
  );
});

test('only a complete questions array can make document absence authoritative', () => {
  assert.equal(parseGreenhousePublicApplicationSchema({}), null);
  assert.equal(parseGreenhousePublicApplicationSchema({ questions: null }), null);
  assert.equal(parseGreenhousePublicApplicationSchema({ questions: [] }), null);
  assert.equal(parseGreenhousePublicApplicationSchema({
    questions: [{
      label: 'What degree are you currently pursuing?',
      fields: [{ name: 'question_67595575[]', type: 'multi_value_multi_select', values: [] }],
    }],
  }), null, 'a partial payload cannot become an all-false document schema');

  const withoutCover = parseGreenhousePublicApplicationSchema({ questions: coreQuestions() });
  assert.ok(withoutCover);
  assert.equal(withoutCover.coverLetterSupported, false);
  assert.equal(withoutCover.transcriptSupported, false);
});

test('public schema fetch is bounded and sends no applicant data', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return new Response(JSON.stringify(jumpSchemaFixture()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const parsed = await greenhousePublicApplicationSchema(
    'https://job-boards.greenhouse.io/jumptrading/jobs/8003019',
    fetchImpl,
  );
  assert.ok(parsed);
  assert.equal(
    requestUrl,
    'https://boards-api.greenhouse.io/v1/boards/jumptrading/jobs/8003019?questions=true',
  );
  assert.equal(requestInit?.method, 'GET');
  assert.ok(requestInit?.signal instanceof AbortSignal);
  assert.equal(requestInit?.body, undefined);
  assert.equal(GREENHOUSE_PUBLIC_APPLICATION_SCHEMA_TIMEOUT_MS, 10_000);
});

test('public schema fetch returns unknown on HTTP and JSON failures', async () => {
  assert.equal(await greenhousePublicApplicationSchema(
    'https://boards.greenhouse.io/jumptrading/jobs/8003019',
    async () => new Response('missing', { status: 404 }),
  ), null);
  assert.equal(await greenhousePublicApplicationSchema(
    'https://boards.greenhouse.io/jumptrading/jobs/8003019',
    async () => new Response('{', { status: 200 }),
  ), null);
});

test('the neutral URL and label parsers retain the established Greenhouse contract', () => {
  assert.deepEqual(
    greenhousePostingFromUrl('https://boards.greenhouse.io/embed/job_app?for=jumptrading&token=8003019'),
    { boardToken: 'jumptrading', jobId: '8003019' },
  );
  assert.equal(greenhousePostingFromUrl('https://jumptrading.com/hr/job?gh_jid=8003019'), null);
  assert.equal(
    greenhousePublicQuestionLabelKey('  What degree are you currently pursuing?  * '),
    'what degree are you currently pursuing?',
  );
});
