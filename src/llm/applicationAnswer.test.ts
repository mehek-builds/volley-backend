import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM_PROMPT,
  normalizeDraftedAnswer,
  rankingGroundingFor,
  rankingRuleText,
  thinRankingWarning,
  draftApplicationAnswer,
  applicantGroundingFacts,
  groundingFactsText,
} from './applicationAnswer';
import { ungroundedProperNouns, wordSet } from '../engine/grounding';

// R-029 regression coverage. Live on Replit (2026-07-17): asked "Please tell us about your
// submitted project" on a form whose Project URL was empty and unfillable, the drafter wrote
// "For my submission I built Tonee..." - every FACT grounded, the FRAME false. No grounding
// check can catch that, because the defect is adopting the question's presupposition, not any
// claim inside the answer. The fix is a prompt rule plus a refusal sentinel that rides the
// module's existing cannot-draft path (empty answer -> route 502 -> the card flags the field).

describe('R-029: the premise rule is pinned in the system prompt', () => {
  // The live model cannot be asserted on in unit tests; the rule TEXT can. If someone rewrites
  // the prompt and drops the rule, these fail instead of the failure resurfacing on a live form.
  // The prompt hard-wraps its lines, so phrases are matched on a whitespace-normalized copy.
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');

  test('names the presupposition hazard', () => {
    assert.match(flat, /Premise \(hard rule\)/);
    assert.match(flat, /presuppose an artifact, event, or status/);
    assert.match(flat, /NEVER adopt such a premise/);
  });

  test('names the exact live failure shape: true facts under a false frame', () => {
    assert.match(flat, /submitted project/);
    assert.match(flat, /still false/);
    assert.match(flat, /never claiming to have submitted, attached, linked, or built anything for THIS application/);
  });

  test('names the honest reframe and the refusal path', () => {
    assert.match(flat, /The project I would point to is/);
    assert.match(flat, /output exactly CANNOT_DRAFT and nothing else/);
  });
});

describe('R-029: the refusal sentinel rides the cannot-draft path', () => {
  test('a bare refusal becomes the empty answer the route already 502s on', () => {
    assert.equal(normalizeDraftedAnswer('CANNOT_DRAFT'), '');
  });

  test('a refusal with an appended reason is still a refusal', () => {
    assert.equal(normalizeDraftedAnswer('CANNOT_DRAFT: the question presumes a submitted project and none exists'), '');
    assert.equal(normalizeDraftedAnswer('CANNOT_DRAFT.'), '');
  });

  test('surrounding whitespace does not hide a refusal', () => {
    assert.equal(normalizeDraftedAnswer('  CANNOT_DRAFT  \n'), '');
  });

  test('a real answer passes through trimmed', () => {
    assert.equal(
      normalizeDraftedAnswer('  The project I would point to is Tonee, which I built and shipped solo.  '),
      'The project I would point to is Tonee, which I built and shipped solo.',
    );
  });

  test('the sentinel mentioned MID-answer is not a refusal', () => {
    const answer = 'My tooling reports CANNOT_DRAFT when a template is missing, which I fixed at Traeco.';
    assert.equal(normalizeDraftedAnswer(answer), answer);
  });

  test('a lookalike prefix is not a refusal', () => {
    const answer = 'CANNOT_DRAFTED is not a word, but drafting is what I did at Traeco.';
    assert.equal(normalizeDraftedAnswer(answer), answer);
  });

  test('an empty model response stays empty', () => {
    assert.equal(normalizeDraftedAnswer(''), '');
    assert.equal(normalizeDraftedAnswer('   '), '');
  });
});

// R-042 regression coverage. Live on DRW (2026-07-18): a "rank your languages" answer said
// "Python first, JAVA second" - Java is nowhere in the 19 declared skills. The prose grounding
// rule (R-015/R-027) keys on the student's material and never sees a ranking's item list, so a
// ranking question invited claiming an item from the QUESTION's own text. The fix treats every
// rankable item as a skill claim: a prompt rule, a per-question held/unheld split in the user
// turn, and a deterministic post-check that fails closed through the cannot-draft path. The
// model itself stays out of these tests (same discipline as the R-029 suite above): the drafted
// answers below are hand-written stand-ins for model output.

