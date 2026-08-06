import { test, describe } from 'node:test';
import assert from 'node:assert';
import { pickDiversePool, PER_COMPANY_CAP, rankByFit, RANKING_POOL, SCORING_CHARS, type RankableJob, scatterRanked } from './jobMonitor';
import { normalizeTargeting } from '../lib/jobPreferences';

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

  test('resume similarity outranks account role preferences when a match score exists', () => {
    const ranked = rankByFit(
      [
        job({ title: 'Frontend Engineer', scored_description: FRONTEND }),
        job({ title: 'Product Manager', scored_description: INFRA }),
      ],
      RESUME,
      normalizeTargeting({ categories: ['product'], titles: ['Product Manager'], role_types: ['full-time'] }),
    );
    assert.strictEqual(ranked[0]!.row.title, 'Frontend Engineer');
    assert.ok(ranked[0]!.score! > ranked[1]!.score!);
  });

  test('account role preferences break ties between equal resume scores', () => {
    const ranked = rankByFit(
      [
        job({ title: 'Frontend Engineer', scored_description: FRONTEND }),
        job({ title: 'Product Manager', scored_description: FRONTEND }),
      ],
      RESUME,
      normalizeTargeting({ categories: ['product'], titles: ['Product Manager'], role_types: ['full-time'] }),
    );
    assert.strictEqual(ranked[0]!.score, ranked[1]!.score);
    assert.strictEqual(ranked[0]!.row.title, 'Product Manager');
  });

  test('account role preferences still order rows when there is no resume score', () => {
    const ranked = rankByFit(
      [
        job({ title: 'Frontend Engineer', scored_description: FRONTEND }),
        job({ title: 'Product Manager', scored_description: INFRA }),
      ],
      '',
      normalizeTargeting({ categories: ['product'], titles: ['Product Manager'], role_types: ['full-time'] }),
    );
    assert.strictEqual(ranked[0]!.row.title, 'Product Manager');
    assert.strictEqual(ranked[0]!.score, null);
  });
});

/* The pool size is a latency budget, not a taste call: ranking runs synchronously on the event
   loop, so every millisecond here is a millisecond Fastify serves nobody else. The RANKING_POOL
   comment states a measured cost, and a comment is not enforcement, this is.

   THIS USED TO BE A STOPWATCH, AND THE STOPWATCH DID NOT WORK. It asserted one run of
   RANKING_POOL finished under 600 ms. Measured 2026-07-29: 8 consecutive runs gave two failures,
   at 864 ms and 673 ms, and the fastest of five back-to-back runs was still 651 ms. So the ceiling
   was not noisy, it was wrong for this hardware, and an absolute millisecond count is not portable
   across a laptop, a CI runner and whatever runs it next. A test that fails one time in four is
   worse than no test, because a suite that fails at random stops being read.

   A RATIO WAS TRIED NEXT AND ALSO FAILED, which is worth recording so nobody tries it a third
   time. Comparing cost at one pool size against a bigger one is machine-independent in principle.
   In practice, on healthy code, the 4x ratio measured min 3.15, median 5.48, max 6.90 across 8
   runs, because bigger pools carry real allocation and GC cost on top of the scoring. Then a
   deliberately injected quadratic measured 8.32. Healthy-but-noisy and genuinely-quadratic overlap,
   so there is no threshold that catches the second without firing on the first.

   SO IT COUNTS WORK INSTEAD OF TIMING IT, and is now fully deterministic. Every row is handed to
   rankByFit behind a Proxy that counts property reads. Linear code reads a fixed handful of
   properties per row, so the total scales with the pool. A nested pass over rows, which is exactly
   the regression this exists to catch, multiplies that by the pool size. No clock, no threshold
   tuning, no flake: the same code gives the same count on any machine, busy or idle.

   WHAT IT DOES NOT CATCH, stated so the guarantee is not overread: it sees work that TOUCHES THE
   ROWS. A quadratic built some other way, say accumulating an n-by-n array of scores without
   reading a row again, would not move this count. That is a narrower promise than a stopwatch
   appeared to make, and it is still the better trade, because the stopwatch's broader promise was
   not kept: it let the injected quadratic through at x8.32 while failing one healthy run in four.

   IT NO LONGER CLAIMS TO GUARD THE CAP. The old comment said this budget also caught "the
   SCORING_CHARS cap removed". It never could. The cap is applied by the QUERY, not by rankByFit:
   jobMonitor.ts builds scored_description as `left(description, SCORING_CHARS)`, so rankByFit only
   ever sees text that is already truncated. A test here that feeds it longer strings measures a
   code path production never takes. Guarding that cap needs a test against the query, and that is
   not this file's job. */

