import { test, describe } from 'node:test';
import assert from 'node:assert';
import { rankByFit, RANKING_POOL, SCORING_CHARS, type RankableJob } from './jobMonitor';

/* A posting with enough real requirements for jdMatch to agree to score it. The requirements block
   is what carries the signal, so the terms that matter live there rather than in the intro. */
function posting(requirements: string): string {
  return [
    'About the role',
    'We are a small team shipping quickly.',
    '',
    'Requirements',
    requirements,
    '',
    'Benefits',
    'Unlimited vacation, great coffee, a passionate team.',
  ].join('\n');
}

const FRONTEND = posting(
  '- Strong TypeScript and React experience\n- Familiarity with Next.js and Tailwind CSS\n- Comfort with PostgreSQL and REST APIs\n- Experience with CI/CD and Git',
);
/* Scorable, and a genuine mismatch for the resume below: a different stack, not a different
   industry. A non-software posting would not work here, because the scorer's lexicon is software
   vocabulary and it correctly refuses to score what it cannot read. */
const INFRA = posting(
  '- Deep Kubernetes and Terraform experience\n- Production Go and gRPC services\n- Kafka and Cassandra at scale\n- Familiarity with Prometheus and Grafana',
);

const RESUME = [
  'Frontend engineer.',
  'Built a dashboard in TypeScript and React on Next.js with Tailwind CSS.',
  'Designed the PostgreSQL schema and the REST API behind it.',
  'Owned the CI/CD pipeline and the Git workflow for a team of six.',
].join('\n');

function job(over: Partial<RankableJob> & { scored_description: string | null }): RankableJob & { id: string } {
  return {
    id: over.title ?? 'job',
    company_name: over.company_name ?? 'Acme',
    title: over.title ?? 'Engineer',
    scored_description: over.scored_description,
  };
}

describe('rankByFit', () => {
  test('puts the posting the resume actually matches above the one it does not', () => {
    const ranked = rankByFit(
      [job({ title: 'infra', scored_description: INFRA }), job({ title: 'frontend', scored_description: FRONTEND })],
      RESUME,
    );
    assert.strictEqual(ranked[0]!.row.title, 'frontend');
    assert.strictEqual(ranked[1]!.row.title, 'infra');
    assert.ok(ranked[0]!.score! > ranked[1]!.score!, 'the matching posting must score higher, not merely sort higher');
  });

  test('an unscorable posting gets null and sorts below every scored one', () => {
    const ranked = rankByFit(
      [
        job({ title: 'vague', scored_description: 'Join Acme. We are hiring. Apply today.' }),
        job({ title: 'infra', scored_description: INFRA }),
      ],
      RESUME,
    );
    assert.strictEqual(ranked[0]!.row.title, 'infra');
    assert.strictEqual(ranked[1]!.row.title, 'vague');
    // The point of the whole exercise: a posting we declined to judge is null, never a confident 0
    // that reads as "your resume matches none of this".
    assert.strictEqual(ranked[1]!.score, null);
  });

  test('an empty description is unscorable rather than a zero', () => {
    const ranked = rankByFit([job({ title: 'empty', scored_description: null })], RESUME);
    assert.strictEqual(ranked[0]!.score, null);
  });

  test('equal scores keep the order they came in, which is newest first', () => {
    const ranked = rankByFit(
      [
        job({ company_name: 'Newer', title: 'a', scored_description: FRONTEND }),
        job({ company_name: 'Older', title: 'b', scored_description: FRONTEND }),
      ],
      RESUME,
    );
    assert.deepStrictEqual(ranked.map((r) => r.row.company_name), ['Newer', 'Older']);
    assert.strictEqual(ranked[0]!.score, ranked[1]!.score);
  });

  test('several unscorable postings keep their incoming order among themselves', () => {
    const ranked = rankByFit(
      [
        job({ title: 'first', scored_description: 'Hiring now.' }),
        job({ title: 'second', scored_description: 'Apply here.' }),
        job({ title: 'frontend', scored_description: FRONTEND }),
      ],
      RESUME,
    );
    assert.deepStrictEqual(ranked.map((r) => r.row.title), ['frontend', 'first', 'second']);
  });

  test('the posting does not get credit for naming its own company and role', () => {
    // "Kubernetes" appears only as the company name and the job title here. If those leaked into
    // the requirement set, a resume that never mentions them would be marked down for it.
    const named = rankByFit(
      [job({ company_name: 'Kubernetes Inc', title: 'Kubernetes Engineer', scored_description: FRONTEND })],
      RESUME,
    );
    const plain = rankByFit([job({ company_name: 'Acme', title: 'Engineer', scored_description: FRONTEND })], RESUME);
    assert.strictEqual(named[0]!.score, plain[0]!.score);
  });

  test('an empty list ranks to an empty list', () => {
    assert.deepStrictEqual(rankByFit([], RESUME), []);
  });
});

/* The pool size is a latency budget, not a taste call: ranking runs synchronously on the event
   loop, so every millisecond here is a millisecond Fastify serves nobody else. The RANKING_POOL
   comment states a measured cost, and a comment is not enforcement — this is.
   The ceiling is deliberately loose. It is a guard against an order-of-magnitude regression (a
   quadratic added to the scorer, the SCORING_CHARS cap removed), not a benchmark, so it should not
   go red because a laptop was busy. */
describe('the ranking budget the comment claims', () => {
  test(`ranking a full pool of ${RANKING_POOL} stays inside its budget`, () => {
    const requirements = Array.from(
      { length: 30 },
      (_, i) => `- TypeScript, React, Node.js, PostgreSQL, Kubernetes, Terraform, Kafka, item ${i}`,
    ).join('\n');
    const jd = posting(requirements);
    const resume = Array.from(
      { length: 34 },
      (_, i) => `Built a dashboard in TypeScript and React with PostgreSQL and CI/CD, line ${i}.`,
    ).join('\n');
    const pool = Array.from({ length: RANKING_POOL }, (_, i) =>
      job({ company_name: `Company ${i}`, title: 'Engineer', scored_description: jd }),
    );

    rankByFit(pool.slice(0, 10), resume); // warm the JIT, as a real process would be
    const started = process.hrtime.bigint();
    rankByFit(pool, resume);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    assert.ok(
      ms < 600,
      `ranking ${RANKING_POOL} postings took ${ms.toFixed(0)} ms of SYNCHRONOUS event-loop time; ` +
        'the route serves no other request while this runs, so both RANKING_POOL and the decision ' +
        'to score inline need revisiting',
    );
  });

  test('the scoring cap is large enough to reach a requirements section', () => {
    // The whole reason the route scores the full column instead of the 600-char preview is that
    // requirements are never in the intro. The cap must not undo that.
    assert.ok(SCORING_CHARS > 600, 'a cap at or below the preview length would defeat its purpose');
    // Six terms clears MIN_SCORABLE_TERMS; five does not, and the scorer is right to refuse there.
    const buried = posting(
      '- TypeScript and React and PostgreSQL\n- Kubernetes, Terraform, Kafka, Go and gRPC',
    );
    assert.ok(buried.length < SCORING_CHARS, 'a realistic posting fits inside the cap');
    assert.notStrictEqual(rankByFit([job({ scored_description: buried })], RESUME)[0]!.score, null);
  });
});
