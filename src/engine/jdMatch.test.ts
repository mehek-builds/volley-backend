import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  MIN_SCORABLE_TERMS as _MIN,
  segmentJd,
  extractJdTerms,
  normalizeTerm,
  resumeCovers,
  scoreJdMatch,
  scoreBand,
  MIN_SCORABLE_TERMS,
  MIN_SIGNAL_TERMS,
  EMPHASIS_LIMIT,
} from './jdMatch';

/**
 * The bar this module has to clear, set by resumeValidate.ts:785: the old coverage number separated
 * a matching JD from a wholly mismatched one by ~2 points. If this scorer ever regresses toward
 * that, these tests fail rather than the dashboard quietly showing a number that means nothing.
 */
const MIN_SEPARATION = 30;

// A realistic software JD, headings and all, including the noise sections that poisoned the old
// denominator (benefits, EEO, about us).
const SWE_JD = `
About us
We are a fast paced, mission driven company in Toronto. We obsess over our customers and we are
passionate about building a world class team. Join us and make an impact.

Responsibilities
- Build and ship features across our React and TypeScript front end
- Design REST and GraphQL APIs backed by PostgreSQL
- Own services deployed on AWS with Docker and Kubernetes

Requirements
- Strong experience with Python and TypeScript
- Familiarity with React, PostgreSQL, and Docker
- Comfortable with Git and CI/CD pipelines
- Bachelor's degree in Computer Science or equivalent experience

Preferred qualifications
- Exposure to Kafka or Airflow
- Experience with Terraform

Benefits
Generous vacation, dental and vision insurance, retirement matching, and a hybrid office in Toronto.

Equal opportunity
We are an equal opportunity employer. All qualified applicants will receive consideration for
employment without regard to race, religion, gender, sexual orientation, veteran or disability status.
`;

// A JD from a completely different discipline. A SWE resume should score badly here, and that gap
// is the entire point of the model.
const MARKETING_JD = `
Requirements
- Hands on experience with Salesforce, HubSpot, and Marketo
- Deep understanding of SEO, SEM, and PPC campaign management
- Advanced Excel and Tableau for attribution and segmentation analysis
- Experience running A/B testing programs and reporting on ROI and KPI dashboards

Responsibilities
- Own the content calendar and copywriting for lifecycle campaigns
- Build reporting in Looker and present to leadership

Benefits
Great culture, generous vacation, and an excellent team of passionate marketers.
`;

const SWE_RESUME = `
Mehek Mandal
University of Southern California, BS Computer Science, May 2028

Experience
Traeco - Software Engineering Intern
- Built a TypeScript and React dashboard backed by a PostgreSQL database
- Containerized services with Docker and deployed them on AWS
- Wrote Python data pipelines and automated deploys through a CI/CD workflow in Git

Skills
Python, TypeScript, React, PostgreSQL, Docker, AWS, Git, GraphQL
`;

describe('segmentJd', () => {
  test('a boilerplate banner too wordy to be a heading still closes the section above it', () => {
    // phonepe's "Senior Executive, Compliance". The line below is 80 characters and 12 words, so
    // isHeadingLine rejects it, and an unrecognised heading does not CLOSE the section it
    // interrupts: the whole benefits table was read as REQUIRED at weight 1, and the extracted
    // requirements for that posting were `adoption assistance`, `car lease` and `pf contribution`
    // while `merchant compliance` and `risk management` were pushed out of the denominator.
    const jd = `Requirements
- Deep knowledge of Merchant Compliance and Risk Management
- Experience with Regulatory Reporting, Governance Management and Change Management
- Familiarity with Python, SQL, Docker, Tableau and Excel for controls testing
PhonePe Full Time Employee Benefits (Not applicable for Intern or Contract Roles)
Parental Support - Maternity Benefit, Adoption Assistance Program, Day-care Support
Other Benefits - Higher Education Assistance, Car Lease, Salary Advance Policy
`;
    const kinds = segmentJd(jd).map((s) => s.kind);
    assert.deepEqual(kinds, ['required', 'noise']);
    const keys = extractJdTerms(jd).map((t) => t.term);
    for (const junk of ['car lease', 'adoption assistance', 'day-care support']) {
      assert.ok(!keys.includes(junk), `"${junk}" is a perk, not a requirement`);
    }
  });

  test('a requirement sentence mentioning benefits is not mistaken for the benefits block', () => {
    // One of the two shape guards. A requirement written as a full sentence ends in a full stop; a
    // boilerplate banner is a label and does not.
    const jd = `Requirements
Ability to explain the benefits of our compliance platform to enterprise customers.
Experience with Regulatory Reporting and Governance Management.
`;
    assert.deepEqual(segmentJd(jd).map((s) => s.kind), ['required']);
  });

  test('KNOWN LIMIT: an unbulleted, unpunctuated requirement line IS misread as boilerplate', () => {
    // Pinned as a limitation rather than asserted as correct, because it is neither hypothetical
    // nor currently harmful and the file must not claim otherwise.
    //
    // Measured over the 400-posting corpus: 3127 of 6440 lines inside required, preferred and
    // responsibilities sections (48.6%) carry no leading bullet and no terminal full stop, so on
    // nearly half the corpus NEITHER shape guard applies and only the narrowness of the NOISE_BLOCK
    // vocabulary is preventing a false positive. The live rate is zero; the margin is vocabulary
    // luck, not the guards.
    //
    // This test exists so that anyone widening NOISE_BLOCK sees the failure mode written down and
    // has a place to check their addition. If a future change makes these classify as `required`,
    // that is an IMPROVEMENT: update the assertion, do not delete the test.
    for (const line of [
      'Ability to explain the benefits of our platform to prospective customers',
      'Knowledge of EEO and affirmative action reporting requirements',
    ]) {
      const kinds = segmentJd(`Requirements\n- Python and Docker and SQL\n${line}\n- React and Git\n`).map(
        (s) => s.kind,
      );
      assert.deepEqual(
        kinds,
        ['required', 'noise'],
        `"${line}" is expected to truncate the block today; if it no longer does, tighten this test`,
      );
    }
  });

  test('"About <Company>" is the company blurb, whoever the company is', () => {
    // The old pattern enumerated "about us|about the company|about our", so every posting that
    // named itself went unrecognised. OpenAI's "Counsel, Litigation" ran its Responsibilities
    // section straight through "About OpenAI" and into the EEO footer, and the twelve terms it
    // yielded were `affirmative action`, `california fair`, `chance ordinance`, `fair chance`,
    // `los angeles`, `san francisco` and `eeo policy statementpdf`.
    for (const heading of ['About OpenAI', 'About PhonePe Limited:', 'About us', 'About the Team']) {
      const [, second] = segmentJd(`Responsibilities\n- Handle litigation matters\n${heading}\nWe are a company.\n`);
      assert.equal(second?.kind, 'noise', `"${heading}" should open a noise section`);
    }
  });

  test('classifies the sections that carry signal and the ones that do not', () => {
    const kinds = segmentJd(SWE_JD).map((s) => s.kind);
    assert.ok(kinds.includes('required'), 'Requirements is a required section');
    assert.ok(kinds.includes('responsibilities'), 'Responsibilities is scored');
    assert.ok(kinds.includes('preferred'), 'Preferred qualifications is scored lower');
    assert.ok(kinds.includes('noise'), 'Benefits/EEO/About are noise');
  });

  test('noise sections carry zero weight', () => {
    for (const s of segmentJd(SWE_JD)) {
      if (s.kind === 'noise') assert.equal(s.weight, 0);
    }
  });

  test('"preferred qualifications" is not read as "qualifications"', () => {
    const s = segmentJd('Preferred qualifications\n- Kafka\n');
    assert.equal(s[0].kind, 'preferred');
  });

  test('a long sentence containing a heading word is not a heading', () => {
    const s = segmentJd(
      'We have a number of requirements that we expect every applicant to read carefully before applying.\n',
    );
    assert.equal(s.length, 1);
    assert.equal(s[0].kind, 'body');
  });
});

