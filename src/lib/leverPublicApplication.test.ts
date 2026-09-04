import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEVER_PUBLIC_APPLICATION_SCHEMA_TIMEOUT_MS,
  leverPostingFromUrl,
  leverPublicApplicationSchema,
  leverPublicQuestionLabelKey,
  parseLeverPublicApplicationSchema,
} from './leverPublicApplication';
import { questionMetadataBlockerForDiscovered } from './questionMetadata';

const BELVEDERE_POSTING = 'https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0/apply';
const CARD = 'cards[6d127747-2d17-402b-87d6-b1f4045ad776]';

function question(label: string, kind: 'text' | 'dropdown' | 'university' | 'textarea', control: string, required = true): string {
  const marker = required ? '<span class="required">✱</span>' : '';
  const fieldClass = required ? 'application-field full-width required-field' : 'application-field full-width';
  return `<li class="application-question custom-question"><div>`
    + `<div class="application-label full-width ${kind}"><div class="text">${label}${marker}</div></div>`
    + `<div class="${fieldClass}">${control}</div></div></li>`;
}

function select(name: string, options: readonly string[], extra = ''): string {
  return `<div class="application-dropdown"><select ${extra}name="${name}">`
    + `<option value="">Select...</option>`
    + options.map((option) => `<option value="${option}">${option}</option>`).join('')
    + `</select></div>`;
}

function radios(name: string, options: readonly string[], required = true): string {
  return `<ul data-qa="multiple-choice">`
    + options.map((option) => `<li><label><input type="radio" name="${name}" value="${option}" ${required ? 'required="required" ' : ''}/>`
      + `<span class="application-answer-alternative">${option}</span></label></li>`).join('')
    + `</ul>`;
}

/**
 * The Belvedere Trading apply page as jobs.lever.co served it on 2026-09-04, reduced to the controls
 * that matter and to a short university list (the live one carries 2,965 options, "University of
 * Southern California" among them). Every class name, attribute and nesting below is the live markup.
 */
function belvedereApplyPage(): string {
  return `<!doctype html><html><body><form id="application-form" enctype="multipart/form-data" method="POST">`
    + `<ul><li class="application-question"><div class="application-label">Resume/CV<span class="required">✱</span></div>`
    + `<div class="application-field"><input type="file" name="resume" /></div></li></ul>`
    + `<ul>`
    + question('Street Address', 'text', `<input required="required" class="card-field-input" type="text" name="${CARD}[field0]" />`)
    + question('How did you learn about Belvedere Trading?', 'dropdown', select(`${CARD}[field4]`, [
      'Belvedere Trading Website', 'Handshake/Campus Job Board', 'LinkedIn', 'Other',
    ]))
    + question('Are you lawfully authorized to work in the United States?', 'dropdown', radios(`${CARD}[field5]`, ['Yes', 'No']))
    + question('If yes, what type of sponsorship will you require? (Ex. F-1, H1-B, OPT, etc.)', 'textarea', `<textarea name="${CARD}[field7]"></textarea>`, false)
    + question('What degree are you currently pursuing?', 'dropdown', radios(`${CARD}[field8]`, [
      'High School Diploma', 'Associate Degree', 'Bachelor Degree', 'Masters/PhD',
    ]))
    + question('Name of School', 'university', select(`${CARD}[field9]`, [
      'Other', 'ACAP University College', 'University of Southern California', 'Vanguard University of Southern California',
    ], 'data-qa="university-dropdown" '))
    + question('School Minor:', 'textarea', `<textarea name="${CARD}[field11]"></textarea>`, false)
    + question('Do you currently have pending offers from other employers?', 'dropdown', radios(`${CARD}[field17]`, ['Yes', 'No', 'N/A'], false))
    + `</ul>`
    + `<div class="application-eeo"><select name="eeo[gender]"><option value="">Select ...</option><option value="Male">Male</option>`
    + `<option value="Female">Female</option><option value="Decline to self-identify">Decline to self-identify</option></select></div>`
    + `</form></body></html>`;
}

test('the published schema carries every closed control\'s exact accepted values, keyed by the question wording', () => {
  const parsed = parseLeverPublicApplicationSchema(belvedereApplyPage());
  assert.ok(parsed);
  assert.deepEqual(
    parsed.optionsByLabel[leverPublicQuestionLabelKey('Name of School ✱')!],
    ['Other', 'ACAP University College', 'University of Southern California', 'Vanguard University of Southern California'],
  );
  assert.deepEqual(
    parsed.optionsByLabel[leverPublicQuestionLabelKey('How did you learn about Belvedere Trading?')!],
    ['Belvedere Trading Website', 'Handshake/Campus Job Board', 'LinkedIn', 'Other'],
  );
  assert.deepEqual(
    parsed.optionsByLabel[leverPublicQuestionLabelKey('What degree are you currently pursuing?')!],
    ['High School Diploma', 'Associate Degree', 'Bachelor Degree', 'Masters/PhD'],
  );
  assert.deepEqual(parsed.optionsByLabel[leverPublicQuestionLabelKey('Are you lawfully authorized to work in the United States?')!], ['Yes', 'No']);
  assert.deepEqual(parsed.optionsByLabel[leverPublicQuestionLabelKey('Do you currently have pending offers from other employers?')!], ['Yes', 'No', 'N/A']);
  // Open text controls publish nothing, and the placeholder option is never a choice.
  assert.equal(leverPublicQuestionLabelKey('Street Address')! in parsed.optionsByLabel, false);
  assert.equal(leverPublicQuestionLabelKey('School Minor:')! in parsed.optionsByLabel, false);
  for (const options of Object.values(parsed.optionsByLabel)) assert.equal(options.includes('Select...'), false);
});

