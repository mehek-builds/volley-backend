import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contentDispositionFileName,
  coverLetterFileNameForRole,
  resumeFileNameForRole,
  transcriptFileNameForRole,
} from './resumeFileName';

test('resume and cover letter filenames use first name, last name, role and required suffixes', () => {
  assert.equal(
    resumeFileNameForRole('Mehek Mandal', 'Hardware Product Management Intern'),
    'Mehek_Mandal_Hardware_Product_Management_Intern_Resume.pdf',
  );
  assert.equal(
    coverLetterFileNameForRole('Mehek Mandal', 'Hardware Product Management Intern'),
    'Mehek_Mandal_Hardware_Product_Management_Intern_Cover_Letter.pdf',
  );
});

test('resume and cover letter filenames ignore middle names and sanitize role punctuation', () => {
  assert.equal(
    resumeFileNameForRole('Mehek K Mandal', '  AI/ML Engineer, Intern  - New Grad '),
    'Mehek_Mandal_AI_ML_Engineer_Intern_New_Grad_Resume.pdf',
  );
  assert.equal(
    coverLetterFileNameForRole('Mehek K Mandal', '  AI/ML Engineer, Intern  - New Grad '),
    'Mehek_Mandal_AI_ML_Engineer_Intern_New_Grad_Cover_Letter.pdf',
  );
});

test('role-based filenames fall back when candidate or role data is missing', () => {
  assert.equal(
    resumeFileNameForRole('', ''),
    'Candidate_Role_Resume.pdf',
  );
  assert.equal(
    coverLetterFileNameForRole(undefined, null),
    'Candidate_Role_Cover_Letter.pdf',
  );
});

/* The file Litos did not make gets the same name as the two it did, because it arrives in the same
   recruiter's inbox beside them. Her own upload's name is the one string in the packet that has
   never been normalized: it can carry a student id, a download counter, or somebody else's name off
   a shared folder. Nothing downstream reads the name, so renaming it costs the file nothing. */
test('an attached transcript is named the same way as the resume and the cover letter', () => {
  assert.equal(
    transcriptFileNameForRole('Mehek Mandal', 'Hardware Product Management Intern'),
    'Mehek_Mandal_Hardware_Product_Management_Intern_Transcript.pdf',
  );
  assert.equal(
    transcriptFileNameForRole('Mehek K Mandal', '  AI/ML Engineer, Intern  - New Grad '),
    'Mehek_Mandal_AI_ML_Engineer_Intern_New_Grad_Transcript.pdf',
  );
  assert.equal(transcriptFileNameForRole(undefined, null), 'Candidate_Role_Transcript.pdf');
});

test('download filename is safe for a quoted content disposition header', () => {
  assert.equal(
    contentDispositionFileName('Mehek_Mandal_AI/ML Engineer Resume.pdf'),
    'Mehek_Mandal_AI_ML_Engineer_Resume.pdf',
  );
});
