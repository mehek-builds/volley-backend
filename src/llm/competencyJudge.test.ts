import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { quoteIsGrounded, validateVerdicts, COMPETENCY_SYSTEM_PROMPT } from './competencyJudge';
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
    assert.equal(byBasis.graduation, 'unmet', 'May 2027 is before the stated window, decided locally');
  });

  test('a judge that fails does not change a term or structured verdict', async () => {
    const r = await scorePosting(jd, facts, undefined, segmentJd as never, async () => ({
      verdicts: [],
      rejected: [{ reason: 'model unavailable' }],
    }));
    const byBasis = Object.fromEntries(r.clauses.map((c) => [c.basis, c.verdict]));
    assert.equal(byBasis.terms, 'met');
    assert.equal(byBasis.graduation, 'unmet');
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
