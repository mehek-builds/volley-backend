import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseRanges,
  employmentTypeFromTitle,
  inferGreenhouseInterval,
  normalizeEmploymentType,
  readAshbyPay,
  readGreenhousePay,
  readLeverPay,
} from './compensation';
import { normalizeGreenhouseJobs, normalizeLeverJobs, normalizeAshbyJobs, sourceEndpoint } from './jobMonitor';

/* THE FLAGS. Two of the three boards send no pay at all unless asked, and the response looks
   perfectly healthy without them, so this is the only thing standing between the board and another
   silent months-long gap. */
test('greenhouse and ashby endpoints ask for pay; lever needs no flag', () => {
  assert.match(sourceEndpoint({ ats_name: 'greenhouse', board_token: 'stripe' }), /pay_transparency=true/);
  assert.match(sourceEndpoint({ ats_name: 'ashby', board_token: 'cursor' }), /includeCompensation=true/);
  assert.match(sourceEndpoint({ ats_name: 'lever', board_token: 'matchgroup' }), /mode=json/);
});

/* THE GREENHOUSE PERIOD. Magnitudes are real values measured on the live board 2026-07-29. */
test('a greenhouse figure gets its period from its size, per currency', () => {
  assert.equal(inferGreenhouseInterval(200_300, 'USD'), 'year');
  assert.equal(inferGreenhouseInterval(64, 'USD'), 'hour');
  // JPY is ~150 to the dollar: 14,878,400 yen is a salary, not an hourly rate.
  assert.equal(inferGreenhouseInterval(14_878_400, 'JPY'), 'year');
  // ...and an unlisted currency is treated as dollar-scaled rather than guessed at.
  assert.equal(inferGreenhouseInterval(180_000, 'XYZ'), 'year');
});

test('an ambiguous greenhouse figure yields no period at all, so no pay is shown', () => {
  // Remote's live "annual salary range" of JPY 86,000, which would be $573 a year. Employer error,
  // and the only safe reading is none.
  assert.equal(inferGreenhouseInterval(97_000, 'JPY', 'The annual salary range for this full-time position is'), null);
  // A $1.00 ceiling is not an hourly wage anywhere.
  assert.equal(inferGreenhouseInterval(1, 'USD'), null);
});

test('inside the ambiguous band only, a monthly label is believed', () => {
  // Airbnb's live Mexico row. Magnitude cannot see "monthly"; the label is the only evidence.
  assert.equal(inferGreenhouseInterval(125_000, 'MXN', 'Mexico Monthly Pay Range'), 'month');
});

test('a label never overturns a period magnitude already decided', () => {
  // 13 live ranges are labelled hourly and carry annual-sized numbers. Size wins.
  assert.equal(inferGreenhouseInterval(280_000, 'USD', 'Hourly Rate'), 'year');
  assert.equal(inferGreenhouseInterval(43, 'USD', 'Annual Salary:'), 'hour');
  // ...including the monthly label, which is consulted only after both tests decline.
  assert.equal(inferGreenhouseInterval(190_000, 'USD', 'Monthly Pay Range'), 'year');
});

/* THE COLLAPSE. 1,121 live postings publish more than one range and 186 mix currencies. */
test('zone ranges in one currency collapse to their full span', () => {
  const pay = readGreenhousePay({
    pay_input_ranges: [
      { min_cents: 14_570_000, max_cents: 20_030_000, currency_type: 'USD', title: 'Zone 1 Pay Range' },
      { min_cents: 13_020_000, max_cents: 17_900_000, currency_type: 'USD', title: 'Zone 2 Pay Range' },
      { min_cents: 11_660_000, max_cents: 16_030_000, currency_type: 'USD', title: 'Zone 3 Pay Range' },
    ],
  });
  assert.deepEqual(pay, { min: 116_600, max: 200_300, currency: 'USD', interval: 'year' });
});

