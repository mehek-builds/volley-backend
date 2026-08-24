import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isSelfDeclarationQuestion, selfDeclarationSkipReason } from './selfDeclaration';

/* THE HARD CONSTRAINT. Litos may relay a declaration she has made and may never compose one.
 *
 * Each label below is either verbatim from a live packet or the immediate sibling of one, and every
 * one of the first four is a question this codebase has ALREADY answered wrongly in production. */

test('the questions a machine may never answer for her', () => {
  const declarations = [
    // Answered "Dubai", because a residence rule matched "state" inside "state-owned".
    'Are you or have you been entrusted with a position or function in any government, international organization, or state-owned enterprise?',
    // Answered with a 600-word drafted essay opening "I have not applied to Akuna in the past".
    'Have you previously applied to work at Akuna?',
    // Auto-answered "Yes": a binding exclusivity commitment across a recruiting season.
    'By answering "yes" below, I acknowledge that this role is my top preference and I will not be considered for other tech and/or quant roles at Akuna this season',
    // Came back required-and-still-empty, recognised by nothing at all.
    'Astranis complies with U.S. Government space technology export regulations, including the International Traffic in Arms Regulations (ITAR). Are you a U.S. person as defined by these regulations?',
    // Sixteen of these on one DRW form, plus five of the settings variant.
    'Please rate your skill level in C++',
    'In which settings have you used Python? Select all that apply',
    // The rest of the declaration family.
    'Do you now OR in the future require visa sponsorship to continue working in the US?',
    'Have you served in the military?',
    'What are your personal pronouns?',
    'I certify that all information I have provided is true, complete, and accurate',
    'Privacy Policy Acknowledgement',
    'Interview Code of Conduct',
    'Have you ever been convicted of a felony?',
    'Are you at least 18 years of age?',
    'Are you considering or committed to pursuing further education immediately after completing your current academic studies?',
    'When did you graduate from High School?',
  ];
  for (const label of declarations) {
    assert.ok(isSelfDeclarationQuestion(label), `should be a self-declaration: ${label.slice(0, 60)}`);
  }
});

test('ordinary form fields are not declarations, so nothing here blocks a normal fill', () => {
  const ordinary = [
    'What is your phone number?',
    'LinkedIn Profile',
    'What is your GPA?',
    'Which University do you attend?',
    'Graduation Month',
    'Website',
    'Based on the team descriptions above, which opening would you be most interested in contributing to?',
    'What is your preferred work location?',
  ];
  for (const label of ordinary) {
    assert.ok(!isSelfDeclarationQuestion(label), `should not be a self-declaration: ${label}`);
  }
  assert.ok(!isSelfDeclarationQuestion(''));
});

test('the refusal names what is being refused rather than reporting a failure', () => {
  const reason = selfDeclarationSkipReason('Please rate your skill level in C++');
  assert.match(reason, /declaration about you/i);
  assert.match(reason, /Please rate your skill level in C\+\+/);
  // "we could not draft an answer" would be false: nothing was attempted, on purpose.
  assert.doesNotMatch(reason, /could not|failed|error/i);
});

test('the drafter is gated on this predicate, before the open-ended branch it used to reach', () => {
  const source = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  const declarationGate = source.indexOf('if (isSelfDeclarationQuestion(label)) {');
  const openEndedGate = source.indexOf('const wouldNotDraftNow = !isOpenEndedQuestion(label)');
  const drafter = source.indexOf('await draftApplicationAnswer(');
  assert.ok(declarationGate > 0, 'discoverAndResolveQuestions must consult isSelfDeclarationQuestion');
  assert.ok(openEndedGate > 0);
  assert.ok(drafter > 0);
  /* The second half of the same gate, added 2026-08-09. isOpenEndedQuestion reads the LABEL and
     cannot see the control, so a paragraph could be aimed at a select whose options it had never
     read: Virtu and Faire each came back "no option matched" with the drafted answer quoted back at
     them. A closed control is a fact about the form and is checked beside the predicate, not after
     it, so the drafter is unreachable for either reason. */
  assert.ok(source.indexOf('const closedControl =') > declarationGate);
  assert.ok(source.indexOf('|| closedControl;') > 0, 'the closed-control belt must be part of the same gate');
  // Order is the whole guarantee: a declaration is refused before anything can decide it reads as
  // an essay, and long before the model is asked for one.
  assert.ok(declarationGate < openEndedGate, 'the declaration gate must run before the open-ended test');
  assert.ok(declarationGate < drafter, 'the declaration gate must run before the drafter');
});

test('a refused declaration still becomes a question she can answer, when the employer requires it', () => {
  const source = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  const gate = source.slice(
    source.indexOf('if (isSelfDeclarationQuestion(label)) {'),
    source.indexOf('if (!isOpenEndedQuestion(label)) {'),
  );
  assert.match(gate, /\(fieldIsRequired \? attentionReasons : optionalAttentionReasons\)\.push\(selfDeclarationSkipReason\(label\)\)/);
  // Refusing without surfacing the field is what made a required attestation a wall: Litos would
  // not answer it and she had nowhere to.
  assert.match(gate, /if \(fieldIsRequired\) surfaceUnansweredQuestion\(field, reviewLabel, existing\)/);
});
