import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { academicsOfRecord, serveProfileJson } from './profile';

/* ISSUE-021, found on Mehek's live production account 2026-08-03. GET /profile served gpa "3.8"
 * from the resume parse while GET /profile/application served "3.89" from application_profile, in
 * the same session on the same account. Her resume prints "GPA: 3.89/4.0", so the parse was the
 * wrong copy - and it was the copy the dashboard showed her, while autofill typed the other one
 * into employer forms.
 *
 * Nothing reconciled the two stores. These tests pin the precedence that now does:
 * application_profile is the academic record, the parse is a seed for its blanks, and no surface
 * may state a grade that disagrees with the one an employer would receive.
 */

const EMAIL = 'student@usc.edu';
const PARSED = {
  full_name: 'Mehek Mandal',
  school: 'USC',
  gpa: '3.8',
  gpa_scale: '4.0',
  major: 'Computer Science and Business Administration',
};

describe('academicsOfRecord', () => {
  test('no application_profile row means there is no second value to contradict', () => {
    assert.deepEqual(academicsOfRecord(undefined), {});
  });

  test('a row is the whole answer, blanks included', () => {
    // Blank on the record means "not on record", which is also what autofill would send: nothing.
    assert.deepEqual(academicsOfRecord({ gpa: '3.89', gpa_scale: '', major: null }), {
      gpa: '3.89',
      gpa_scale: '',
      major: '',
    });
  });

  test('stored whitespace is not served as a value', () => {
    assert.deepEqual(academicsOfRecord({ gpa: '  3.89  ', gpa_scale: '   ', major: ' CS ' }), {
      gpa: '3.89',
      gpa_scale: '',
      major: 'CS',
    });
  });
});

describe('serveProfileJson academic precedence', () => {
  test('the served GPA is the one an employer would receive, not the parsed one', () => {
    const served = serveProfileJson(PARSED, null, EMAIL, {
      gpa: '3.89',
      gpa_scale: '4.0',
      major: 'Computer Science',
    });
    assert.equal(served.gpa, '3.89');
    assert.equal(served.major, 'Computer Science');
    // Everything the application profile has no opinion about still comes through untouched.
    assert.equal(served.full_name, 'Mehek Mandal');
    assert.equal(served.school, 'USC');
  });

  test('an unreadable application_profile suppresses the grade instead of falling back', () => {
    // applicationRowForProfile hands back {} when the row cannot be decrypted. Falling back to the
    // parse is what put a contradicting number on the screen, so a blank is the honest answer.
    const served = serveProfileJson(PARSED, null, EMAIL, {});
    assert.equal(served.gpa, '');
    assert.equal(served.gpa_scale, '');
    assert.equal(served.major, '');
  });

  test('a user with no application_profile row is served exactly what they were before', () => {
    const served = serveProfileJson(PARSED, null, EMAIL);
    assert.equal(served.gpa, '3.8');
    assert.equal(served.gpa_scale, '4.0');
    assert.equal(served.major, 'Computer Science and Business Administration');
  });
});