test('a mixed-currency posting shows the majority market, not the biggest number', () => {
  const pay = collapseRanges([
    { min: 100_000, max: 150_000, currency: 'USD', interval: 'year' },
    { min: 110_000, max: 160_000, currency: 'USD', interval: 'year' },
    // Larger figure, single range: it must not win, or a two-city role advertises the outlier.
    { min: 200_000, max: 900_000, currency: 'CAD', interval: 'year' },
  ]);
  assert.deepEqual(pay, { min: 100_000, max: 160_000, currency: 'USD', interval: 'year' });
});

test('the collapse does not depend on the order the board happened to send', () => {
  const ranges = [
    { min: 50, max: 60, currency: 'USD', interval: 'hour' as const },
    { min: 40, max: 55, currency: 'USD', interval: 'hour' as const },
  ];
  assert.deepEqual(collapseRanges(ranges), collapseRanges([...ranges].reverse()));
});

test('a posting with no ranges, or only unusable ones, yields nothing', () => {
  assert.equal(readGreenhousePay({}), null);
  assert.equal(readGreenhousePay({ pay_input_ranges: [] }), null);
  assert.equal(collapseRanges([null, null]), null);
});

/* LEVER + ASHBY. Both state the period, so nothing is inferred - but both also send shapes that
   are not a rate, and those must not become one. */
test('lever pay is read, and only for periods the product can print', () => {
  assert.deepEqual(
    readLeverPay({ salaryRange: { interval: 'per-year-salary', currency: 'USD', min: 150_000, max: 180_000 } }),
    { min: 150_000, max: 180_000, currency: 'USD', interval: 'year' },
  );
  // A one-time bonus is not a rate and has no honest short form on a tile.
  assert.equal(readLeverPay({ salaryRange: { interval: 'one-time', currency: 'USD', min: 5_000, max: 5_000 } }), null);
  assert.equal(readLeverPay({}), null);
});

test('ashby equity components never collapse into the salary line', () => {
  const pay = readAshbyPay({
    compensation: {
      compensationTiers: [{
        components: [
          { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 150_000, maxValue: 165_000 },
          // No currency, no period, null values. Spread into the pay line it would zero the range.
          { compensationType: 'EquityPercentage', interval: 'NONE', currencyCode: null, minValue: null, maxValue: null },
        ],
      }],
    },
  });
  assert.deepEqual(pay, { min: 150_000, max: 165_000, currency: 'USD', interval: 'year' });
});

test('ashby tiers in one currency span; an empty compensation object yields nothing', () => {
  const pay = readAshbyPay({
    compensation: {
      compensationTiers: [
        { components: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 150_000, maxValue: 165_000 }] },
        { components: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 170_000, maxValue: 189_000 }] },
      ],
    },
  });
  assert.deepEqual(pay, { min: 150_000, max: 189_000, currency: 'USD', interval: 'year' });
  // Cursor and Notion send exactly this: the field is present and carries nothing.
  assert.equal(readAshbyPay({ compensation: { compensationTierSummary: null, compensationTiers: [] } }), null);
});

/* JOB TYPE. The rule the whole feature turns on: derive the positive cases, never the default. */
test('a title states an internship, a contract or a part-time role', () => {
  assert.equal(employmentTypeFromTitle('Data Science Intern'), 'Internship');
  assert.equal(employmentTypeFromTitle('Software Engineering Co-op (Fall 2026)'), 'Internship');
  assert.equal(employmentTypeFromTitle('Contract Recruiter'), 'Contract');
  assert.equal(employmentTypeFromTitle('Part-Time Barista'), 'Part-time');
});

test('a title NEVER produces Full-time, because no title ever says so', () => {
  // The ~18,000 Greenhouse postings this covers show no chip at all. Defaulting them to Full-time
  // would assert on every tile a fact no source stated.
  assert.equal(employmentTypeFromTitle('Senior Backend Engineer'), undefined);
  assert.equal(employmentTypeFromTitle('Staff Product Designer, Growth'), undefined);
});