describe('extractJdTerms', () => {
  test('drops the corporate vocabulary the old scorer counted as keywords', () => {
    const terms = extractJdTerms(SWE_JD).map((t) => t.term);
    for (const junk of ['toronto', 'vacation', 'benefits', 'passionate', 'obsess', 'insurance']) {
      assert.ok(!terms.includes(junk), `"${junk}" must not be a requirement term`);
    }
  });

  test('keeps the real requirements', () => {
    // `kubernetes` left this list when EMPHASIS_LIMIT shipped. It is real, and it is the LAST word
    // of the last Responsibilities bullet in a posting that then states seven weight-1 requirements
    // below it, so it is the thirteenth most emphasised thing here and the cap stops at twelve.
    // That is the cap doing its job; every term the Requirements block states still survives.
    const terms = extractJdTerms(SWE_JD).map((t) => t.term);
    for (const real of ['python', 'typescript', 'react', 'postgresql', 'docker', 'git']) {
      assert.ok(terms.includes(real), `"${real}" should be a requirement term`);
    }
  });

  test('the denominator is a size a one-page resume can actually cover', () => {
    // The old bound here was 60, which this posting passed while its score stayed unreachable. A
    // ceiling that no real posting could hit was not a bound at all: see EMPHASIS_LIMIT.
    const terms = extractJdTerms(SWE_JD);
    assert.ok(
      terms.length >= MIN_SCORABLE_TERMS && terms.length <= EMPHASIS_LIMIT,
      `expected a human-reachable term count, got ${terms.length}`,
    );
  });

  test('a required term outweighs a preferred one', () => {
    // Deliberately a SHORT posting rather than SWE_JD. SWE_JD states twelve requirements and
    // responsibilities before it reaches its Preferred block, so EMPHASIS_LIMIT drops Terraform
    // from the set entirely, which is the cap working rather than the weighting failing. The
    // weighting itself is what this test is about, so it is asserted where the cap does not bind.
    const terms = extractJdTerms('Requirements\n- Python\n\nPreferred\n- Terraform\n');
    const python = terms.find((t) => t.term === 'python');
    const terraform = terms.find((t) => t.term === 'terraform');
    assert.ok(python && terraform);
    assert.ok(python.weight > terraform.weight, 'Requirements outrank Preferred');
  });

  test('a term in both required and preferred keeps the higher weight', () => {
    const terms = extractJdTerms('Requirements\n- Docker\n\nPreferred\n- Docker\n');
    assert.equal(terms.find((t) => t.term === 'docker')?.weight, 1);
  });

  // --- regressions from the first pass of this model, all three found by reading the missing list
  // rather than the score. The score looked plausible while the list was full of junk, which is
  // exactly the failure mode that made the old coverage number useless.

  test('does not build a bigram across a comma (React, PostgreSQL is two requirements)', () => {
    const terms = extractJdTerms('Requirements\n- Familiarity with React, PostgreSQL, and Docker\n');
    const keys = terms.map((t) => t.term);
    assert.ok(!keys.includes('react postgresql'), 'a list separator is not a phrase boundary to cross');
    assert.ok(keys.includes('react') && keys.includes('postgresql') && keys.includes('docker'));
  });

  test('a bullet-opening verb is not a requirement', () => {
    // "Design REST APIs" asks for REST, not for "Design". An earlier version read every
    // bullet-initial capital as a product name and put "Design", "Comfortable" and "Build" on the
    // missing list, where F2 would have written a resume bullet about them.
    const keys = extractJdTerms(
      'Responsibilities\n- Design REST APIs\n- Build services\n- Comfortable with Git\n',
    ).map((t) => t.term);
    for (const junk of ['design', 'build', 'comfortable']) {
      assert.ok(!keys.includes(junk), `"${junk}" opens a bullet as grammar, not as a requirement`);
    }
    assert.ok(keys.includes('rest') && keys.includes('git'), 'the real requirements survive');
  });

  test('a bullet-initial capital that IS the requirement survives', () => {
    const keys = extractJdTerms('Requirements\n- Machine Learning experience required\n').map((t) => t.term);
    assert.ok(keys.includes('machine learning'));
  });

  test('short English words are not mistaken for acronyms', () => {
    // The lexicon carries genuine short acronyms; a shape rule admitted "ship", "end" and "own".
    const keys = extractJdTerms(
      'Responsibilities\n- You will ship work end to end and own the outcome\n',
    ).map((t) => t.term);
    for (const junk of ['ship', 'end', 'own']) {
      assert.ok(!keys.includes(junk), `"${junk}" is an English word, not an acronym`);
    }
  });

  test('a tech plural resolves to its lexicon singular (APIs -> api)', () => {
    const keys = extractJdTerms('Requirements\n- Experience designing GraphQL APIs\n').map((t) => t.term);
    assert.ok(!keys.includes('graphql apis'), 'two lexicon skills side by side stay separate');
    assert.ok(keys.includes('graphql'));
  });

  test('a bigram removes its own parts so one requirement is counted once', () => {
    const terms = extractJdTerms('Requirements\n- Machine Learning experience\n').map((t) => t.term);
    assert.ok(terms.includes('machine learning'));
    assert.ok(!terms.includes('machine'), 'the bigram subsumes its parts');
    assert.ok(!terms.includes('learning'));
  });
});

describe('normalizeTerm and resumeCovers', () => {
  test('spelling variants of one term normalize together', () => {
    assert.equal(normalizeTerm('Node.js'), 'nodejs');
    assert.equal(normalizeTerm('CI/CD'), 'ci cd');
    assert.equal(normalizeTerm('  Machine-Learning '), 'machine learning');
  });

  test('matches across plural and hyphenation', () => {
    assert.ok(resumeCovers('Built data pipelines in Python', 'pipeline'));
    assert.ok(resumeCovers('Owned CI/CD for the team', 'ci cd'));
  });

  test('does not match a substring of an unrelated word', () => {
    assert.ok(!resumeCovers('Studied international relations', 'r'));
    assert.ok(!resumeCovers('Wrote a javadoc', 'java'));
  });

  test('NEVER credits a broader term for a narrower one (the R-015 trap)', () => {
    // resumeSpec.ts documents the model laundering "Hugging Face" into "Machine Learning". A scorer
    // that does the same thing silently is the same defect wearing a different hat.
    assert.ok(
      !resumeCovers('Used Hugging Face transformers', 'machine learning'),
      'a specific tool must not satisfy a broad discipline requirement',
    );
    assert.ok(
      !resumeCovers('Experience with machine learning', 'pytorch'),
      'a broad discipline must not satisfy a specific tool requirement',
    );
  });
});