describe('R-042: the ranking rule is pinned in the system prompt', () => {
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');

  test('names ranking as a skill claim', () => {
    assert.match(flat, /Ranking \(hard rule\)/);
    assert.match(flat, /every item you place in that ranking is a skill claim in the applicant's name/);
  });

  test('confines the ranking to the declared list and bans padding', () => {
    assert.match(flat, /Rank ONLY items that appear in the applicant's declared skills list/);
    assert.match(flat, /leave it out of the answer entirely/);
    assert.match(flat, /rather than padding the list/);
  });
});

describe('R-042: rankingGroundingFor grades the question against the declared list', () => {
  const DECLARED = ['Python', 'C++', 'SQL'];

  test('splits the question\'s items into held and unheld', () => {
    const g = rankingGroundingFor('Rank the following languages by proficiency: Python, Java, C++', DECLARED);
    assert.ok(g);
    assert.deepEqual(g.items, ['Python', 'Java', 'C++']);
    assert.deepEqual(g.held, ['Python', 'C++']);
    assert.deepEqual(g.unheld, ['Java']);
  });

  test('matching is case- and whitespace-insensitive (same normalization as findUngroundedSkills)', () => {
    const g = rankingGroundingFor('Rank these: PYTHON, sql', DECLARED);
    assert.deepEqual(g?.held, ['PYTHON', 'sql']);
    assert.deepEqual(g?.unheld, []);
  });

  test('a non-ranking prose question is completely unaffected', () => {
    assert.equal(rankingGroundingFor('Why do you want to work at DRW?', DECLARED), null);
    assert.equal(rankingGroundingFor('Tell us about a project you are proud of.', DECLARED), null);
  });

  test('a never-declared list disables the check instead of reading as "holds nothing"', () => {
    assert.equal(rankingGroundingFor('Rank these: Python, Java', []), null);
    assert.equal(rankingGroundingFor('Rank these: Python, Java', null), null);
    assert.equal(rankingGroundingFor('Rank these: Python, Java', undefined), null);
    // junk-only entries are "never declared" too, same filtering as declaredSkillsList
    assert.equal(rankingGroundingFor('Rank these: Python, Java', ['', '   ']), null);
  });

  test('a ranking ask naming no candidates still grounds prompt-side (items empty)', () => {
    const g = rankingGroundingFor('Rank your programming languages by proficiency', DECLARED);
    assert.ok(g);
    assert.deepEqual(g.items, []);
    assert.deepEqual(g.held, []);
    assert.deepEqual(g.unheld, []);
  });
});

describe('R-042: the per-question rule the user turn carries', () => {
  test('names the held intersection and bans the unheld remainder', () => {
    const text = rankingRuleText({ items: ['Python', 'Java', 'C++'], held: ['Python', 'C++'], unheld: ['Java'] });
    assert.match(text, /declared skills cover only: Python, C\+\+/);
    assert.match(text, /names Java, which the applicant has NOT declared/);
    assert.match(text, /do not rank, claim, or mention them at all/);
  });

  test('a fully-held list carries no unheld clause', () => {
    const text = rankingRuleText({ items: ['Python', 'SQL'], held: ['Python', 'SQL'], unheld: [] });
    assert.match(text, /cover only: Python, SQL/);
    assert.doesNotMatch(text, /NOT declared/);
  });

  test('a listless ranking ask still gets the declared-list-only rule', () => {
    const text = rankingRuleText({ items: [], held: [], unheld: [] });
    assert.match(text, /Rank only skills on the declared skills list/);
  });
});

describe('R-042: the thin-intersection flag', () => {
  test('names what the ask wanted and what the draft omits', () => {
    const w = thinRankingWarning({ items: ['Python', 'Java', 'C++'], held: ['Python', 'C++'], unheld: ['Java'] });
    assert.ok(w);
    assert.match(w, /names 3 items/);
    assert.match(w, /cover 2 \(Python, C\+\+\)/);
    assert.match(w, /omits: Java/);
  });

  test('a fully-held ranking carries no flag', () => {
    assert.equal(thinRankingWarning({ items: ['Python'], held: ['Python'], unheld: [] }), null);
  });

  test('a listless ranking ask carries no flag (nothing measurable to be thinner than)', () => {
    assert.equal(thinRankingWarning({ items: [], held: [], unheld: [] }), null);
  });
});

describe('R-042: an all-unheld ranking rides the cannot-draft path', () => {
  test('zero declared overlap returns the empty answer deterministically, before any model call', async () => {
    // No API key, no mock, no network: the short-circuit must fire before the client is touched,
    // and the route's existing empty-answer 502 flags the field for the student (same signal as
    // an R-029 premise refusal).
    const { answer, warnings } = await draftApplicationAnswer(
      'Rank the following languages by proficiency: Java, Kotlin, Scala',
      'DRW',
      'Software Engineering Intern',
      'JVM-heavy trading systems role',
      [],
      { school: 'USC' },
      ['Python', 'SQL'],
    );
    assert.equal(answer, '');
    assert.deepEqual(warnings, []);
  });
});

// Set by Mehek 2026-07-23 as a standard, after a session surfaced "have you done any math
// competitions" and "have you completed any internships" as blockers rather than answering them.
// Both are checkable facts already present (or provably absent) in her own material.

test('the prompt treats an absent fact as an answer, not a gap to escalate', () => {
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /ABSENCE IS AN ANSWER/);
  assert.match(flat, /the applicant has not done it/i);
  assert.match(flat, /I have not participated in any of these competitions/i);
});

test('the prompt requires naming real roles when the history does exist', () => {
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /name the real roles, employers and dates/i);
});

