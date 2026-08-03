import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsedProfileFromModelText,
  parsedProfileWithOneRepair,
  splitSpokenLanguages,
  SYSTEM_PROMPT,
} from './parse';

// R-047, found in live QA 2026-07-23. Mehek's uploaded resume reads "Bachelor of Science in Computer
// Science & Business Administration, Finance Emphasis". The parser stored "Bachelor of Science in
// Business Administration, Emphasis in Finance": the Computer Science half was dropped and the
// emphasis reworded. Every tailored resume then presented a computer science candidate as a finance
// candidate, and resumeValidate's "education degree differs from uploaded resume" check could not
// catch it, because that check compares the spec against this same corrupted stored value. The only
// defence is the parse prompt, so pin its load-bearing clauses.

test('the parse prompt demands a verbatim degree', () => {
  assert.match(SYSTEM_PROMPT, /copied VERBATIM/);
});

test('the parse prompt names the joint-degree failure it exists to prevent', () => {
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /joint or dual degree/);
  assert.match(flat, /carry BOTH halves/i);
});

test('the prompt does not hand the model a ready-made degree to copy', () => {
  // Few-shot contamination: a plausible verbatim degree inside model-visible text is something the
  // model can emit when a resume's education section is unclear, which is the exact fabrication the
  // rule forbids. The concrete R-047 strings belong in a code comment, not the prompt.
  assert.doesNotMatch(SYSTEM_PROMPT, /Bachelor of Science in/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /Emphasis in Finance/i);
});

test('the parse prompt forbids inferring a degree from the school or college name', () => {
  // The prompt is a wrapped template literal, so match across the line breaks rather than pinning
  // one particular wrap position: rewrapping the paragraph must not fail this test.
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /never let the school or college name influence the degree/i);
  assert.match(flat, /business school hosts non-business degrees/i);
});

test('the parse prompt still requires an empty string over an invented degree', () => {
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /return an empty string rather than inferring one/i);
});

test('the parse prompt keeps the precise graduation date', () => {
  // Summer 2027 eligibility turns on this. A resume that loses "May 2027" down to a bare year, or
  // gains a year it never printed, changes whether the student qualifies for the posting at all.
  assert.match(SYSTEM_PROMPT, /most precise date printed on the resume/i);
});

test('the parse prompt pins the five-role evidence and ordering contract', () => {
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /exactly five distinct job titles/i);
  assert.match(flat, /ordered from strongest to weakest fit/i);
  assert.match(flat, /dated years of experience, past job titles, projects, skills, and stated degree/i);
  assert.match(flat, /match the seniority shown by the evidence/i);
  assert.match(flat, /do not invent a field the resume does not support/i);
  assert.match(flat, /do not return five cosmetic variations/i);
  assert.match(flat, /space of valid job titles is open-ended/i);
  assert.match(flat, /never restrict recommendations.*predefined occupation list/i);
});

function modelProfile(target_roles: unknown): string {
  return JSON.stringify({
    full_name: 'A Candidate', experience: [], skills: [], projects: [], school: '',
    grad_year: 0, target_roles,
  });
}

test('the parser accepts exactly five distinct non-empty target roles and trims them', () => {
  const parsed = parsedProfileFromModelText(modelProfile([
    ' Software Engineer ', 'Backend Engineer', 'Frontend Engineer', 'Product Engineer', 'Data Engineer',
  ]));
  assert.deepEqual(parsed.target_roles, [
    'Software Engineer', 'Backend Engineer', 'Frontend Engineer', 'Product Engineer', 'Data Engineer',
  ]);
});

test('the parser normalizes roles without inventing unrelated fallback careers', () => {
  assert.throws(() => parsedProfileFromModelText(modelProfile(undefined)), /five evidence-backed/);
  assert.throws(() => parsedProfileFromModelText(modelProfile(['Nurse', 'Teacher'])), /five evidence-backed/);
  assert.deepEqual(
    parsedProfileFromModelText(modelProfile(['One', 'Two', 'Three', 'Four', 'Five', 'Six'])).target_roles,
    ['One', 'Two', 'Three', 'Four', 'Five'],
  );
  assert.throws(
    () => parsedProfileFromModelText(JSON.stringify({
      ...JSON.parse(modelProfile(['Nurse', 'Clinical Researcher', 'Care Coordinator', 'Health Educator'])),
      experience: [{ company: 'Hospital', title: 'Registered Nurse', start: '', end: '', description: '' }],
    })),
    /five evidence-backed/,
  );
});

test('the parser keeps every suggested title within the targeting API limit', () => {
  const parsed = parsedProfileFromModelText(modelProfile([
    'A'.repeat(120), 'Backend Engineer', 'Frontend Engineer', 'Product Engineer', 'Data Engineer',
  ]));
  assert.equal(parsed.target_roles[0].length, 80);
  assert.ok(parsed.target_roles.every((role) => role.length <= 80));
});

test('a short role list gets exactly one bounded quality repair', async () => {
  let calls = 0;
  const repaired = await parsedProfileWithOneRepair(modelProfile(['One', 'Two']), async (failure) => {
    calls += 1;
    assert.match(failure, /five evidence-backed target roles/);
    return modelProfile(['One', 'Two', 'Three', 'Four', 'Five']);
  });

  assert.equal(calls, 1);
  assert.deepEqual(repaired.target_roles, ['One', 'Two', 'Three', 'Four', 'Five']);
});

