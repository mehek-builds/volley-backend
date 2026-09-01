import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseRanges,
  employmentTypeFromTitle,
  resolveEmploymentType,
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
  for (const value of ['Intern', 'Internship', 'Scholarship']) {
    assert.equal(normalizeEmploymentType(value), 'Internship');
  }
  // Split out of Internship 2026-08-04; see the apprenticeship test below.
  for (const value of ['Apprentice', 'Apprenticeship']) {
    assert.equal(normalizeEmploymentType(value), 'Apprenticeship');
  }
  for (const value of ['Contract', 'Contractor', 'Fixed Term', 'Short Term', 'Temporary']) {
    assert.equal(normalizeEmploymentType(value), 'Contract');
  }
  assert.equal(normalizeEmploymentType('PartTime'), 'Part-time');
});

test('an unrecognized employer value is passed through, not discarded', () => {
  // It came from the employer's own field, so it is a fact about the posting even when this list
  // has not seen it before. These are the real live values the compound pass deliberately does not
  // guess at: a department, a seniority band and a work arrangement are not employment types.
  assert.equal(normalizeEmploymentType('Investment Banking'), 'Investment Banking');
  assert.equal(normalizeEmploymentType('Mid-Senior Level'), 'Mid-Senior Level');
  assert.equal(normalizeEmploymentType('Homeoffice'), 'Homeoffice');
  assert.equal(normalizeEmploymentType('Volunteer'), 'Volunteer');
  assert.equal(normalizeEmploymentType('   '), undefined);
  assert.equal(normalizeEmploymentType(undefined), undefined);
});

/* PRECEDENCE. The employer's field normally wins; a title saying internship is the one exception. */
test('a title saying internship beats the employer field', () => {
  // Modal's live posting: tagged FullTime, meaning full-time HOURS, on an internship. Rendering
  // that as a Full-time job tells a job seeker the opposite of what the title plainly says.
  assert.equal(resolveEmploymentType('ML Research Intern', 'FullTime'), 'Internship');
  assert.equal(resolveEmploymentType('Software Engineering Co-op', 'Permanent'), 'Internship');
});

test('the employer field still wins everywhere else', () => {
  assert.equal(resolveEmploymentType('Senior Backend Engineer', 'FullTime'), 'Full-time');
  /* NARROW ON PURPOSE. "Contract" in a title is often the work rather than the arrangement -
     "Contract Manager" and "Contracts Counsel" are both live full-time roles - so the field wins. */
  assert.equal(resolveEmploymentType('Contract Manager', 'FullTime'), 'Full-time');
  assert.equal(resolveEmploymentType('Part-Time Coordinator', 'FullTime'), 'Full-time');
  // An unrecognized employer value is still passed through rather than dropped.
  assert.equal(resolveEmploymentType('Field Organizer', 'Volunteer'), 'Volunteer');
});

test('with no employer field it falls back to the title, and still never invents Full-time', () => {
  // The Greenhouse path: 84% of the board, no field at all.
  assert.equal(resolveEmploymentType('Data Science Intern'), 'Internship');
  assert.equal(resolveEmploymentType('Contract Recruiter'), 'Contract');
  assert.equal(resolveEmploymentType('Senior Backend Engineer'), undefined);
  assert.equal(resolveEmploymentType('Senior Backend Engineer', '   '), undefined);
});

test('the internship override cannot fire on an internal/international title', () => {
  // The word-boundary false positives, now checked through the precedence path too: if these
  // overrode the field, every "Internal Comms" role at a Lever employer would read Internship.
  assert.equal(resolveEmploymentType('Internal Audit Manager', 'FullTime'), 'Full-time');
  assert.equal(resolveEmploymentType('International Revenue Manager', 'FullTime'), 'Full-time');
  assert.equal(resolveEmploymentType('Sr Internal Auditor', 'Permanent'), 'Full-time');
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

  /* The same board shape, but the title says intern and the field says FullTime. This is Modal's
     live posting, and it must reach the tile as Internship. */
  const [ashbyIntern] = normalizeAshbyJobs({
    jobs: [{
      id: 'a2', title: 'ML Research Intern', jobUrl: 'https://jobs.ashbyhq.com/x/2', applyUrl: 'https://jobs.ashbyhq.com/x/2/application',
      employmentType: 'FullTime', location: 'New York', descriptionPlain: description,
    }],
  });
  assert.equal(ashbyIntern.employment_type, 'Internship');
});

