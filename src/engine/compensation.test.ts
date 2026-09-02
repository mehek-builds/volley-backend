import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annualize,
  answerCompensation,
  formatCompensation,
  parseStatedCompensation,
} from './compensation';

// Fixtures are the real postings applied to on 2026-07-23, so the parser is pinned against the
// formats actually seen in the wild rather than invented ones.

test('a monthly range yields its median', () => {
  // Circleback, Ashby.
  const stated = parseStatedCompensation('Compensation\n$7K – $10K per month\nOverview');
  assert.deepEqual(stated, { min: 7000, max: 10000, median: 8500, currency: 'USD', unit: 'month' });
});

test('an hourly range yields its median', () => {
  // Deepgram, Ashby.
  const stated = parseStatedCompensation('Compensation\nHourly $55 – $65 per hour\n');
  assert.equal(stated?.median, 60);
  assert.equal(stated?.unit, 'hour');
});

test('a single stated figure is its own median', () => {
  // Ellipsis Labs, Ashby.
  const stated = parseStatedCompensation('Compensation\n$10K per month\n');
  assert.equal(stated?.median, 10000);
  assert.equal(stated?.unit, 'month');
});

test('an annual base salary is parsed as yearly', () => {
  // Five Rings, Greenhouse.
  const stated = parseStatedCompensation('Annual Base Salary: $300,000. Additionally, interns receive a sign on bonus.');
  assert.equal(stated?.median, 300000);
  assert.equal(stated?.unit, 'year');
});

test('an explicit currency code beats a bare dollar sign', () => {
  const stated = parseStatedCompensation('US Salary Range\n$40 - $55 USD per hour\n');
  assert.equal(stated?.currency, 'USD');
  assert.equal(stated?.median, 47.5);
});

test('non-US currencies survive', () => {
  assert.equal(parseStatedCompensation('Salary: £57,800-£75,000 per year')?.currency, 'GBP');
  assert.equal(parseStatedCompensation('Salary: £57,800-£75,000 per year')?.median, 66400);
  assert.equal(parseStatedCompensation('Compensation: CA$69.6K - CA$87K annually')?.currency, 'CAD');
  assert.equal(parseStatedCompensation('Compensation: €45,000 - €55,000 per year')?.currency, 'EUR');
});

test('a posting with no compensation section returns null, not a guess', () => {
  // Aquatic Capital Management states none. Null must mean "research it", never "invent one".
  const jd = 'Software Engineer, Intern (Summer 2027). Chicago. Solid programming skills in Python and/or C++.';
  assert.equal(parseStatedCompensation(jd), null);
});

test('experience and duration figures are never mistaken for pay', () => {
  // The exact false-positive class that makes a naive number scan dangerous.
  assert.equal(parseStatedCompensation('3 to 5 years of experience required'), null);
  assert.equal(parseStatedCompensation('This is a paid, in-person, 12 week internship.'), null);
  assert.equal(parseStatedCompensation('Over $285B in trading volume across Solana markets.'), null);
  assert.equal(parseStatedCompensation('More than 200,000 developers build on the platform.'), null);
});

test('a money line with no unit is not treated as a rate', () => {
  // Without a unit the figure cannot be placed, and placing it wrongly is worse than not answering.
  assert.equal(parseStatedCompensation('Employees receive a $2,000 equipment stipend.'), null);
});

// ---- The answer itself ----

test('a stated range answers from the posting, and says so', () => {
  const answer = answerCompensation({ jdText: 'Compensation\n$7K – $10K per month\n' });
  assert.equal(answer?.basis, 'posting_range');
  assert.equal(answer?.amount, 8500);
  assert.equal(answer?.value, 'USD 8,500 per month');
});

test('an annualized field annualizes the posting rate rather than quoting a full-time salary', () => {
  // Aquatic asks for "annualized total compensation" on an INTERNSHIP. Annualizing the intern rate
  // is the honest reading; quoting a full-time salary would be a different job's number.
  const answer = answerCompensation({ jdText: 'Compensation\n$10K per month\n', wantsAnnualized: true });
  assert.equal(answer?.unit, 'year');
  assert.equal(answer?.amount, 120000);
});

test('hourly annualizes at full-time equivalent', () => {
  assert.equal(annualize(60, 'hour'), 124800);
  assert.equal(annualize(8500, 'month'), 102000);
  assert.equal(annualize(300000, 'year'), 300000);
});

test('a numeric-only field gets digits, not a formatted string', () => {
  const answer = answerCompensation({ jdText: 'Compensation\n$7K – $10K per month\n', numericOnly: true });
  assert.equal(answer?.value, '8500');
});

