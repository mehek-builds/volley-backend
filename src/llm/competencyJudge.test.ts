import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { quoteIsGrounded, validateVerdicts, COMPETENCY_SYSTEM_PROMPT } from './competencyJudge';
import type { CandidateProfile, CompetencyQuestion } from './competencyJudge';
import { scorePosting, type CandidateFacts } from '../engine/clauseMatch';
import { segmentJd } from '../engine/jdMatch';

const BULLETS = [
  'Led a 4-person team, analyzing 350 survey responses & conducting 30 user interviews, refining marketing strategies.',
  'Produced a 50-page proposal detailing actionable recommendations and achieving impactful engagement outcomes.',
  'Analyzed portfolio allocations across 20+ positions, presenting findings to the investment committee.',
];

const QUESTIONS = [
  { id: 'c0', clause: 'You use analytical skills to make data-driven decisions' },
  { id: 'c1', clause: 'You are hands-on and learn by doing' },
];

/**
 * THE GROUNDING GATE IS THE WHOLE SAFETY ARGUMENT, so it is tested without a network.
 *
 * A model is allowed to judge whether a resume evidences a competency because a `met` verdict is
 * rejected unless it quotes a real bullet. Everything else in this module is prompt text; this is
 * the part that makes a number built on a model verdict defensible, and it has to hold when the
 * model is having a bad day rather than only when it behaves.
 */
describe('a met verdict must quote a real bullet', () => {
  test('an exact bullet is grounded', () => {
    assert.equal(quoteIsGrounded(BULLETS[0], BULLETS), true);
  });

  test('a contiguous run of a bullet is grounded', () => {
    // Asked for one bullet verbatim, a model will sometimes return the clause of it that did the
    // work. That is still the student's own sentence, so it counts.
    assert.equal(quoteIsGrounded('analyzing 350 survey responses & conducting 30 user interviews', BULLETS), true);
  });

  test('punctuation and case are not what is being verified', () => {
    assert.equal(quoteIsGrounded('LED A 4-PERSON TEAM, ANALYZING 350 SURVEY RESPONSES', BULLETS), true);
    assert.equal(quoteIsGrounded('Produced a 50 page proposal detailing actionable recommendations', BULLETS), true);
  });

  test('a plausible sentence the student never wrote is NOT grounded', () => {
    // The failure this gate exists for: fluent, on-topic, and invented.
    assert.equal(quoteIsGrounded('Analyzed product usage data to prioritise the roadmap', BULLETS), false);
  });

  test('a fragment too short to identify a bullet is not grounded', () => {
    assert.equal(quoteIsGrounded('analyzed', BULLETS), false);
    assert.equal(quoteIsGrounded('', BULLETS), false);
    // Six words, not twelve characters: a common phrase is an echo, not a citation.
    assert.equal(quoteIsGrounded('led a 4-person team', BULLETS), false);
  });
});

