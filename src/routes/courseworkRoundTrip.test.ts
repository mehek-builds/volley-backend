import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';
import { applyResumePolicy, educationFrom } from '../engine/resumePolicy';
import { applyParsedProfilePatch, parsedProfilePatchSchema } from './profile';

/* ISSUE-044: the write path and the read path disagreed about the SHAPE of one field, and nothing
 * on either side alone could see it.
 *
 * PATCH /profile/parsed stored `coursework` as the plain string the review screen edits; the resume
 * generator read it with Array.isArray and got undefined; `(education.coursework ?? []).join(', ')`
 * then printed an EMPTY "Relevant coursework" line. The save returned 200, the dashboard went on
 * showing the text the student had typed, and the loss was visible only in a generated PDF.
 *
 * WHY THIS TEST CROSSES THE BOUNDARY RATHER THAN TESTING EITHER SIDE. A unit test of the patch
 * function asserts what it stored and passes. A unit test of the generator feeds it an array and
 * passes. Both sides were internally consistent and individually green while the product silently
 * dropped a resume line. The only assertion that could have caught this is one that puts a real
 * patch payload in at one end and reads the rendered line out of the other, so that is what this
 * file does: schema -> applyParsedProfilePatch -> stored parsed_json -> educationFrom ->
 * applyResumePolicy -> spec.coursework.
 */

const COURSES = [
  'Data Structures and Object-Oriented Design',
  'Financial Analysis & Valuation',
  'Business Finance',
  'Accounting',
  'Macroeconomics',
  'Communication',
];

function bank(): ExperienceBankEntry[] {
  return [
    {
      id: '1',
      user_id: 'user-1',
      type: 'job',
      org: 'Acme Labs',
      title: 'Product Intern',
      date_range: '2025 - Present',
      bullet_variants: [
        'Analyzed customer interviews and translated findings into launch priorities for the team',
        'Built weekly dashboards that tracked activation across three onboarding paths',
        'Presented research findings to leaders and secured approval for two experiments',
      ],
      tags: [],
      created_at: new Date('2026-01-01'),
    } as ExperienceBankEntry,
  ];
}

function rawSpec(): ResumeSpec {
  return {
    school: 'University of Southern California',
    degree: 'BS Computer Science and Business Administration',
    grad_date: 'May 2028',
    coursework: '',
    education_position: 'top',
    experience: bank().map((entry) => ({
      type: 'job' as const,
      org: entry.org,
      title: entry.title ?? '',
      date_range: entry.date_range ?? '',
      bullets: entry.bullet_variants as string[],
    })),
    skills: ['TypeScript', 'PostgreSQL', 'Python'],
  };
}

/* The rendered line, built the way both generation paths build it: read the stored parse into an
 * education block, then run the policy pass that produces the printable spec. */
function courseworkLineFor(parsedJson: Record<string, unknown>): string {
  const { spec } = applyResumePolicy(
    rawSpec(),
    educationFrom(parsedJson),
    bank(),
    'product analytics internship',
    { now: new Date('2026-08-04') },
  );
  return spec.coursework;
}

/* The patch the "Edit parsed details" screen actually sends: coursework as ONE comma separated
 * line, alongside the fields it sends on every save whether or not they changed. */
function reviewScreenSave(coursework: string) {
  const parsed = parsedProfilePatchSchema.safeParse({
    full_name: 'Mehek Mandal',
    school: 'University of Southern California',
    degree: 'BS Computer Science and Business Administration',
    grad_date: 'May 2028',
    coursework,
    skills: ['TypeScript', 'PostgreSQL', 'Python'],
    languages: ['English'],
  });
  assert.ok(parsed.success, `the review screen's own payload must validate: ${JSON.stringify(parsed.error?.issues)}`);
  return parsed.data;
}

test('a PATCH /profile/parsed round trip leaves the generated coursework line intact', () => {
  const stored: Record<string, unknown> = {
    full_name: 'Mehek Mandal',
    school: 'University of Southern California',
    degree: 'BS Computer Science and Business Administration',
    grad_date: 'May 2028',
    coursework: [...COURSES],
    skills: ['TypeScript', 'PostgreSQL', 'Python'],
  };

  const before = courseworkLineFor(stored);
  assert.equal(before, COURSES.join(', '));

  // The student opens the screen, which shows the line joined, and saves it back unchanged.
  const next = applyParsedProfilePatch(stored, reviewScreenSave(before));

  // The STORED shape stays a list. This is the half a reader-side tolerance would paper over.
  assert.deepEqual(next.coursework, COURSES);

  // And the resume still prints it. This is the assertion the bug would have failed.
  assert.equal(courseworkLineFor(next), before);
  assert.notEqual(courseworkLineFor(next), '');
});

test('editing the coursework line through the review screen changes it without flattening the shape', () => {
  const stored: Record<string, unknown> = { school: 'USC', coursework: [...COURSES] };
  const next = applyParsedProfilePatch(
    stored,
    reviewScreenSave('Data Structures and Object-Oriented Design, Financial Analysis & Valuation, Corporate Strategy'),
  );

  assert.deepEqual(next.coursework, [
    'Data Structures and Object-Oriented Design',
    'Financial Analysis & Valuation',
    'Corporate Strategy',
  ]);
  assert.equal(
    courseworkLineFor(next),
    'Data Structures and Object-Oriented Design, Financial Analysis & Valuation, Corporate Strategy',
  );
});

/* A course title containing "and" or "&" must survive as ONE course. Splitting on anything but the
 * comma cuts "Data Structures and Object-Oriented Design" in half, which would corrupt the grounding
 * check in resumeValidate.courseworkIsUngrounded as well as the printed line. */
test('course titles that contain "and" or "&" are not split apart', () => {
  const next = applyParsedProfilePatch({}, reviewScreenSave(COURSES.join(', ')));
  assert.deepEqual(next.coursework, COURSES);
});

/* The rows that were corrupted before the fix, and any row a separately-deployed old site still
 * writes. The generator must print them rather than reading them as empty a second time. */
test('a coursework line already stored as a string still generates', () => {
  assert.equal(courseworkLineFor({ school: 'USC', coursework: COURSES.join(', ') }), COURSES.join(', '));
});

test('an omitted coursework key is not an instruction to clear the stored list', () => {
  const stored: Record<string, unknown> = { school: 'USC', coursework: [...COURSES] };
  const parsed = parsedProfilePatchSchema.safeParse({ full_name: 'Mehek Mandal' });
  assert.ok(parsed.success);
  assert.deepEqual(applyParsedProfilePatch(stored, parsed.data).coursework, COURSES);
});

/* The stored shape must validate on the NEXT save. parsedProfilePatchSchema is both what the screen
 * sends and what it sends back after the server has written parsed_json, so a shape this route
 * stores but will not accept is a 400 on our own data - the trap the MAX_EDITABLE_LANGUAGES comment
 * in profile.ts documents, applied to this field. */
test('the shape this route stores is a shape it will accept back', () => {
  const stored = applyParsedProfilePatch({}, reviewScreenSave(COURSES.join(', ')));
  const roundTrip = parsedProfilePatchSchema.safeParse({
    full_name: 'Mehek Mandal',
    coursework: stored.coursework,
  });
  assert.ok(roundTrip.success, 'the stored list must validate as a patch payload');
  assert.deepEqual(roundTrip.data.coursework, COURSES);
});
