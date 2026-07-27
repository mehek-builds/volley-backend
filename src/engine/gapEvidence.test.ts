import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { findGapEvidence } from './gapEvidence';
import type { JdTerm } from './jdMatch';
import type { ExperienceBankEntry } from '../db/schema';

const term = (t: string): JdTerm => ({ term: t, display: t, weight: 1, kind: 'required' });

function entry(over: Partial<ExperienceBankEntry> = {}): ExperienceBankEntry {
  return {
    id: 'e1',
    user_id: 'u1',
    type: 'job',
    org: 'Traeco',
    title: 'Software Engineering Intern',
    date_range: 'Jun 2025 - Aug 2025',
    bullet_variants: [],
    tags: null,
    created_at: new Date(),
    ...over,
  } as ExperienceBankEntry;
}

describe('findGapEvidence', () => {
  test('surfaces the student\'s own wording for a term the resume omitted', () => {
    const bank = [
      entry({
        bullet_variants: [
          'Built a React dashboard for the ops team',
          'Deployed six services on Kubernetes, cutting release time 35%',
        ],
      }),
    ];
    const [answer] = findGapEvidence([term('kubernetes')], bank, 'Built a React dashboard');
    assert.equal(answer.unsupported, false);
    assert.equal(answer.evidence.length, 1);
    assert.match(answer.evidence[0].variant, /Kubernetes/);
    assert.equal(answer.evidence[0].org, 'Traeco');
  });

  test('NEVER invents: no evidence means unsupported, with nothing offered', () => {
    // The whole point. Rezi generates a bullet containing the missing keyword; that is a claim the
    // student used the tool. If their bank does not say it, we do not say it.
    const bank = [entry({ bullet_variants: ['Wrote Python data pipelines'] })];
    const [answer] = findGapEvidence([term('kubernetes')], bank, 'Wrote Python data pipelines');
    assert.equal(answer.unsupported, true);
    assert.deepEqual(answer.evidence, []);
  });

  test('an empty bank is unsupported, not a crash', () => {
    const [answer] = findGapEvidence([term('docker')], [], '');
    assert.equal(answer.unsupported, true);
  });

  test('a malformed bullet_variants row is skipped rather than thrown on', () => {
    const bank = [entry({ bullet_variants: null as unknown as string[] }), entry({ id: 'e2', bullet_variants: ['Ran Docker in CI'] })];
    const [answer] = findGapEvidence([term('docker')], bank, '');
    assert.equal(answer.evidence.length, 1);
    assert.equal(answer.evidence[0].entry_id, 'e2');
  });

  test('a quantified variant is offered before an unquantified one', () => {
    const bank = [
      entry({
        bullet_variants: [
          'Used Docker in the build',
          'Containerized six services with Docker, cutting release time 35%',
        ],
      }),
    ];
    const [answer] = findGapEvidence([term('docker')], bank, '');
    assert.match(answer.evidence[0].variant, /35%/, 'a metric-bearing bullet is the stronger offer');
  });

  test('evidence already on the resume is marked, so the UI can avoid a no-op swap', () => {
    const variant = 'Containerized six services with Docker on AWS';
    const bank = [entry({ bullet_variants: [variant] })];
    const [answer] = findGapEvidence([term('docker')], bank, `Education. ${variant}. Skills.`);
    assert.equal(answer.evidence[0].already_on_resume, true);
  });

  test('two variants sharing a long prefix are not confused for one another', () => {
    // The bank's Kubernetes phrasing and the resume's AWS phrasing of the same sentence share their
    // first 60 characters. A prefix check marked the Kubernetes variant "already on this resume",
    // so the one bullet that would have closed the gap could never be accepted.
    const bankVariant = 'Containerized six services with Docker and deployed them on Kubernetes, cutting release time by 35%';
    const onResume = 'Containerized six services with Docker and deployed them on AWS, cutting release time by 35%';
    const bank = [entry({ bullet_variants: [bankVariant] })];
    const [answer] = findGapEvidence([term('kubernetes')], bank, onResume);
    assert.equal(answer.evidence[0].already_on_resume, false, 'these are different bullets');
  });

  test('matching uses the same rule as the score', () => {
    // If this drifted we would offer a bullet that does not move the number, or withhold one that
    // would. The import is the guard; this test states why it matters.
    const src = readFileSync(path.join(__dirname, 'gapEvidence.ts'), 'utf8');
    assert.match(src, /import \{ resumeCovers/, 'evidence must use the scorer\'s matcher');
  });

  test('a term appearing in several entries returns all of them', () => {
    const bank = [
      entry({ id: 'a', org: 'Traeco', bullet_variants: ['Shipped Docker images'] }),
      entry({ id: 'b', org: 'Litos', bullet_variants: ['Ran Docker locally for QA'] }),
    ];
    const [answer] = findGapEvidence([term('docker')], bank, '');
    assert.equal(answer.evidence.length, 2);
    assert.deepEqual(new Set(answer.evidence.map((e) => e.org)), new Set(['Traeco', 'Litos']));
  });
});
