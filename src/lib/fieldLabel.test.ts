import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeRequiredBlocker,
  describeUnlabelledBlockers,
  humanFieldLabel,
  isOpaqueIdentifier,
  tidyLabel,
} from './fieldLabel';

// R-048, from live QA 2026-07-23 against real Greenhouse and Ashby forms.

test('the literal fallback that produced "required field is required" cannot recur', () => {
  // The old code did (aria-label ?? name ?? 'required field') + ' is required'.
  const sentence = describeRequiredBlocker(humanFieldLabel([null, undefined, '']));
  assert.doesNotMatch(sentence, /required field is required/);
  assert.match(sentence, /no label Litos can read/);
});

test('a Greenhouse UUID field name never reaches the user', () => {
  const uuid = '5a326a1d-1a9e-42b1-a918-ca74022064dc';
  assert.equal(isOpaqueIdentifier(uuid), true);
  assert.equal(humanFieldLabel([uuid]), null);
  assert.doesNotMatch(describeRequiredBlocker(humanFieldLabel([uuid])), /5a326a1d/);
});

test('every opaque id shape observed on real portals is rejected', () => {
  for (const opaque of [
    '6c37e676-e0c3-45b7-99fb-661fe93bc270',
    '9f8d4312-8d32-4bc2-baf2-e2ff2b684844',
    'a3f9c2e14b7d0918',
    '_systemfield_location',
    'cf-4820193',
    'question[12]',
    'job_application[answers][0]',
    'field_9',
    '4820193',
    '   ',
  ]) {
    assert.equal(isOpaqueIdentifier(opaque), true, `${opaque} should be opaque`);
  }
});

test('genuine labels are kept', () => {
  for (const real of [
    'First Name',
    'Are you legally eligible to work in the United States?',
    'GPA',
    'Resume/CV',
    'What is your top location preference?',
  ]) {
    assert.equal(isOpaqueIdentifier(real), false, `${real} should be treated as a label`);
  }
});

test('vowelless acronyms are labels, not machine ids', () => {
  // A "single token with no vowel is machine-generated" rule was tried and removed: it swallowed
  // these, and suppressing one costs the user the name of the field blocking their application.
  for (const acronym of ['CV', 'SSN', 'PhD', 'MD', 'NDA', 'DBS']) {
    assert.equal(isOpaqueIdentifier(acronym), false, `${acronym} should be treated as a label`);
    assert.equal(humanFieldLabel([acronym]), acronym);
  }
});

test('the visible label wins over the opaque name attribute', () => {
  const label = humanFieldLabel([
    'Please indicate your overall GPA. *',
    '5a326a1d-1a9e-42b1-a918-ca74022064dc',
  ]);
  assert.equal(label, 'Please indicate your overall GPA.');
});

test('an opaque first candidate falls through to a later human one', () => {
  // aria-labelledby resolving to nothing, then a real placeholder.
  const label = humanFieldLabel([null, 'cf-4820193', 'Phone number']);
  assert.equal(label, 'Phone number');
});

test('required-marker decoration is stripped, not shown to the user', () => {
  assert.equal(tidyLabel('  School *  '), 'School');
  assert.equal(tidyLabel('Degree:'), 'Degree');
  assert.equal(tidyLabel('Start date (required)'), 'Start date');
  assert.equal(tidyLabel('Cover\n  Letter'), 'Cover Letter');
});

test('a very long label is truncated rather than flooding the blocker screen', () => {
  const long = `${'Describe a time you '.repeat(20)}end`;
  const label = humanFieldLabel([long]);
  assert.ok(label);
  assert.ok(label.length <= 120, `got ${label.length}`);
  assert.match(label, /\.\.\.$/);
});

test('the blocker sentence quotes the field so it can be found on the page', () => {
  assert.equal(
    describeRequiredBlocker('Are you legally eligible to work in the United States?'),
    '"Are you legally eligible to work in the United States?" is required and is still empty',
  );
});

test('an unlabelled field is described by its input type when that helps', () => {
  assert.match(describeRequiredBlocker(null, { type: 'file' }), /required file field/);
  assert.match(describeRequiredBlocker(null, { type: null }), /A required field on the form/);
});

test('the sentence never says "is required" twice', () => {
  for (const candidate of [null, 'GPA', 'required field']) {
    const sentence = describeRequiredBlocker(humanFieldLabel([candidate]));
    assert.ok((sentence.match(/is required/g) ?? []).length <= 1, sentence);
  }
});

// The following were all found by adversarial review of the first cut of this file, 2026-07-23.
// Each is a case where the heuristics told the user "no label Litos can read" while a perfectly
// readable label sat on the form, or let a machine handle through.

test('non-Latin labels are labels, not machine ids', () => {
  // An ASCII-only letter test classified every localised label as opaque, so a Greenhouse or Ashby
  // posting in any non-English locale reported all of its blocked fields as unreadable.
  for (const label of ['姓名', '氏名', 'Фамилия', 'الاسم', '이름', 'Ονοματεπώνυμο']) {
    assert.equal(isOpaqueIdentifier(label), false, `${label} should be treated as a label`);
    assert.equal(humanFieldLabel([label]), label);
  }
});

test('accented and non-English Latin labels survive', () => {
  for (const label of ['Prénom', 'Año de graduación', 'Führerschein', 'Endereço']) {
    assert.equal(isOpaqueIdentifier(label), false, `${label} should be treated as a label`);
  }
});

test('framework handles flattened into an id are still rejected', () => {
  // portalSubmission offers the element id as a last-resort candidate, and Rails renders
  // job_application[answers_attributes][0][text_value] as an underscore-flattened id.
  for (const handle of [
    'job_application_answers_attributes_0_text_value',
    'answers_attributes_2_boolean_value',
    'urn:li:answer:9911',
    'customQuestion12345',
    'some.nested.path[0]',
  ]) {
    assert.equal(isOpaqueIdentifier(handle), true, `${handle} should be opaque`);
  }
});

test('a label containing a colon or digits is still a label', () => {
  // The structural-token rules must only apply to unspaced tokens with INTERNAL punctuation, or
  // real prose gets suppressed. Asserted through humanFieldLabel, which is how callers reach this:
  // tidyLabel strips the trailing decoration first.
  for (const label of ['Degree: ', 'Graduation year (e.g. 2028)', 'Address line 2', 'GPA out of 4.0']) {
    assert.ok(humanFieldLabel([label]), `${label} should survive as a label`);
  }
  assert.equal(isOpaqueIdentifier('Degree'), false);
});

test('unlabelled fields are counted, not collapsed into one line', () => {
  // Every unlabelled field yields an identical sentence, so deduping them as strings turned five
  // blocked fields into one and the student would fix one thing and fail again learning nothing.
  assert.equal(describeUnlabelledBlockers(1), describeRequiredBlocker(null));
  assert.match(describeUnlabelledBlockers(4), /^4 required fields/);
  assert.match(describeUnlabelledBlockers(4), /have no label Litos can read/);
});
