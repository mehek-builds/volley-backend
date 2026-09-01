import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { bankEntriesFromResumeSpec, missingBankEntriesFromResumeSpec } from './experienceBank';
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

test('base resume rescue fills missing entries in a partial experience bank', () => {
  const spec: ResumeSpec = {
    school: '',
    degree: '',
    grad_date: '',
    coursework: '',
    education_position: 'top',
    experience: [
      {
        type: 'job',
        org: 'Tonee',
        title: 'AI Engineer',
        date_range: '2025 - Present',
        bullets: ['Built a mobile inference feature.'],
      },
      {
        type: 'job',
        org: 'Cinematica Labs',
        title: 'Program Management Intern',
        date_range: 'June 2025 - August 2025',
        bullets: ['Built mentor-founder monitoring.'],
      },
    ],
    skills: [],
  };

  const missing = missingBankEntriesFromResumeSpec(spec, userId, [{
    type: 'job',
    org: 'Tonee',
    title: 'AI Engineer',
  }]);

  assert.deepEqual(missing.map((entry) => entry.org), ['Cinematica Labs']);
});

/* One venture is one bank row whichever section it prints under.
 *
 * The bank already holding Tonee as a `project` used to admit the base resume's `job` copy of it,
 * because the identity check opened by comparing types. The account then carried two rows for one
 * venture and /resume/generate selected both, printing the same bullets under EXPERIENCE and
 * PROJECTS. Pinned with the real production shape: user a18f774b carried exactly this pair. */
test('a venture already banked as a project is not re-seeded as a job', () => {
  const spec: ResumeSpec = {
    school: '',
    degree: '',
    grad_date: '',
    coursework: '',
    education_position: 'top',
    experience: [
      {
        type: 'job',
        org: 'Tonee - AI Texting Tone Detector',
        title: 'AI Engineer',
        date_range: 'September 2025 - Present',
        bullets: ['Shipped a consumer mobile app end to end.'],
      },
    ],
    skills: [],
  };

  const missing = missingBankEntriesFromResumeSpec(spec, userId, [{
    type: 'project',
    org: 'Tonee - AI Texting Tone Detector',
    title: 'AI Engineer',
  }]);

  assert.deepEqual(missing, []);
});

/* Two genuinely different roles at one organisation stay two rows. This is the case the type
   comparison was accidentally protecting, and it has to survive its removal: a promotion, or two
   lab positions at one university, is an ordinary resume shape that engine/resumeValidate.ts goes
   to some trouble to keep apart. Title is what separates them. */
test('a second distinct role at one organisation is still seeded', () => {
  const spec: ResumeSpec = {
    school: '',
    degree: '',
    grad_date: '',
    coursework: '',
    education_position: 'top',
    experience: [
      {
        type: 'job',
        org: 'Department of Biology',
        title: 'Research Assistant',
        date_range: '2026 - Present',
        bullets: ['Ran assays for a protein folding study.'],
      },
    ],
    skills: [],
  };

  const missing = missingBankEntriesFromResumeSpec(spec, userId, [{
    type: 'job',
    org: 'Department of Biology',
    title: 'Lab Technician',
  }]);

  assert.deepEqual(missing.map((entry) => entry.title), ['Research Assistant']);
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

/* A BLANK TITLE KEEPS ITS TYPE DISCRIMINATOR.
 *
 * Dropping type from the identity check entirely made this case collapse: the bank's leadership
 * row suppressed an untitled PROJECT at the same org describing completely different work, and the
 * student lost that entry from their bank for good. Same org plus same title still collapses
 * across types (the test above); same org plus an unknown title collapses only within a type. */
test('an untitled entry is not suppressed by a different-type row at the same org', () => {
  const spec: ResumeSpec = {
    school: '',
    degree: '',
    grad_date: '',
    coursework: '',
    education_position: 'top',
    experience: [
      {
        type: 'project',
        org: 'USC Lava Lab',
        title: '',
        date_range: '2025',
        bullets: ['Built a matching engine pairing founders with mentors across the cohort.'],
      },
    ],
    skills: [],
  };

  const missing = missingBankEntriesFromResumeSpec(spec, userId, [{
    type: 'leadership',
    org: 'USC Lava Lab',
    title: 'Product Manager',
  }]);

  assert.deepEqual(missing.map((entry) => entry.org), ['USC Lava Lab']);
});

/* The same untitled entry IS suppressed by a row of its own type, which is the pre-existing
   leniency this branch preserves rather than a behaviour the review change introduced. */
test('an untitled entry is still suppressed by a same-type row at the same org', () => {
  const spec: ResumeSpec = {
    school: '',
    degree: '',
    grad_date: '',
    coursework: '',
    education_position: 'top',
    experience: [
      {
        type: 'project',
        org: 'USC Lava Lab',
        title: '',
        date_range: '2025',
        bullets: ['Built a matching engine pairing founders with mentors across the cohort.'],
      },
    ],
    skills: [],
  };

  const missing = missingBankEntriesFromResumeSpec(spec, userId, [{
    type: 'project',
    org: 'USC Lava Lab',
    title: 'Builder',
  }]);

  assert.deepEqual(missing, []);
});