test('a failed repair is not retried indefinitely', async () => {
  let calls = 0;
  await assert.rejects(
    parsedProfileWithOneRepair(modelProfile(['One']), async () => {
      calls += 1;
      return modelProfile(['One', 'Two']);
    }),
    /five evidence-backed target roles/,
  );
  assert.equal(calls, 1);
});

test('open-ended real job titles do not depend on a hard-coded occupation vocabulary', async () => {
  let calls = 0;
  const parsed = await parsedProfileWithOneRepair(modelProfile([
    'Private Equity Associate',
    'Growth Equity Analyst',
    'Search Fund Associate',
    'Infrastructure Investment Analyst',
    'Venture Capital Analyst',
  ]), async () => {
    calls += 1;
    return modelProfile(['One', 'Two', 'Three', 'Four', 'Five']);
  });

  assert.equal(calls, 0);
  assert.equal(parsed.target_roles[0], 'Private Equity Associate');
});

/* ISSUE-020, found on the live demo account 2026-08-03. ParsedProfile had no `languages` key, so
 * the extractor filed spoken languages under `skills`: English, Hindi, Punjabi, French, Arabic and
 * Spanish arrived AHEAD of C++, Figma and Python, because a resume prints its language line above
 * its technical line. baseResume.ts's skillsSourceFor falls back to this array whenever the declared
 * profiles.skills column is null, which is every student at onboarding, so every tailored resume the
 * account produced led its skills section with six spoken languages. */

const FIVE_ROLES = ['One', 'Two', 'Three', 'Four', 'Five'];

function modelSkills(skills: unknown, languages?: unknown): string {
  return JSON.stringify({
    full_name: 'A Candidate', experience: [], skills, projects: [], school: '',
    grad_year: 0, target_roles: FIVE_ROLES, ...(languages === undefined ? {} : { languages }),
  });
}

test('spoken languages do not land in skills', () => {
  const parsed = parsedProfileFromModelText(modelSkills([
    'English', 'Hindi', 'Punjabi', 'French', 'Arabic', 'Spanish',
    'MS PowerPoint', 'Adobe Photoshop', 'C++', 'Figma', 'Python',
  ]));

  assert.deepEqual(parsed.skills, ['MS PowerPoint', 'Adobe Photoshop', 'C++', 'Figma', 'Python']);
  assert.deepEqual(parsed.languages, ['English', 'Hindi', 'Punjabi', 'French', 'Arabic', 'Spanish']);
  // The regression was as much about ORDER as membership: the first skill on the generated resume
  // must now be a technical one.
  assert.equal(parsed.skills[0], 'MS PowerPoint');
});

test('programming languages and tools survive the language split', () => {
  // Every name here is one a careless spoken-language list would swallow. Losing any of them
  // deletes a real engineering skill from the student's resume, which is worse than the bug.
  const technical = ['Go', 'R', 'Rust', 'Swift', 'Ruby', 'Julia', 'Scheme', 'Java', 'Basic', 'Processing'];
  const parsed = parsedProfileFromModelText(modelSkills(technical));

  assert.deepEqual(parsed.skills, technical);
  assert.deepEqual(parsed.languages, []);
});

test('a stated proficiency is carried across rather than flattened to bare fluency', () => {
  // "Spanish (basic)" reduced to "Spanish" would read as fluency the student never claimed.
  const parsed = parsedProfileFromModelText(modelSkills([
    'Spanish (conversational)', 'French - fluent', 'Mandarin Chinese: native', 'Python',
  ]));

  assert.deepEqual(parsed.skills, ['Python']);
  assert.deepEqual(parsed.languages, [
    'Spanish (conversational)', 'French - fluent', 'Mandarin Chinese: native',
  ]);
});

test('the model answer leads and the reclassified remainder is merged in without duplicates', () => {
  const parsed = parsedProfileFromModelText(modelSkills(['Hindi', 'english', 'Figma'], ['English', 'Tamil']));

  assert.deepEqual(parsed.skills, ['Figma']);
  // "english" off the skills line is the same language as the model's "English", so the first
  // spelling wins and the entry is not repeated.
  assert.deepEqual(parsed.languages, ['English', 'Tamil', 'Hindi']);
});

test('a resume printing no language line yields an empty list, never an inferred one', () => {
  const parsed = parsedProfileFromModelText(modelSkills(['Python', 'Figma']));

  assert.deepEqual(parsed.skills, ['Python', 'Figma']);
  assert.deepEqual(parsed.languages, []);
});

test('the split tolerates the malformed skills arrays the model actually emits', () => {
  assert.deepEqual(splitSpokenLanguages(null), { skills: [], languages: [] });
  assert.deepEqual(splitSpokenLanguages('English'), { skills: [], languages: [] });
  assert.deepEqual(
    splitSpokenLanguages(['  ', 7, null, ' Hindi ', 'Figma']),
    { skills: ['Figma'], languages: ['Hindi'] },
  );
});

test('the parse prompt keeps spoken languages out of the skills field', () => {
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /"skills" is TECHNICAL and professional ability only/i);
  assert.match(flat, /never contain a spoken or natural language/i);
  assert.match(flat, /"languages" holds the spoken or natural languages printed on the resume/i);
  assert.match(flat, /programming languages are NOT spoken languages and belong in "skills"/i);
  // The parser may not manufacture a fluency claim the page never printed.
  assert.match(flat, /never infer a language from the applicant's name, school, or country/i);
});