describe('scoreJdMatch', () => {
  test('a matching resume lands in a believable band, not pinned near zero', () => {
    const r = scoreJdMatch(SWE_RESUME, SWE_JD);
    assert.equal(r.scorable, true);
    assert.ok(r.score !== null);
    assert.ok(
      r.score! >= 40,
      `a genuinely matching resume should not read as failing, got ${r.score}`,
    );
  });

  test('THE DISCRIMINATION TEST: matched and mismatched separate by a wide margin', () => {
    // This is the assertion the old ats_keyword_coverage_pct could not pass. It managed ~2 points.
    const match = scoreJdMatch(SWE_RESUME, SWE_JD);
    const mismatch = scoreJdMatch(SWE_RESUME, MARKETING_JD);
    assert.ok(match.score !== null && mismatch.score !== null);
    const separation = match.score! - mismatch.score!;
    assert.ok(
      separation >= MIN_SEPARATION,
      `a match score must tell a matching JD from a mismatched one: got ${match.score} vs ${mismatch.score} (separation ${separation}, need ${MIN_SEPARATION})`,
    );
  });

  test('the missing list is ordered by weight, so the top fix is the top item', () => {
    const r = scoreJdMatch(SWE_RESUME, SWE_JD);
    for (let i = 1; i < r.missing.length; i++) {
      assert.ok(r.missing[i - 1].weight >= r.missing[i].weight);
    }
  });

  test('matched plus missing accounts for every term, with none double counted', () => {
    const r = scoreJdMatch(SWE_RESUME, SWE_JD);
    assert.equal(r.matched.length + r.missing.length, r.term_count);
    const seen = new Set([...r.matched, ...r.missing].map((t) => t.term));
    assert.equal(seen.size, r.term_count);
  });

  test('refuses to score a posting with no real requirements rather than guessing', () => {
    const r = scoreJdMatch(SWE_RESUME, 'We are hiring! Come join our team. Great culture.');
    assert.equal(r.scorable, false);
    assert.equal(r.score, null);
    assert.match(r.reason ?? '', /Nothing is wrong with your resume/);
  });

  test('an empty JD is not scorable', () => {
    assert.equal(scoreJdMatch(SWE_RESUME, '').scorable, false);
  });

  test('an empty resume against a real JD scores zero, not null', () => {
    const r = scoreJdMatch('', SWE_JD);
    assert.equal(r.scorable, true);
    assert.equal(r.score, 0);
  });
});

describe('scoreBand', () => {
  test('bands are calibrated to what this scorer produces', () => {
    assert.equal(scoreBand(80).tone, 'strong');
    assert.equal(scoreBand(50).tone, 'fair');
    assert.equal(scoreBand(20).tone, 'weak');
  });

  test('the bottom band describes the pair, not the student', () => {
    // ISSUE-023. On a board of 400 postings most are in someone else's field, so this is the label
    // a student reads most often, and it was the only one of the four that graded THEM. The number
    // is not softened; the words are just about the job, which is what they were always measuring.
    const { label, tone } = scoreBand(5);
    assert.equal(tone, 'weak', 'the styling is unchanged');
    assert.ok(!/weak/i.test(label), `"${label}" grades the student rather than the fit`);
  });
});

/**
 * ISSUE-023: the denominator, and the reachability of the label sitting next to it.
 *
 * Measured before this change against the 400 newest active postings scored against three real
 * production base resumes: p50 = 3, p90 = 11, max = 57, and 1105 of 1107 scorable pairs read "Weak
 * match". "Strong match" at 65 was unreached on the entire board.
 *
 * These tests pin the INTENT, not the constants. The reachability test in particular would still
 * fail if someone kept EMPHASIS_LIMIT at 12 and quietly went back to a denominator of every term
 * the posting mentions, because it asserts on the score a genuinely well-matched resume gets.
 */
