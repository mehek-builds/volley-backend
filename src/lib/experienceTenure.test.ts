import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseExperienceBand,
  readExperienceBand,
  readTenureMonth,
  totalExperienceMonths,
} from './experienceTenure';

const asOf = new Date('2026-09-02T00:00:00Z');

test('tenure months read every shape a resume prints and a parser emits', () => {
  assert.equal(readTenureMonth('Feb 2026'), 2026 * 12 + 1);
  assert.equal(readTenureMonth('February 2026'), 2026 * 12 + 1);
  assert.equal(readTenureMonth('Sept. 2024'), 2024 * 12 + 8);
  assert.equal(readTenureMonth('02/2026'), 2026 * 12 + 1);
  assert.equal(readTenureMonth('2026-02'), 2026 * 12 + 1);
  assert.equal(readTenureMonth('2026-02-15'), 2026 * 12 + 1);
  assert.deepEqual(readTenureMonth('2024'), { year: 2024 });
  for (const now of ['Present', 'present', 'Current', 'Now', 'Ongoing', 'to date']) {
    assert.equal(readTenureMonth(now), 'present', now);
  }
  for (const junk of ['', '  ', 'Summer 2025', 'Q3 2025', '13/2026', '2026-13', 'soon']) {
    assert.equal(readTenureMonth(junk), undefined, junk);
  }
});

test('total tenure merges concurrent roles and counts exclusive months', () => {
  // The owner's canon roles: an internship, then two overlapping jobs running to today.
  const periods = [
    { start: 'Feb 2025', end: 'May 2025' },
    { start: 'Sep 2025', end: 'Present' },
    { start: 'Feb 2026', end: 'Present' },
  ];
  // Feb->May 2025 is 3 exclusive months; Sep 2025->Sep 2026 is 12; Feb 2026 sits inside it.
  assert.equal(totalExperienceMonths(periods, asOf), 15);
  // The bank's single date_range column reads the same as start/end, and a duplicate of a role
  // already counted adds nothing.
  assert.equal(totalExperienceMonths([...periods, { date_range: 'Feb 2026 - Present' }], asOf), 15);
  assert.equal(totalExperienceMonths([{ date_range: 'Sep 2025 – Present' }], asOf), 12);
  assert.equal(totalExperienceMonths([{ date_range: 'June 2024 to August 2024' }], asOf), 2);
  // A bare year is January to December of that year, and a future start is a plan, not tenure.
  assert.equal(totalExperienceMonths([{ start: '2024', end: '2024' }], asOf), 11);
  assert.equal(totalExperienceMonths([{ start: 'Jan 2027', end: 'Present' }], asOf), null);
  // A role still running is clipped at today, never extended past it.
  assert.equal(totalExperienceMonths([{ start: 'Aug 2026', end: 'Dec 2026' }], asOf), 1);
});

test('total tenure is null - a refusal - with no dated role or with one it cannot read', () => {
  assert.equal(totalExperienceMonths(undefined, asOf), null);
  assert.equal(totalExperienceMonths([], asOf), null);
  assert.equal(totalExperienceMonths([{ start: '', end: '' }], asOf), null);
  assert.equal(totalExperienceMonths([{}], asOf), null);
  // One unreadable date poisons the whole total rather than silently understating it.
  assert.equal(totalExperienceMonths([{ start: 'Sep 2025', end: 'Present' }, { start: 'Summer 2024', end: 'Present' }], asOf), null);
  assert.equal(totalExperienceMonths([{ start: 'May 2025', end: 'Feb 2025' }], asOf), null);
  assert.equal(totalExperienceMonths([{ date_range: 'Jan 2024 - Feb 2024 - Mar 2024' }], asOf), null);
  // An entry with no date at all is simply not dated; a dated sibling still counts.
  assert.equal(totalExperienceMonths([{}, { start: 'Sep 2025', end: 'Present' }], asOf), 12);
});

