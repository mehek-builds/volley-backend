import assert from 'node:assert/strict';
import test from 'node:test';
import { countryForPhoneField, isCallingCodeQuestion } from './phoneCountry';

test('the dial code decides the country, and a number without one falls back to where she lives', () => {
  assert.equal(countryForPhoneField('+12135746270', 'United Arab Emirates'), 'United States');
  assert.equal(countryForPhoneField('+971 56 741 7451', 'United States'), 'United Arab Emirates');
  assert.equal(countryForPhoneField('+44 20 7946 0958', undefined), 'United Kingdom');
  // The longest matching code wins: +91 is India, not +9 anything.
  assert.equal(countryForPhoneField('+919876543210', 'United States'), 'India');
  assert.equal(countryForPhoneField('2135746270', 'United States'), 'United States');
  assert.equal(countryForPhoneField(undefined, 'United States'), 'United States');
  assert.equal(countryForPhoneField('+999 1234', 'United States'), 'United States');
  assert.equal(countryForPhoneField(undefined, undefined), undefined);
});

test('a label asking which code is a calling-code question; one asking for the number is not', () => {
  // Measured on dsiinnovations.recruitee.com, 2026-09-01: the control's current value rides on the label.
  assert.equal(isCallingCodeQuestion('select country calling code: united states'), true);
  assert.equal(isCallingCodeQuestion('Country calling code'), true);
  assert.equal(isCallingCodeQuestion('Country code'), true);
  assert.equal(isCallingCodeQuestion('Phone country code'), true);
  assert.equal(isCallingCodeQuestion('Please select your country code'), true);
  assert.equal(isCallingCodeQuestion('International dialling code (e.g. +1)'), true);
  assert.equal(isCallingCodeQuestion('Dial code'), true);
  assert.equal(isCallingCodeQuestion('Telephone country code'), true);
  assert.equal(isCallingCodeQuestion('What is your telephone country code?'), true);
  assert.equal(isCallingCodeQuestion('Mobile country code'), true);
  assert.equal(isCallingCodeQuestion('Choose country code'), true);
  assert.equal(isCallingCodeQuestion('Enter country code'), true);
  assert.equal(isCallingCodeQuestion('Phone number country code'), false);
  // The teamtailor placeholder label asks for the number and only mentions its code.
  assert.equal(isCallingCodeQuestion('phone number with country code +1 201-555-0123'), false);
  assert.equal(isCallingCodeQuestion('Mobile number (include country code)'), false);
  assert.equal(isCallingCodeQuestion('Country of residence'), false);
  assert.equal(isCallingCodeQuestion('Which country are you based in?'), false);
  assert.equal(isCallingCodeQuestion('Postal code'), false);
  assert.equal(isCallingCodeQuestion('Do you have a referral code?'), false);
});