describe('the denominator is capped to what the posting emphasises', () => {
  test('THE REACHABILITY TEST: a genuinely strong resume reaches the Strong band', () => {
    // The assertion the shipped scorer could not pass. SWE_RESUME states Python, TypeScript, React,
    // PostgreSQL, Docker, AWS, Git, GraphQL and a CI/CD workflow; SWE_JD requires that list almost
    // exactly. If THIS pair cannot read as a strong match then no pair can, and the label is
    // decoration.
    const r = scoreJdMatch(SWE_RESUME, SWE_JD);
    assert.ok(r.score !== null);
    const band = scoreBand(r.score!, r.required_coverage);
    assert.equal(
      band.tone,
      'strong',
      `a resume carrying nearly every stated requirement scored ${r.score} (${r.matched.length} of ${r.term_count}) and read "${band.label}"`,
    );
  });

  test('a long posting is scored against at most EMPHASIS_LIMIT requirements', () => {
    // A 6k posting and a 1.5k posting must ask the student a question of the same size, or the
    // score measures how much the employer wrote rather than how well the student fits.
    const suffix = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const long = `Requirements\n${suffix
      .map((s) => `- Experience with Vendor${s}x Platform`)
      .join('\n')}\n`;
    assert.equal(extractJdTerms(long).length, EMPHASIS_LIMIT);
  });

  test('a posting that states fewer requirements is scored against all of them', () => {
    // The cap is a ceiling, never a floor. A short honest posting is not padded out.
    const terms = extractJdTerms('Requirements\n- Python, Docker, AWS, React, PostgreSQL, Git\n');
    assert.ok(terms.length >= MIN_SCORABLE_TERMS && terms.length < EMPHASIS_LIMIT);
  });

  test('a stated requirement outlives unheaded prose that names a real product', () => {
    // NOT asserted against SWE_JD. Its sections are [noise, responsibilities, required, preferred,
    // noise, noise] with no body section at all, so an assertion that no `body` term survives the
    // cap there passes whatever capToEmphasis does, and an earlier version of this test made
    // exactly that mistake while claiming to cover this change's central promise.
    //
    // So the fixture below OPENS with unheaded prose, which segments as `body` at weight 0.4, and
    // fills it with Title Case product names that the proper-noun rule really does admit. Run
    // uncapped they are all requirement terms; the cap has to be what removes them, and the
    // weight-1 block below has to be what survives.
    const jd = `We are a team that loves Datadog and Splunk and Grafana and Sentry and Snowplow.
Our office runs on Notion Calendar, Linear Roadmaps and Superhuman Mail every single day.

Requirements
- Strong experience with Python and TypeScript
- Familiarity with React, PostgreSQL, and Docker
- Comfortable with Git and CI/CD pipelines
- Bachelor's degree in Computer Science or equivalent experience
`;
    const uncapped = new Set(extractJdTerms(jd.split('\nRequirements')[0]).map((t) => t.term));
    assert.ok(
      uncapped.has('datadog') && uncapped.has('splunk'),
      'the prose terms must be admitted uncapped, or this test proves nothing',
    );

    const keys = extractJdTerms(jd).map((t) => t.term);
    assert.equal(keys.length, EMPHASIS_LIMIT);

    // EVERY stated requirement survives. This is the half that bites if weight ever stops leading
    // the emphasis ranking: put body above required and these are the terms that get evicted.
    for (const stated of ['python', 'typescript', 'react', 'postgresql', 'docker', 'git']) {
      assert.ok(keys.includes(stated), `"${stated}" is stated under Requirements`);
    }

    // The prose does not vanish, and asserting that it did would be the same untestable claim in a
    // new costume. The Requirements block supplies 8 terms, the cap keeps 12, so 4 slots are left
    // and body prose fills them. What must hold is that it fills only the LEFTOVER slots: eight
    // stated requirements first, prose in what remains, never the other way round.
    const prose = ['datadog', 'splunk', 'grafana', 'sentry', 'snowplow', 'notion calendar', 'linear roadmaps', 'superhuman mail'];
    const survivors = prose.filter((p) => keys.includes(p));
    assert.ok(
      survivors.length <= EMPHASIS_LIMIT - 8,
      `prose took more than the leftover slots: ${survivors.join(', ')}`,
    );
    assert.ok(survivors.length < prose.length, 'the cap must actually be cutting prose here');
  });

  test('a Preferred item yields to a full block of stated requirements', () => {
    const keys = extractJdTerms(SWE_JD).map((t) => t.term);
    assert.ok(keys.includes('python') && keys.includes('typescript'));
    assert.ok(!keys.includes('terraform'), 'a Preferred item yields to twelve stated requirements');
  });

  test('the cap never turns a scorable posting into an unscorable one', () => {
    // MIN_SIGNAL_TERMS is the refusal path, and a change to the denominator must not be able to
    // trigger it. This is the constraint that RESERVES MIN_SIGNAL_TERMS slots for hard signal: a
    // set of proper nouns under a Requirements heading outranks the lexicon hits on section weight
    // alone, and without the reservation it would crowd them out of the denominator and leave a
    // perfectly scorable posting looking like it stated nothing.
    const jd = `Requirements\n${'abcdefghijklmnopqrstuvwxyz'
      .split('')
      .map((s) => `- Familiarity with Vendor${s}y Platform\n`)
      .join('')}
Responsibilities
- Write Python and SQL against a PostgreSQL warehouse using Docker
`;
    const terms = extractJdTerms(jd);
    assert.equal(terms.length, EMPHASIS_LIMIT);
    assert.ok(
      terms.filter((t) => t.signal).length >= MIN_SIGNAL_TERMS,
      'the cap must not manufacture a refusal by dropping every hard-signal term',
    );
    assert.equal(scoreJdMatch(SWE_RESUME, jd).scorable, true);
  });

  test('with no requirements section, repetition is what decides emphasis', () => {
    // 47% of postings on the board have no requirements block at all. There every term is body
    // prose at one weight, so mention count is the only thing the employer said on purpose. The
    // alternative tiebreak was alphabetical order, which is not a statement about the job.
    const jd = `We build data tooling. ${'Our team uses Kubernetes daily. '.repeat(6)}
Someone here once used Fortran. We also touched Cobol once, and Perl once.
${'Kubernetes runs everything. '.repeat(4)}
We use Python and Docker and SQL and React and AWS and Git and Kafka and Redis and Airflow.`;
    const terms = extractJdTerms(jd);
    const kubernetes = terms.find((t) => t.term === 'kubernetes');
    assert.ok(kubernetes, 'the term named ten times must survive the cap');
    assert.ok((kubernetes!.mentions ?? 0) > 1, 'repeat mentions are counted, not collapsed');
  });

  test('BOILERPLATE ACRONYMS DO NOT EVICT STATED REQUIREMENTS', () => {
    // The regression that failed the first version of this cap. isHardSignal is
    // `lexicon OR ACRONYM OR TECH_MARKER`, and ACRONYM is any 2-5 letter capital run, which is
    // dense in benefits tables and regulator names. Ranking on signal promoted all of it: phonepe's
    // Senior Executive Compliance kept `ca, cs, kyc, mba, npci, nps, rbi` and dropped
    // `merchant compliance`, `risk management` and `change management`.
    //
    // Hard signal now RESERVES MIN_SIGNAL_TERMS slots instead of sorting first, so the acronyms can
    // take three slots and never more.
    const jd = `Requirements
- In-depth knowledge of the Merchant Compliance space and its regulatory environment
- Experience with Risk Management and Change Management frameworks
- Track record in Regulatory Reporting and Governance Management
- Familiarity with RBI and NPCI circulars, KYC, AML and NPS
- MBA or CA or CS qualification
`;
    const keys = extractJdTerms(jd).map((t) => t.term);
    for (const real of ['merchant compliance', 'risk management', 'change management']) {
      assert.ok(keys.includes(real), `"${real}" is a stated requirement, got ${keys.join(', ')}`);
    }
    // Beyond the reservation the acronyms compete on document order like everything else, and this
    // fixture does name them, so some of them belonging in the set is correct. What must never
    // happen again is the denominator being MOSTLY them.
    const acronyms = keys.filter((k) => ['ca', 'cs', 'mba', 'nps', 'npci', 'rbi', 'kyc', 'aml'].includes(k));
    assert.ok(
      acronyms.length <= EMPHASIS_LIMIT / 2,
      `acronym boilerplate took ${acronyms.length} of ${EMPHASIS_LIMIT} slots: ${acronyms.join(', ')}`,
    );
  });

  test('the lexicon reaches the disciplines Litos actually serves', () => {
    // Measured 2026-08-03: a real UW law-and-policy base resume matched ZERO lexicon entries across
    // all 400 postings on the board, because the list carried no litigation, compliance, regulatory,
    // policy or contracts. Every match it ever got came from the loose proper-noun path, and no
    // amount of denominator work can help a student the lexicon cannot see: the reserved hard-signal
    // slots reserve nothing when there is no hard signal to match.
    for (const [discipline, jd] of [
      ['law', 'Requirements\n- litigation, compliance, and regulatory experience\n- contracts and governance\n'],
      ['policy', 'Requirements\n- legislative advocacy, rulemaking, and policy analysis\n- grants and appropriations\n'],
      ['health', 'Requirements\n- epidemiology and biostatistics\n- triage and pharmacology\n'],
      ['ops', 'Requirements\n- logistics, inventory, and warehousing\n- lean and kaizen practice\n'],
    ] as const) {
      const signal = extractJdTerms(jd).filter((t) => t.signal).map((t) => t.term);
      assert.ok(
        signal.length >= MIN_SIGNAL_TERMS,
        `a ${discipline} posting produced only ${signal.length} hard-signal terms: ${signal.join(', ')}`,
      );
    }
  });

  test('the applicant-privacy footer stays out of the denominator', () => {
    // PINS THE `privacy` / `notice` BOILERPLATE ENTRIES. Removing both from that list passed 90 of
    // 90 tests before this existed, so anyone tidying it would have silently put the footer back
    // into 35 postings' denominators with a fully green suite.
    //
    // The footer line below is the real one, and it defeats every other filter on the way in:
    // 9 words exceeds isHeadingLine's 7-word budget, and NOISE_BLOCK lists `applicant privacy` and
    // `privacy policy` but not `privacy notice`. So BOILERPLATE is the only thing standing between
    // it and the score, which is exactly why it needs a test of its own.
    //
    // Asserted on the OUTCOME, not on membership of the constant: what must hold is that no
    // privacy-footer term reaches the requirement set, however that exclusion comes to be
    // implemented. Blocking `notice` is what also kills the BIGRAM, since a bigram forms only from
    // two independently specific tokens.
    const jd = `Requirements
- Deep knowledge of Merchant Compliance and Risk Management
- Experience with Regulatory Reporting and Governance Management
Global Data Privacy Notice for Job Candidates and Applicants
`;
    const keys = extractJdTerms(jd).map((t) => t.term);
    for (const junk of ['privacy', 'notice', 'privacy notice', 'data privacy']) {
      assert.ok(!keys.includes(junk), `"${junk}" is the applicant-privacy footer, not a requirement`);
    }
    // ...and the block above it is untouched, so the exclusion is not just truncating the posting.
    for (const real of ['merchant compliance', 'risk management', 'governance management']) {
      assert.ok(keys.includes(real), `"${real}" is a stated requirement, got ${keys.join(', ')}`);
    }
  });

  test('blocking the privacy footer does not cost a real privacy-engineering posting', () => {
    // The counterweight to the test above, and the reason it is safe. `privacy` is blocked as a
    // bare word, but a posting that genuinely hires for privacy work states the surrounding
    // practice, and that is what survives. Checked against the one real privacy-engineering posting
    // on the board (Asana, Senior Privacy Engineer), which keeps compliance, data protection,
    // regulatory and security.
    const keys = extractJdTerms(
      'Requirements\n- Lead compliance and data protection reviews across regulatory regimes\n' +
        '- Partner with security engineering on GDPR and CCPA obligations\n',
    ).map((t) => t.term);
    assert.ok(
      ['compliance', 'regulatory', 'data protection'].some((k) => keys.includes(k)),
      `a privacy posting must still be scorable on its practice vocabulary, got ${keys.join(', ')}`,
    );
  });

  test("a posting's own web address is not a requirement", () => {
    // These reach the set through TECH_MARKER (a domain has dots) and are marked hard signal, so
    // under the emphasis ranking they sort to the TOP of the denominator. Measured 2026-08-03:
    // 130 of the 400 newest postings carried at least one.
    const keys = extractJdTerms(
      'Requirements\n- Python and Docker and SQL and React and AWS and Git\n- Read more at www.spacex.com or spacex.com or careers.toasttab.com\n',
    ).map((t) => t.term);
    for (const junk of ['wwwspacexcom', 'spacexcom', 'careerstoasttabcom']) {
      assert.ok(!keys.includes(junk), `"${junk}" is a place to read about the job, not a skill`);
    }
    assert.ok(keys.includes('python') && keys.includes('docker'));
  });

  test('.NET survives the web-address rule', () => {
    // The suffix list deliberately omits .net. ASP.NET and C#.NET are real stated requirements on
    // this board, and deleting them to catch a domain trades a requirement for a nuisance.
    const keys = extractJdTerms('Requirements\n- Strong ASP.NET and C#.NET experience\n').map(
      (t) => t.term,
    );
    assert.ok(
      keys.some((k) => k.includes('aspnet')),
      `ASP.NET must survive, got ${keys.join(', ')}`,
    );
  });

  test('the two shipped denominator fixes are still in force under the cap', () => {
    // PLACE_SAFE_KINDS and the e.g. stopword predate this change and must not be undone by it.
    const placed = extractJdTerms(
      'We work out of Bellevue, WA and Mountain View, CA. You will use Python, SQL and Docker here.',
      { company: 'Databricks', role: 'Product Management Intern', location: 'Bellevue, Washington' },
    ).map((t) => t.term);
    for (const junk of ['bellevue', 'wa']) {
      assert.ok(!placed.includes(junk), `"${junk}" is the commute, not the resume`);
    }
    const eg = extractJdTerms(
      'Requirements\n- Cloud experience (e.g. AWS), plus Python, Docker, SQL, React, Git\n',
    ).map((t) => t.term);
    assert.ok(!eg.includes('eg'), 'a prose connective is not a requirement');
  });
});

