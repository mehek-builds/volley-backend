import assert from 'node:assert/strict';
import test from 'node:test';

import { contentDispositionFileName, coverLetterFileNameForRole, resumeFileNameForRole } from './resumeFileName';

test('resume and cover letter filenames use first name, last name, role and required suffixes', () => {
  assert.equal(
    resumeFileNameForRole('Mehek Mandal', 'Hardware Product Management Intern'),
    'Mehek_Mandal_Hardware_Product_Management_Intern_resume.pdf',
  );
  assert.equal(
    coverLetterFileNameForRole('Mehek Mandal', 'Hardware Product Management Intern'),
    'Mehek_Mandal_Hardware_Product_Management_Intern_cover_letter.pdf',
  );
});

test('resume and cover letter filenames ignore middle names and sanitize role punctuation', () => {
  assert.equal(
    resumeFileNameForRole('Mehek K Mandal', '  AI/ML Engineer, Intern  - New Grad '),
    'Mehek_Mandal_AI_ML_Engineer_Intern_New_Grad_resume.pdf',
  );
  assert.equal(
    coverLetterFileNameForRole('Mehek K Mandal', '  AI/ML Engineer, Intern  - New Grad '),
    'Mehek_Mandal_AI_ML_Engineer_Intern_New_Grad_cover_letter.pdf',
  );
});

test('role-based filenames fall back when candidate or role data is missing', () => {
  assert.equal(
    resumeFileNameForRole('', ''),
    'Candidate_Role_resume.pdf',
  );
  assert.equal(
    coverLetterFileNameForRole(undefined, null),
    'Candidate_Role_cover_letter.pdf',
  );
});

test('download filename is safe for a quoted content disposition header', () => {
  assert.equal(
    contentDispositionFileName('Mehek_Mandal_AI/ML Engineer Resume.pdf'),
    'Mehek_Mandal_AI_ML_Engineer_Resume.pdf',
  );
});