test('experience bands read the employer wordings and ignore everything without a figure', () => {
  assert.deepEqual(readExperienceBand('Less than 1 year'), { minMonths: 0, maxMonths: 12, open: false });
  assert.deepEqual(readExperienceBand('under 6 months'), { minMonths: 0, maxMonths: 6, open: false });
  assert.deepEqual(readExperienceBand('1-2 years'), { minMonths: 12, maxMonths: 36, open: false });
  assert.deepEqual(readExperienceBand('1 – 2 years'), { minMonths: 12, maxMonths: 36, open: false });
  assert.deepEqual(readExperienceBand('3 to 5 years'), { minMonths: 36, maxMonths: 72, open: false });
  assert.deepEqual(readExperienceBand('between two and five years'), { minMonths: 24, maxMonths: 72, open: false });
  assert.deepEqual(readExperienceBand('6-12 months'), { minMonths: 6, maxMonths: 12, open: false });
  assert.deepEqual(readExperienceBand('5+ years'), { minMonths: 60, maxMonths: Number.POSITIVE_INFINITY, open: true });
  assert.deepEqual(readExperienceBand('More than 10 years'), { minMonths: 120, maxMonths: Number.POSITIVE_INFINITY, open: true });
  assert.deepEqual(readExperienceBand('3 years or more'), { minMonths: 36, maxMonths: Number.POSITIVE_INFINITY, open: true });
  assert.deepEqual(readExperienceBand('at least 2 years'), { minMonths: 24, maxMonths: Number.POSITIVE_INFINITY, open: true });
  assert.deepEqual(readExperienceBand('2 years'), { minMonths: 24, maxMonths: 36, open: false });
  for (const notABand of ['None', 'No experience', 'Student', 'Entry level', 'Select...', 'Other', '']) {
    assert.equal(readExperienceBand(notABand), null, notABand);
  }
});

test('the chosen band is the one holding the total, trimmed to its neighbour and lowest on overlap', () => {
  const personio = ['Less than 1 year', '1-2 years', '3-5 years', '5-10 years', '10+ years'];
  assert.equal(chooseExperienceBand(personio, 0), 'Less than 1 year');
  assert.equal(chooseExperienceBand(personio, 11), 'Less than 1 year');
  assert.equal(chooseExperienceBand(personio, 12), '1-2 years');
  assert.equal(chooseExperienceBand(personio, 15), '1-2 years');
  // "1-2 years" beside "3-5 years": the whole of year two belongs to the first band.
  assert.equal(chooseExperienceBand(personio, 30), '1-2 years');
  assert.equal(chooseExperienceBand(personio, 36), '3-5 years');
  assert.equal(chooseExperienceBand(personio, 200), '10+ years');
  // "1-2 years" beside "2-5 years": the neighbour's floor is the ceiling, so 2.5 years is "2-5".
  const contiguous = ['0-1 years', '1-2 years', '2-5 years', '5+ years'];
  assert.equal(chooseExperienceBand(contiguous, 30), '2-5 years');
  assert.equal(chooseExperienceBand(contiguous, 23), '1-2 years');
  assert.equal(chooseExperienceBand(contiguous, 60), '5+ years');
  // A gap between bands ("0-1", "2-5") hands the gap year to the LOWER band: the smaller claim.
  assert.equal(chooseExperienceBand(['0-1 years', '2-5 years', '5+ years'], 15), '0-1 years');
  // Non-band options are stepped over, and a value no band holds is null.
  assert.equal(chooseExperienceBand(['Select...', 'None', '1-2 years'], 15), '1-2 years');
  assert.equal(chooseExperienceBand(['None', 'Student'], 15), null);
  assert.equal(chooseExperienceBand(['5+ years'], 15), null);
  assert.equal(chooseExperienceBand(undefined, 15), null);
  // Order of arrival does not change the choice.
  assert.equal(chooseExperienceBand([...personio].reverse(), 15), '1-2 years');
});