/**
 * Regressions from the pre-merge review. Every case below was REPRODUCED against the first version
 * of this model, so each test is a bug that shipped into the branch and was caught by reading the
 * output rather than the code.
 */
describe('review regressions', () => {
  test('a comma-separated resume line covers every skill on it', () => {
    // normalizeTerm only separated on [-_/], so commas stayed glued to the word and the whole-word
    // test ` docker ` failed. Two of three real skills went uncredited.
    const resume = 'Used Docker, Kubernetes, and Terraform in production (3 yrs).';
    for (const term of ['docker', 'kubernetes', 'terraform']) {
      assert.ok(resumeCovers(resume, term), `"${term}" is plainly on the resume`);
    }
  });

  test('markdown headings are still headings', () => {
    for (const heading of ['## Requirements', '**Requirements**', '__Requirements__']) {
      const [first] = segmentJd(`${heading}\n- Python and Docker\n`);
      assert.equal(first.kind, 'required', `${heading} should classify as required`);
    }
  });

  test('a posting that opens with Compensation is still scorable', () => {
    // A noise heading runs to the next heading, so a pay-transparency posting could put the whole
    // document in a zero-weight section and be reported as listing no requirements at all.
    const jd = `Compensation
Base pay is 120000 to 150000.
Requirements: Python, Docker, AWS, Kafka, Terraform, React, PostgreSQL.`;
    const terms = extractJdTerms(jd);
    assert.ok(terms.length >= MIN_SCORABLE_TERMS, `expected a scorable posting, got ${terms.length} terms`);
    assert.equal(scoreJdMatch('Python and Docker', jd).scorable, true);
  });

  test('a slash-joined pair is two requirements, not one unmatchable phrase', () => {
    const keys = extractJdTerms('Requirements\n- Experience with Docker/Kubernetes and React/Redux\n').map((t) => t.term);
    assert.ok(!keys.includes('docker kubernetes'), 'the slash form must not become one term');
    for (const real of ['docker', 'kubernetes', 'react', 'redux']) {
      assert.ok(keys.includes(real), `"${real}" is a requirement in its own right`);
    }
  });

  test('a known slash form stays whole', () => {
    const keys = extractJdTerms('Requirements\n- Comfortable with CI/CD pipelines\n').map((t) => t.term);
    assert.ok(keys.includes('ci cd'));
  });

  test('a bigram does not form across a sentence boundary', () => {
    // '.' is inside the token class so node.js survives, which also swallowed sentence-final
    // periods and made the gap to the next sentence a plain space.
    const keys = extractJdTerms('Requirements\nYou will use Python daily. Kubernetes knowledge helps.\n').map((t) => t.term);
    assert.ok(!keys.some((k) => k.includes(' ')), `no cross-sentence phrases, got ${JSON.stringify(keys)}`);
    assert.ok(keys.includes('python') && keys.includes('kubernetes'));
  });

  test('a bullet-opening verb outside the deny-list is still not a requirement', () => {
    const keys = extractJdTerms('Responsibilities\n- Troubleshoot production incidents\n- Mentor junior engineers\n').map((t) => t.term);
    for (const junk of ['troubleshoot', 'mentor']) {
      assert.ok(!keys.includes(junk), `"${junk}" is a verb, not a requirement`);
    }
  });

  test('a Title Case product name at bullet start survives the same rule', () => {
    const keys = extractJdTerms('Requirements\n- Machine Learning experience required\n').map((t) => t.term);
    assert.ok(keys.includes('machine learning'));
  });

  test('a required term is not deleted by a phrase it also appears in', () => {
    const terms = extractJdTerms('Requirements\n- Deep experience with Databricks\n\nResponsibilities\n- Own Databricks Delta pipelines\n');
    const databricks = terms.find((t) => t.term === 'databricks');
    assert.ok(databricks, 'the weight-1 requirement must survive the phrase');
    assert.equal(databricks.weight, 1);
  });

  test('an academic term does not credit a framework of the same name', () => {
    assert.ok(!resumeCovers('Marketing Intern, Spring 2026 - Present', 'spring'), 'Spring 2026 is a date');
    assert.ok(resumeCovers('Built services with Spring Boot', 'spring'), 'the real framework still counts');
  });

  test('a single-letter language is extracted only as a standalone capital', () => {
    const keys = extractJdTerms('Requirements\n- Proficiency in R and SQL\n').map((t) => t.term);
    assert.ok(keys.includes('r'), 'R is a real requirement on a data posting');
    assert.ok(!keys.includes('proficiency'), 'proficiency is boilerplate');
  });

  test('covering the responsibilities cannot read as a strong match while requirements are missed', () => {
    const jd = `Requirements
- Kubernetes
- Terraform
- Kafka

Responsibilities
- Work in Jira, Notion, Slack, Asana, Figma
- Reporting in Excel, Tableau, SQL and Python`;
    const result = scoreJdMatch('I use Jira, Notion, Slack, Asana, Figma, Excel, Tableau, SQL and Python', jd);
    assert.ok(result.required_coverage !== null && result.required_coverage < 0.5);
    assert.notEqual(scoreBand(result.score!, result.required_coverage).tone, 'strong');
  });

  test('a 60k single-line posting scores without stalling the event loop', () => {
    const jd = 'Requirements: ' + 'We need Python and Docker and AWS experience. '.repeat(1400);
    const started = process.hrtime.bigint();
    scoreJdMatch('Python Docker AWS', jd.slice(0, 60_000));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 250, `extraction took ${Math.round(ms)}ms; positional() was O(n^2) at ~594ms`);
  });
});