test('words that merely contain a type word are not that type', () => {
  // Both live on the board. A substring match would file them as internships.
  assert.equal(employmentTypeFromTitle('Internal Audit Manager'), undefined);
  assert.equal(employmentTypeFromTitle('Internationalization Engineer'), undefined);
});

test('an intern on a contract is an internship, whichever word comes first', () => {
  assert.equal(employmentTypeFromTitle('Contract Intern, Marketing'), 'Internship');
});

test('a dozen board spellings become one product word', () => {
  for (const value of ['FullTime', 'Full-time', 'Permanent']) {
    assert.equal(normalizeEmploymentType(value), 'Full-time');
  }
  for (const value of ['Intern', 'Internship', 'Apprenticeship', 'Scholarship']) {
    assert.equal(normalizeEmploymentType(value), 'Internship');
  }
  for (const value of ['Contract', 'Contractor', 'Fixed Term', 'Short Term', 'Temporary']) {
    assert.equal(normalizeEmploymentType(value), 'Contract');
  }
  assert.equal(normalizeEmploymentType('PartTime'), 'Part-time');
});

test('an unrecognized employer value is passed through, not discarded', () => {
  // It came from the employer's own field, so it is a fact about the posting even when this list
  // has not seen it before.
  assert.equal(normalizeEmploymentType('Volunteer'), 'Volunteer');
  assert.equal(normalizeEmploymentType('   '), undefined);
  assert.equal(normalizeEmploymentType(undefined), undefined);
});

/* END TO END through the normalizers, in the payload shapes the live boards actually send. */
test('each normalizer carries pay and type onto the posting', () => {
  const description = 'A real description, long enough to clear the ingest floor. '.repeat(4);

  const [gh] = normalizeGreenhouseJobs({
    jobs: [{
      id: 1, title: 'Software Engineering Intern', absolute_url: 'https://boards.greenhouse.io/x/jobs/1',
      location: { name: 'New York, NY' }, content: description, updated_at: '2026-07-28T00:00:00Z',
      pay_input_ranges: [{ min_cents: 4_500, max_cents: 5_500, currency_type: 'USD', title: 'Hourly Pay Range' }],
    }],
  });
  assert.equal(gh.employment_type, 'Internship');
  assert.deepEqual(gh.pay, { min: 45, max: 55, currency: 'USD', interval: 'hour' });

  const [lever] = normalizeLeverJobs([{
    id: 'l1', text: 'Staff Engineer', hostedUrl: 'https://jobs.lever.co/x/1', applyUrl: 'https://jobs.lever.co/x/1/apply',
    categories: { commitment: 'Permanent', location: 'Austin, TX' }, descriptionPlain: description,
    salaryRange: { interval: 'per-year-salary', currency: 'USD', min: 150_000, max: 180_000 },
  }]);
  assert.equal(lever.employment_type, 'Full-time');
  assert.deepEqual(lever.pay, { min: 150_000, max: 180_000, currency: 'USD', interval: 'year' });

  const [ashby] = normalizeAshbyJobs({
    jobs: [{
      id: 'a1', title: 'Product Manager', jobUrl: 'https://jobs.ashbyhq.com/x/1', applyUrl: 'https://jobs.ashbyhq.com/x/1/application',
      employmentType: 'FullTime', location: 'Remote', descriptionPlain: description,
      compensation: { compensationTiers: [{ components: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 150_000, maxValue: 189_000 }] }] },
    }],
  });
  assert.equal(ashby.employment_type, 'Full-time');
  assert.deepEqual(ashby.pay, { min: 150_000, max: 189_000, currency: 'USD', interval: 'year' });
});

test('a posting that publishes no pay carries none, on every board', () => {
  const description = 'A real description, long enough to clear the ingest floor. '.repeat(4);
  const [gh] = normalizeGreenhouseJobs({
    jobs: [{ id: 1, title: 'Backend Engineer', absolute_url: 'https://boards.greenhouse.io/x/jobs/1', content: description }],
  });
  assert.equal(gh.pay, undefined);
  assert.equal(gh.employment_type, undefined);
});