test('a posting that publishes no pay carries none, on every board', () => {
  const description = 'A real description, long enough to clear the ingest floor. '.repeat(4);
  const [gh] = normalizeGreenhouseJobs({
    jobs: [{ id: 1, title: 'Backend Engineer', absolute_url: 'https://boards.greenhouse.io/x/jobs/1', content: description }],
  });
  assert.equal(gh.pay, undefined);
  assert.equal(gh.employment_type, undefined);
});

test('an internship that never says so in its title is still an internship', () => {
  /* Jane Street posts "Software Engineer" thirteen times: some are full-time reqs and some are the
     summer internship, and the body copy is the only thing that separates them. These two strings
     are the real openings of two live postings with the SAME title on the SAME board. */
  const internBody = '<p>Our goal is to give you a real sense of what it\'s like to work at Jane '
    + 'Street full time while also providing a truly unparalleled educational experience. As an '
    + 'intern, you are paired with full-time employees who act as mentors.</p>';
  const fullTimeBody = '<p>We’re looking for Software Engineers who want to help us design and '
    + 'build the systems and tools that run the firm.</p>';

  assert.equal(resolveEmploymentType('Software Engineer', undefined, internBody), 'Internship');
  assert.equal(resolveEmploymentType('Software Engineer', undefined, fullTimeBody), undefined,
    'the full-time twin must stay untyped, not be swept along with its namesake');

  // The other phrasings on live postings, all second person.
  for (const body of [
    'Over the course of your internship, you will explore ways to approach problems.',
    'During the internship, your work is reinforced with intensive classes.',
    'The internship is a fast-paced, immersive experience.',
  ]) {
    assert.equal(resolveEmploymentType('Quantitative Trader', undefined, body), 'Internship', body);
  }
});

test('a job that RUNS the internship programme is not an internship', () => {
  /* The failure mode this guard exists for. All live full-time postings, and each one talks about
     interns in the third person, which is exactly how they differ from the postings above. */
  const body = 'You will manage our internship program and support our interns through the summer.';
  for (const title of [
    'Campus Recruiter',
    'University Recruiter, Contract',
    'Talent Acquisition - Campus',
    'Early Talent Program Coordinator',
    'Events Coordinator - Recruiting',
  ]) {
    assert.notEqual(resolveEmploymentType(title, undefined, body), 'Internship', title);
  }
});

test('the description never overrules an employer who stated a type', () => {
  // Weakest evidence in the chain: it fills a silence, it does not argue with the employer.
  assert.equal(
    resolveEmploymentType('Software Engineer', 'FullTime', 'As an intern, you are paired with...'),
    'Full-time',
  );
});

test('an apprenticeship is its own category, not a kind of internship', () => {
  /* The four live trade apprenticeships. Each is a paid multi-year route into a skilled trade,
     open to people who are not students, so Internship was the wrong label and so was the plain
     Full-time their employers state. Crusoe's is tagged FullTime and the title still wins. */
  for (const title of [
    'Apprentice Electrician',
    'Apprentice Aerospace Technician',
    'Apprentice Weld Support Technician',
    'Apprentice Robot Service Technician',
  ]) {
    assert.equal(resolveEmploymentType(title, 'FullTime'), 'Apprenticeship', title);
    assert.equal(resolveEmploymentType(title), 'Apprenticeship', `${title} with no employer field`);
  }
  // Match Group's four are the early-career kind, and their employer names the category outright.
  assert.equal(
    resolveEmploymentType('Apprenticeship - Junior Brand Designer', 'Apprenticeship'),
    'Apprenticeship',
  );
  assert.equal(normalizeEmploymentType('Apprenticeship'), 'Apprenticeship');

  // Intern and co-op are unchanged: still their own category, still beating the field (Modal).
  assert.equal(resolveEmploymentType('ML Research Intern', 'FullTime'), 'Internship');
  assert.equal(resolveEmploymentType('Software Engineering Co-Op', 'FullTime'), 'Internship');
  // And an internship that also says apprentice is an internship: the intern rule is listed first.
  assert.equal(resolveEmploymentType('Apprentice Intern, Manufacturing'), 'Internship');
});