/**
 * Registration, not behaviour.
 *
 * This exists because the route shipped to production UNREGISTERED. The unbundle PR removed the two
 * lines in index.ts that mount it, and the follow-up that restored the route file did not restore
 * them. Every unit test passed, typecheck passed, the module was perfect, and POST /jd-match
 * answered "Route not found" in prod. The same shape as the squash that once dropped schema.ts and
 * kept the auth epoch out of prod: the code exists, nothing wires it up.
 *
 * A behavioural test of jdMatch.ts can never catch this. Only a test that reads the composition
 * root can.
 */
describe('a posting does not ask for itself', () => {
  const JD =
    'Litos QA is validating a Software Engineering Intern workflow for Summer 2027. The role uses ' +
    'TypeScript, React, Node.js and PostgreSQL. Candidates should be enrolled at a university in the United States.';
  const CONTEXT = { company: 'Litos QA Receipt', role: 'Software Engineering Intern - Summer 2027' };

  test('the company name, the job title, the season and the country are not requirements', () => {
    // Found on a real posting in production, not in a fixture. The gap list told a student their
    // resume "does not mention" the name of the company they were applying to.
    const keys = extractJdTerms(JD, CONTEXT).map((t) => t.term);
    for (const junk of ['litos qa', 'litos', 'qa', 'engineering intern', 'software engineering', 'summer', 'united states']) {
      assert.ok(!keys.includes(junk), `"${junk}" is the posting describing itself`);
    }
  });

  test('every real requirement still survives the exclusion', () => {
    const keys = extractJdTerms(JD, CONTEXT).map((t) => t.term);
    for (const real of ['typescript', 'react', 'nodejs', 'postgresql']) {
      assert.ok(keys.includes(real), `"${real}" is a real requirement`);
    }
  });

  test('without a context nothing is excluded beyond the standing list', () => {
    const keys = extractJdTerms(JD).map((t) => t.term);
    assert.ok(keys.includes('litos qa'), 'the exclusion is driven by job_context, not guessed');
  });

  test('a company whose name IS a skill does not erase the skill for everyone else', () => {
    // Only this posting's own context is excluded, and only for this call.
    const jd = 'Requirements\n- Strong Python and Docker experience\n';
    const keys = extractJdTerms(jd, { company: 'Docker Inc', role: 'Engineer' }).map((t) => t.term);
    assert.ok(!keys.includes('docker'), 'applying to Docker, Docker is not a requirement to list');
    assert.ok(extractJdTerms(jd, { company: 'Acme', role: 'Engineer' }).map((t) => t.term).includes('docker'));
  });
});

/**
 * ISSUE-014. The posting that started it, verbatim in the parts that matter.
 *
 * Databricks' "Product Management Intern (Summer 2027)" extracted 19 terms against a real student
 * resume and scored 0. Five of the 19 were the office list: bellevue, wa, mountain view, ca,
 * san francisco. They sat in the denominator AND on the missing list, which is the list
 * gap-to-bullet consumes, so the product was one click from offering to write a bullet about
 * Bellevue.
 *
 * The signal floor above cannot catch this. It defends against a term set that is NOTHING but
 * proper nouns, and this posting also mentions Python, SQL, ETL and EDA while listing which TEAMS
 * are hiring, so the floor clears with the geography still in.
 */
