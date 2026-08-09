import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  numberSignatures,
  ungroundedNumbers,
  wordSet,
  ungroundedProperNouns,
  stripEmDashes,
  isRankingAsk,
  extractRankedItems,
  claimedUnheldItems,
  contestedMetrics,
  contestedMetricsUsed,
  unsupportedCommitments,
} from './grounding';

test('a number present in the source is grounded', () => {
  const src = numberSignatures('Handled 40K requests per day across the pipeline');
  assert.deepEqual(ungroundedNumbers('Scaled the service to 40K requests/day', src), []);
});

test('a fabricated metric when the source has no numbers is flagged', () => {
  const src = numberSignatures('Built an internal dashboard for the analytics team');
  assert.deepEqual(ungroundedNumbers('Built a dashboard serving 40K requests/day', src), ['40K']);
});

test('number written differently still matches its source value (40K vs 40,000)', () => {
  const src = numberSignatures('processed 40,000 events');
  assert.deepEqual(ungroundedNumbers('processed 40K events', src), []);
  const src2 = numberSignatures('cut latency by 40K ms');
  assert.deepEqual(ungroundedNumbers('cut latency by 40,000 ms', src2), []);
});

test('percentages and multipliers are checked against source', () => {
  const src = numberSignatures('improved conversion by 25% and cut costs 3x');
  assert.deepEqual(ungroundedNumbers('improved conversion 25%, a 3x gain', src), []);
  assert.deepEqual(ungroundedNumbers('improved conversion 90%', src).length, 1);
});

test('a percentage/multiplier is NOT grounded by a bare count of the same digits', () => {
  // "team of 25" must not license a fabricated "25%"; "3 projects" must not license "3x".
  const src = numberSignatures('Led a team of 25 across 3 projects');
  assert.deepEqual(ungroundedNumbers('Improved conversion by 25%', src), ['25%']);
  assert.deepEqual(ungroundedNumbers('Delivered a 3x speedup', src), ['3x']);
  // ...but a real percentage in the source still grounds the same percentage.
  const src2 = numberSignatures('cut costs by 25%');
  assert.deepEqual(ungroundedNumbers('cut costs 25%', src2), []);
});

test('L3: "24/7" ratio is not treated as the fabricated metric "24"', () => {
  const src = numberSignatures('Provided on-call support for the platform'); // no numbers
  assert.deepEqual(ungroundedNumbers('Kept the service available 24/7', src), []);
  // a date-like N/N is likewise not clipped into a spurious metric
  assert.deepEqual(ungroundedNumbers('Ran the program from 09/2024', numberSignatures('joined 2024')), []);
});

test('L3: percent and decimal proportion are treated as equivalent (0.40 <-> 40%)', () => {
  const srcDecimal = numberSignatures('conversion rate of 0.40 on the funnel');
  assert.deepEqual(ungroundedNumbers('lifted conversion to 40%', srcDecimal), []);
  const srcPercent = numberSignatures('improved conversion by 40%');
  assert.deepEqual(ungroundedNumbers('reached a 0.40 conversion rate', srcPercent), []);
  // a genuinely different proportion is still flagged
  assert.deepEqual(ungroundedNumbers('lifted conversion to 90%', srcDecimal), ['90%']);
});

test('L3: a decimal >= 1 (GPA/rating) does NOT ground a fabricated large percentage', () => {
  // "3.8" GPA and "380%" both used to reduce to d:3.8 and cross-ground. They must stay distinct:
  // only a value < 1 is a percentage-equivalent proportion.
  const srcGpa = numberSignatures('maintained a 3.8 GPA while working');
  assert.deepEqual(ungroundedNumbers('grew active users 380%', srcGpa), ['380%']);
  // reverse: a source "380%" must not ground a fabricated "3.8"
  const srcPct = numberSignatures('grew revenue 380% year over year');
  assert.deepEqual(ungroundedNumbers('earned a 3.8 rating', srcPct), ['3.8']);
  // the legitimate < 1 proportion equivalence still holds
  assert.deepEqual(ungroundedNumbers('hit 40%', numberSignatures('a 0.40 rate')), []);
});

