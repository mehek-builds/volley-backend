import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASHBY_PUBLIC_APPLICATION_SCHEMA_TIMEOUT_MS,
  ashbyPostingFromUrl,
  ashbyPublicApplicationSchema,
  ashbyPublicQuestionLabelKey,
  parseAshbyPublicApplicationSchema,
} from './ashbyPublicApplication';
import { consentAcknowledgementClasses } from './questionDiscovery';
import { questionMetadataBlockerForDiscovered } from './questionMetadata';

const OPENAI_POSTING_ID = 'db053b0e-c1a5-4b7a-bcb6-6e766629e7b1';
const ARBITRATION_LABEL = 'Applicant Arbitration Agreement Acknowledgement';
const ARBITRATION_OPTION = 'I acknowledge that I have opened, read, and understood the Arbitration'
  + ' Agreement. I understand that by submitting my application, I am agreeing to be bound by the'
  + ' terms of the Arbitration Agreement.';
const CERTIFICATION_LABEL = 'I hereby certify that I have not knowingly withheld any information'
  + ' that might adversely affect my application.';

function field(overrides: Record<string, unknown>): Record<string, unknown> {
  return { isMany: false, ...overrides };
}

/** The systemfield witnesses every real Ashby application form carries. */
function coreFields(): Record<string, unknown>[] {
  return [
    field({ path: '_systemfield_name', title: 'Legal Name', type: 'String' }),
    field({ path: '_systemfield_email', title: 'Email', type: 'Email' }),
    field({ path: '_systemfield_resume', title: 'Resume', type: 'File' }),
  ];
}

/**
 * OpenAI's Software Engineer, Internal Applications - Enterprise form, as the live endpoint
 * returned it on 2026-09-01. The two MultiValueSelect attestations are the measured shape that
 * blocked application e4b0420c: required, one accepted value each, isMany false.
 */
function openAiPostingFixture(): Record<string, unknown> {
  return {
    applicationForm: {
      sections: [
        { fieldEntries: coreFields().map((f) => ({ field: f, isRequired: true })) },
        {
          fieldEntries: [
            {
              field: field({
                path: 'bed95633-1b6e-4cd0-9eaf-c5a9f75ac35d',
                title: 'Are you authorized to work in the country where the job is located?',
                type: 'Boolean',
              }),
              isRequired: true,
            },
            {
              field: field({
                path: 'a90e16d2-baaf-4c31-b3e5-70b53f261040',
                title: ARBITRATION_LABEL,
                type: 'MultiValueSelect',
                selectableValues: [
                  { label: ARBITRATION_OPTION, value: ARBITRATION_OPTION, isArchived: false },
                ],
              }),
              isRequired: true,
            },
            {
              field: field({
                path: '7fe82de7-a1d7-4d8a-95a5-e5cc9adc84ea',
                title: CERTIFICATION_LABEL,
                type: 'MultiValueSelect',
                selectableValues: [
                  { label: 'I confirm I have read the above.', value: 'x', isArchived: false },
                ],
              }),
              isRequired: true,
            },
          ],
        },
      ],
    },
  };
}

test('the employer-published schema carries the exact accepted value for each attestation', () => {
  const parsed = parseAshbyPublicApplicationSchema(openAiPostingFixture());
  assert.ok(parsed);
  assert.deepEqual(
    parsed.optionsByLabel[ashbyPublicQuestionLabelKey(ARBITRATION_LABEL)!],
    [ARBITRATION_OPTION],
  );
  assert.deepEqual(
    parsed.optionsByLabel[ashbyPublicQuestionLabelKey(CERTIFICATION_LABEL)!],
    ['I confirm I have read the above.'],
  );
  // A Boolean control publishes the two answers its type implies - the exact texts of the two
  // pills Ashby renders for it - because Ashby lists no selectableValues for a yes/no question.
  assert.deepEqual(
    parsed.optionsByLabel[ashbyPublicQuestionLabelKey('Are you authorized to work in the country where the job is located?')!],
    ['Yes', 'No'],
  );
});