test('no stated range and no research returns null, so the caller must research', () => {
  // Null is the signal to GO RESEARCH. It must never become a fabricated figure, and per the
  // 2026-07-23 standard it must never become a question for the student either.
  assert.equal(answerCompensation({ jdText: 'No pay information here at all.' }), null);
});

test('a researched median answers when the posting is silent, and is labelled as researched', () => {
  const answer = answerCompensation({
    jdText: 'Software Engineer, Intern (Summer 2027). Chicago.',
    researchedMedian: { amount: 11000, currency: 'USD', unit: 'month' },
    wantsAnnualized: true,
  });
  assert.equal(answer?.basis, 'researched_median');
  assert.equal(answer?.amount, 132000);
  assert.equal(answer?.value, 'USD 132,000 per year');
});

test('the posting always beats research when both are available', () => {
  // The employer's own stated band is the defensible anchor; research is the fallback only.
  const answer = answerCompensation({
    jdText: 'Compensation\n$7K – $10K per month\n',
    researchedMedian: { amount: 99000, currency: 'USD', unit: 'month' },
  });
  assert.equal(answer?.basis, 'posting_range');
  assert.equal(answer?.amount, 8500);
});

test('formatting is readable and rounded', () => {
  assert.equal(formatCompensation(132000, 'USD', 'year'), 'USD 132,000 per year');
  assert.equal(formatCompensation(47.5, 'USD', 'hour'), 'USD 48 per hour');
});

/* THE 2026-09-02 REVIEW ATTACKS, pinned with the exact strings that were executed end-to-end
 * against the first wiring of this standard (PR #866 round 1). Every one of these filled a wrong
 * value; every one must now either parse the RIGHT range or refuse. */

test('the English article is not the Australian dollar', () => {
  assert.equal(
    parseStatedCompensation('We offer a $130,000 - $150,000 salary per year')?.currency,
    'USD',
  );
  // Real Australian notation still is.
  assert.equal(parseStatedCompensation('Salary: A$130,000 - A$150,000 per year')?.currency, 'AUD');
  assert.equal(parseStatedCompensation('Salary: CA$130,000 - CA$150,000 per year')?.currency, 'CAD');
});

test('a bare number range on a money line is not the salary', () => {
  // The hours range must not be read as an hourly band; the currency-bearing single is under the
  // lone-figure floor, so the whole line honestly refuses.
  assert.equal(parseStatedCompensation('Schedule: pay for 40-50 hours per week at $25 per hour'), null);
  assert.equal(parseStatedCompensation('2-4 years of experience preferred; pay is $30 per hour'), null);
  assert.equal(parseStatedCompensation('401(k) match 3%-6% and $0 premium healthcare, yearly'), null);
});

test('benefit figures are not compensation, and never shadow the real range', () => {
  assert.equal(parseStatedCompensation('Benefits include a $500 monthly wellness stipend'), null);
  assert.equal(parseStatedCompensation('Annual bonus: $5,000 for all employees'), null);
  const shadowed = parseStatedCompensation(
    'We provide a $1,000 annual equipment stipend\nSalary: $130,000 - $150,000 per year',
  );
  assert.equal(shadowed?.median, 140000);
  assert.equal(shadowed?.currency, 'USD');
});

test('European thousands-dots are thousands', () => {
  const parsed = parseStatedCompensation('Gehalt/salary: €60.000 - €80.000 per year');
  assert.equal(parsed?.median, 70000);
  assert.equal(parsed?.currency, 'EUR');
});

test('a label that names its own unit binds the answer to it', () => {
  // Year-labelled fields annualize a sub-annual posting.
  assert.equal(
    answerCompensation({
      jdText: 'Compensation\n$10K per month salary\n',
      numericOnly: true,
      fieldLabel: 'Expected annualized total compensation',
    })?.value,
    '120000',
  );
  // Any other labelled unit that differs from the posting refuses: hourly from annual would
  // smuggle in a working-week assumption the posting never made.
  assert.equal(
    answerCompensation({
      jdText: 'Salary: $130,000 - $150,000 per year',
      fieldLabel: 'Desired salary (hourly)',
    }),
    null,
  );
  // A label with no unit keeps the posting's own.
  assert.equal(
    answerCompensation({
      jdText: 'Salary: $130,000 - $150,000 per year',
      fieldLabel: 'What are your salary expectations for this position?',
    })?.value,
    'USD 140,000 per year',
  );
});