test('L6: stripEmDashes replaces em/en dashes and tidies punctuation', () => {
  assert.equal(stripEmDashes('I built the API — it scaled well.'), 'I built the API, it scaled well.');
  assert.equal(stripEmDashes('Fast, reliable—and simple.'), 'Fast, reliable, and simple.');
  assert.equal(stripEmDashes('No dashes here.'), 'No dashes here.');
  assert.ok(!stripEmDashes('a — b – c').includes('—'));
  assert.ok(!stripEmDashes('a — b – c').includes('–'));
});

test('tech identifiers like S3 / EC2 / GPT-4 are not treated as fabricated metrics', () => {
  const src = numberSignatures('Deployed a service'); // no numbers in source
  // None of these should be flagged as ungrounded numbers.
  assert.deepEqual(ungroundedNumbers('Deployed on AWS S3 and EC2 using GPT-4', src), []);
});

test('bare single digits are ignored (too noisy to be a metric signal)', () => {
  const src = numberSignatures('Worked on a team project');
  assert.deepEqual(ungroundedNumbers('Worked with 2 other engineers', src), []);
});

test('wordSet lowercases, drops stopwords, and keeps content tokens', () => {
  const ws = wordSet('Software Engineer at Google Cloud');
  assert.equal(ws.has('software'), true);
  assert.equal(ws.has('google'), true);
  assert.equal(ws.has('at'), false); // stopword dropped
});

test('ungroundedProperNouns flags multi-word names and acronyms absent from the corpus', () => {
  const corpus = wordSet('I built a payments dashboard at Stripe using Python');
  const out = ungroundedProperNouns('I led a team at Goldman Sachs and used NASA data.', corpus);
  assert.ok(out.includes('Goldman Sachs'));
  assert.ok(out.includes('NASA'));
});

test('ungroundedProperNouns does not flag names that appear in the corpus', () => {
  const corpus = wordSet('Interned at Stripe on the payments team');
  const out = ungroundedProperNouns('At Stripe I owned the payments flow.', corpus);
  assert.deepEqual(out, []);
});

// R-042: ranking/ordering asks treat every rankable item as a skill claim. The live miss (DRW,
// 2026-07-18): "rank your languages" drafted "Python first, JAVA second" with no Java anywhere
// in the declared list. These helpers are the deterministic half of that fix.

test('R-042: ranking asks are detected, prose questions are not', () => {
  assert.equal(isRankingAsk('Rank the following languages by proficiency: Python, Java, C++'), true);
  assert.equal(isRankingAsk('Please rank these tools in order of preference'), true);
  assert.equal(isRankingAsk('List your languages in order of comfort'), true);
  assert.equal(isRankingAsk('Order these frameworks from most to least familiar'), true);
  assert.equal(isRankingAsk('Why do you want to work here?'), false);
  assert.equal(isRankingAsk('Tell us about a project you are proud of'), false);
});

test('R-042: "in order to" never reads as a ranking ask', () => {
  assert.equal(isRankingAsk('What would you do in order to meet a tight deadline?'), false);
  assert.equal(isRankingAsk('Describe the steps you took in order to ship your project'), false);
});

test('R-042: the question\'s own item list is extracted from a colon tail', () => {
  assert.deepEqual(
    extractRankedItems('Rank the following languages by proficiency: Python, Java, C++, Go'),
    ['Python', 'Java', 'C++', 'Go'],
  );
});

test('R-042: parenthesized and semicolon-separated lists extract too', () => {
  assert.deepEqual(extractRankedItems('Rank the languages below (Python, Java, C++) by comfort'), ['Python', 'Java', 'C++']);
  assert.deepEqual(extractRankedItems('Rank these: React; Vue; Angular'), ['React', 'Vue', 'Angular']);
});

test('R-042: "and"/"or" joiners and trailing punctuation are handled', () => {
  assert.deepEqual(extractRankedItems('Rank your comfort with the following: Python, Java, and SQL.'), ['Python', 'Java', 'SQL']);
});

test('R-042: a colon followed by prose is not mistaken for an item list', () => {
  assert.deepEqual(extractRankedItems('Rank your priorities: tell us what matters most to you in a first job.'), []);
});

test('R-042: a ranking ask naming no candidates extracts nothing', () => {
  assert.deepEqual(extractRankedItems('Rank your programming languages by proficiency'), []);
});

test('R-042: an unheld item in the drafted answer is caught in any casing', () => {
  // the live shape: the question wrote "Java", the draft claimed "JAVA"
  assert.deepEqual(claimedUnheldItems('I would rank Python first and JAVA second.', ['Java']), ['Java']);
});