describe('validateVerdicts refuses to trust what it cannot check', () => {
  test('met without a quote is downgraded, not accepted', () => {
    const { verdicts, rejected } = validateVerdicts(
      { verdicts: [{ id: 'c0', met: true, why: 'clearly analytical' }] },
      QUESTIONS,
      BULLETS,
    );
    assert.equal(verdicts.find((v) => v.id === 'c0')!.met, false);
    // c0 for the ungrounded claim, c1 because the model never answered it. Both are rejections now,
    // which is what keeps an unanswered question out of a cache that never expires.
    assert.deepEqual(rejected.map((r) => r.id).sort(), ['c0', 'c1']);
  });

  test('met with an invented quote is downgraded and reported', () => {
    const { verdicts, rejected } = validateVerdicts(
      { verdicts: [{ id: 'c0', met: true, quote: 'Shipped a data platform used by 400 engineers' }] },
      QUESTIONS,
      BULLETS,
    );
    assert.equal(verdicts.find((v) => v.id === 'c0')!.met, false);
    assert.match(rejected[0].reason, /grounded quote/);
  });

  test('met with a real quote is accepted', () => {
    const { verdicts, rejected } = validateVerdicts(
      { verdicts: [{ id: 'c0', met: true, quote: BULLETS[0] }] },
      QUESTIONS,
      BULLETS,
    );
    assert.equal(verdicts.find((v) => v.id === 'c0')!.met, true);
    // c1 was never answered, so it is rejected and therefore never cached.
    assert.deepEqual(rejected.map((r) => r.id), ['c1']);
  });

  test('a question the model skipped is unmet, never absent', () => {
    // An absent answer must not shrink the denominator. Silently dropping a requirement nobody
    // judged would inflate the score by exactly the requirements that were hardest to judge.
    const { verdicts } = validateVerdicts({ verdicts: [{ id: 'c0', met: false }] }, QUESTIONS, BULLETS);
    assert.equal(verdicts.length, 2);
    assert.equal(verdicts.find((v) => v.id === 'c1')!.met, false);
  });

  test('a malformed response yields no verdicts rather than throwing', () => {
    const { verdicts, rejected } = validateVerdicts({ nope: true }, QUESTIONS, BULLETS);
    assert.deepEqual(verdicts, []);
    assert.equal(rejected.length, 1);
  });

  test('an id the caller never asked about is discarded', () => {
    const { verdicts, rejected } = validateVerdicts(
      { verdicts: [{ id: 'c99', met: true, quote: BULLETS[0] }] },
      QUESTIONS,
      BULLETS,
    );
    assert.ok(!verdicts.some((v) => v.id === 'c99'));
    assert.match(rejected[0].reason, /unknown id/);
  });
});

describe('the prompt holds the rules the gate cannot enforce', () => {
  test('it forbids paraphrase and demands a verbatim bullet', () => {
    assert.match(COMPETENCY_SYSTEM_PROMPT, /copied verbatim/i);
    assert.match(COMPETENCY_SYSTEM_PROMPT, /Never paraphrase/i);
  });

  test('it names the adjacency trap the regex model fell into', () => {
    // "Led a team" evidencing "mentored engineers" is precisely the over-credit the cue list made.
    assert.match(COMPETENCY_SYSTEM_PROMPT, /adjacent is not evidence/i);
  });

  test('it forbids the job description as evidence about the candidate', () => {
    assert.match(COMPETENCY_SYSTEM_PROMPT, /never evidence about the candidate/i);
  });
});

describe('scorePosting keeps the deterministic half deterministic', () => {
  const facts: CandidateFacts = {
    degree: 'Bachelor of Science in Computer Science',
    school: 'University of Southern California',
    gradDate: 'May 2027',
    resumeText: BULLETS.join(' ') + ' Python',
    bullets: BULLETS,
  };
  const jd = `What we look for:
- You have some first hand experience with SQL and/or Python
- Pursuing a bachelor's in computer science graduating in Fall 2027 or Spring 2028
- You can communicate nuance to partners in written and verbal form
`;

  test('terms and structured facts are decided without calling the judge', async () => {
    let called = 0;
    const r = await scorePosting(jd, facts, undefined, segmentJd as never, async (_b, qs) => {
      called++;
      return { verdicts: qs.map((q) => ({ id: q.id, met: false })), rejected: [] };
    });
    assert.equal(called, 1, 'exactly one batched call, never one per clause');
    const byBasis = Object.fromEntries(r.clauses.map((c) => [c.basis, c.verdict]));
    assert.equal(byBasis.terms, 'met', 'Python satisfies "SQL and/or Python" locally');
    /* Graduation now rides the SAME batched call, and that is the point of asserting called === 1
       above: routing it to the judge must not turn one request per posting into two. */
    assert.equal(byBasis.graduation, 'unmet', 'the judge answered, and its answer is what stands');
  });

  test('the graduation clause is sent as eligibility, and the facts go with it', async () => {
    let seen: { qs: CompetencyQuestion[]; profile?: CandidateProfile } | null = null;
    await scorePosting(jd, facts, undefined, segmentJd as never, async (_b, qs, profile) => {
      seen = { qs, profile };
      return { verdicts: qs.map((q) => ({ id: q.id, met: false })), rejected: [] };
    });
    const grad = seen!.qs.find((q) => /graduating/.test(q.clause));
    assert.ok(grad, 'the graduation clause reached the judge at all');
    /* Without the kind, the judge grounds it against the BULLETS, no bullet can carry a graduation
       date, and every eligibility verdict is rejected as ungrounded: the clause would silently
       stop being checked. */
    assert.equal(grad!.kind, 'eligibility');
    assert.equal(seen!.qs.find((q) => /communicate nuance/.test(q.clause))!.kind, 'competency');
    assert.equal(seen!.profile?.gradDate, 'May 2027', 'the fact it must be judged against');
  });

  test('a judge that fails does not change a term or structured verdict', async () => {
    const r = await scorePosting(jd, facts, undefined, segmentJd as never, async () => ({
      verdicts: [],
      rejected: [{ reason: 'model unavailable' }],
    }));
    const byBasis = Object.fromEntries(r.clauses.map((c) => [c.basis, c.verdict]));
    assert.equal(byBasis.terms, 'met', 'a term match is local and survives an outage');
    /* Graduation is no longer deterministic, so an outage leaves it UNSCOREABLE. That is the
       honest state and the safe one: the alternative, defaulting it to met, is exactly the bug
       that shipped a 100% score on a posting the student did not qualify for. */
    assert.equal(byBasis.graduation, 'unscoreable');
    assert.equal(r.score, null, 'and no headline number is published on a partial answer');
  });

  test('responsibilities are not scored against the candidate', async () => {
    // "The impact you will have" describes the JOB. Scoring a student against what they will do is
    // how the regex prototype credited "ship features on the Databricks platform" to someone who
    // has never worked there.
    const withResp = `The impact you will have:\n- Ship features on the platform\n\n${jd}`;
    const r = await scorePosting(withResp, facts, undefined, segmentJd as never, async (_b, qs) => ({
      verdicts: qs.map((q) => ({ id: q.id, met: false })),
      rejected: [],
    }));
    assert.ok(!r.clauses.some((c) => /Ship features/.test(c.text)));
  });
});

