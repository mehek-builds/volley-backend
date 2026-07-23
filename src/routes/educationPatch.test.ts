import { test } from 'node:test';
import assert from 'node:assert/strict';
import { educationPatchSchema } from './profile';

// R-052. The parsed education block was write-once at upload time, so R-047's dropped
// "Computer Science &" could only be fixed by producing a whole new PDF. These pin the shape of the
// correction endpoint's input.

test('a single field may be corrected on its own', () => {
  const parsed = educationPatchSchema.safeParse({ degree: 'BS Computer Science' });
  assert.equal(parsed.success, true);
});

test('an empty patch is rejected rather than silently doing nothing', () => {
  assert.equal(educationPatchSchema.safeParse({}).success, false);
});

test('the joint degree that started all of this fits comfortably', () => {
  const degree = 'Bachelor of Science in Computer Science & Business Administration, Finance Emphasis';
  const parsed = educationPatchSchema.safeParse({ degree });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.degree, degree);
});

test('a degree may be cleared to empty, because an absent degree beats an invented one', () => {
  // resumeSpec's rule is to leave degree empty when none is provided; the user must be able to
  // reach that state deliberately.
  const parsed = educationPatchSchema.safeParse({ degree: '' });
  assert.equal(parsed.success, true);
});

test('school and name may not be blanked, since autofill has no fallback for them', () => {
  assert.equal(educationPatchSchema.safeParse({ school: '' }).success, false);
  assert.equal(educationPatchSchema.safeParse({ school: '   ' }).success, false);
  assert.equal(educationPatchSchema.safeParse({ full_name: '' }).success, false);
});

test('values are trimmed, so a stray paste newline is not stored', () => {
  const parsed = educationPatchSchema.safeParse({ school: '  USC Viterbi  ' });
  assert.equal(parsed.success && parsed.data.school, 'USC Viterbi');
});

test('a pasted resume cannot be dumped into a field', () => {
  assert.equal(educationPatchSchema.safeParse({ school: 'x'.repeat(201) }).success, false);
  assert.equal(educationPatchSchema.safeParse({ degree: 'x'.repeat(201) }).success, false);
  assert.equal(educationPatchSchema.safeParse({ grad_date: 'x'.repeat(41) }).success, false);
});

test('unknown keys cannot ride along into parsed_json', () => {
  // The handler only copies the four known keys, but the schema stripping them first means a
  // caller cannot smuggle e.g. skills or experience through this route.
  const parsed = educationPatchSchema.safeParse({ degree: 'BS CS', skills: ['fake'], experience: [] });
  assert.equal(parsed.success, true);
  assert.deepEqual(Object.keys(parsed.success ? parsed.data : {}), ['degree']);
});

// The handler derives grad_year from grad_date so eligibility filters and the printed date cannot
// disagree. Mirrored here as a unit so the rule is pinned independently of the route wiring.
function derivedGradYear(gradDate: string): number | undefined {
  const year = gradDate.match(/\b(19|20)\d{2}\b/)?.[0];
  return year ? Number(year) : undefined;
}

test('grad_year follows grad_date, since eligibility is read from the year', () => {
  assert.equal(derivedGradYear('May 2028'), 2028);
  assert.equal(derivedGradYear('Expected May 2027'), 2027);
  assert.equal(derivedGradYear('2028-05'), 2028);
});

test('a grad_date with no year leaves the stored year alone rather than zeroing it', () => {
  assert.equal(derivedGradYear('Spring'), undefined);
  assert.equal(derivedGradYear(''), undefined);
});