test('the employer vocabulary is normalized, but "Full Time Contractor" is still a contract', () => {
  assert.equal(normalizeEmploymentType('Full Time Employee'), 'Full-time');
  assert.equal(normalizeEmploymentType('FullTime'), 'Full-time');
  assert.equal(normalizeEmploymentType('Permanent'), 'Full-time');
  /* The reason the Full-time patterns are anchored rather than prefixes. A prefix match would read
     this as full-time and lose the one word that says what it actually is. */
  assert.equal(normalizeEmploymentType('Full Time Contractor'), 'Contract');
  assert.equal(normalizeEmploymentType('Contractor No Legal Entity'), 'Contract');
  /* Still passed through, deliberately: these describe the legal engagement model rather than
     hours or permanence, so mapping them to Full-time would be our inference wearing the
     employer's voice. They stay visible on the tile and outside the four filterable words. */
  assert.equal(normalizeEmploymentType('International Office Entity'), 'International Office Entity');
  assert.equal(normalizeEmploymentType('Other'), 'Other');
});

test('a programme-owner role is not an internship, in all the ways it gets titled', () => {
  /* The guard's job is to keep salaried programme staff out of the one filter a student uses to
     stop reading them. These titles all missed the first version of the guard. */
  const body = 'This internship program places 200 students each summer, and our interns love it.';
  for (const title of [
    'Manager, Early Careers Programs',
    'Program Lead, Emerging Talent',
    'Head of Student Programs',
    'Employer Brand Manager',
    'Campus Recruiter',
    'University Recruiter, Contract',
    'Early Talent Program Coordinator',
    'Events Coordinator - Recruiting',
  ]) {
    assert.notEqual(resolveEmploymentType(title, undefined, body), 'Internship', title);
  }
});

test('the recruiting guard applies to the DESCRIPTION rule only, never to the title', () => {
  /* MEASURED, and it is why the asymmetry exists. Eleven live titles contain both an intern word
     and a programme-owner noun, and TEN of them are genuine internships: "Talent Acquisition Intern
     Fall 2026" (Rocket Lab), "Recruiting Operations Internship - Fall 2026" (Varda), "Recruitment
     Intern (Working Student)" (Optiver), "Operations Program Management Intern" (Skydio). Extending
     RECRUITING_TITLES to veto the title rule would strip the type off all of them to catch the one
     ambiguous case, so the guard stays where the title is SILENT and inference is all we have. */
  for (const title of [
    'Talent Acquisition Intern Fall 2026',
    'Recruitment Intern (Working Student)',
    'Recruiting Operations Internship - Fall 2026',
    'Operations Program Management Intern',
    'Software Engineer - 2027 Internship Program (June Start)',
  ]) {
    assert.equal(resolveEmploymentType(title), 'Internship', title);
  }
});

test('an internship word in the language the posting was written in', () => {
  /* Twenty live internships were missed for no reason but language. Every title below is real. */
  for (const title of [
    'Estágio em Data Analytics',            // btgpactual, pt
    'Estágio | Research – Fundos de Investimento e Renda Fixa',
    'Programa Estágio de Férias 2027.1',
    'Field Marketing Stagiair (f/m/x)',     // HelloFresh, nl
    'Social Media & Influencer Stagiair(e) (m/v/x)',
    'IT Asset Management Stagiair(e)',      // Lucid
    'Werkstudent Finance',                  // crisp, de
  ]) {
    assert.equal(resolveEmploymentType(title), 'Internship', title);
  }
  // Werkstudent is tagged FullTime by its employer, meaning full-time HOURS. Same Modal case.
  assert.equal(resolveEmploymentType('Werkstudent Finance', 'FullTime'), 'Internship');
});