/* THE MEASURED JOIN. The live DOM read keeps Lever's required glyph in the discovered label
 * ("name of school ✱", packet c4413bff) while the published label carries it inside a span; both
 * sides key through leverPublicQuestionLabelKey so they agree. */
test('the discovered label and the published label key identically, required glyph or not', () => {
  assert.equal(leverPublicQuestionLabelKey('name of school ✱'), leverPublicQuestionLabelKey('Name of School'));
  assert.equal(leverPublicQuestionLabelKey('Name of School *'), 'name of school');
  assert.equal(leverPublicQuestionLabelKey(undefined), undefined);
  assert.equal(leverPublicQuestionLabelKey('   '), undefined);
});

/* THE WHOLE POINT: with the published list attached, the 2,965-option university select stops being
 * an unreadable field and becomes one whose exact accepted values are known. */
test('an attached published list clears the metadata blocker that held the packet', () => {
  const parsed = parseLeverPublicApplicationSchema(belvedereApplyPage());
  assert.ok(parsed);
  const discovered = {
    label: 'name of school ✱',
    selector: `[name="${CARD}[field9]"]`,
    durableSelector: `[name="${CARD}[field9]"]`,
    inputType: 'text',
    role: 'combobox',
    options: null as string[] | null,
    optionsComplete: false,
    required: true,
  };
  const before = questionMetadataBlockerForDiscovered(discovered as never, { closedControlRequiresOptions: true });
  assert.equal(before?.kind, 'missing_exact_options');
  const options = parsed.optionsByLabel[leverPublicQuestionLabelKey(discovered.label)!];
  const after = questionMetadataBlockerForDiscovered({ ...discovered, options, optionsComplete: true } as never, {
    closedControlRequiresOptions: true,
  });
  assert.equal(after, null);
});

test('a label two controls share is dropped from both, and a page that is not an apply form is unknown', () => {
  const twice = belvedereApplyPage().replace(
    question('School Minor:', 'textarea', `<textarea name="${CARD}[field11]"></textarea>`, false),
    question('Name of School', 'dropdown', select(`${CARD}[field99]`, ['Somewhere Else'])),
  );
  const parsed = parseLeverPublicApplicationSchema(twice);
  assert.ok(parsed);
  assert.equal(leverPublicQuestionLabelKey('Name of School')! in parsed.optionsByLabel, false);
  assert.deepEqual(parsed.optionsByLabel[leverPublicQuestionLabelKey('What degree are you currently pursuing?')!], [
    'High School Diploma', 'Associate Degree', 'Bachelor Degree', 'Masters/PhD',
  ]);

  assert.equal(parseLeverPublicApplicationSchema('<html><body><h1>Job not found</h1></body></html>'), null);
  assert.equal(parseLeverPublicApplicationSchema('<form id="application-form"></form>'), null);
  assert.equal(parseLeverPublicApplicationSchema(undefined), null);
});

test('the posting URL parser accepts exactly the canonical Lever application shapes', () => {
  assert.deepEqual(leverPostingFromUrl(BELVEDERE_POSTING), {
    host: 'jobs.lever.co', site: 'belvederetrading', postingId: '10746b3d-1760-4573-9b63-b93f5a5e4fc0',
  });
  assert.deepEqual(leverPostingFromUrl('https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0?lever-source=x'), {
    host: 'jobs.lever.co', site: 'belvederetrading', postingId: '10746b3d-1760-4573-9b63-b93f5a5e4fc0',
  });
  assert.equal(leverPostingFromUrl('https://jobs.eu.lever.co/acme/10746b3d-1760-4573-9b63-b93f5a5e4fc0/apply')?.host, 'jobs.eu.lever.co');
  assert.equal(leverPostingFromUrl('https://jobs.lever.co/belvederetrading'), null);
  assert.equal(leverPostingFromUrl('https://jobs.lever.co/belvederetrading/not-a-posting/apply'), null);
  assert.equal(leverPostingFromUrl('http://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0'), null);
  assert.equal(leverPostingFromUrl('https://jobs.ashbyhq.com/sentry/672e2a76-d8e1-49c1-b227-4a189c4e49a1'), null);
  assert.equal(leverPostingFromUrl(undefined), null);
});

test('the schema fetch is bounded, reads only the posting\'s own public apply page, and sends no applicant data', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(belvedereApplyPage(), { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const parsed = await leverPublicApplicationSchema(BELVEDERE_POSTING, fetchImpl);
  assert.ok(parsed);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0/apply');
  assert.equal(calls[0].init?.method, 'GET');
  assert.equal(calls[0].init?.body, undefined);
  assert.equal(calls[0].init?.redirect, 'manual');
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
  assert.equal(LEVER_PUBLIC_APPLICATION_SCHEMA_TIMEOUT_MS, 10_000);
  assert.deepEqual(parsed.optionsByLabel[leverPublicQuestionLabelKey('Name of School')!]?.includes('University of Southern California'), true);
});

test('a non-Lever URL never reaches the network, and HTTP failures are unknown', async () => {
  let called = 0;
  const parsed = await leverPublicApplicationSchema('https://jobs.ashbyhq.com/sentry/672e2a76-d8e1-49c1-b227-4a189c4e49a1', async () => {
    called += 1;
    return new Response('', { status: 200 });
  });
  assert.equal(parsed, null);
  assert.equal(called, 0);
  assert.equal(await leverPublicApplicationSchema(BELVEDERE_POSTING, async () => new Response('gone', { status: 404 })), null);
  assert.equal(await leverPublicApplicationSchema(BELVEDERE_POSTING, async () => new Response('', { status: 302, headers: { location: 'https://jobs.lever.co/' } })), null);
});
