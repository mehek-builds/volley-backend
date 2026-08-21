import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  chooseCanonicalFinalSubmit,
  FINAL_SUBMIT_CHOOSER_GRAMMAR,
  FINAL_SUBMIT_CHOOSER_HASH,
  FINAL_SUBMIT_CHOOSER_POLICY,
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
  assert.equal(FINAL_SUBMIT_CHOOSER_HASH, '9bd60803e7a713555132b6740e9765599ba975e75f803f436841dbc6d340091e');
  assert.equal(
    createHash('sha256').update(FINAL_SUBMIT_CHOOSER_GRAMMAR).digest('hex'),
    FINAL_SUBMIT_CHOOSER_HASH,
  );
});
