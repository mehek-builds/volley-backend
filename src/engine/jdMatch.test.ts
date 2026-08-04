import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
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

/** Mirrors STATED_KINDS in jdMatch.ts: the sections where an employer states what the job needs. */
const STATED_KINDS_FOR_TEST = new Set(['required', 'preferred', 'responsibilities']);

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

  test('"What we look for" and "The impact you will have" are the sections they say they are', () => {
    // Databricks' "Product Management Intern (Summer 2027)", found 2026-08-03. Both lines pass
    // isHeadingLine and both were one word away from the patterns: `what we're looking for` did not
    // cover "what we look for", and `your impact` did not cover "the impact you will have".
    //
    // The cost was not the headings. An unrecognised heading does not close the section above it,
    // so the ENTIRE posting stayed `body` at 0.4 and the denominator filled from the culture
    // paragraph: the score was built from `genie`, `unity catalog`, `ai platform` and `streaming`,
    // which is the sentence naming the TEAMS Databricks hires across, while the one real ask -
    // "first hand experience with SQL and/or Python" - never reached weight 1. 8/100 for a
    // resume that has Python and the CS degree the posting asks for.
    //
    // Both are house templates, not one posting's quirk: over 600 live postings this heading pair
    // was the difference on 5, split across Databricks and Affirm.
    const jd = `As a Product Management Intern, you will join a team. We're hiring across all of our teams, including AI Platform, Genie, Machine Learning, Unity Catalog, Databricks SQL, ETL, Streaming, and EDA.

The impact you will have:

Prototype and test early ideas with customers and engineers
Work with engineers and designers to ship features on the platform

What we look for:

Pursuing a bachelor's in computer science or a related engineering field
You have some first hand experience with SQL and/or Python
`;
    const kinds = segmentJd(jd).map((s) => s.kind);
    assert.deepEqual(kinds, ['body', 'responsibilities', 'required']);

    // The team-roster nouns are still admitted, but out of `body` at 0.4, so they can no longer
    // outweigh the stated requirement. That is the part that makes the number wrong, not their
    // presence: `sql` and `python` must carry more than `genie` does.
    const terms = extractJdTerms(jd);
    const weightOf = (term: string) => terms.find((t) => t.term === term)?.weight;
    assert.equal(weightOf('sql'), 1, 'SQL is stated under "What we look for"');
    assert.equal(weightOf('python'), 1, 'Python is stated under "What we look for"');
    // No `if (w !== undefined)` guard here, deliberately: as a guard this whole loop degraded to a
    // no-op the moment a roster term stopped being extracted, which is exactly when it stops
    // proving anything. Asserted as a relation instead, so it holds whether or not the roster term
    // survives extraction at all.
    for (const roster of ['genie', 'unity catalog', 'streaming']) {
      assert.ok(
        (weightOf(roster) ?? 0) < weightOf('sql')!,
        `"${roster}" names a team, so it cannot weigh as much as a stated requirement`,
      );
    }

    // required_coverage is null whenever nothing parses as required, which silently disables the
    // scoreBand guard that stops "covered the responsibilities, missed every hard requirement"
    // from reading as a strong match. Restoring the section restores the guard's input.
    const result = scoreJdMatch('Python. Computer science.', jd, { company: 'Databricks' });
    assert.notEqual(result.required_coverage, null, 'a posting with a requirements section has required coverage');
  });

  test('the widened heading patterns still do not swallow the company blurb', () => {
    // `(your|the) impact` is the looser of the two. Noise is tested before responsibilities for
    // exactly this reason, and this pins that order rather than trusting it.
    for (const heading of ['About our impact', 'Our mission and impact']) {
      const [, second] = segmentJd(`Responsibilities\n- Ship features\n${heading}\nWe are a company.\n`);
      assert.equal(second?.kind, 'noise', `"${heading}" is a blurb, not a responsibilities block`);
    }
  });
});