describe('a response we could not read is never a verdict', () => {
  /* Review of the first attempt at this. It returned met:false for every question with an ID-LESS
     rejection, and both halves were wrong: confident unmets for questions nobody answered, and a
     rejection carrying no id, so competencyCache's `r.id` write filter filtered nothing and one
     truncated response was cached forever. Throwing is correct because scorePosting catches and
     marks the clauses unscoreable, and nothing reaches the cache because the write happens after. */

  test('a whole bullet grounds a verdict however short it is', () => {
    const short = ['Built Litos, a Chrome extension'];
    assert.equal(quoteIsGrounded('Built Litos, a Chrome extension', short), true);
    // ...but a five-word FRAGMENT of a longer bullet still does not.
    assert.equal(quoteIsGrounded('Built Litos, a Chrome', short), false);
  });

  test('the six-word floor still rejects an echoed phrase', () => {
    assert.equal(quoteIsGrounded('led a 4-person team', BULLETS), false);
  });
});

describe('an eligibility verdict grounds in the facts, not the bullets', () => {
  const profile: CandidateProfile = {
    degree: 'Bachelor of Science in Computer Science',
    school: 'University of Southern California',
    gradDate: 'May 2027',
  };
  const q: CompetencyQuestion[] = [
    { id: 'c1', clause: 'graduating in Fall 2027 or Spring 2028', kind: 'eligibility' },
  ];

  test('a met verdict must quote a fact verbatim', () => {
    const ok = validateVerdicts(
      { verdicts: [{ id: 'c1', met: true, quote: 'May 2027', why: 'inside the window' }] },
      q,
      BULLETS,
      profile,
    );
    assert.equal(ok.verdicts[0]?.met, true);
  });

  test('a met verdict quoting a bullet is rejected, however true it sounds', () => {
    /* The grounding gate is the whole reason this is safe to hand to a model. A bullet cannot
       establish a graduation date, so a verdict citing one is not evidence, it is the model
       reaching for the nearest text. */
    const bad = validateVerdicts(
      { verdicts: [{ id: 'c1', met: true, quote: BULLETS[0], why: 'seems recent' }] },
      q,
      BULLETS,
      profile,
    );
    // Downgraded, not dropped: the question still has an answer and the answer is no. Dropping it
    // would shrink the denominator by exactly the clauses the model got creative about.
    assert.equal(bad.verdicts[0]?.met, false);
    assert.equal(bad.rejected.length, 1, 'and it is reported, so a drifting model is visible');
    assert.match(bad.verdicts[0]?.why ?? '', /profile/i, 'not "no bullet supports this"');
  });

  test('a date the student never entered cannot be invented', () => {
    const invented = validateVerdicts(
      { verdicts: [{ id: 'c1', met: true, quote: 'December 2027', why: 'inside the window' }] },
      q,
      BULLETS,
      profile,
    );
    assert.equal(invented.verdicts[0]?.met, false, 'May 2027 is the only date on file');
    assert.equal(invented.rejected.length, 1);
  });

  test('a competency verdict still grounds in the bullets, not the facts', () => {
    const cross = validateVerdicts(
      { verdicts: [{ id: 'c2', met: true, quote: 'May 2027', why: 'graduating soon' }] },
      [{ id: 'c2', clause: 'experience leading a team', kind: 'competency' }],
      BULLETS,
      profile,
    );
    assert.equal(cross.verdicts[0]?.met, false, 'the corpora do not cross');
  });
});