test('the prompt still forbids inventing a positive to look stronger', () => {
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /the negative is always safe, a fabricated positive never is/i);
});

/* ─── the grounding corpus is the applicant's whole stored background, not just her school ───
 *
 * Measured on the Anduril packet of 2026-08-08 (submission_run_id 32823cf6). The drafted answer to
 * "Are you willing to work in-person for 12 weeks during the internship?" mentioned Los Angeles and
 * came back with, verbatim:
 *   drafted answer needs your review: Names/orgs not found in your background or the job post
 *   (verify): Los Angeles
 * profiles.parsed_json.school_location is "Los Angeles, CA". The corpus only ever held
 * `education.school`, so a place named in her own profile was reported to her as unverifiable.
 */
describe('the grounding corpus holds every stored fact, so the applicant is not warned about her own', () => {
  const parsedJson = {
    school: 'University of Southern California, Viterbi School of Engineering',
    school_location: 'Los Angeles, CA',
    degree: 'Bachelor of Science in Computer Science',
    major: 'Computer Science & Business Administration, Finance Emphasis',
    grad_year: 2028,
  };

  test('school_location is read out of parsed_json and into the facts', () => {
    const facts = applicantGroundingFacts(parsedJson, { address_city: 'Dubai', address_country: 'United Arab Emirates' });
    assert.equal(facts.school_location, 'Los Angeles, CA');
    assert.equal(facts.residence, 'Dubai, United Arab Emirates');
    assert.equal(facts.grad_year, 2028);
  });

  test('"Los Angeles" is no longer an unverifiable name', () => {
    const facts = applicantGroundingFacts(parsedJson, null);
    const corpus = wordSet(`${groundingFactsText(facts)} Anduril Industries 2027 Software Engineer Intern`);
    assert.deepEqual(
      ungroundedProperNouns(
        'I am fully willing to work in person for the full twelve weeks. I already commute to campus in Los Angeles.',
        corpus,
      ),
      [],
    );
  });

  test('the old corpus is what produced the warning, so this stays a regression and not a coincidence', () => {
    const schoolOnly = wordSet('University of Southern California, Viterbi School of Engineering Anduril Industries');
    assert.deepEqual(
      ungroundedProperNouns('I already commute to campus in Los Angeles.', schoolOnly),
      ['Los Angeles'],
    );
  });

  test('a name that really is nowhere in her material is still flagged', () => {
    const facts = applicantGroundingFacts(parsedJson, null);
    const corpus = wordSet(`${groundingFactsText(facts)} Anduril Industries`);
    assert.deepEqual(
      ungroundedProperNouns('I led delivery at Northwind Logistics.', corpus),
      ['Northwind Logistics'],
    );
  });

  test('nothing derived joins the corpus: an empty profile contributes nothing', () => {
    assert.equal(groundingFactsText(applicantGroundingFacts(undefined, null)).trim(), '');
    assert.equal(applicantGroundingFacts({ school_location: '   ' }, null).school_location, undefined);
  });
});
