import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  chooseCanonicalFinalSubmit,
  exactFinalSubmitChooserPolicy,
  FINAL_SUBMIT_CHOOSER_GRAMMAR,
  FINAL_SUBMIT_CHOOSER_GRAMMAR_V4,
  FINAL_SUBMIT_CHOOSER_HASH,
  FINAL_SUBMIT_CHOOSER_HASH_V4,
  FINAL_SUBMIT_CHOOSER_POLICIES,
  FINAL_SUBMIT_CHOOSER_POLICY,
  FINAL_SUBMIT_CHOOSER_POLICY_V3,
  FINAL_SUBMIT_CHOOSER_POLICY_V4,
  finalSubmitLabelScore,
} from './finalSubmitChooserPolicy';

test('canonical final-submit grammar preserves approved application labels', () => {
  for (const label of [
    'Submit',
    'Apply',
    'Apply now',
    'Submit application',
    'Submit my application',
    'Send this application',
    'Submit application with attachments',
    'Submit your application with cover letter',
    'Send application from your profile',
    'Send application from your saved details',
    'Submit application for review',
    'Finish & apply',
    'Submit your application - Contact Center Agent',
    'Submit application - Acme Corp',
    // Recruitee localizes the stock final control. Captured live on CBS Consulting's German form.
    'Senden',
  ]) assert.notEqual(finalSubmitLabelScore(label), null, label);
});

test('canonical final-submit grammar rejects handoff, social, support and progression labels', () => {
  for (const label of [
    'Apply with LinkedIn',
    'Apply With Indeed',
    'Continue with Google',
    'Sign in with Apple',
    'Apply now with our recruiting partner',
    'Import profile',
    'Autofill with resume service',
    'Quick apply',
    'One-click apply',
    'Submit feedback',
    'Submit a support request',
    'Submit your question',
    'Submit application feedback',
    'Continue',
    'Next',
    'Start',
    'Start application',
    'Complete',
    'Finish',
    'Review application',
    'Review and submit',
    'Save and continue',
  ]) assert.equal(finalSubmitLabelScore(label), null, label);
});

test('canonical chooser ranks explicit application intent and blocks equal top candidates', () => {
  assert.equal(chooseCanonicalFinalSubmit(['Apply', 'Submit application']), 1);
  assert.equal(chooseCanonicalFinalSubmit(['Apply now', 'Submit']), 0);
  assert.equal(chooseCanonicalFinalSubmit(['Submit application', 'Submit application']), null);
  assert.equal(chooseCanonicalFinalSubmit(['Apply with LinkedIn', 'Submit application']), 1);
});

test('CBS German Recruitee chooses only the exact final control', () => {
  const labels = [
    'Über Indeed bewerben',
    'Bewerben mit XING',
    'Weiter',
    'Anfrage senden',
    'Senden',
  ];
  assert.equal(chooseCanonicalFinalSubmit(labels), 4);
  for (const label of labels.slice(0, -1)) {
    assert.equal(finalSubmitLabelScore(label), null, label);
  }
  assert.equal(chooseCanonicalFinalSubmit(['Senden', 'Senden']), null);
});

test('chooser policy hash identifies the exact declarative grammar bytes', () => {
  assert.equal(FINAL_SUBMIT_CHOOSER_POLICY.name, 'litos-final-submit');
  assert.equal(FINAL_SUBMIT_CHOOSER_POLICY.version, 3);
  assert.equal(FINAL_SUBMIT_CHOOSER_POLICY, FINAL_SUBMIT_CHOOSER_POLICY_V3);
  assert.equal(FINAL_SUBMIT_CHOOSER_HASH, '9bd60803e7a713555132b6740e9765599ba975e75f803f436841dbc6d340091e');
  assert.equal(
    createHash('sha256').update(FINAL_SUBMIT_CHOOSER_GRAMMAR).digest('hex'),
    FINAL_SUBMIT_CHOOSER_HASH,
  );
});

test('v4 adds only bare Send to the managed positive grammar', () => {
  assert.equal(FINAL_SUBMIT_CHOOSER_POLICY_V4.name, 'litos-final-submit');
  assert.equal(FINAL_SUBMIT_CHOOSER_POLICY_V4.version, 4);
  assert.equal(FINAL_SUBMIT_CHOOSER_HASH_V4, 'ee6697971965f0ab360f77da88d935a58b0b7af8ea412ad5d5b3813e9cc11263');
  assert.equal(
    createHash('sha256').update(FINAL_SUBMIT_CHOOSER_GRAMMAR_V4).digest('hex'),
    FINAL_SUBMIT_CHOOSER_HASH_V4,
  );
  assert.equal(
    FINAL_SUBMIT_CHOOSER_POLICY_V4.finalPattern,
    FINAL_SUBMIT_CHOOSER_POLICY_V3.finalPattern.replace('^\\s*apply\\s*$', '^\\s*send\\s*$|^\\s*apply\\s*$'),
  );
  assert.equal(FINAL_SUBMIT_CHOOSER_POLICY_V4.exclusionPattern, FINAL_SUBMIT_CHOOSER_POLICY_V3.exclusionPattern);
});

test('exact registry accepts only byte-identical v3 and v4 policies', () => {
  assert.equal(Object.isFrozen(FINAL_SUBMIT_CHOOSER_POLICIES), true);
  assert.equal(Object.isFrozen(FINAL_SUBMIT_CHOOSER_POLICY_V3), true);
  assert.equal(Object.isFrozen(FINAL_SUBMIT_CHOOSER_POLICY_V4), true);
  assert.equal(exactFinalSubmitChooserPolicy({ ...FINAL_SUBMIT_CHOOSER_POLICY_V3 }), FINAL_SUBMIT_CHOOSER_POLICY_V3);
  assert.equal(exactFinalSubmitChooserPolicy({ ...FINAL_SUBMIT_CHOOSER_POLICY_V4 }), FINAL_SUBMIT_CHOOSER_POLICY_V4);
  assert.equal(exactFinalSubmitChooserPolicy({ ...FINAL_SUBMIT_CHOOSER_POLICY_V4, version: 5 }), null);
  assert.equal(exactFinalSubmitChooserPolicy({ ...FINAL_SUBMIT_CHOOSER_POLICY_V4, grammarHash: '0'.repeat(64) }), null);
  assert.equal(exactFinalSubmitChooserPolicy({ ...FINAL_SUBMIT_CHOOSER_POLICY_V4, extra: true }), null);
});

test('direct chooser keeps bare Send disabled under the compatibility v3 policy', () => {
  assert.equal(finalSubmitLabelScore('Send'), null);
  assert.equal(chooseCanonicalFinalSubmit(['Send']), null);
  assert.equal(chooseCanonicalFinalSubmit(['Send', 'Submit application']), 1);
});