describe('the admission gate, measured 2026-08-03 over 600 live postings', () => {
  /* The attribution that drove all of these. Of 6950 terms that reached a scored denominator:
   *
   *   55.1%  proper-noun mid-sentence   please(31) english(49) employer(27) fortune(25) state(23)
   *   24.7%  lexicon                    ai(124) python(78) compliance(72) sql(36)
   *   13.4%  acronym                    usd(22) cad(16) ms(13) bs(12) pto(10) ote(9)
   *    4.8%  proper-noun title-case run
   *    1.7%  tech marker                c++(24) usc(17)
   *
   * Against the six real base resumes on the system, proper-noun terms were matched 3.6% of the
   * time and hard-signal terms 6.4%, so the loosest rule was filling most of the denominator with
   * the least earnable half of it. */

  test('the compensation block is not a requirements block', () => {
    const jd = `Requirements
- Experience with Python and Kubernetes
- Familiarity with SQL
The base salary range for this role is 120,000 USD to 160,000 USD, plus PTO and an OTE bonus.
`;
    const terms = extractJdTerms(jd).map((t) => t.term);
    for (const junk of ['usd', 'pto', 'ote']) {
      assert.ok(!terms.includes(junk), `"${junk}" is what the job pays, not a thing to have done`);
    }
    assert.ok(terms.includes('python') && terms.includes('kubernetes'), 'the real requirements survive');
  });

  test('a real acronym that happens to share the shape is untouched', () => {
    // The reason NON_REQUIREMENT_ACRONYMS is an enumeration and not a shape rule: these are the
    // same shape as USD and PTO and they are genuine stated requirements.
    const jd = `Requirements\n- ITAR and SOX compliance experience\n- Familiarity with SAML and REST\n`;
    const terms = extractJdTerms(jd).map((t) => t.term);
    for (const real of ['itar', 'sox', 'saml', 'rest']) {
      assert.ok(terms.includes(real), `"${real}" is a stated requirement`);
    }
  });

  test('a legal citation is not a technical name', () => {
    // `U.S.C` reached the denominator as HARD SIGNAL on 34 of 600 postings, every one out of the
    // work-authorization paragraph, because dots are the punctuation that says "node.js".
    const jd = `Requirements
- Applicants must be a U.S. citizen, a Refugee under 8 U.S.C. § 1157, or an Asylee under 8 U.S.C. § 1158
- Strong Python and SQL experience with Docker and Kubernetes
`;
    const terms = extractJdTerms(jd).map((t) => t.term);
    for (const junk of ['usc', 'us', 'asylee', 'refugee']) {
      assert.ok(!terms.includes(junk), `"${junk}" is immigration boilerplate, not a requirement`);
    }
    assert.ok(terms.includes('python'), 'the real requirement survives');
  });

  test('a deny-listed word is denied in the plural too', () => {
    // inLexicon has always singularised and the deny-lists never did, so every entry in them was
    // singular-only. `requirement` was listed, `requirements` was the most common junk term left
    // after everything else, at 47 of 600 postings: HTML-stripped postings put the heading inline,
    // where segmentJd cannot strip it and it reads as the head of a Title Case run.
    const jd = `We ship fast and iterate. Requirements Demonstrated experience with Python, SQL and Docker.
Reasonable Accommodations are available on request.
`;
    const terms = extractJdTerms(jd).map((t) => t.term);
    assert.ok(!terms.includes('requirements'), '"requirements" is the heading, not the requirement');
    assert.ok(!terms.includes('accommodations'), '"accommodations" is the application-process copy');
    assert.ok(terms.includes('python'), 'the real requirement survives');
  });

  test('singularising the deny-lists deletes no real skill', () => {
    // The deny-lists are checked BEFORE the lexicon, so a skill whose singular collides with one of
    // them would vanish from every posting that states it. This asserts the collision set is empty
    // rather than assuming it, because both lists are expected to keep growing.
    const src = readFileSync(path.join(__dirname, 'jdMatch.ts'), 'utf8');
    const grab = (name: string) =>
      new Set(new RegExp(`const ${name} = new Set\\(\\s*\`([^\`]*)\``).exec(src)![1].split(/\s+/).filter(Boolean));
    const lexicon = grab('SKILL_LEXICON');
    const denied = new Set([...grab('BOILERPLATE'), ...grab('GENERIC_STOPWORDS')]);
    const singular = (w: string) =>
      /(ss|us|is)$/.test(w) ? w
      : /ies$/.test(w) ? w.slice(0, -3) + 'y'
      : /es$/.test(w) && /(ch|sh|x|s)es$/.test(w) ? w.slice(0, -2)
      : /s$/.test(w) ? w.slice(0, -1) : w;

    const introduced = [...lexicon].filter((w) => singular(w) !== w && denied.has(singular(w)) && !denied.has(w));
    assert.deepEqual(introduced, [], 'singularising the deny-lists must not shadow a lexicon skill');
  });

  test('a capital the posting itself spells lowercase is decoration, not a name', () => {
    // What the deny-list could not reach. After the vocabulary pass the junk left was `microsoft`,
    // `engineering`, `data`, `product`, `security`, `sales`, `finance`, `legal` - ordinary nouns,
    // an open set. A product name is capitalized every time it appears; a common noun that carries
    // one capital is written lowercase somewhere else in the same posting.
    const jd = `Requirements
- We use Data and Security tooling daily, and strong data and security instincts matter here
- Experience with Redux and Datadog
`;
    const terms = extractJdTerms(jd).map((t) => t.term);
    assert.ok(!terms.includes('data'), 'the posting also writes "data"');
    assert.ok(!terms.includes('security'), 'the posting also writes "security"');
    assert.ok(terms.includes('redux') && terms.includes('datadog'), 'a name is never written lowercase');
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
    assert.equal(scoreBand(50).tone, 'strong');
    assert.equal(scoreBand(30).tone, 'fair');
    assert.equal(scoreBand(15).tone, 'fair');
    assert.equal(scoreBand(5).tone, 'weak');
  });

  test('ISSUE-023: every band is reachable, and the top one still means something', () => {
    // The thresholds were 65 and 40, and measured over 600 live postings against the six real base
    // resumes on the system, 96.0% of ON-FIELD pairs read "Not much overlap" and 0.6% reached
    // "Strong match". A four-valued label that returns one value 24 times in 25 tells a student
    // nothing, and it is the label they use to decide where to apply.
    //
    // This pins the SHAPE rather than the constants: four distinct labels, ordered, each reachable
    // by a score this scorer produces. The on-field p90 is 25 and p99 is 50, so a threshold set
    // that put every one of those in the same band would fail here.
    const at = (s: number) => scoreBand(s).label;
    const labels = [at(50), at(30), at(15), at(5)];
    assert.equal(new Set(labels).size, 4, `every band must be reachable, got ${labels.join(' / ')}`);

    // Monotone: a better-covered posting never reads as a worse match.
    const tones = [50, 30, 15, 5].map((s) => scoreBand(s).tone);
    assert.deepEqual(tones, ['strong', 'fair', 'fair', 'weak']);

    // The top band sits above the on-field p95 of 33, so it stays rare enough to be worth reading.
    assert.equal(scoreBand(33).tone, 'fair', 'p95 of a student\'s own field is not automatically strong');

    // Exact cut-offs. Without these the constants only had to land somewhere in an open range:
    // BAND_STRONG could drift 40 -> 45 with the suite still green, and the labels themselves were
    // pinned by nothing at all, so renaming "Solid match" back to the old "Partial match" passed.
    assert.equal(scoreBand(9).label, 'Not much overlap');
    assert.equal(scoreBand(10).label, 'Some overlap');
    assert.equal(scoreBand(21).label, 'Some overlap');
    assert.equal(scoreBand(22).label, 'Solid match');
    assert.equal(scoreBand(39).label, 'Solid match');
    assert.equal(scoreBand(40).label, 'Strong match');
  });

  test('the requirements gate still outranks the band', () => {
    // Unchanged by the recalibration, and the one thing this number must never do: a score built
    // from a long responsibilities list while the requirements block is more than half unmet does
    // not read as a strong match at any threshold.
    const gated = scoreBand(50, 0.25);
    assert.equal(gated.tone, 'fair');
    assert.equal(gated.label, 'Missing key requirements');
    assert.equal(scoreBand(50, 0.75).tone, 'strong', 'a met requirements block is not penalised');
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

    // EVERY stated requirement survives. This is the half that bites if weight ever stops leading
    // the emphasis ranking: put body above required and these are the terms that get evicted.
    for (const stated of ['python', 'typescript', 'react', 'postgresql', 'docker', 'git']) {
      assert.ok(keys.includes(stated), `"${stated}" is stated under Requirements`);
    }

    // THE PROSE NOW VANISHES ENTIRELY, and this assertion is the change of contract.
    //
    // It used to read "prose fills only the LEFTOVER slots", because the denominator was always
    // EMPHASIS_LIMIT and the only question was who got the twelve. Measured 2026-08-03 over 600
    // live postings, 87.3% sat exactly at that cap, which makes a fixed denominator a padding rule:
    // delete a junk term and the next one is promoted into the vacancy, so filtering could never
    // change the score. preferStatedRequirements drops `body` whenever the employer stated
    // requirements of their own, so the denominator is now eight here rather than twelve, and the
    // four slots that used to go to whatever the culture paragraph happened to name are simply not
    // filled. A student is scored on what the posting asked for and on nothing else.
    const prose = ['datadog', 'splunk', 'grafana', 'sentry', 'snowplow', 'notion calendar', 'linear roadmaps', 'superhuman mail'];
    const survivors = prose.filter((p) => keys.includes(p));
    assert.deepEqual(survivors, [], 'a posting that states its requirements is not scored on its prose');
    assert.ok(keys.length < EMPHASIS_LIMIT, 'the denominator is allowed to be smaller than the cap');
  });

  test('a four-term posting is scored, not refused', () => {
    // MIN_SCORABLE_TERMS was 6 and is 4, and nothing pinned it: reverting the constant left the
    // whole suite green, because every other test refers to it symbolically. The literal is
    // asserted here because 4 is the number preferStatedRequirements needs in order to fire on a
    // posting that states four things, which is the case the whole pass exists for.
    assert.equal(MIN_SCORABLE_TERMS, 4);
    assert.ok(MIN_SIGNAL_TERMS < MIN_SCORABLE_TERMS, 'the refusal floor must sit above the signal floor');

    const jd = `What we look for:
- First hand experience with SQL and/or Python
- Familiarity with Docker
- Comfortable with Git
`;
    const terms = extractJdTerms(jd);
    assert.equal(terms.length, 4, 'four stated requirements');
    const scored = scoreJdMatch('Python and Docker and Git and SQL.', jd);
    assert.equal(scored.scorable, true, 'four terms is enough to be honest about');
    assert.notEqual(scored.score, null);
  });

  test('the shrink stops rather than pushing a posting into refusal', () => {
    // Both halves of the keepsScorable guard were unpinned: replacing either with `true` left the
    // suite green, because the only fallback test used a posting whose stated set was EMPTY, which
    // passes under either mutation. These two cover the real case, where the employer stated
    // something but not enough to stand on its own.

    // (a) a stated set too small to stand alone. Three stated terms, ALL hard signal, so the
    // signal half of the guard passes. Prose sits ABOVE the heading, because a heading closes the
    // section before it and a blank line does not.
    //
    // This pins the OUTCOME, not the count half of isScorable. Mutating that half to `true` does
    // not fail this test and cannot: the salvage pass in extractJdTerms re-extracts without
    // preferStatedRequirements and its larger result wins, so the prose returns by another route.
    // See the note beside isScorable. What this test guarantees is the behaviour a student sees.
    const tooFewStated = `We are a team that loves Datadog and Splunk and Grafana and Sentry and Snowplow every day.

What we look for:
- Experience with Kubernetes, Terraform and Kafka
`;
    const statedA = extractJdTerms(tooFewStated).filter((t) => STATED_KINDS_FOR_TEST.has(t.kind));
    assert.equal(statedA.length, 3, 'fixture must sit just under MIN_SCORABLE_TERMS');
    assert.equal(statedA.filter((t) => t.signal).length, MIN_SIGNAL_TERMS, 'and must clear the signal half');
    const keysA = extractJdTerms(tooFewStated).map((t) => t.term);
    assert.ok(keysA.includes('kubernetes'), 'the stated requirements survive');
    assert.ok(
      keysA.includes('datadog') && keysA.includes('splunk'),
      'body prose is retained when the stated set alone is too small to score',
    );

    // (b) the SIGNAL half, isolated. Enough stated terms to clear the count, but only proper-noun
    // ones, so the posting would refuse if the prose were dropped.
    const tooLittleSignal = `We are a team that loves Python and Docker and Kubernetes and Terraform and Postgres.

What we look for:
- Familiarity with Contentful Delivery, Optimizely Feature, Amplitude Experiment and Braze Canvas
- Comfortable with Segment Protocols and Iterable Journeys
`;
    const statedB = extractJdTerms(tooLittleSignal).filter((t) => STATED_KINDS_FOR_TEST.has(t.kind));
    assert.ok(statedB.length >= MIN_SCORABLE_TERMS, 'fixture must clear the count half');
    assert.ok(statedB.filter((t) => t.signal).length < MIN_SIGNAL_TERMS, 'and must fail the signal half');
    const keysB = extractJdTerms(tooLittleSignal).map((t) => t.term);
    assert.ok(
      keysB.includes('python') && keysB.includes('docker'),
      'body prose is retained when the stated set carries too little hard signal',
    );
  });

  test('prose still carries the whole denominator when nothing was stated', () => {
    // The other side of preferStatedRequirements, and the reason it is conditional. A short unheaded
    // posting has no required/preferred/responsibilities section at all, and `body` at 0.4 is what
    // SECTION_WEIGHT.body exists for. Dropping it unconditionally would make these unscorable.
    const jd = `We are a team that loves Datadog and Splunk and Grafana and Sentry and Snowplow.
Our office runs on Notion Calendar, Linear Roadmaps and Superhuman Mail every single day.
`;
    const keys = extractJdTerms(jd).map((t) => t.term);
    assert.ok(keys.includes('datadog') && keys.includes('splunk'), 'unheaded prose is still the denominator');
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

/**
 * ISSUE-026. psiquantum's "Intern, Quantum Architecture", production row
 * eb6f80b6-cd83-4e6f-a26e-58627af6f6ca, measured 2026-08-04 over the full 6164-char description.
 *
 * Its twelve extracted requirements were `C++, Computer Science, GitHub, Housing, HR, Math, Once,
 * Physics, Police Check, Python, Rate, ZX`. Five of the twelve are not things a student can have on
 * a resume, so they sat permanently in the denominator of `round(100 * got / total)` and depressed
 * every score on this posting by roughly 40 points, under a tooltip telling the student these were
 * "the N requirements Litos counted in this posting".
 *
 * The text below is the shape rather than the whole posting: the requirements block, then the
 * heading-shaped line "The interview process", then the three paragraphs and the pay table that the
 * unclosed section swallowed. All five junk terms and the real ones are reproduced from it.
 */
const PSIQUANTUM_JD = `Requirements
Degree in Physics, Math or Computer Science or equivalent required.
Knowledge of quantum information is required. Familiarity with graphical calculus (e.g, tensor networks, ZX calculus).
Experience programming in Python, C++ or similar languages.
Competent use of collaborative software development tools (e.g., GitHub) is desirable.

The interview process

Expect at least two interviews with the hiring team and HR. Once interviews are complete, we match students to relevant internship projects in our hiring teams.

Successful candidates are required to complete background checks prior to commencing their internship. These include a National Police Check and verification of employment and education qualifications.

Education level COMPLETED

Hourly Rate

Housing/Commuter Stipend

Bachelor's Degree

$31.00

Variable based on permanent residency location
`;

const PSIQUANTUM_CONTEXT = {
  company: 'psiquantum',
  role: 'Intern, Quantum Architecture',
  location: 'Brisbane, Queensland, Australia; Palo Alto, California, United States; Remote',
};

describe('the process-and-logistics footer is not a requirements block', () => {
  test('none of the five measured junk terms reach the denominator', () => {
    const keys = extractJdTerms(PSIQUANTUM_JD, PSIQUANTUM_CONTEXT).map((t) => t.term);
    for (const junk of ['housing', 'hr', 'once', 'police check', 'rate']) {
      assert.ok(!keys.includes(junk), `"${junk}" is not something a student can put on a resume`);
    }
    // The terms each junk term was standing next to in that table, pinned so a narrower fix that
    // only caught the five measured spellings reads as the regression it would be.
    for (const junk of ['commuter stipend', 'near completion', 'national police', 'police']) {
      assert.ok(!keys.includes(junk), `"${junk}" is the same table`);
    }
  });

  test('the requirements the posting actually stated all survive', () => {
    const keys = extractJdTerms(PSIQUANTUM_JD, PSIQUANTUM_CONTEXT).map((t) => t.term);
    for (const real of ['physics', 'math', 'computer science', 'zx', 'python', 'c++', 'github']) {
      assert.ok(keys.includes(real), `"${real}" is a stated requirement and must stay in the denominator`);
    }
  });

  test('a heading-shaped process line CLOSES the section above it', () => {
    // The mechanism, asserted directly rather than only through its symptom. "The interview process"
    // passes isHeadingLine and used to classify as nothing, and an unrecognised heading does not
    // close the section it interrupts - so the pay table below it was REQUIRED at weight 1.
    const kinds = segmentJd(PSIQUANTUM_JD).map((s) => s.kind);
    assert.ok(kinds.includes('noise'), 'the footer is its own zero-weight section');
    // "Hourly Rate" is itself one of the noise headings now, and a matched heading line is consumed
    // rather than kept, so the text to look for is the table row under it.
    const tail = segmentJd(PSIQUANTUM_JD).find((s) => s.text.includes('National Police Check'));
    assert.equal(tail?.kind, 'noise');
    assert.equal(tail?.weight, 0);
  });

  test('a sentence-initial capital is not a proper noun', () => {
    // `Once` came in because tokenizeSection rebased `prevEnd` off the UNTRIMMED match, so the
    // sentence-final period sat inside the previous token and the gap the positional test reads was
    // a bare space. The sentence half of that rule never ran. Asserted on its own text, because on
    // the posting above the footer fix would hide it.
    const keys = extractJdTerms(
      'Requirements\nWe use Python here. Once you are ready, you will ship. Kubernetes and Docker run our services.\n',
    ).map((t) => t.term);
    assert.ok(!keys.includes('once'), 'a capital after a full stop is grammar');
    assert.ok(keys.includes('python'), 'a mid-sentence lexicon skill is unaffected');
    // The cost of the fix, stated: a sentence-initial capital now needs a Title Case run OR the
    // lexicon. `kubernetes` clears it on the lexicon, which is how most real cases clear it.
    assert.ok(keys.includes('kubernetes'), 'a lexicon skill is admitted from any position');
  });

  test('the noise vocabulary cannot fire on a requirements sentence', () => {
    // The safety claim at HEADING_PATTERNS: every pattern there is gated by isHeadingLine, so it
    // needs a line under 60 chars and 7 words. Requirement prose about the same words is longer.
    const keys = extractJdTerms(
      'Requirements\nAbility to explain the interview process to candidates and run background check workflows in Workday\n- Experience with Python\n',
    ).map((t) => t.term);
    assert.ok(keys.includes('workday'), 'the requirement below the sentence still scores');
    assert.ok(keys.includes('python'));
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
      /location:\s*body\.job_context\?\.location \?\?\s*posting\?\.location/,
      'an explicit location wins; the id is the fallback',
    );
    assert.match(routeFile, /from\(monitored_jobs\)/, 'the id must be resolved against the live row');
  });

  test('POST /jd-match reads the posting itself when the caller sends no jd_text', () => {
    /* The defect this closes, found on a real account 2026-08-04: GET /jobs sends
       `left(description, 600)`, a preview sized for a list row, and the dashboard scored THAT.
       Six hundred characters of company blurb yields two or three requirement terms, every posting
       lands under MIN_SCORABLE_TERMS, and the number never rendered for anyone. The suite was green
       throughout, because nothing tied the text the client sends to the text the row holds. */
    const routeFile = readFileSync(path.join(__dirname, '..', 'routes', 'jdMatch.ts'), 'utf8');

    assert.match(routeFile, /jd_text: z\s*[\s\S]{0,200}?\.optional\(\)/, 'jd_text must be omittable');
    assert.match(
      routeFile,
      /description: sql<string>`left\(\$\{monitored_jobs\.description\}, 60000\)`/,
      'the row read must be capped at the same bound the schema enforces',
    );
    // The caller's text WINS when present. The review screen holds the JD its packet was tailored
    // against, and the live row may have been edited since; scoring the row there would put a
    // number next to a resume that was written for different text.
    // Both /jd-match and /jd-match/requirements now go through ONE resolver, because they render on
    // the same screen and two resolutions is two numbers about one posting. The invariant is
    // unchanged: the caller's text wins unless it is the 600-char list preview.
    assert.match(routeFile, /export function resolveJdText/);
    assert.match(routeFile, /const jdText = resolveJdText\(body\.jd_text \?\? posting\?\.description \?\? '', posting\?\.description\);/);
    assert.match(routeFile, /const jdText = resolveJdText\(parsed\.data\.jd_text \?\? '', posting\?\.description\);/);
    // Neither supplied nor resolvable is a WIRING fault, and must not borrow the engine's
    // "this posting did not list enough requirements" copy, which is a claim about the job.
    assert.match(routeFile, /jd_text is required unless job_context\.job_id names a posting we hold/);
  });
});

/**
 * The apostrophe defect, found on a real Pro account 2026-08-04.
 *
 * cresta "Software Engineer Intern" (job 6e584f84-83d1-4e10-8b21-2dfac727ce9a, 7867 characters).
 * The review screen printed "Not much overlap", "1 of 12 requirements we counted", score 8, beside
 * a resume Litos had itself tailored to that exact posting and which leads with Python, an
 * LLM-as-judge evaluation pipeline and REST APIs.
 *
 * The posting is written with typographic apostrophes, U+2019, because that is what a rich-text
 * editor emits. Every apostrophe in HEADING_PATTERNS is the ASCII one, because a regex literal is
 * typed on a keyboard. So "What We[U+2019]re Looking For" and "What You[U+2019]ll Do" classified as
 * nothing, and an unrecognised heading does not close the section above it: both sat inside the
 * noise block that "About the Role" had correctly opened. The whole stated-requirements block was
 * weight 0, the only scorable text left was four paragraphs of company marketing, and the twelve
 * "requirements" were AI, Born, CEO, Cox, Google, Greylock, Marriott, Ping, Sequoia, Stanford AI,
 * United Airlines and Vertex AI.
 *
 * NOTHING IN THE SUITE COULD SEE IT. Every fixture above is typed in this file, so every fixture is
 * ASCII. And the salvage pass in extractJdTerms only re-reads noise when zeroing leaves a posting
 * UNSCORABLE: twelve investor names clear MIN_SCORABLE_TERMS, so the posting looked fine and the
 * number was confidently wrong rather than absent.
 *
 * The fixture below therefore keeps the curly characters. Do not "clean them up".
 */
const CURLY_JD = `
Cresta unlocks the true potential of the customer experience. The world's leading companies,
including United Airlines, Cox Communications, and Marriott, use Cresta every day.

Born from the Stanford AI Lab, Cresta has raised more than $270 million from the world's leading
investors, including a16z, Greylock, and Sequoia. Our CEO, Ping Wu, founded Google's Contact Center
AI and Vertex AI platforms before joining Cresta.

About the Role
As a Software Engineer Intern, you’ll build systems that power real-time customer interactions.

What You’ll Do

Design and build systems that support real-time AI-powered customer interactions
Work on features combining LLMs, data systems, and user-facing applications
Optimize for low latency, high throughput, and reliability at scale

What We’re Looking For

Experience with one or more programming languages (e.g., Python, Go, Java, JavaScript, TypeScript)
Interest in building user-facing products, backend systems, or real-time/data-intensive applications
Familiarity with modern web development (frontend and/or backend), APIs, or system design fundamentals
Understanding of building reliable, maintainable systems, including UI/UX quality and API design
Curiosity about LLMs, AI agents, or production AI systems (no prior ML experience required)
Experience using AI-powered developer tools (e.g., Cursor, Claude Code) to accelerate development
Strong problem-solving ability and a bias toward action

Perks

Lunch and dinner can be expensed while working in the office
PTO: 4 days
`;

/** The resume Litos tailored FOR that posting, which is the whole reason 8/100 was indefensible. */
const CURLY_RESUME = `
University of Southern California, Viterbi School of Engineering
Bachelor of Science in Computer Science & Business Administration, May 2028

AI Engineer, Traeco - AI Agent Cost Infrastructure
- Engineered high-quality, well-tested, idiomatic Python as sole engineer: a Python SDK,
  orchestration layer, and LLM-as-judge evaluation pipeline shipped to 3 design partners.
- Designed scalable REST APIs and a live traffic-replay system, taking the architecture from
  specification through production and monitoring.

AI Engineer, Tonee - AI Texting Tone Detector
- Shipped a real-time Python-based product to 100+ active users, owning the full stack from model
  fine-tuning through production deployment.

Skills
Python, OpenAI API, Hugging Face, TensorFlow, Core ML, Git, SQL, BigQuery
`;

describe('a posting written with typographic apostrophes', () => {
  test('a curly heading is the section it says it is, exactly like the straight one', () => {
    // The pair, side by side. Both must classify the same, or the file's whole heading vocabulary
    // is conditional on which editor the employer happened to use.
    for (const [curly, straight] of [
      ['What We’re Looking For', "What We're Looking For"],
      ['What You’ll Do', "What You'll Do"],
      ['What You’ll Need', "What You'll Need"],
    ]) {
      const kindOf = (heading: string) =>
        segmentJd(`${heading}\n- Experience with Python and TypeScript\n`).find((s) => s.text.trim())?.kind;
      assert.equal(kindOf(curly), kindOf(straight), `${curly} must classify as ${straight} does`);
      assert.notEqual(kindOf(curly), 'body', `${curly} must be recognised at all`);
    }
  });

  test('a curly heading CLOSES the About block above it, so the requirements are not noise', () => {
    // This is the half that turned a missed heading into a wrong number. `^about` zeroes the blurb
    // correctly; the failure was that nothing afterwards ever ended it.
    const sections = segmentJd(CURLY_JD);
    const required = sections.find((s) => s.kind === 'required');
    assert.ok(required, 'the "What We’re Looking For" block must be a required section');
    assert.equal(required.weight, 1);
    assert.match(required.text, /programming languages/);
    assert.ok(
      sections.every((s) => s.kind !== 'noise' || !/programming languages/.test(s.text)),
      'the stated requirements must not sit inside a zero-weight block',
    );
  });

  test('the denominator is the posting’s requirements, not its investors', () => {
    const terms = extractJdTerms(CURLY_JD, { company: 'cresta', role: 'Software Engineer Intern', location: null });
    const displays = terms.map((t) => t.display);

    // What the defect actually produced, named one by one. A regression puts these back.
    for (const marketing of ['Born', 'CEO', 'Cox', 'Greylock', 'Marriott', 'Ping', 'Sequoia', 'United Airlines']) {
      assert.ok(!displays.includes(marketing), `${marketing} is company marketing, not a requirement`);
    }
    // And what a Software Engineer Intern posting obviously asks for.
    for (const real of ['Python', 'TypeScript', 'LLMs']) {
      assert.ok(displays.includes(real), `${real} is stated under requirements and must be counted`);
    }
    // Every counted term now comes from a block the employer used to state what the job needs.
    assert.ok(terms.every((t) => t.weight >= 0.7), 'no requirement should be carried by the blurb alone');
  });

  test('the tailored resume scores like the strong match it is, not 8/100', () => {
    const result = scoreJdMatch(CURLY_RESUME, CURLY_JD, {
      company: 'cresta',
      role: 'Software Engineer Intern',
      location: null,
    });
    assert.equal(result.scorable, true);
    assert.ok(result.score !== null && result.score >= 35, `expected a believable score, got ${result.score}`);
    // The observed defect verbatim: one match out of twelve. Anything at or below that is the bug.
    assert.ok(result.matched.length >= 4, `expected several matches, got ${result.matched.length}`);
    for (const covered of ['Python', 'LLMs']) {
      assert.ok(
        result.matched.some((t) => t.display === covered),
        `${covered} is on both documents and must be counted as matched`,
      );
    }
    // The gap list is the input to the gap-to-bullet feature. It must never offer to write a
    // student a bullet about an investor.
    assert.ok(
      result.missing.every((t) => !['Greylock', 'Sequoia', 'Ping', 'Born'].includes(t.display)),
      'the missing list must not name the company’s investors or executives',
    );
  });

  test('headingCore folds the apostrophe before any pattern is tested', () => {
    // The mutation guard. Deleting the fold in headingCore fails the four tests above; this one
    // says WHERE the fix lives, so a future rewrite that moves the fold elsewhere has to move this
    // assertion deliberately rather than delete a passing test by accident.
    const engineFile = readFileSync(path.join(__dirname, 'jdMatch.ts'), 'utf8');
    const core = engineFile.slice(engineFile.indexOf('function headingCore'), engineFile.indexOf('function isHeadingLine'));
    assert.match(core, /replace\(\/\[[‘’ʼ]+\]\/g, "'"\)/, 'headingCore must fold curly apostrophes to ASCII');
  });
});

/**
 * A POSTING THAT ADDRESSES THE CANDIDATE IN ITS REQUIREMENTS HEADING.
 *
 * Separate defect from the curly-apostrophe one above, and larger. Verified independently of it:
 * this block is noise:0 with the fold and without it.
 *
 * The `^about` rule that the cresta case widened reads the whole word "About" as a marketing
 * signal, but "About" only tells you a blurb follows; the word AFTER it says whose blurb. When the
 * subject is the employer - "About OpenAI", "About the Team" - the section is marketing and zero is
 * right. When the subject is the reader - "About You", "About you:", "About the candidate" - the
 * section is the stated requirements, and zeroing it is the same failure the widening was meant to
 * fix, pointed the other way.
 *
 * Measured read-only against the prod board on 2026-08-04: 1,304 of 20,931 active postings (6.2%)
 * head a section with a heading-shaped second-person "About you" line. All of them scored the block
 * at weight 0.
 *
 * StockX "Software Development Engineer in Test" (job 6f39c23b-1202-4937-87c6-072a302553ea) is the
 * shape, and the fixture below is its real section order: "What you'll do" (responsibilities),
 * "About You" (the requirements), "Nice to have skills" (preferred), "About StockX" (marketing).
 * The cost is not the dropped block. `Nice to have skills` DOES close the noise section, so nothing
 * downstream is corrupted and the salvage pass never fires - the posting stays comfortably
 * scorable, on the wrong text. Twelve terms came back and four of them were `understand brds`,
 * `prds`, `qa` and `regression`, lifted from the responsibilities prose, while the requirements the
 * employer actually wrote - 3+ years of Web and Mobile Automation Testing, JavaScript/TypeScript,
 * Git, CI/CD - were worth nothing. A confidently wrong denominator, again.
 */
const SECOND_PERSON_JD = `
Help empower our global customers to connect to culture through their passions.

What you'll do

Work collaboratively with product managers and engineers to deliver high-quality software.
Create well-structured test cases following QA best practices.
Understand BRDs and PRDs and translate them into regression coverage.
Automate test cases for Web, iOS, and Android applications using WebdriverIO, Selenium, and Appium.
Participate in sprint ceremonies including planning, grooming, and release testing.

About You

3+ years of experience in Web and Mobile Automation Testing.
Strong experience with WebdriverIO, Selenium, Appium, and JavaScript/TypeScript.
Experience with cloud execution platforms (LambdaTest, BrowserStack, SauceLabs).
Familiarity with Git and CI/CD pipelines.
Excellent communication and documentation skills.

Nice to have skills

Exposure to performance, load, or security testing.
Test management tools (Jira, TestRail).

About StockX

StockX is proud to be a Detroit-based technology leader focused on the large and growing online
market for sneakers, apparel, accessories, electronics, collectibles, and more. Launched in 2016,
StockX employs 1,000 people across offices and verification centers around the world.
`;

describe('"About you" is the candidate, not the company', () => {
  test('the second-person forms open a REQUIRED section', () => {
    for (const heading of [
      'About You',
      'About you:',
      'About You:',
      'ABOUT YOU',
      'About the candidate',
      'About the ideal candidate:',
    ]) {
      const [, second] = segmentJd(`Responsibilities\n- Ship features\n${heading}\n- Experience with Python\n`);
      assert.equal(second?.kind, 'required', `"${heading}" states requirements`);
      assert.equal(second?.weight, 1);
    }
  });

  test('the employer-subject forms are still the blurb they always were', () => {
    // The regression this exclusion could cause. `you\b` and not `you`, so the possessive stays
    // out: "About your role" is cresta's spelling of "About the Role", the employer describing the
    // job, and it must keep scoring zero.
    for (const heading of [
      'About OpenAI',
      'About PhonePe Limited:',
      'About us',
      'About the Team',
      'About your role:',
      'About the Company',
    ]) {
      const [, second] = segmentJd(`Responsibilities\n- Ship features\n${heading}\nWe are a company.\n`);
      assert.equal(second?.kind, 'noise', `"${heading}" is a blurb about the employer`);
    }
  });

  test('nothing carved out of the noise rule is left unrecognised', () => {
    // The coupling that makes the fix safe. A form dropped from the noise pattern but not added to
    // the required pattern is WORSE than noise: an unrecognised heading does not close the section
    // above it, so the requirements would inherit the previous section's weight instead of getting
    // their own. Every excluded spelling must land somewhere real.
    for (const heading of ['About You', 'About yourself:', 'About the ideal candidate', 'About our ideal candidate']) {
      const [, second] = segmentJd(`Responsibilities\n- Ship features\n${heading}\n- Experience with Python\n`);
      assert.equal(second?.kind, 'required', `"${heading}" must classify, not fall through`);
    }
  });

  test('the whitespace between "About" and "You" can be any whitespace', () => {
    // Found in review, on the first version of this fix, which spelled the forms out twice: the
    // noise lookahead was written `\s+` and the required alternative with a literal space. So the
    // exclusion fired on all of these and the claim fired on none, dropping every one of them into
    // the unrecognised gap the test above exists to prevent. Zero postings on the 2026-08-04 board
    // spell it this way, which is exactly how it would have shipped unnoticed. The non-breaking
    // space is the one that matters: it is what a rich-text editor emits, and it is the same shape
    // as the U+2019 defect headingCore already carries a comment about.
    for (const [label, gap] of [['two spaces', '  '], ['tab', '\t'], ['non-breaking space', ' ']] as const) {
      const [, second] = segmentJd(
        `Responsibilities\n- Ship features\nAbout${gap}You\n- Experience with Python\n`,
      );
      assert.equal(second?.kind, 'required', `"About<${label}>You" must classify as required`);
    }
    // And the multiword forms, where the inner space is the one that drifted.
    const [, multi] = segmentJd('Responsibilities\n- Ship features\nAbout the  candidate\n- Python\n');
    assert.equal(multi?.kind, 'required', '"About the  candidate" must classify as required');
  });

  test('an employer whose name starts with "you" is still the employer', () => {
    // The cost of a looser `you`. These are real company spellings, and each one must stay noise.
    for (const heading of ['About Youth Programs', 'About Yousign', 'About Younited Credit']) {
      const [, second] = segmentJd(`Responsibilities\n- Ship features\n${heading}\nWe are a company.\n`);
      assert.equal(second?.kind, 'noise', `"${heading}" names the employer`);
    }
  });

  test('the StockX posting scores its requirements, not its responsibilities prose', () => {
    const sections = segmentJd(SECOND_PERSON_JD);
    assert.deepEqual(
      sections.map((s) => s.kind),
      ['body', 'responsibilities', 'required', 'preferred', 'noise'],
      'the "About You" block is the requirements; only "About StockX" is marketing',
    );
    const required = sections.find((s) => s.kind === 'required');
    assert.ok(required && /Automation Testing/.test(required.text));

    const terms = extractJdTerms(SECOND_PERSON_JD, {
      company: 'StockX',
      role: 'Software Development Engineer in Test',
      location: null,
    });
    const displays = terms.map((t) => t.display.toLowerCase());

    // The four the defect produced, named so a regression puts them back visibly.
    for (const prose of ['understand brds', 'prds', 'qa', 'regression']) {
      assert.ok(!displays.includes(prose), `"${prose}" is responsibilities prose, not a stated requirement`);
    }
    // And what the employer wrote under "About You". `ci cd` is deliberately not asserted: it
    // survives on the full posting but not on this trimmed one, where twelve weight-1 terms fill
    // EMPHASIS_LIMIT outright and the cap drops it. The fixture is shortened, so the assertions are
    // the ones the shortening does not change.
    for (const real of ['javascript', 'typescript', 'git']) {
      assert.ok(displays.includes(real), `"${real}" is stated under "About You" and must be counted`);
    }
  });
});

/**
 * VENDOR_SPELLINGS, the month block and the dead-entry removal, 2026-08-04.
 *
 * Every test here pins the INTENT of a change rather than the constant, the regex or the wording
 * that implements it, because the file this suite guards carries comments that were found to be
 * factually false. A test that reads a comment proves nothing about the code.
 */
describe('one product spelled two ways is one requirement', () => {
  /**
   * The subsumption residual: a posting naming "Microsoft Excel" also names "Excel", the pass that
   * spares a lexicon part kept both, and the same requirement was credited once and charged once
   * against the same resume.
   *
   * The second half is what keeps the fix honest. The general form of this merge was implemented
   * and measured first: over 400 live postings it produced 89 merges, most of them NARROWINGS
   * ("merchant compliance" into "compliance", "cost accounting" into "accounting"), under which a
   * resume saying "compliance" was credited for "merchant compliance". That is the laundering the
   * module header forbids, so both directions are pinned here.
   */
  test('a vendor spelling merges, and a narrowing modifier does not', () => {
    const merged = extractJdTerms(`Requirements:
- Advanced Microsoft Excel and Excel modelling
- Familiarity with Docker
- Comfortable with Git
- Working knowledge of Linux
`);
    assert.ok(
      !merged.some((t) => t.term === 'microsoft excel'),
      'the vendor spelling is not a second requirement',
    );
    const excel = merged.find((t) => t.term === 'excel');
    assert.ok(excel?.alternatives?.includes('microsoft excel'), 'both spellings still match');

    const narrowed = extractJdTerms(`Requirements:
- Experience with merchant compliance and compliance reporting
- Familiarity with Docker
- Comfortable with Git
- Working knowledge of Linux
`);
    const compliance = narrowed.find((t) => t.term === 'compliance');
    assert.ok(
      !compliance?.alternatives?.includes('merchant compliance'),
      'a resume saying "compliance" must not be credited for "merchant compliance"',
    );
  });

  /**
   * The merge is worth nothing unless BOTH spellings satisfy the merged slot. Asserted through the
   * score, which is what a student sees: a resume writing only "Excel" and a resume writing only
   * "Microsoft Excel" must read the same on a posting that used both.
   */
  test('either spelling satisfies the merged requirement', () => {
    const jd = `Requirements:
- Advanced Microsoft Excel and Excel modelling
- Familiarity with Docker
- Comfortable with Git
- Working knowledge of Linux
`;
    const bare = scoreJdMatch('Excel, Docker, Git and Linux.', jd).score;
    const vendor = scoreJdMatch('Microsoft Excel, Docker, Git and Linux.', jd).score;
    assert.equal(bare, vendor, 'the two spellings of one product cannot score differently');
    // "Nothing is left unmet", not "the score is 100". The claim this test exists to make is about
    // the MERGE: that one spelling settles the requirement and leaves no residue on the gap list.
    // The missing list states that directly. A score of 100 states it only indirectly, via whatever
    // arithmetic currently turns coverage into a number, so it is the weaker way to write the same
    // claim and it goes stale the moment that arithmetic is revisited.
    assert.deepEqual(scoreJdMatch('Excel, Docker, Git and Linux.', jd).missing, [],
      'covering the product once covers the requirement');
  });
});

describe('the lexicon is honest about what it covers', () => {
  /**
   * A lexicon entry that is also in BOILERPLATE or GENERIC_STOPWORDS is DEAD, because isDenied is
   * consulted before inLexicon in isSpecific. Two were dead and had been since they were written:
   * `next` and `recruiting`, so the HR line did not in fact cover the word recruiting.
   *
   * Probed through behaviour rather than by reading the two lists out of the source, because the
   * point is not that the sets are disjoint, it is that an entry the list claims to carry can
   * actually be admitted. A source-level set-difference would still pass if isDenied moved.
   */
  test('no lexicon entry is silently dead', () => {
    const admits = (word: string) => {
      const jd = `Requirements:\n- Experience with ${word} and with Kubernetes\n- Comfortable with Git\n- Working knowledge of Linux\n- Familiarity with Docker\n`;
      return extractJdTerms(jd).some((t) => (t.alternatives ?? [t.term]).includes(normalizeTerm(word)));
    };
    for (const word of ['litigation', 'compliance', 'excel', 'payroll', 'journalism']) {
      assert.ok(admits(word), `the list claims to carry "${word}", so it has to be admissible`);
    }
    for (const dead of ['next', 'recruiting']) {
      assert.ok(!admits(dead), `"${dead}" is BOILERPLATE, so it must not be claimed by the lexicon`);
    }

    // AND the lists themselves must not collide, which the behavioural probe above cannot see: a
    // dead entry is behaviourally INDISTINGUISHABLE from an absent one, so re-adding `recruiting`
    // to the lexicon changes nothing a caller could observe. That is exactly the defect - the list
    // claiming coverage it does not have - so it is asserted at the only level where it is visible.
    const source = readFileSync(path.join(__dirname, 'jdMatch.ts'), 'utf8');
    const listOf = (name: string) =>
      new Set(
        (new RegExp(`const ${name} = new Set\\(\\s*\`([\\s\\S]*?)\``).exec(source)?.[1] ?? '')
          .split(/\s+/)
          .filter(Boolean),
      );
    const lexicon = listOf('SKILL_LEXICON');
    assert.ok(lexicon.size > 0, 'the lexicon has to be readable for this assertion to mean anything');
    // Mirrors singular() in jdMatch.ts. isDenied checks the SINGULAR of every token as well as the
    // token, so a lexicon entry whose singular sits in a deny list is dead in the same way as an
    // exact collision - and an exact-string set intersection cannot see it.
    const singularOf = (w: string) => {
      if (/(ss|us|is)$/.test(w)) return w;
      if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
      if (/es$/.test(w) && /(ch|sh|x|s)es$/.test(w)) return w.slice(0, -2);
      if (/s$/.test(w)) return w.slice(0, -1);
      return w;
    };
    for (const denied of ['BOILERPLATE', 'GENERIC_STOPWORDS']) {
      const list = listOf(denied);
      assert.ok(list.size > 0, `${denied} must be readable, or every check below passes vacuously`);
      assert.deepEqual(
        [...lexicon].filter((w) => list.has(w)),
        [],
        `these lexicon entries can never be admitted, because ${denied} wins`,
      );
      // Only that direction. The reverse - a deny-list PLURAL over a lexicon singular - is not a
      // collision, because isDenied singularises the token and never the list, so denying `excels`
      // leaves `excel` fully reachable. That asymmetry is load-bearing: it is how the verb is
      // blocked without costing the spreadsheet.
      assert.deepEqual(
        [...lexicon].filter((w) => list.has(singularOf(w))),
        [],
        `${denied} holds the singular of these lexicon entries`,
      );
    }
  });

  /**
   * A date is not a requirement, and this one paid out. Month names were the largest block of junk
   * left in the final denominator, and a student resume dates every entry, so "June 2025" on a
   * resume MATCHED `june` in a trading firm's denominator and earned a twelfth of a score for
   * having graduated in the right month.
   *
   * Pinned as "the resume gains nothing", which is the harm, rather than as "the term is absent".
   */
  test('a date in the posting cannot be earned by a date on the resume', () => {
    const jd = `Requirements:
- Start date is June 2027 and the programme runs through December
- Familiarity with Docker
- Comfortable with Git
- Working knowledge of Linux
`;
    const dated = scoreJdMatch('Bachelor of Arts, June 2025. Docker, Git and Linux.', jd);
    const undated = scoreJdMatch('Bachelor of Arts. Docker, Git and Linux.', jd);
    assert.equal(dated.score, undated.score, 'a graduation month is not a qualification');
    assert.ok(
      !dated.matched.some((t) => ['june', 'december'].includes(t.term)),
      'no month may be a matched requirement',
    );

    // THE WEEKDAYS ARE THE SAME CLASS AND WORSE PER POSTING. An on-site schedule line sits INSIDE
    // a requirements block, so a weekday lands at weight 1: Roblox's "Content Designer" spent five
    // of its twelve required slots on monday through friday. Rarer than the months across the
    // board and a much larger share of the score on the postings that carry it.
    // Four real requirements beside the schedule line, deliberately: with the weekdays gone this
    // posting must still clear MIN_SCORABLE_TERMS, or the test would be asserting a refusal rather
    // than a clean score.
    const schedule = `Requirements:
- On site Monday, Tuesday, Wednesday, Thursday and Friday
- Familiarity with Docker
- Comfortable with Git
- Working knowledge of Linux
- Experience with Kubernetes
`;
    const terms = extractJdTerms(schedule);
    assert.deepEqual(
      terms.filter((t) => ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].includes(t.term)),
      [],
      'a day of the week is a condition of the job, never a requirement to have met',
    );
    // Asserted as an empty gap list rather than as a score of 100, for the reason given at the
    // vendor-spelling test above. The claim here is about DILUTION: that the schedule line does not
    // survive extraction to become a requirement the student is charged for. An empty missing list
    // says exactly that, and says it without depending on how coverage is turned into a number.
    assert.deepEqual(
      scoreJdMatch('Docker, Git, Linux and Kubernetes.', schedule).missing,
      [],
      'a resume covering every real requirement is not diluted by the schedule line',
    );
  });

  /**
   * `excels` is the verb. inLexicon strips a trailing s for tokens over three characters, so
   * "excels at turning ambiguity into execution" was admitted as the spreadsheet and matched
   * against a resume that lists Excel. The product is never written in the plural.
   */
  test('the verb "excels" is not the spreadsheet', () => {
    const jd = `Requirements:
- A problem solver who excels at ambiguity
- Familiarity with Docker
- Comfortable with Git
- Working knowledge of Linux
`;
    const scored = scoreJdMatch('Excel, Docker, Git and Linux.', jd);
    assert.ok(
      !scored.matched.some((t) => t.term === 'excels' || t.term === 'excel'),
      'a spreadsheet on the resume must not answer a verb in the posting',
    );
  });

  /**
   * EVERY VENDOR PAIR MUST ACTUALLY FIRE, which is the half of this list that can be checked
   * mechanically and the half that was already broken once.
   *
   * The merge sits inside the branch that spares a lexicon part, so a pair whose words are BOTH
   * absent from SKILL_LEXICON is dead: the phrase keeps its own slot, no `alternatives` are
   * written, and the list silently claims a merge it never performs. `microsoft powerpoint` was
   * exactly that - `powerpoint` is not a lexicon entry - and it sat here undetected because the
   * previous version of this test only checked that the phrase was two words and that
   * resumeCovers("I used <phrase> daily", secondWord) was true, which is plain substring matching
   * and therefore true of every two-word string ever written. It asserted nothing.
   *
   * WHAT THIS TEST CANNOT DO, stated so nobody trusts it further than it goes: it cannot tell a
   * genuine spelling pair from a NARROWING. Adding 'google analytics' would pass every assertion
   * here, because `analytics` is a lexicon entry and the merge would fire - and it would be wrong,
   * for the reason VENDOR_SPELLINGS gives. That judgement is human and this test does not make it.
   */
  test('every vendor spelling actually merges into the product it names', () => {
    const source = readFileSync(path.join(__dirname, 'jdMatch.ts'), 'utf8');
    const block = /const VENDOR_SPELLINGS = new Set\(\[([\s\S]*?)\]\);/.exec(source)?.[1] ?? '';
    const pairs = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(pairs.length > 0, 'the list has to be readable for this assertion to mean anything');

    for (const phrase of pairs) {
      // Exercised through extraction, not by reading the lexicon: what matters is that the merge
      // HAPPENS, not that a word appears in a list the merge might stop consulting.
      // Written the way a posting writes it: Title Case. A lowercase "microsoft" is not a specific
      // token, so the bigram would never form and the test would pass for the wrong reason.
      const titled = phrase.split(' ').map((w) => w[0].toUpperCase() + w.slice(1));
      const jd = `Requirements:\n- Advanced ${titled.join(' ')} and ${titled[1]} modelling\n- Familiarity with Docker\n- Comfortable with Git\n- Working knowledge of Linux\n`;
      const terms = extractJdTerms(jd);
      assert.ok(
        !terms.some((t) => t.term === phrase),
        `"${phrase}" is a DEAD pair: it survives as its own slot, so the merge never fired`,
      );
      const merged = terms.find((t) => t.alternatives?.includes(phrase));
      assert.ok(merged, `"${phrase}" merged into nothing, so no alternative was written`);
      // The representative must be a WORD of the phrase. This is what makes covering the phrase
      // cover the requirement, and it is why gapEvidence.ts and interviewPrep.ts can still match a
      // JdTerm through resumeCovers without being wrong.
      assert.ok(
        phrase.split(' ').includes(merged.term),
        `"${phrase}" merged into "${merged.term}", which is not one of its words`,
      );
    }
  });
});

/**
 * THE PAY-AND-REWARDS FOOTER, the residue the "About You" fix named and did not close.
 *
 * That fix stopped a second-person heading from zeroing the requirements under it, and said in its
 * own PR that a requirements block running to the end of a posting with nothing to close it keeps
 * the pay and EEO footer at weight 1. Measured board-wide rather than on that one subset, footer
 * text sits inside a REQUIRED section on 5,839 of 22,138 active postings (26.4%).
 *
 * Toast's "Field Sales Account Executive" is the fixture below and it is the funniest instance of a
 * serious bug: the company writes its benefits section as bread puns under the heading "Our Spread*
 * of Total Rewards", and `Toasters`, `Tofu`, `Baked` and `Recipe` were being counted as things the
 * employer required of a candidate. Board-wide the four additions drop `Zone Philosophy` (162),
 * `Baked` (144), `Recipe` (132), `Toasters` (48), `Washington Minimum` (47) and the greenhouse mail
 * domain (40) out of denominators.
 *
 * Every assertion here is on the INTENT (footer text scores zero, requirement text does not) rather
 * than on the vocabulary that implements it, because the vocabulary is expected to keep growing.
 *
 * THE FIXTURE IS DELIBERATELY RICH ON THE REQUIREMENTS SIDE, and a thinner one does not test what
 * it looks like it tests. The first draft listed three requirement lines, which left fewer than
 * MIN_SCORABLE_TERMS once the footer was zeroed, so the salvage pass in extractJdTerms re-read the
 * noise as body prose and handed `Tofu` straight back. That is the salvage pass working as
 * designed. It also means a footer fix can only be observed on a posting that stays scorable
 * WITHOUT the footer, which every real posting of this shape is.
 */
const TOTAL_REWARDS_JD = `
About You

5+ years of closing experience in SaaS sales
Proficiency with Salesforce, Outreach and Gong
Experience running a full sales cycle from prospecting to close
Comfort building forecasts in Excel and reporting through Tableau
Familiarity with SQL for self-serve pipeline analysis
Experience with HubSpot or a comparable CRM

Our Spread* of Total Rewards

Toasters get a competitive base salary and uncapped commission.
We are proud of our Recipe for benefits: medical, dental and vision from day one.
Baked into the offer is equity, plus a Tofu Tuesday lunch stipend.

Pay Transparency

The base salary range for this role is $90,000 to $120,000.
Washington Minimum Wage Act disclosures apply to this posting.
`;

describe('the pay and rewards footer is not a requirement', () => {
  test('a rewards heading CLOSES the requirements block above it', () => {
    const sections = segmentJd(TOTAL_REWARDS_JD);
    const required = sections.find((s) => s.kind === 'required');
    assert.ok(required, '"About You" still opens the requirements');
    assert.match(required.text, /closing experience/);
    assert.ok(
      !/Toasters|Tofu/.test(required.text),
      'the benefits puns must not sit inside the requirements block',
    );
    for (const s of sections) {
      if (/Toasters|Washington Minimum/.test(s.text)) assert.equal(s.weight, 0, 'footer text scores zero');
    }
  });

  test('the denominator is the sales requirements, not the bread puns', () => {
    const displays = extractJdTerms(TOTAL_REWARDS_JD, {
      company: 'Toast',
      role: 'Field Sales Account Executive',
      location: null,
    }).map((t) => t.display);
    for (const pun of ['Toasters', 'Tofu', 'Baked', 'Recipe', 'Washington Minimum']) {
      assert.ok(!displays.includes(pun), `"${pun}" is a benefits pun, not a requirement`);
    }
    for (const real of ['Salesforce', 'Outreach']) {
      assert.ok(displays.includes(real), `"${real}" is stated under "About You" and must be counted`);
    }
  });

  test('each added heading closes a section on its own', () => {
    for (const heading of [
      'Total Rewards',
      'Our Total Rewards Philosophy',
      'Pay Transparency',
      'Pay Transparency Disclosure',
      "What we'll offer",
      'Prior employment verification check',
      'Disclosures:',
    ]) {
      const [, second] = segmentJd(`Requirements\n- Python and Docker\n${heading}\nWe pay well and verify offers.\n`);
      assert.equal(second?.kind, 'noise', `"${heading}" opens a footer, not a requirements block`);
    }
  });

  test('the words that are somebody’s actual job are not footer', () => {
    // Measured rejections, pinned so they are not re-proposed. Bare `disclosures?` fires on 202
    // heading lines board-wide and four of its ten spellings are real work; only the anchored bare
    // banner is safe. These are the lines that must keep scoring.
    for (const real of [
      'Prepare tax related disclosures for financial statements',
      'Manage subprocessor tracking and disclosures',
      'Experience negotiating non-disclosure agreements',
    ]) {
      const [first] = segmentJd(`Requirements\n${real}\n- Experience with Python\n`);
      assert.equal(first?.kind, 'required', `"${real}" is a requirement line, not a disclosures banner`);
      assert.match(first.text, /Python/, 'and it must not have closed the block either');
    }
  });

  test('a LinkedIn tracking tag still closes nothing', () => {
    // The other measured rejection. `#LI-Hybrid` and its 328 cousins are the biggest unrecognised
    // heading on the board (3,705 lines, and headingCore strips the `#` so they arrive looking like
    // headings), but only 635 sit in the last 5% of their posting while 1,867 sit before the 80%
    // mark. A rule that closed the section at the tag would zero real content on a third of them.
    // Harmless where they are, so this pins that they stay harmless rather than becoming noise.
    const sections = segmentJd('Requirements\n- Experience with Python\n#LI-Hybrid\n- Experience with Kubernetes\n');
    const keys = sections.flatMap((s) => (s.kind === 'required' ? [s.text] : []));
    assert.equal(keys.length, 1, 'the tag must not split the requirements into two blocks');
    assert.match(keys[0], /Kubernetes/, 'the requirement below the tag is still required');
  });
});