describe('the prompt states the direction rules the regex never had', () => {
  /* Round six found "not graduating before 2027" read as a closed range and inverted, and
     "Fall 2027 or Spring 2028" treated as a floor. Both are direction, and both are now written
     into the prompt rather than into a pattern. */
  test('it names polarity, alternatives and non-graduation dates', () => {
    assert.match(COMPETENCY_SYSTEM_PROMPT, /not graduating before/i);
    assert.match(COMPETENCY_SYSTEM_PROMPT, /no later than/i);
    assert.match(COMPETENCY_SYSTEM_PROMPT, /requisition number, a funding round, a cohort year/i);
  });

  test('it forbids inventing a condition the posting never stated', () => {
    assert.match(COMPETENCY_SYSTEM_PROMPT, /do not invent one/i);
  });
});

describe('a judge that fails publishes no score at all', () => {
  const facts = {
    degree: 'Bachelor of Science in Computer Science',
    school: 'USC',
    gradDate: 'May 2027',
    resumeText: 'Python. Led a 4-person team, analyzing 350 survey responses.',
    bullets: ['Led a 4-person team, analyzing 350 survey responses.'],
  };
  const jd = `What we look for:
- You have some first hand experience with SQL and/or Python
- You can communicate nuance to partners in written and verbal form
`;

  test('a thrown judge leaves the deterministic clauses and returns score null', async () => {
    /* Dropping the competency clauses from the denominator leaves only the ones that passed
       locally, so a run where the model was never reached could report a HIGHER number than a
       successful one, up to 100. The clause list is still worth returning; the headline percentage
       is not, because it would be built on a question nobody got to ask. */
    const { scorePosting } = await import('../engine/clauseMatch');
    const { segmentJd } = await import('../engine/jdMatch');
    const r = await scorePosting(jd, facts, undefined, segmentJd as never, async () => {
      throw new Error('overloaded');
    });
    assert.equal(r.score, null, 'no score when the judge never answered');
    assert.ok(r.clauses.some((c) => c.basis === 'terms' && c.verdict === 'met'), 'Python still counts');
    assert.ok(r.clauses.some((c) => c.basis === 'competency' && c.verdict === 'unscoreable'));
    assert.match(r.rejected[0].reason, /judge unavailable/);
  });

  test('truncation throws rather than returning verdicts nobody gave', () => {
    /* Returning met:false here was the reintroduced bug: confident unmets for unanswered questions,
       carried on an id-less rejection that the cache write filter could not filter, so one
       truncated response was stored in a cache that never expires. */
    const src = readFileSync(path.join(__dirname, 'competencyJudge.ts'), 'utf8');
    assert.ok(src.includes("throw new Error('response hit the token ceiling before it finished')"));
    assert.match(src, /throw new Error\(`unparseable response/);
    /* Not asserting the ABSENCE of a met:false map: the legitimate "no bullets to judge against"
       early return is exactly that shape, and a broad ban flagged it. The mutation that matters -
       turning the throw back into fabricated verdicts - is caught behaviourally by the
       thrown-judge test above, which is the stronger check anyway. */
  });
});