describe('a posting does not ask for its own address', () => {
  const JD =
    'At Databricks we build the best data and AI infrastructure platform. As a Product Management ' +
    "Intern you will learn how to be a successful PM. We're hiring across all of our teams, " +
    'including AI Platform, Genie, Machine Learning, Unity Catalog, Databricks SQL, ETL, Streaming, ' +
    'and EDA. This is a 12 week paid summer internship in either San Francisco, CA, Mountain View, ' +
    'CA, or Bellevue, WA. You will prototype and test early ideas with customers using Python.';
  const CONTEXT = {
    company: 'Databricks',
    role: 'Product Management Intern (Summer 2027)',
    // Exactly as the row stores it: three sites, semicolon separated, states spelled out.
    location: 'Bellevue, Washington; Mountain View, California; San Francisco, California',
  };

  test('the offices are not requirements', () => {
    const keys = extractJdTerms(JD, CONTEXT).map((t) => t.term);
    for (const place of ['bellevue', 'mountain view', 'san francisco', 'wa', 'ca']) {
      assert.ok(!keys.includes(place), `"${place}" is where the job is, not something to have done`);
    }
  });

  test('the state is excluded under the spelling the BODY uses, not the one the FIELD uses', () => {
    // The location field says "Washington" and the posting body says "WA". Only cities.ts knows
    // those are one place, which is the whole reason the canonical parse is folded in as well as
    // the raw string.
    const keys = extractJdTerms(JD, CONTEXT).map((t) => t.term);
    assert.ok(!keys.includes('wa'), 'WA in the prose is Washington in the field');
  });

  test('the real requirements survive', () => {
    const keys = extractJdTerms(JD, CONTEXT).map((t) => t.term);
    for (const real of ['python', 'machine learning', 'etl', 'streaming']) {
      assert.ok(keys.includes(real), `"${real}" is a real requirement`);
    }
  });

  test('without a location nothing geographic is excluded', () => {
    // A SHORT posting, so the cap does not bind and the only thing that can remove `bellevue` is
    // the location exclusion. Asserted against JD would have passed for the wrong reason: that
    // fixture states more than EMPHASIS_LIMIT terms and `bellevue` is body prose, so emphasis alone
    // drops it whether or not any exclusion fired.
    const short =
      'This is a 12 week paid summer internship in Bellevue, WA. You will use Python, SQL, ' +
      'Docker, React and Git, and prototype early ideas with customers.';
    const keys = extractJdTerms(short, { company: CONTEXT.company, role: CONTEXT.role }).map((t) => t.term);
    assert.ok(keys.length < EMPHASIS_LIMIT, 'the cap must not be what removes it');
    assert.ok(keys.includes('bellevue'), 'the exclusion is driven by the job row, not guessed from prose');
  });

  /**
   * A location field may never delete a STATED requirement, whatever it is spelled like.
   *
   * The first cut of this fix excluded every word of the location from every section, guarded only
   * by the ~250-word curated lexicon. That deleted `mobile` on a posting located in Mobile, AL, and
   * `reading`, `split`, `cork`, `bath`, `salem` and `georgia` for their cities. Deleting a real
   * requirement is worse than leaving geography in: the term leaves the denominator, which INFLATES
   * the score, and leaves the missing list the student is supposed to act on.
   *
   * The bare-city cases are separate and were separately broken: a location field of exactly "Java"
   * normalizes to ONE token, which skipped a guard that only ran inside the per-word loop. The
   * original test used "Java, Indonesia", two tokens, so it passed without ever exercising that
   * path.
   */
  const COLLISIONS: Array<[string, string]> = [
    ['Java', 'Java'],
    ['Angular', 'Angular'],
    ['Oracle', 'Oracle'],
    // The same city written the other common way. The bare and the regioned form must agree.
    ['Oracle', 'Oracle, Arizona'],
    ['Mobile', 'Mobile, AL'],
    ['Mobile', 'Mobile, Alabama'],
    ['Reading', 'Reading, UK'],
    ['Split', 'Split, Croatia'],
    ['Cork', 'Cork'],
    ['Bath', 'Bath, UK'],
    ['Georgia', 'Atlanta, Georgia'],
    ['Texas', 'Austin, Texas'],
  ];

  for (const [word, location] of COLLISIONS) {
    test(`a Requirements bullet for ${word} survives a posting located in ${location}`, () => {
      const jd = `Requirements\n- Strong ${word}, Docker, Kubernetes and React experience\n- 3 years of Python\n`;
      const keys = extractJdTerms(jd, { company: 'Acme', role: 'Engineer', location }).map((t) => t.term);
      assert.ok(
        keys.includes(word.toLowerCase()),
        `"${word}" is under Requirements, so the address may not delete it`,
      );
    });
  }

  test('the section is the discriminator, because the signal flag is exactly backwards here', () => {
    // `ca` and `wa` are hard signal (two-letter acronyms) while `mobile` and `reading` are not, so
    // a signal-based guard would have kept the geography and deleted the requirements.
    const stated = extractJdTerms('Requirements\n- Mobile, Docker, Kubernetes, React and Python\n', {
      company: 'Acme',
      role: 'Engineer',
      location: 'Mobile, AL',
    });
    assert.ok(stated.some((t) => t.term === 'mobile' && t.kind === 'required'));

    const prose = extractJdTerms(JD, CONTEXT).map((t) => t.term);
    assert.ok(!prose.includes('ca') && !prose.includes('wa'), 'body-prose geography still goes');
  });

  test('a null or empty location is simply no exclusion, never a crash', () => {
    const base = extractJdTerms(JD, { company: CONTEXT.company, role: CONTEXT.role }).length;
    for (const location of [null, undefined, '', '   ']) {
      assert.equal(extractJdTerms(JD, { ...CONTEXT, location }).length, base);
    }
  });

  test('the score rises once the geography leaves the denominator', () => {
    // Not a claim about the absolute number. Only that removing terms no resume should carry
    // cannot make the same resume look worse against the same posting.
    const resume = 'Product management intern. Built dashboards with Python and SQL. ETL pipelines.';
    const withPlaces = scoreJdMatch(resume, JD, { company: CONTEXT.company, role: CONTEXT.role });
    const withoutPlaces = scoreJdMatch(resume, JD, CONTEXT);
    assert.ok(
      (withoutPlaces.score ?? 0) > (withPlaces.score ?? 0),
      `expected the geography-free score to be higher, got ${withoutPlaces.score} vs ${withPlaces.score}`,
    );
    assert.ok(
      withoutPlaces.missing.every((t) => !['Bellevue', 'Mountain View', 'San Francisco'].includes(t.display)),
      'no office may reach the missing list that gap-to-bullet reads',
    );
  });
});

/**
 * ISSUE-024. Two more ways the denominator filled with terms no resume could ever match, both found
 * while fixing ISSUE-014 on the same Databricks posting and deliberately left out of scope there.
 *
 * The discipline is ISSUE-014's discipline. This denominator is the one the score divides by, so a
 * WRONG exclusion deletes a real requirement, which both inflates the score and drops the term off
 * the missing list the student is supposed to act on. That is worse than the junk. Every exclusion
 * below is therefore keyed on something the posting or the job row stated outright.
 */
