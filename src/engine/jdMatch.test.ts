import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  segmentJd,
  extractJdTerms,
  normalizeTerm,
  resumeCovers,
  scoreJdMatch,
  scoreBand,
  MIN_SCORABLE_TERMS,
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
    const terms = extractJdTerms(SWE_JD).map((t) => t.term);
    for (const real of ['python', 'typescript', 'react', 'postgresql', 'docker', 'kubernetes']) {
      assert.ok(terms.includes(real), `"${real}" should be a requirement term`);
    }
  });

  test('the denominator is a size a one-page resume can actually cover', () => {
    const terms = extractJdTerms(SWE_JD);
    assert.ok(
      terms.length >= MIN_SCORABLE_TERMS && terms.length <= 60,
      `expected a human-reachable term count, got ${terms.length}`,
    );
  });

  test('a required term outweighs a preferred one', () => {
    const terms = extractJdTerms(SWE_JD);
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
});
