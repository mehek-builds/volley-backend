import assert from 'node:assert/strict';
import test from 'node:test';

import { contentDispositionFileName, resumeFileNameForRole } from './resumeFileName';

test('resume filename uses first name, last name, role and Resume suffix', () => {
  assert.equal(
    resumeFileNameForRole('Mehek Mandal', 'Hardware Product Management Intern'),
    'Mehek_Mandal_Hardware_Product_Management_Intern_Resume.pdf',
  );
});

test('resume filename ignores middle names and sanitizes role punctuation', () => {
  assert.equal(
    resumeFileNameForRole('Mehek K Mandal', 'AI/ML Engineer, Intern'),
    'Mehek_Mandal_AI_ML_Engineer_Intern_Resume.pdf',
  );
});

test('download filename is safe for a quoted content disposition header', () => {
  assert.equal(
    contentDispositionFileName('Mehek_Mandal_AI/ML Engineer Resume.pdf'),
    'Mehek_Mandal_AI_ML_Engineer_Resume.pdf',
  );
});