/* MEASURED 2026-09-04 on Sentry's "Software Engineer, Intern (Summer 2027)" (packet 84bf5354): the
 * three Boolean questions on the form were exactly the three "employer fields stayed untouched -
 * exact choices not read", while every ValueSelect beside them published normally. A yes/no
 * question reaches the packet as a closed control, so without its two choices it is a
 * missing_exact_options blocker the applicant can clear only on the employer's page; with them it
 * is a question Litos can answer from the profile (sponsorship) or hand to her with both choices
 * showing. Only the Boolean type gains a list: every other optionless type still publishes nothing. */
test('a Boolean question publishes Yes and No, and that clears the blocker it used to be', () => {
  const sentryFixture = {
    applicationForm: {
      sections: [
        { fieldEntries: coreFields().map((f) => ({ field: f, isRequired: true })) },
        {
          fieldEntries: [
            {
              field: field({
                path: '0b7b2d1e-6f0d-4b3e-9c2a-2f1c5e8a9d10',
                title: 'Will you now or in the future require visa sponsorship to work in the location where this job is posted?',
                type: 'Boolean',
              }),
              isRequired: true,
            },
            {
              field: field({ path: '5d2c9a7b-1e4f-4c8d-b3a6-7e9f0c1d2b34', title: 'Have you ever used Sentry before?', type: 'Boolean' }),
              isRequired: false,
            },
            {
              field: field({ path: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c65', title: 'Pronouns', type: 'String' }),
              isRequired: false,
            },
            {
              field: field({ path: 'c1b2a3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', title: 'When is your expected graduation date?', type: 'Date' }),
              isRequired: false,
            },
          ],
        },
      ],
    },
  };
  const parsed = parseAshbyPublicApplicationSchema(sentryFixture);
  assert.ok(parsed);
  const sponsorship = 'Will you now or in the future require visa sponsorship to work in the location where this job is posted?';
  assert.deepEqual(parsed.optionsByLabel[ashbyPublicQuestionLabelKey(sponsorship)!], ['Yes', 'No']);
  assert.deepEqual(parsed.optionsByLabel[ashbyPublicQuestionLabelKey('Have you ever used Sentry before?')!], ['Yes', 'No']);
  assert.equal(ashbyPublicQuestionLabelKey('Pronouns')! in parsed.optionsByLabel, false);
  assert.equal(ashbyPublicQuestionLabelKey('When is your expected graduation date?')! in parsed.optionsByLabel, false);
  assert.deepEqual(parsed.multiSelectLabels, []);

  /* The same clearing the arbitration test above proves for a published list: a closed control
   * that reaches the packet with no options is a missing_exact_options blocker, and the SAME control
   * carrying the two published choices is not. The discovered shape mirrors that test's on purpose,
   * so the two cannot drift apart on what "a closed control" means. */
  const discovered = {
    label: sponsorship,
    selector: '[data-litos-discovered-7]',
    durableSelector: null,
    inputType: 'text',
    role: 'combobox',
    options: null as string[] | null,
    optionsComplete: false,
    required: true,
  };
  const before = questionMetadataBlockerForDiscovered(discovered as never, {
    closedControlRequiresOptions: true,
  });
  assert.equal(before?.kind, 'missing_exact_options');
  const after = questionMetadataBlockerForDiscovered({
    ...discovered,
    options: parsed.optionsByLabel[ashbyPublicQuestionLabelKey(sponsorship)!],
    optionsComplete: true,
  } as never, { closedControlRequiresOptions: true });
  assert.equal(after, null);
});

/* THE WHOLE POINT OF THE FIX, stated as the behaviour rather than the plumbing: with the published
 * list attached the arbitration control stops being an unreadable field and becomes one the
 * applicant can answer. Mutation check: drop `optionsComplete` from the attached shape and this
 * fails, which is what makes the flag load-bearing rather than decorative. */
test('an attached published list clears the metadata blocker that held the packet', () => {
  const parsed = parseAshbyPublicApplicationSchema(openAiPostingFixture());
  assert.ok(parsed);
  const discovered = {
    label: ARBITRATION_LABEL,
    selector: '[data-litos-discovered-11]',
    durableSelector: null,
    inputType: 'text',
    role: 'combobox',
    options: null as string[] | null,
    optionsComplete: false,
    required: true,
  };
  const before = questionMetadataBlockerForDiscovered(discovered as never, {
    closedControlRequiresOptions: true,
  });
  assert.equal(before?.kind, 'missing_exact_options');
  assert.equal(before?.question, ARBITRATION_LABEL);

  const options = parsed.optionsByLabel[ashbyPublicQuestionLabelKey(ARBITRATION_LABEL)!];
  const after = questionMetadataBlockerForDiscovered({
    ...discovered,
    options,
    optionsComplete: true,
  } as never, { closedControlRequiresOptions: true });
  assert.equal(after, null);
});

/* THE SAFETY BOUNDARY. Reading the employer's wording must never become Litos agreeing to it. Both
 * OpenAI attestations must classify as no consent class at all, so no licence covers them and they
 * stay held for the applicant. The privacy and conduct rows are the contrast that proves the
 * classifier is live rather than answering empty for everything. */
test('reading the options does not make arbitration or certification auto-acceptable', () => {
  assert.deepEqual(consentAcknowledgementClasses(ARBITRATION_LABEL, 'OpenAI'), []);
  assert.deepEqual(consentAcknowledgementClasses(CERTIFICATION_LABEL, 'OpenAI'), []);
  assert.deepEqual(
    consentAcknowledgementClasses('I have read and agree to the Privacy Policy', 'OpenAI'),
    ['privacy_and_terms'],
  );
  assert.deepEqual(
    consentAcknowledgementClasses('I acknowledge the Code of Conduct', 'OpenAI'),
    ['conduct'],
  );
});

test('a genuinely multi-select control is refused rather than reduced to one answer', () => {
  const fixture = openAiPostingFixture() as never as {
    applicationForm: { sections: { fieldEntries: { field: Record<string, unknown> }[] }[] };
  };
  const arbitration = fixture.applicationForm.sections[1].fieldEntries[1].field;
  arbitration.isMany = true;
  arbitration.selectableValues = [
    { label: 'First choice', value: 'a', isArchived: false },
    { label: 'Second choice', value: 'b', isArchived: false },
  ];
  const parsed = parseAshbyPublicApplicationSchema(fixture);
  assert.ok(parsed);
  const key = ashbyPublicQuestionLabelKey(ARBITRATION_LABEL)!;
  assert.equal(key in parsed.optionsByLabel, false);
  assert.deepEqual(parsed.multiSelectLabels, [key]);
});

test('archived values are never offered, and a label two fields share is dropped from both', () => {
  const withArchived = parseAshbyPublicApplicationSchema({
    applicationForm: {
      sections: [{
        fieldEntries: [
          ...coreFields().map((f) => ({ field: f, isRequired: true })),
          {
            field: field({
              path: 'q1',
              title: 'Referral source',
              type: 'MultiValueSelect',
              selectableValues: [
                { label: 'Job board', value: 'a', isArchived: false },
                { label: 'Retired channel', value: 'b', isArchived: true },
              ],
            }),
            isRequired: true,
          },
        ],
      }],
    },
  });
  assert.ok(withArchived);
  assert.deepEqual(withArchived.optionsByLabel['referral source'], ['Job board']);

  const duplicated = parseAshbyPublicApplicationSchema({
    applicationForm: {
      sections: [{
        fieldEntries: [
          ...coreFields().map((f) => ({ field: f, isRequired: true })),
          {
            field: field({
              path: 'q1',
              title: 'Referral source',
              type: 'MultiValueSelect',
              selectableValues: [{ label: 'Job board', value: 'a' }],
            }),
            isRequired: true,
          },
          {
            field: field({
              path: 'q2',
              title: 'Referral Source',
              type: 'MultiValueSelect',
              selectableValues: [{ label: 'Recruiter', value: 'b' }],
            }),
            isRequired: true,
          },
        ],
      }],
    },
  });
  assert.ok(duplicated);
  assert.equal('referral source' in duplicated.optionsByLabel, false);
});

/* A partial or intermediary response must not become an empty-but-successful schema, or the runner
 * would treat "we learned nothing" as "the employer publishes no options". Same witness discipline
 * parseGreenhousePublicApplicationSchema applies. */
test('a response missing the systemfield witnesses is unknown, not empty', () => {
  assert.equal(parseAshbyPublicApplicationSchema({ applicationForm: { sections: [] } }), null);
  assert.equal(parseAshbyPublicApplicationSchema({
    applicationForm: {
      sections: [{
        fieldEntries: [{ field: field({ path: '_systemfield_name', title: 'Legal Name' }), isRequired: true }],
      }],
    },
  }), null);
  assert.equal(parseAshbyPublicApplicationSchema(null), null);
  assert.equal(parseAshbyPublicApplicationSchema({ jobPosting: null }), null);
});

test('the posting URL parser accepts exactly the canonical Ashby application shapes', () => {
  assert.deepEqual(
    ashbyPostingFromUrl(`https://jobs.ashbyhq.com/openai/${OPENAI_POSTING_ID}/application`),
    { organization: 'openai', jobPostingId: OPENAI_POSTING_ID },
  );
  assert.deepEqual(
    ashbyPostingFromUrl(`https://jobs.ashbyhq.com/openai/${OPENAI_POSTING_ID}`),
    { organization: 'openai', jobPostingId: OPENAI_POSTING_ID },
  );
  // Not a posting: a listing page, a non-UUID id, another host, and plain http.
  assert.equal(ashbyPostingFromUrl('https://jobs.ashbyhq.com/openai'), null);
  assert.equal(ashbyPostingFromUrl('https://jobs.ashbyhq.com/openai/not-a-uuid'), null);
  assert.equal(ashbyPostingFromUrl(`https://ashbyhq.com/openai/${OPENAI_POSTING_ID}`), null);
  assert.equal(ashbyPostingFromUrl(`http://jobs.ashbyhq.com/openai/${OPENAI_POSTING_ID}`), null);
  assert.equal(ashbyPostingFromUrl(undefined), null);
});

test('the schema fetch is bounded and sends no applicant data', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return new Response(JSON.stringify({ data: { jobPosting: openAiPostingFixture() } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const parsed = await ashbyPublicApplicationSchema(
    `https://jobs.ashbyhq.com/openai/${OPENAI_POSTING_ID}/application`,
    fetchImpl,
  );
  assert.ok(parsed);
  assert.equal(requestUrl, 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting');
  assert.equal(requestInit?.method, 'POST');
  assert.ok(requestInit?.signal instanceof AbortSignal);
  assert.equal(ASHBY_PUBLIC_APPLICATION_SCHEMA_TIMEOUT_MS, 10_000);
  // The body names the posting and nothing else. No applicant, no answers, no credentials.
  const body = JSON.parse(String(requestInit?.body));
  assert.deepEqual(body.variables, {
    organizationHostedJobsPageName: 'openai',
    jobPostingId: OPENAI_POSTING_ID,
  });
  assert.equal(JSON.stringify(body).toLowerCase().includes('resume'), false);
});

test('a non-Ashby URL never reaches the network', async () => {
  let called = false;
  const parsed = await ashbyPublicApplicationSchema(
    'https://boards.greenhouse.io/jumptrading/jobs/8003019',
    async () => { called = true; return new Response('{}', { status: 200 }); },
  );
  assert.equal(parsed, null);
  assert.equal(called, false);
});

/* GraphQL answers 200 with an `errors` array, so the HTTP status alone proves nothing. A partial
 * `data` beside errors is exactly the intermediary response that must not become a schema. */
test('the fetch returns unknown on HTTP, JSON and GraphQL-level failures', async () => {
  const url = `https://jobs.ashbyhq.com/openai/${OPENAI_POSTING_ID}`;
  assert.equal(await ashbyPublicApplicationSchema(
    url,
    async () => new Response('missing', { status: 404 }),
  ), null);
  assert.equal(await ashbyPublicApplicationSchema(
    url,
    async () => new Response('{', { status: 200 }),
  ), null);
  assert.equal(await ashbyPublicApplicationSchema(
    url,
    async () => new Response(JSON.stringify({
      errors: [{ message: 'Cannot query field' }],
      data: { jobPosting: openAiPostingFixture() },
    }), { status: 200 }),
  ), null);
  assert.equal(await ashbyPublicApplicationSchema(
    url,
    async () => new Response(JSON.stringify({ data: { jobPosting: null } }), { status: 200 }),
  ), null);
});
