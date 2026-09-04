import assert from 'node:assert/strict';
import test from 'node:test';
import { applicationProfileWriteValues, bodySchema, decryptRow } from '../routes/applicationProfile';
import { eligibilityFromLoadedApplicationProfile, experiencePeriodsFromSources } from './applicationProfileLike';
import { resolveProfileField } from './profileFieldResolution';

process.env.ENCRYPTION_KEY ??= 'test-encryption-key-at-least-32-chars-long';

test('the live profile loader resolves decrypted country records into a send value', () => {
  const records = [{
    country_code: 'GB',
    authorized_now: false,
    needs_sponsorship_now: true,
    needs_sponsorship_future: true,
  }];
  const written = applicationProfileWriteValues(bodySchema.parse({ work_eligibility_by_country: records }));
  const raw = {
    work_eligibility_by_country: written.work_eligibility_by_country,
    work_authorized: null,
    needs_sponsorship: null,
  } as never;
  const app = decryptRow(raw);
  const loaded = eligibilityFromLoadedApplicationProfile(app, {
    work_authorized: undefined,
    needs_sponsorship: undefined,
  });
  assert.deepEqual(loaded, records);
  assert.deepEqual(resolveProfileField(
    { label: 'Will you require sponsorship?', inputType: 'select', options: ['Yes', 'No'] },
    { work_eligibility_by_country: loaded },
    undefined,
    'non_us',
    'GB',
  )?.value, 'Yes');
});

test('an empty stored envelope is authoritative and never unlocks scalar fallback', () => {
  const app = decryptRow({
    work_eligibility_by_country: '',
    work_authorized: true,
    needs_sponsorship: false,
  } as never);
  assert.deepEqual(app.work_eligibility_by_country, []);
  assert.deepEqual(eligibilityFromLoadedApplicationProfile(app, {
    work_authorized: true,
    needs_sponsorship: false,
  }), []);
});

test('the dated roles reach the resolver from the parse, the base resume, and the bank\'s job rows', () => {
  const parsed = {
    experience: [
      { company: 'Traeco', title: 'AI Engineer', start: 'Feb 2026', end: 'Present', description: '' },
      { company: 'SoFi', title: 'PM Intern', start: 'Feb 2025', end: 'May 2025', description: '' },
      { company: 'Undated Co', title: 'Volunteer', start: '', end: '', description: '' },
    ],
    leadership: [{ organization: 'Club', title: 'President', start: 'Jan 2020', end: 'Present', description: '' }],
  };
  const bank = [
    { type: 'job', date_range: 'Sep 2025 - Present' },
    { type: 'project', date_range: 'Jan 2019 - Present' },
    { type: 'leadership', date_range: 'Jan 2019 - Present' },
    { type: 'job', date_range: null },
  ];
  /* Leadership and projects never count, on either source; an undated entry is dropped.
   *
   * Each surviving entry also carries its own title and its own bullets, which are SKILL EVIDENCE
   * and never dates: skillScopedExperienceAnswer answers "how many years of hands on experience do
   * you have with X" by summing only the roles whose own words name X, so the words have to travel
   * with the span. An empty description stays undefined rather than becoming an empty string, so a
   * role with no prose evidences nothing instead of matching everything. A bank row contributes no
   * evidence text at all: it is an organisation, a title and a date range, with no bullets. */
  assert.deepEqual(experiencePeriodsFromSources(parsed, {}, bank), [
    { start: 'Feb 2026', end: 'Present', date_range: undefined, description: undefined },
    { start: 'Feb 2025', end: 'May 2025', date_range: undefined, description: undefined },
    { date_range: 'Sep 2025 - Present' },
  ]);
  // The base resume is read only when the parse carries no experience array at all.
  assert.deepEqual(experiencePeriodsFromSources({}, { experience: [{ start: '2024-01', end: '2024-06' }] }, []), [
    { start: '2024-01', end: '2024-06', date_range: undefined, description: undefined },
  ]);

  /* THE EVIDENCE TEXT, from every shape the parse and the resume spec write prose in. The bullets
   * are joined into one string because every reader asks the same question of them, "is this skill
   * named anywhere in this role", and non-string members are dropped rather than stringified so an
   * object can never reach the matcher as "[object Object]". */
  assert.deepEqual(
    experiencePeriodsFromSources(
      { experience: [{ start: 'Feb 2025', end: 'May 2025', role: 'Backend Intern', bullets: ['Shipped a Python service', { note: 'x' }, 'Wrote SQL'] }] },
      {},
      [],
    ),
    [{ start: 'Feb 2025', end: 'May 2025', date_range: undefined, description: 'Shipped a Python service Wrote SQL' }],
  );
  // Nothing dated anywhere is undefined - "never on file" - and the resolver refuses on it.
  assert.equal(experiencePeriodsFromSources({}, {}, []), undefined);
  assert.equal(experiencePeriodsFromSources({ experience: [] }, {}, [{ type: 'job', date_range: '' }]), undefined);
});