test('bare "stage" is NOT an internship word in an English title', () => {
  /* Why the multilingual list is hand-picked rather than a translation table. All live titles. */
  for (const title of [
    'Account Executive, Early Stage - EMEA',
    'Senior Account Executive, Growth Stage',
    'Senior Stage Fluids Engineer I',
    'Account Manager, Growth Stage',
  ]) {
    assert.notEqual(resolveEmploymentType(title), 'Internship', title);
  }
});

test('an intern word in a QUALIFICATIONS list is not the job on offer', () => {
  /* Rocket Lab's Security Officer, live, and five postings wide. The phrase is identical to Jane
     Street's until you look for the second person after it. */
  const rocketLab = 'THESE QUALIFICATIONS WOULD BE NICE TO HAVE: Industrial work experience, '
    + 'preferably in aerospace. Previous or current employment with Rocket Lab as an intern, '
    + 'employee or contractor, or work experience at another aerospace company.';
  assert.equal(resolveEmploymentType('Security Officer', undefined, rocketLab), undefined);

  // N26 publishes this benefits block on every posting it lists, internship or not.
  const n26 = 'A Premium N26 bank account. Varying vacation days depending on your location of '
    + 'work and duration of your internship. A high degree of autonomy.';
  assert.equal(
    resolveEmploymentType('Social Media Customer Service Team Lead', undefined, n26),
    undefined,
  );

  // And the real thing still resolves.
  assert.equal(
    resolveEmploymentType('Software Engineer', undefined,
      'As an intern, you are paired with full-time employees who act as mentors.'),
    'Internship',
  );
});

test('a posting that POINTS AT the internship is not the internship', () => {
  /* Astranis runs paired postings: a post-grad Associate and an Intern for the same role. The
     Associate one sends students away, in the exact words a real internship would use. Twelve
     live postings, and all twelve were on the board as internships. */
  const associate = 'Many past interns have designed hardware that is heading to space. If you '
    + 'have not already graduated from a four-year university, please apply to our internship '
    + 'program. Role: work with the GNC team to design satellite software.';
  assert.equal(
    resolveEmploymentType('Guidance, Navigation, and Control Engineer Associate (Fall 2026)',
      undefined, associate),
    undefined,
  );
  const pointer2 = 'If you are still a college student, please apply to join us as an Intern.';
  assert.equal(resolveEmploymentType('Flight Software Associate (Fall 2026)', undefined, pointer2),
    undefined);

  // A posting that points at one internship AND describes its own still counts as an internship.
  const both = 'For our other openings please apply to our internship program. During your '
    + 'internship, you will work alongside the research team.';
  assert.equal(resolveEmploymentType('Research Associate', undefined, both), 'Internship');
});

test('the finance "Summer Analyst" convention is caught from the body', () => {
  /* AQR posts eight of these and the word intern appears in none of the titles. This is the shape
     Mehek flagged: a fixed-period summer role that only the description confirms. */
  const aqr = 'We recognize the power of collaboration. The Internship Program Our 10-week summer '
    + 'program puts real work of the firm in your hands. You will work alongside brilliant people.';
  assert.equal(resolveEmploymentType('2027 Research Summer Analyst', undefined, aqr), 'Internship');

  const aqr2 = "AQR's 10-week internship experience features the Quanta Academy Summer Term.";
  assert.equal(resolveEmploymentType('2027 Risk Summer Analyst', undefined, aqr2), 'Internship');

  const mozilla = 'As part of our internship program, you will be mentored one-on-one.';
  assert.equal(resolveEmploymentType('Necko Student Worker', undefined, mozilla), 'Internship');
});

test('a season word in the title is NOT on its own an internship signal', () => {
  /* Measured: 28 live titles carry a season word without an intern word, and only 9 are
     internships. Fifteen are Astranis post-grad "Associate (Fall 2026)" roles and one is Gusto's
     "Summer Opportunities - Retirement Sales AE", a full-time sales job. The season goes in the
     title; the evidence stays in the body. */
  for (const title of [
    'Summer Opportunities - Retirement Sales AE',
    'Mission Engineering Associate (Fall 2026)',
    'Campus AI/ML Researcher (Fall 2026)',
  ]) {
    assert.equal(resolveEmploymentType(title), undefined, title);
  }
});