test('R-042: an answer ranking only held items passes clean', () => {
  assert.deepEqual(claimedUnheldItems('Python first: I used it daily at Traeco. C++ second.', ['Java', 'Go']), []);
});

test('R-042: symbol-bearing items match whole, never by prefix', () => {
  // "C" must not be claimed by an answer that says C++, nor "Java" by JavaScript
  assert.deepEqual(claimedUnheldItems('C++ is my strongest language.', ['C']), []);
  assert.deepEqual(claimedUnheldItems('I write JavaScript daily.', ['Java']), []);
  assert.deepEqual(claimedUnheldItems('I have shipped C# services in production.', ['C#']), ['C#']);
});

/* ------------------------------------------------------------------------------------------------
 * A PROMISE IN THE LETTER. Packet fbc1d407 (truveta, Software Engineering Intern), 2026-08-09.
 * ---------------------------------------------------------------------------------------------- */

// The exact sentence that shipped. She lives in Dubai and is enrolled in Los Angeles, and she never
// said either half of it: Truveta's form asks whether the applicant will be in the Seattle area and
// the letter answered in prose, where nothing could check it.
const TRUVETA_PROMISE =
  'I am based in Los Angeles but able to work from the Greater Seattle area for this internship, '
  + 'and I am currently enrolled in my undergraduate program with an expected graduation date of May 2028.';

test('the letter sentence that promised Greater Seattle is caught', () => {
  assert.deepEqual(unsupportedCommitments(TRUVETA_PROMISE), [TRUVETA_PROMISE]);
});

test('the other real promises across the stored letters are caught', () => {
  // Every one of these was generated and stored in production. They are the whole of what the check
  // found across all 136 stored letters, so this list is the regression surface, not a sample.
  const shipped = [
    "I'm based in the Los Angeles area currently but am able to work in the Greater Seattle area for this internship.",
    "I'm available for the fall term and can commit to full-time hours in office in Austin.",
    "I'm available for a 12-14 week internship in Austin this fall.",
    "I'm based in the Los Angeles area with the flexibility to work in-office in the Greater Seattle area.",
    "I'm available for a fall internship in Austin.",
    "I'm a U.S. citizen and available for a twelve-week internship this fall.",
    "I'm available for either fall term listed.",
  ];
  for (const sentence of shipped) {
    assert.deepEqual(unsupportedCommitments(sentence), [sentence], sentence);
  }
});

test('relocation, exclusivity and a start date are promises too', () => {
  for (const sentence of [
    'I would relocate to Austin for the right team.',
    'Truveta is the only offer I am pursuing and I will work exclusively with your team.',
    'My start date is flexible.',
    'I can start on June 1.',
    'I am willing to commute to the Bellevue office three days a week.',
    'I have signed no non-compete.',
  ]) {
    assert.equal(unsupportedCommitments(sentence).length, 1, sentence);
  }
});

test('past-tense achievements and facts on file are not promises', () => {
  /* The failure direction that matters second. Blocking is a hard gate on a real letter, so a check
   * that trips on ordinary prose costs Mehek working letters. Every line here is drawn from the same
   * 136 stored letters and every one must pass clean, including "in person" in a past-tense claim
   * and the graduation date, which is a fact she gave Litos rather than a promise she is making. */
  for (const sentence of [
    'I conducted 47 user interviews in person and analyzed 8,300+ behavioral data points.',
    'I am currently enrolled in my undergraduate program with an expected graduation date of May 2028.',
    "I'm looking for an internship where I can work alongside experienced engineers on systems operating at real scale.",
    'I would welcome the chance to apply my Python and product engineering background to health data infrastructure.',
    'At Cinematica Labs I built threshold alerting across 96 pairs from 8 dropout indicators.',
    'That work required the kind of collaborative, deadline-driven execution this internship calls for.',
    'I made the results available for the whole team on a shared dashboard.',
    'I am applying for the Software Engineering Intern role at Truveta.',
  ]) {
    assert.deepEqual(unsupportedCommitments(sentence), [], sentence);
  }
});

test('only the offending sentence is returned, not the whole letter', () => {
  const letter = `I am applying for the Software Engineering Intern role at Truveta. ${TRUVETA_PROMISE} I built a Chrome extension end to end.`;
  assert.deepEqual(unsupportedCommitments(letter), [TRUVETA_PROMISE]);
});

