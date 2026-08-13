/* THE ASHBY "EXPECTED GRADUATION YEAR" CONTROL, AND WHAT IS ACTUALLY SENT TO IT.
 *
 * Measured on production packets bbf0115a, 59fb48ae, cd066fee and 4bfd5827 (Deepgram on Ashby,
 * 2026-08-08 to 2026-08-11). All four filled everything else on the form and all four reported
 * "Expected Graduation Year" as required and still empty. The control behind
 * `[data-field-path="407cc864-..."]` is a react-datepicker at day precision: handed a bare "2028" the
 * managed runner deliberately writes nothing, because tabbing off a typed year commits 01/01/2028,
 * four months before a May graduation and a date the employer reads as fact.
 *
 * The profile held "May 2028" the whole time, and questionDiscovery resolved the question to it. The
 * action builder then replaced it with packet.graduationYear on the strength of the word "year" in
 * the label. These tests pin the three cases that decision has to get right at once.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildManagedPortalActions } from './portalSubmission';

const ASHBY_GRADUATION_SELECTOR = '[data-field-path="407cc864-6d10-4427-bc5e-71598c5e593f"]';

type PacketOverrides = Partial<Parameters<typeof buildManagedPortalActions>[1]>;

function packetWith(overrides: PacketOverrides): Parameters<typeof buildManagedPortalActions>[1] {
  return {
    fullName: 'Mehek Mandal',
    email: 'applicant@example.com',
    school: 'University of Southern California',
    degree: 'Bachelor of Science in Computer Science',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
    ...overrides,
  } as Parameters<typeof buildManagedPortalActions>[1];
}

/** The value the runner is asked to type into one reviewed question, or undefined if none is. */
function questionFillValue(
  portal: Parameters<typeof buildManagedPortalActions>[0],
  overrides: PacketOverrides,
  label: string,
): string | undefined {
  const actions = buildManagedPortalActions(portal, packetWith(overrides));
  const action = actions.find((candidate) => candidate.label === `question:${label}`);
  return action?.value;
}

test('a full graduation date on file drives the Ashby graduation control', () => {
  const value = questionFillValue('ashby', {
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    questions: [{
      question: 'expected graduation year',
      answer: 'May 2028',
      portalSelector: ASHBY_GRADUATION_SELECTOR,
      portalInputType: 'text',
    }],
  }, 'expected graduation year');
  // "May 2028" is the one value this control accepts: the runner writes 2028-05-01 and the required
  // blocker clears. "2028" is what it refuses, and refusing it is correct.
  assert.equal(value, 'May 2028');
});

test('a year-only profile still sends the bare year, so the date control still refuses it', () => {
  // No month is on file, so no month may reach the form. The runner's refusal ("this control is a
  // date picker and needs a full date") is the right outcome here and must survive this fix.
  const value = questionFillValue('ashby', {
    graduationDate: undefined,
    graduationMonth: undefined,
    graduationYear: '2028',
    questions: [{
      question: 'expected graduation year',
      answer: '2028',
      portalSelector: ASHBY_GRADUATION_SELECTOR,
      portalInputType: 'text',
    }],
  }, 'expected graduation year');
  assert.equal(value, '2028');
});

test('a stored graduation date naming a different year than grad_year sends only the year', () => {
  // Two stored facts disagreeing. The month belongs to the one this answer is not reporting, so the
  // year alone is what both agree on, and no month is asserted on the employer's form.
  const value = questionFillValue('ashby', {
    graduationDate: 'May 2027',
    graduationMonth: 'May',
    graduationYear: '2028',
    questions: [{
      question: 'expected graduation year',
      answer: 'May 2027',
      portalSelector: ASHBY_GRADUATION_SELECTOR,
      portalInputType: 'text',
    }],
  }, 'expected graduation year');
  assert.equal(value, '2028');
});

test('a closed graduation-year list still receives the bare year', () => {
  // A select carries the employer's own option text and is matched against it. Widening the answer
  // there can only miss an option that "2028" matches exactly. An UNREPORTED type means discovery
  // never saw the control - Greenhouse's known-question aliases arrive that way, and Akuna's
  // "Graduation Year" React-select is one of them - so it is treated as a list too.
  for (const inputType of ['select', 'radio', 'checkbox', 'combobox', 'number', undefined]) {
    const actions = buildManagedPortalActions('lever', packetWith({
      graduationDate: 'May 2028',
      graduationMonth: 'May',
      graduationYear: '2028',
      questions: [{
        question: 'graduation year',
        answer: 'May 2028',
        portalSelector: '#grad-year',
        portalInputType: inputType,
      }],
    }));
    const values = actions
      .filter((action) => action.label?.startsWith('question') === true)
      .map((action) => action.value)
      .filter((value): value is string => typeof value === 'string');
    assert.ok(
      values.every((value) => value === '2028'),
      `${inputType} should be offered only the bare year, got ${JSON.stringify(values)}`,
    );
  }
});

test('the other graduation controls are unchanged', () => {
  const overrides: PacketOverrides = {
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
  };
  // A month control asks for a month and gets one. A date control asks for a date and gets one.
  // Neither route goes through the year rule, and neither changes.
  assert.equal(questionFillValue('ashby', {
    ...overrides,
    questions: [{
      question: 'graduation month',
      answer: 'May',
      portalSelector: '#grad-month',
      portalInputType: 'text',
    }],
  }, 'graduation month'), 'May');
  assert.equal(questionFillValue('ashby', {
    ...overrides,
    questions: [{
      question: 'expected graduation date',
      answer: 'May 2028',
      portalSelector: '#grad-date',
      portalInputType: 'text',
    }],
  }, 'expected graduation date'), 'May 2028');
});

test('a graduation-year question with no stored graduation facts is left as it was answered', () => {
  const value = questionFillValue('ashby', {
    graduationDate: undefined,
    graduationMonth: undefined,
    graduationYear: undefined,
    questions: [{
      question: 'expected graduation year',
      answer: 'Spring 2028',
      portalSelector: ASHBY_GRADUATION_SELECTOR,
      portalInputType: 'text',
    }],
  }, 'expected graduation year');
  assert.equal(value, 'Spring 2028');
});
