import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { bankEntriesFromResumeSpec } from './experienceBank';
import type { ResumeSpec } from '../llm/resumeSpec';

const userId = '00000000-0000-4000-8000-000000000001';

test('approved base resume entries can seed the experience bank without inventing data', () => {
  const spec: ResumeSpec = {
    school: 'University of Southern California',
    degree: 'BS Computer Science',
    grad_date: 'May 2028',
    coursework: '',
    education_position: 'top',
    experience: [
      {
        type: 'job',
        org: 'Traeco',
        title: 'Founder',
        location: 'Los Angeles, CA',
        date_range: '2025 - Present',
        bullets: ['Built an AI workflow system.', '  ', 'Launched pilots with real users.'],
      },
      {
        type: 'leadership',
        org: 'Spark SC',
        title: 'Fellow',
        date_range: '2026',
        bullets: ['Led product research.'],
      },
    ],
    skills: ['Product strategy'],
  };

  const entries = bankEntriesFromResumeSpec(spec, userId);
  assert.deepEqual(entries.map((entry) => entry.type), ['job', 'leadership']);
  assert.equal(entries[0].org, 'Traeco');
  assert.equal(entries[0].title, 'Founder');
  assert.equal(entries[0].location, 'Los Angeles, CA');
  assert.deepEqual(entries[0].bullet_variants, ['Built an AI workflow system.', 'Launched pilots with real users.']);
  assert.equal(entries[1].org, 'Spark SC');
});

test('empty resume entries do not create ungrounded bank rows', () => {
  const spec: ResumeSpec = {
    school: '',
    degree: '',
    grad_date: '',
    coursework: '',
    education_position: 'top',
    experience: [
      { type: 'job', org: '', title: 'Intern', date_range: '2026', bullets: ['Built it'] },
      { type: 'project', org: 'Ghost Project', title: '', date_range: '', bullets: [] },
    ],
    skills: [],
  };

  assert.deepEqual(bankEntriesFromResumeSpec(spec, userId), []);
});

test('resume, answer, cover letter, gap evidence, and profile-bank reads use the approved-resume rescue path', () => {
  const sources = {
    resume: readFileSync('src/routes/resume.ts', 'utf8'),
    answer: readFileSync('src/routes/applicationAnswer.ts', 'utf8'),
    coverLetter: readFileSync('src/lib/coverLetterService.ts', 'utf8'),
    jdMatch: readFileSync('src/routes/jdMatch.ts', 'utf8'),
    profileBank: readFileSync('src/routes/experienceBank.ts', 'utf8'),
    applicationGates: readFileSync('src/routes/applications.ts', 'utf8'),
  };
  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /readExperienceBankOrSeedFromBaseResume/, name);
  }
  assert.doesNotMatch(sources.applicationGates, /import \{ readExperienceBank \}/);
});