/* ------------------------------------------------------------------------------------------------
 * ONE METRIC, TWO PROJECTS. The same letter credited "2.3s to 0.1s" to Traeco and to Tonee.
 * ---------------------------------------------------------------------------------------------- */

// Her real experience bank, trimmed to the entries that matter. Both bullets are stored exactly like
// this, which is the finding: the duplication is in the DATA. The generator repeated the source
// faithfully and every number in that letter passed ungroundedNumbers honestly.
const BANK = [
  {
    org: 'Traeco - AI Agent Cost Infrastructure',
    text: 'Built LLM-agent cost infrastructure with LangChain and the OpenAI API, instrumenting evaluation harnesses for accuracy that cut agent response latency from 2.3s to 0.1s.'
      + ' Structured an ambiguous, fast-moving AI market into testable hypotheses through 50+ customer discovery interviews.',
  },
  {
    org: 'Tonee - AI Texting Tone Detector',
    text: 'Evaluated 3 technical architectures for mobile performance; authored specification reducing latency from 2.3s to 0.1s.'
      + ' Conducted 47 user interviews and analyzed 8,300+ behavioral data points, increasing accuracy from 78% to 89%.',
  },
  // Same project, second title. Normalizing on the org means these do not contest each other.
  {
    org: 'Tonee – AI Texting Tone Detector',
    text: 'Evaluated 3 technical architectures for mobile performance; authored specification reducing latency from 2.3s to 0.1s.',
  },
  {
    org: 'SoFi',
    text: 'Analyzed digital product funnel for 80K monthly users; synthesized behavioral data and 50+ interviews.',
  },
  { org: 'Spark SC', text: 'Secured $14K from 7 sponsors and managed $27K budget for 12 events.' },
  {
    org: 'Cinematica Labs',
    text: 'Managed tracking across 24 mentor-founder pods; shipped 3 initiatives contributing to a 14-point NPS increase.',
  },
  {
    org: 'Einstein Bros. Bagels',
    text: 'Designed and A/B tested UX flows with 24 participants; achieved 9.6% higher completion.',
  },
];

test('a figure two different projects both claim belongs to neither', () => {
  const { labels } = contestedMetrics(BANK);
  assert.deepEqual(labels, ['0.1', '2.3']);
});

test('a single number two orgs happen to share is left alone', () => {
  /* The reason the threshold is two shared numbers and not one. All three of these pairs exist in
   * her real bank and all three are innocent: $14K of sponsorship against a 14-point NPS rise, 24
   * pods against 24 usability participants, 50+ interviews at two different places. Flagging them
   * would strip true claims out of good letters. */
  const { labels } = contestedMetrics(BANK);
  for (const innocent of ['14', '24', '50']) {
    assert.equal(labels.includes(innocent), false, innocent);
  }
});

test('two spellings of the same org do not contest each other', () => {
  // The en-dash and hyphen spellings of Tonee are one project. If org normalization regressed, every
  // Tonee figure would be declared contested and the letter would lose all of them.
  const tonee = BANK.filter((entry) => entry.org.toLowerCase().startsWith('tonee'));
  assert.deepEqual(contestedMetrics(tonee).labels, []);
});

test('a bank with no duplicated attribution contests nothing', () => {
  assert.deepEqual(contestedMetrics(BANK.filter((entry) => !entry.org.toLowerCase().startsWith('tonee'))).labels, []);
});

test('a draft that reuses the contested figure is caught, and one that drops it is clean', () => {
  const { signatures } = contestedMetrics(BANK);
  const reused = 'At Traeco I cut agent response latency from 2.3s to 0.1s, and at Tonee I authored a specification that reduced latency from 2.3s to 0.1s.';
  assert.deepEqual(contestedMetricsUsed(reused, signatures).sort(), ['0.1', '2.3']);
  const dropped = 'At Traeco I instrumented evaluation harnesses across 50+ customer discovery interviews, and at Tonee I raised accuracy from 78% to 89%.';
  assert.deepEqual(contestedMetricsUsed(dropped, signatures), []);
});

test('nothing contested means nothing to check', () => {
  assert.deepEqual(contestedMetricsUsed('Cut latency from 2.3s to 0.1s.', new Set()), []);
});
