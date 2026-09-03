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
    { start: 'Feb 2026', end: 'Present', date_range: undefined, title: 'AI Engineer', description: undefined },
    { start: 'Feb 2025', end: 'May 2025', date_range: undefined, title: 'PM Intern', description: undefined },
    { date_range: 'Sep 2025 - Present' },
  ]);
  // The base resume is read only when the parse carries no experience array at all.
  assert.deepEqual(experiencePeriodsFromSources({}, { experience: [{ start: '2024-01', end: '2024-06' }] }, []), [
    { start: '2024-01', end: '2024-06', date_range: undefined, title: undefined, description: undefined },
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
    [{ start: 'Feb 2025', end: 'May 2025', date_range: undefined, title: 'Backend Intern', description: 'Shipped a Python service Wrote SQL' }],
  );
  // Nothing dated anywhere is undefined - "never on file" - and the resolver refuses on it.
  assert.equal(experiencePeriodsFromSources({}, {}, []), undefined);
  assert.equal(experiencePeriodsFromSources({ experience: [] }, {}, [{ type: 'job', date_range: '' }]), undefined);
});