test('employers keep inventing new spellings of full-time', () => {
  // Each of these was found live, on a different board, after the previous one was fixed.
  assert.equal(normalizeEmploymentType('Full Time Employee'), 'Full-time');      // Workable
  assert.equal(normalizeEmploymentType('Permanent, Full-time'), 'Full-time');    // Ninja Van
  assert.equal(normalizeEmploymentType('Permanent'), 'Full-time');               // Lever
  // And the anchor still holds where it matters.
  assert.equal(normalizeEmploymentType('Full Time Contractor'), 'Contract');
});

/* THE COMPOUND PASS. Every value below is VERBATIM from prod on 2026-09-01, with the posting count
 * it carried, because the whole point of this pass is that it was measured rather than imagined.
 * The counts are what makes the priority obvious: `fulltime_permanent` alone was 11,164 tiles
 * reading like a database column. */

test('Recruitee ships a code, not a word, and the code is still an employment type', () => {
  // The value that started this: 18,489 live postings across the five codes, every one of them
  // rendering the raw code on the tile and matching none of the five filters.
  assert.equal(normalizeEmploymentType('fulltime_permanent'), 'Full-time');    // 11,164 live
  assert.equal(normalizeEmploymentType('parttime_permanent'), 'Part-time');    //  1,683 live
  assert.equal(normalizeEmploymentType('parttime_minijob'), 'Part-time');      //    206 live
  // The code states hours AND tenure, and the hours are the half both filters run on, so they win.
  // Reading these as Contract dropped 3,550 postings out of every full-time match with no role type
  // able to recover them - see the hours-win test below.
  assert.equal(normalizeEmploymentType('fulltime_fixed_term'), 'Full-time');   //  3,550 live
  assert.equal(normalizeEmploymentType('parttime_fixed_term'), 'Part-time');   //  1,886 live
});

test('a payroll or site qualifier welded onto the type does not hide the type', () => {
  assert.equal(normalizeEmploymentType('Salaried, full-time'), 'Full-time');   //  3,961 live
  assert.equal(normalizeEmploymentType('Hourly, full-time'), 'Full-time');     //  1,312 live
  assert.equal(normalizeEmploymentType('Full Time Hybrid'), 'Full-time');      //    922 live
  assert.equal(normalizeEmploymentType('Clinical Part Time'), 'Part-time');    //  1,005 live
  assert.equal(normalizeEmploymentType('Hourly, part-time'), 'Part-time');     //    893 live
  assert.equal(normalizeEmploymentType('Full Time - Exempt'), 'Full-time');
  assert.equal(normalizeEmploymentType('Regular Full-Time'), 'Full-time');
});

test('the type survives being said in another language', () => {
  for (const value of ['Vollzeit', 'Temps plein', 'Tiempo Completo', 'Tempo integral',
    'Tempo pieno', 'Voltijds', 'A tiempo completo', 'Jornada Completa',
    'Contrat a duree indeterminee', '正社員', '시니어/정규직']) {
    assert.equal(normalizeEmploymentType(value), 'Full-time', value);
  }
  for (const value of ['Teilzeit', 'Deeltijds', 'Temps partiel']) {
    assert.equal(normalizeEmploymentType(value), 'Part-time', value);
  }
  // The world's payroll shorthand for a permanent staff job.
  for (const value of ['CDI', 'CLT', 'Efetivo', 'On-roll', 'En planilla', 'W2', 'FTE',
    'Direct Hire']) {
    assert.equal(normalizeEmploymentType(value), 'Full-time', value);
  }
  assert.equal(normalizeEmploymentType("Stage de fin d'etudes"), 'Internship');
  assert.equal(normalizeEmploymentType('Working Student'), 'Internship');
});