/* A PROJECT IS NOT EMPLOYMENT, AND base_resume_json IS WHERE THAT BREAKS.
 *
 * The role TITLE is deliberately absent from every expected shape below: it used to be carried and
 * read as skill evidence, and titles are Title Case by convention, so every case-based signal was
 * inverted on that one field. See experienceEvidencing.
 *
 * `parsed_json.experience` holds employment only, with leadership in a separate top-level array, so
 * this path looked correct and was correct FOR THAT SOURCE. `base_resume_json` is a ResumeSpec, and
 * its `experience[]` is one array holding all three kinds behind a `type` discriminator alongside
 * `date_range` and `bullets` (src/llm/resumeSpec.ts). fromResume(base) runs whenever the parse
 * carries no experience array, so a personal project and a club presidency were reaching the
 * resolver as dated employment, and a project's bullets are exactly where a tool gets named.
 */
test('a ResumeSpec base resume contributes its jobs and NOT its projects or leadership', () => {
  const base = {
    experience: [
      { type: 'job', org: 'Cafe', title: 'Operations Intern', date_range: 'Jun 2026 - Aug 2026', bullets: ['Scheduled shifts.'] },
      { type: 'project', org: 'Personal', title: 'Trading bot', date_range: 'Jan 2024 - Dec 2025', bullets: ['Built a Python backtester.'] },
      { type: 'leadership', org: 'CS Club', title: 'President', date_range: 'Sep 2023 - May 2024', bullets: ['Ran a Kubernetes cluster.'] },
    ],
  };
  assert.deepEqual(experiencePeriodsFromSources({}, base, []), [
    { start: undefined, end: undefined, date_range: 'Jun 2026 - Aug 2026', description: 'Scheduled shifts.' },
  ]);

  /* THE TEST IS NEGATIVE ON PURPOSE, and this half is what stops it being "fixed" into a positive
   * one. A parsed resume entry routinely carries no `type` at all; requiring type === 'job' here
   * would silently drop every parsed role and zero out the total tenure that already ships. An
   * untyped row is employment, exactly as it always was. */
  assert.deepEqual(
    experiencePeriodsFromSources({ experience: [{ title: 'SWE Intern', start: 'Feb 2025', end: 'May 2025' }] }, {}, []),
    [{ start: 'Feb 2025', end: 'May 2025', date_range: undefined, description: undefined }],
  );
  // An explicit job row is kept on the parse path too, and casing is not a way past the filter.
  assert.deepEqual(
    experiencePeriodsFromSources({ experience: [
      { type: 'job', title: 'SWE Intern', start: 'Feb 2025', end: 'May 2025' },
      { type: ' Project ', title: 'Side thing', start: 'Feb 2020', end: 'May 2024' },
    ] }, {}, []),
    [{ start: 'Feb 2025', end: 'May 2025', date_range: undefined, description: undefined }],
  );
  // A base resume of nothing but projects and leadership is "no dated role on file", not a total.
  assert.equal(experiencePeriodsFromSources({}, { experience: [base.experience[1], base.experience[2]] }, []), undefined);
});