const RANKING_REQUIREMENTS = Array.from(
  { length: 30 },
  (_, i) => `- TypeScript, React, Node.js, PostgreSQL, Kubernetes, Terraform, Kafka, item ${i}`,
).join('\n');
const RANKING_RESUME = Array.from(
  { length: 34 },
  (_, i) => `Built a dashboard in TypeScript and React with PostgreSQL and CI/CD, line ${i}.`,
).join('\n');

/** The pool, with every row wrapped so its property reads can be counted. */
function countingPool(size: number, description: string) {
  let reads = 0;
  const rows = Array.from({ length: size }, (_, i) => {
    const row = job({ company_name: `Company ${i}`, title: 'Engineer', scored_description: description });
    return new Proxy(row, {
      get(target, key, receiver) {
        reads++;
        return Reflect.get(target, key, receiver);
      },
    });
  });
  return { rows, reads: () => reads };
}

describe('the ranking budget the comment claims', () => {
  test('ranking touches each posting a fixed number of times, so cost stays linear in the pool', () => {
    const jd = posting(RANKING_REQUIREMENTS);
    const { rows, reads } = countingPool(RANKING_POOL, jd);

    rankByFit(rows, RANKING_RESUME);

    const perRow = reads() / RANKING_POOL;
    console.log(`      ${reads()} property reads across ${RANKING_POOL} postings (${perRow.toFixed(1)} per posting)`);

    /* Linear code reads a small fixed set per row: the description to score, and the company and
       title excluded from the requirement set. A nested pass over rows would make this scale with
       RANKING_POOL instead, so the gap between passing and failing is a factor of a hundred, not a
       few percent. The bound is generous on purpose; it is the shape that matters, not the exact
       count, and it must not go red because someone legitimately reads one more field. */
    assert.ok(
      perRow <= 10,
      `rankByFit read ${reads()} properties across ${RANKING_POOL} postings, ${perRow.toFixed(1)} ` +
        'per posting. Linear code reads a fixed handful per row, so a number that scales with the ' +
        'pool means something now walks the rows for every row. Ranking is synchronous, so the ' +
        'route serves no other request while it runs.',
    );
  });

  test('the per-posting work does not grow when the pool does', () => {
    const jd = posting(RANKING_REQUIREMENTS);
    const small = countingPool(RANKING_POOL, jd);
    const large = countingPool(RANKING_POOL * 4, jd);

    rankByFit(small.rows, RANKING_RESUME);
    rankByFit(large.rows, RANKING_RESUME);

    const smallPerRow = small.reads() / RANKING_POOL;
    const largePerRow = large.reads() / (RANKING_POOL * 4);

    /* The sharpest statement of linearity available without a clock: quadrupling the pool must not
       change what each posting costs. Under a nested pass this goes from 3 to 303 and then 1203.

       A tolerance rather than strict equality, even though both sides are whole numbers today.
       These are counts divided by pool sizes, so the moment any field is read conditionally for
       some rows and not others the two averages stop being exactly equal, and this would fail on a
       change that is perfectly linear. Half a read per posting is far below the signal it exists
       to catch and far above that kind of drift. */
    assert.ok(
      Math.abs(largePerRow - smallPerRow) < 0.5,
      `each posting cost ${smallPerRow.toFixed(1)} property reads in a pool of ${RANKING_POOL} but ` +
        `${largePerRow.toFixed(1)} in a pool of ${RANKING_POOL * 4}. Per-posting work must not ` +
        'depend on how many other postings there are.',
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

  /* The fixture above is a few hundred characters, so it kept passing at every value SCORING_CHARS
     has ever held and proved nothing about the cap. When the cap was cut from 20k to 6k for the
     Neon transfer bill, that made it the wrong test to be relying on. This one uses a preamble long
     enough that the cut would actually show. */
  test('requirements still survive the cap behind a long employer preamble', () => {
    const preamble = 'We are a mission-driven team building the future of work. '.repeat(60);
    assert.ok(preamble.length > 3_000, `preamble was only ${preamble.length} chars, too short to test`);

    const late = [
      'About us',
      preamble,
      'Requirements',
      '- TypeScript and React and PostgreSQL',
      '- Kubernetes, Terraform, Kafka, Go and gRPC',
    ].join('\n');

    /* The route applies the cap in SQL, so the scorer only ever sees the prefix. Slicing here is
       what the query does, and is the only way this test can observe the cap at all. */
    const capped = late.slice(0, SCORING_CHARS);
    assert.ok(capped.includes('Kubernetes'), 'the cap must not cut off the requirements section');
    assert.notStrictEqual(rankByFit([job({ scored_description: capped })], RESUME)[0]!.score, null);
  });
});

/* RANKING_POOL and PER_COMPANY_CAP are two halves of one decision and nothing tied them together.
   The pool was halved to 150 on 2026-08-04 to cut bytes off Neon; had PER_COMPANY_CAP been left at
   6, employer spread would have silently dropped from ~50 companies to ~25, which is most of the
   way back to the all-Datadog board pickDiversePool exists to prevent. No existing test failed on
   that, so this one does. */
describe('the pool and the per-company cap stay in proportion', () => {
  test('the cap still admits roughly fifty employers', () => {
    const employers = RANKING_POOL / PER_COMPANY_CAP;
    assert.ok(
      employers >= 40 && employers <= 60,
      `a pool of ${RANKING_POOL} at ${PER_COMPANY_CAP} per employer spreads across ` +
        `${employers} companies. The invariant is ~50; change both constants together.`,
    );
  });
});

/* Measured against production 2026-07-28: the newest 300 postings were 166 Datadog rows and 35
   companies out of 53 sources, so "Top matches for you" was ten Datadog jobs. The ranking was
   correct and the feature was useless. These pin the fix. */
describe('pickDiversePool', () => {
  const rows = (spec: Array<[string, number]>) =>
    spec.flatMap(([company, n]) =>
      Array.from({ length: n }, (_, i) => ({ id: `${company}-${i}`, company_name: company })),
    );

  test('one loud employer cannot crowd out the board', () => {
    // 200 from one company followed by 1 each from 40 others: the shape production actually had.
    const candidates = [
      ...rows([['Datadog', 200]]),
      ...rows(Array.from({ length: 40 }, (_, i) => [`Company${i}`, 1] as [string, number])),
    ];
    const pool = pickDiversePool(candidates, 6, 40);
    const datadog = pool.filter((r) => r.company_name === 'Datadog').length;
    assert.strictEqual(datadog, 6, 'the cap binds');
    assert.ok(
      new Set(pool.map((r) => r.company_name)).size >= 35,
      `expected a wide spread, got ${new Set(pool.map((r) => r.company_name)).size} companies`,
    );
  });

  test('the incoming priority order is preserved within the cap', () => {
    const candidates = rows([['A', 3], ['B', 3]]);
    const pool = pickDiversePool(candidates, 2, 10);
    // A's first two, then B's first two, in the order they arrived; then the backfill.
    assert.deepStrictEqual(pool.slice(0, 4).map((r) => r.id), ['A-0', 'A-1', 'B-0', 'B-1']);
  });

  test('a thin board still fills the pool rather than withholding rows', () => {
    // Two employers and a cap of 2 would leave 4 rows; the backfill must return the rest.
    const candidates = rows([['A', 10], ['B', 10]]);
    const pool = pickDiversePool(candidates, 2, 12);
    assert.strictEqual(pool.length, 13, 'poolSize + 1, so the caller can still detect overflow');
  });

  test('a search for one company still returns that company', () => {
    // The cap exists to stop an employer dominating a BROWSE, never to answer a direct search with
    // six results and a shrug.
    const pool = pickDiversePool(rows([['Datadog', 50]]), 6, 20);
    assert.strictEqual(pool.length, 21);
    assert.ok(pool.every((r) => r.company_name === 'Datadog'));
  });

  test('company matching ignores case and padding', () => {
    const pool = pickDiversePool(
      [
        { id: '1', company_name: 'Acme' },
        { id: '2', company_name: ' acme ' },
        { id: '3', company_name: 'ACME' },
        { id: '4', company_name: 'Other' },
      ],
      2,
      10,
    );
    assert.deepStrictEqual(pool.map((r) => r.id), ['1', '2', '4', '3'], 'the third Acme is backfilled last');
  });

  test('it returns one more than asked for, so overflow is still detectable', () => {
    assert.strictEqual(pickDiversePool(rows([['A', 100]]), 6, 10).length, 11);
  });

  test('an empty board pools to nothing', () => {
    assert.deepStrictEqual(pickDiversePool([], 6, 10), []);
  });
});

describe('scatterRanked', () => {
  const rows = (spec: string) =>
    spec.split('').map((c, i) => ({ company_name: c, id: `${c}${i}` }));
  const worstPerPage = (out: { company_name: string }[], pageSize: number) => {
    let worst = 0;
    for (let start = 0; start < out.length; start += pageSize) {
      const counts = new Map<string, number>();
      for (const r of out.slice(start, start + pageSize)) {
        counts.set(r.company_name, (counts.get(r.company_name) ?? 0) + 1);
      }
      worst = Math.max(worst, ...counts.values());
    }
    return worst;
  };

  test('holds the cap on a list that is one employer at the top', () => {
    /* The real shape this exists for: production had 166 Datadog rows in a 300-row pool, so
       "Top matches for you" was nine Datadog jobs on the first screen.
       The tail deliberately contains no 'D': an earlier version of this test used A-X as the
       "other" employers, which silently included D and made the test fail on its own fixture. */
    const input = rows('D'.repeat(30) + 'ABCEFGHIJKLMNOPQRSTUVWXYZ');
    const out = scatterRanked(input, 3, 8);
    assert.equal(out.length, input.length, 'no row may be dropped');
    /* Only while there is something else to show. Once the other employers are exhausted the cap
       gives way on purpose, and the last test in this block is the one that pins that down. */
    const early = out.slice(0, 32);
    assert.ok(
      worstPerPage(early, 8) <= 3,
      `a page held ${worstPerPage(early, 8)} of one employer while others were available`,
    );
  });

  test('keeps fit order wherever the cap allows it', () => {
    /* Deferring is a last resort, not a reshuffle: a list that already obeys the cap must come
       back untouched, or the dashboard stops being ranked by fit at all. */
    const input = rows('ABCDEFGH');
    assert.deepEqual(scatterRanked(input, 3, 8), input);
  });

  test('fills the page rather than leaving it short when only one employer is left', () => {
    /* A short page is a worse lie than a repeated employer: it reads as "that is all there is". */
    const input = rows('DDDDD');
    const out = scatterRanked(input, 3, 8);
    assert.equal(out.length, 5);
  });

  test('is stable for equal companies, so two runs of one ranking agree', () => {
    const input = rows('DDDABCDDD');
    assert.deepEqual(
      scatterRanked(input, 2, 4).map((r) => r.id),
      scatterRanked(input, 2, 4).map((r) => r.id),
    );
  });

  test('treats employer names case-insensitively', () => {
    const input = [
      { company_name: 'Datadog', id: '1' },
      { company_name: 'datadog', id: '2' },
      { company_name: 'DATADOG', id: '3' },
      { company_name: 'Stripe', id: '4' },
    ];
    const out = scatterRanked(input, 2, 3);
    const firstPage = out.slice(0, 3).filter((r) => r.company_name.toLowerCase() === 'datadog');
    assert.ok(firstPage.length <= 2, 'case variants must count as one employer');
  });
});