test('precedence holds when a value carries more than one signal', () => {
  // Part-time above full-time, or "Permanent Part-Time" reads as permanent-therefore-full-time.
  assert.equal(normalizeEmploymentType('Permanent Part-Time'), 'Part-time');
  assert.equal(normalizeEmploymentType('Part Time Permanent - Team Member (Retail)'), 'Part-time');
  // Internship above everything: a paid full-time summer placement is still an internship.
  assert.equal(normalizeEmploymentType('Full time - intern'), 'Internship');
});

test('when a value states both hours and tenure, the hours win', () => {
  /* BOTH filters this board runs are hours filters - targetingConditions matches
     `employment_type ~* 'full.?time'` and matchingRoleType sets isNonFullTime from the same word -
     and ROLE_TYPES has no contract entry, so a posting typed Contract leaves targeting rather than
     moving to another filter. Reading the tenure half here cost 3,676 live postings their
     full-time matches with nothing able to bring them back. */
  assert.equal(normalizeEmploymentType('fulltime_fixed_term'), 'Full-time');   // 3,550 live
  assert.equal(normalizeEmploymentType('Full Time - 1099'), 'Full-time');      //    64 live
  assert.equal(normalizeEmploymentType('Per Diem, Part-Time or Full Time'), 'Full-time'); // 36
  assert.equal(normalizeEmploymentType('Seasonal, full-time'), 'Full-time');   //     8 live
  assert.equal(normalizeEmploymentType('PT Temp/Seasonal'), 'Part-time');      //    91 live
  assert.equal(normalizeEmploymentType('Part-time (Seasonal)'), 'Part-time');  //     6 live
});

test('a value that states only tenure is still a contract', () => {
  // Nothing here says how many hours, so there is no hours fact to prefer.
  for (const value of ['Freelance', 'Per Diem', 'PRN', 'Casual', 'Seasonal', 'Interim', 'Locum',
    '1099', 'Contingent Worker', 'Maternity Cover', 'Casual Seasonal']) {
    assert.equal(normalizeEmploymentType(value), 'Contract', value);
  }
  /* Lever's bare "Fixed Term" is untouched by the hours rule, and is right to be: it is caught by
     the anchored pass above precisely because it carries no hours. */
  assert.equal(normalizeEmploymentType('Fixed Term'), 'Contract');
  assert.equal(normalizeEmploymentType('Short Term'), 'Contract');
  // And the oldest guard of all still holds, from the anchored pass.
  assert.equal(normalizeEmploymentType('Full Time Contractor'), 'Contract');
});

test('a posting offered as either full or part time stays reachable from a filter', () => {
  // 964 live postings say both. One flat category has to be chosen, and Full-time is the one the
  // employer is certainly offering.
  for (const value of ['Full-time or Part-time', 'Full Time/Part Time', 'Full-Time or Part-Time',
    'Part Time, Full Time', 'Full-Time & Part-Time', 'Pt or FT']) {
    assert.equal(normalizeEmploymentType(value), 'Full-time', value);
  }
});

test('a word that only looks like a signal is not read as one', () => {
  // Each of these was mistyped by an earlier draft of the compound pass, and each is live.
  // A probationary period is a permanent job, not a contract.
  assert.equal(normalizeEmploymentType('PH:  Professional Class - Probation'),
    'PH:  Professional Class - Probation');
  // Grant-contingent, not a contingent worker.
  assert.equal(normalizeEmploymentType('Contingent on Award'), 'Contingent on Award');
  // "See Salary Details" is an instruction to the reader, not the word "salary".
  assert.equal(normalizeEmploymentType('Coach & Cocurricular (See Salary Details for information)'),
    'Coach & Cocurricular (See Salary Details for information)');
  // But a value that genuinely states the type alongside that instruction still resolves.
  assert.equal(
    normalizeEmploymentType('Lunch Assistant (Part Time - See Salary Details for information)'),
    'Part-time',
  );
});

test('the compound pass never overrides a title that says internship', () => {
  // resolveEmploymentType's one exception has to keep winning over the newly-understood field.
  assert.equal(resolveEmploymentType('ML Research Intern', 'fulltime_permanent'), 'Internship');
  assert.equal(resolveEmploymentType('Senior Backend Engineer', 'fulltime_permanent'), 'Full-time');
});