describe('the requirement denominator excludes prose and branding, not requirements', () => {
  // The same real posting ISSUE-014 was found on, so the two fixes are asserted against one text.
  const DATABRICKS_JD =
    'At Databricks we build the best data and AI infrastructure platform. As a Product Management ' +
    "Intern you will learn how to be a successful PM. We're hiring across all of our teams, " +
    'including AI Platform, Genie, Machine Learning, Unity Catalog, Databricks SQL, ETL, Streaming, ' +
    'and EDA. This is a 12 week paid summer internship in either San Francisco, CA, Mountain View, ' +
    'CA, or Bellevue, WA. You will prototype and test early ideas with customers using Python.';
  const DATABRICKS_CONTEXT = {
    company: 'Databricks',
    role: 'Product Management Intern (Summer 2027)',
    location: 'Bellevue, Washington; Mountain View, California; San Francisco, California',
  };

  test('an example marker is not a requirement', () => {
    // "(e.g. AWS)" tokenizes to "e.g", normalizes to "eg", and the dot is what admitted it:
    // TECH_MARKER reads '.' as the punctuation of a technical name. Nearly every JD names examples.
    const keys = extractJdTerms(
      'Requirements\n- Experience with cloud platforms (e.g. AWS) and CI/CD\n- Scripting, i.e. Python or Bash\n',
    ).map((t) => t.term);

    assert.ok(!keys.includes('eg'), '"e.g." is prose punctuation, not a requirement');
    assert.ok(!keys.includes('ie'), '"i.e." is prose punctuation, not a requirement');
    for (const real of ['aws', 'ci cd', 'python', 'bash']) {
      assert.ok(keys.includes(real), `"${real}" is what the example was an example OF`);
    }
  });

  test("a phrase carrying the company's own name is that company's product, not a requirement", () => {
    // "Databricks SQL" survived the ISSUE-014 strip because `sql` is not a self-reference word, so
    // only the whole-term and every-word tests ran and neither matched.
    const keys = extractJdTerms(DATABRICKS_JD, DATABRICKS_CONTEXT).map((t) => t.term);
    assert.ok(!keys.includes('databricks sql'), 'the employer cannot require experience with its own branding');
    assert.ok(keys.includes('sql'), 'the real skill inside the phrase stands on its own unigram');
  });

  test('a company name that is itself a real skill does not delete phrases for everyone', () => {
    // The guard that makes the rule above safe. At a posting from Spring Health, `spring` is the
    // employer AND `spring boot` is the requirement, and the phrase rule declines to act on a
    // company word the lexicon already knows. `spring` alone is still excluded, as it was before.
    const jd = 'Requirements\n- Strong Spring Boot and Python experience\n';
    const keys = extractJdTerms(jd, { company: 'Spring Health', role: 'Engineer' }).map((t) => t.term);
    assert.ok(keys.includes('spring boot'), 'the framework is the requirement, the employer is the name');
    assert.ok(keys.includes('python'));
  });

  test('the branding rule is driven by job_context and never guessed from the prose', () => {
    const keys = extractJdTerms(DATABRICKS_JD, { location: DATABRICKS_CONTEXT.location }).map((t) => t.term);
    assert.ok(keys.includes('databricks sql'), 'with no company on the row there is nothing to strip');
  });

  /**
   * THE RESIDUAL, stated rather than hidden.
   *
   * The same posting lists "Genie" and "Unity Catalog", which are also Databricks products, and both
   * still land in the denominator. Neither is spelled with the company name, so nothing the posting
   * or the job row said separates them from "Snowflake" or "Airflow" - bare proper nouns in body
   * prose that ARE real requirements on other postings. A rule broad enough to catch them would be a
   * guess at which capitalized words are products, and guessing wrong here deletes a requirement and
   * inflates the score, which ISSUE-014 established is the worse failure. Left in on purpose.
   */
  test('product names not spelled with the company name are a known residual', () => {
    const keys = extractJdTerms(DATABRICKS_JD, DATABRICKS_CONTEXT).map((t) => t.term);
    assert.ok(keys.includes('genie'), 'documented residual: a bare product name is not separable from a bare skill');
    assert.ok(keys.includes('unity catalog'), 'documented residual, same reason');
  });
});

describe('scorability needs signal, not just a term count', () => {
  test('a posting of company, city and people names is not scorable', () => {
    // Cleared a floor of 6 and produced a confident 0% "Weak match" with Bob Smith, Jane Doe and
    // Toronto on the missing list, which is the list the gap-to-bullet feature consumes.
    const r = scoreJdMatch(
      'nothing here',
      'Join Acme Corp in Toronto. We use Slack and Notion daily. Contact Jane Doe or Bob Smith.',
    );
    assert.equal(r.scorable, false);
    assert.equal(r.missing.length, 0, 'a person is never handed out as an unmet requirement');
  });

  test('a real posting with enough lexicon hits is still scorable', () => {
    const r = scoreJdMatch('Python and Docker', 'Requirements\n- Python, Docker, AWS, Kubernetes, Terraform, React\n');
    assert.equal(r.scorable, true);
    assert.ok(r.missing.every((t) => t.display !== 'Toronto'));
  });

  test('the signal floor is lower than the term floor, so it gates rather than duplicates', () => {
    assert.ok(MIN_SIGNAL_TERMS < MIN_SCORABLE_TERMS);
  });
});

describe('route registration', () => {
  test('POST /jd-match is actually mounted in index.ts', () => {
    // __dirname, not import.meta.url: tsconfig targets CommonJS for the Vercel build.
    const root = readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    assert.match(root, /import \{ jdMatchRoutes \} from '\.\/routes\/jdMatch'/, 'index.ts must import the route');
    assert.match(root, /register\(jdMatchRoutes\)/, 'index.ts must register the route');
    // Both endpoints live in the same plugin, so one registration mounts both. Named here so a
    // future split does not silently drop the evidence endpoint the way the first one was dropped.
    const routeFile = readFileSync(path.join(__dirname, '..', 'routes', 'jdMatch.ts'), 'utf8');
    assert.match(routeFile, /'\/jd-match'/);
    assert.match(routeFile, /'\/jd-match\/evidence'/);
  });

  /**
   * The review screen is the one surface that still shows resume coverage, so it is the surface
   * that most needs the geography out of its denominator and its missing list. It holds a saved
   * packet, not a job row, and a packet has never stored a location. Passing the id and resolving
   * it here is what covers packets that already exist.
   */
  test('POST /jd-match resolves the posting location from job_id when the caller has no location', () => {
    const routeFile = readFileSync(path.join(__dirname, '..', 'routes', 'jdMatch.ts'), 'utf8');
    assert.match(routeFile, /job_id: z\.string\(\)\.uuid\(\)\.nullish\(\)/, 'the schema must accept an id');
    assert.match(
      routeFile,
      /location: body\.job_context\?\.location \?\? \(await postingLocation\(body\.job_context\?\.job_id\)\)/,
      'an explicit location wins; the id is the fallback',
    );
    assert.match(routeFile, /from\(monitored_jobs\)/, 'the id must be resolved against the live row');
  });
});
