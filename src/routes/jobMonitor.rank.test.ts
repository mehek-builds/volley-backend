import { test, describe } from 'node:test';
import assert from 'node:assert';
import { rankByFit, type RankableJob } from './jobMonitor';

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

function job(over: Partial<RankableJob> & { full_description: string | null }): RankableJob & { id: string } {
  return {
    id: over.title ?? 'job',
    company_name: over.company_name ?? 'Acme',
    title: over.title ?? 'Engineer',
    full_description: over.full_description,
  };
}

describe('rankByFit', () => {
  test('puts the posting the resume actually matches above the one it does not', () => {
    const ranked = rankByFit(
      [job({ title: 'infra', full_description: INFRA }), job({ title: 'frontend', full_description: FRONTEND })],
      RESUME,
    );
    assert.strictEqual(ranked[0]!.row.title, 'frontend');
    assert.strictEqual(ranked[1]!.row.title, 'infra');
    assert.ok(ranked[0]!.score! > ranked[1]!.score!, 'the matching posting must score higher, not merely sort higher');
  });

  test('an unscorable posting gets null and sorts below every scored one', () => {
    const ranked = rankByFit(
      [
        job({ title: 'vague', full_description: 'Join Acme. We are hiring. Apply today.' }),
        job({ title: 'infra', full_description: INFRA }),
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
    const ranked = rankByFit([job({ title: 'empty', full_description: null })], RESUME);
    assert.strictEqual(ranked[0]!.score, null);
  });

  test('equal scores keep the order they came in, which is newest first', () => {
    const ranked = rankByFit(
      [
        job({ company_name: 'Newer', title: 'a', full_description: FRONTEND }),
        job({ company_name: 'Older', title: 'b', full_description: FRONTEND }),
      ],
      RESUME,
    );
    assert.deepStrictEqual(ranked.map((r) => r.row.company_name), ['Newer', 'Older']);
    assert.strictEqual(ranked[0]!.score, ranked[1]!.score);
  });

  test('several unscorable postings keep their incoming order among themselves', () => {
    const ranked = rankByFit(
      [
        job({ title: 'first', full_description: 'Hiring now.' }),
        job({ title: 'second', full_description: 'Apply here.' }),
        job({ title: 'frontend', full_description: FRONTEND }),
      ],
      RESUME,
    );
    assert.deepStrictEqual(ranked.map((r) => r.row.title), ['frontend', 'first', 'second']);
  });

  test('the posting does not get credit for naming its own company and role', () => {
    // "Kubernetes" appears only as the company name and the job title here. If those leaked into
    // the requirement set, a resume that never mentions them would be marked down for it.
    const named = rankByFit(
      [job({ company_name: 'Kubernetes Inc', title: 'Kubernetes Engineer', full_description: FRONTEND })],
      RESUME,
    );
    const plain = rankByFit([job({ company_name: 'Acme', title: 'Engineer', full_description: FRONTEND })], RESUME);
    assert.strictEqual(named[0]!.score, plain[0]!.score);
  });

  test('an empty list ranks to an empty list', () => {
    assert.deepStrictEqual(rankByFit([], RESUME), []);
  });
});
