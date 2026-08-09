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

test('chooser policy hash identifies the exact declarative grammar bytes', () => {
  assert.equal(FINAL_SUBMIT_CHOOSER_POLICY.name, 'litos-final-submit');
  assert.equal(FINAL_SUBMIT_CHOOSER_POLICY.version, 2);
  assert.equal(FINAL_SUBMIT_CHOOSER_HASH, '3302786c27e20fc2dd0a7396078e286db37051962893b554e92b8fd9db6816e9');
  assert.equal(
    createHash('sha256').update(FINAL_SUBMIT_CHOOSER_GRAMMAR).digest('hex'),
    FINAL_SUBMIT_CHOOSER_HASH,
  );
});
