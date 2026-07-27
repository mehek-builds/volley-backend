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
describe('route registration', () => {
  test('POST /jd-match is actually mounted in index.ts', () => {
    // __dirname, not import.meta.url: tsconfig targets CommonJS for the Vercel build.
    const root = readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    assert.match(root, /import \{ jdMatchRoutes \} from '\.\/routes\/jdMatch'/, 'index.ts must import the route');
    assert.match(root, /register\(jdMatchRoutes\)/, 'index.ts must register the route');
  });
});
