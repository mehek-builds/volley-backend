import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groundedBulletsForEntry, resumeBulletKey, RESUME_CONTENT_LIMITS } from './resumeContentPolicy';
import { enforceExperienceBulletFloor } from './resumePolicy';
import type { ResumeSpec } from '../llm/resumeSpec';
import type { ExperienceBankEntry } from '../db/schema';

/* THE ONE DEFINITION of "how many bullets can this entry print", and the tests that keep it one.
 *
 * Three rules need this number: the floor, which selects the bullets; the survivability rule, which
 * decides whether an entry may be MANDATORY; and the validator, which decides whether a one-bullet
 * entry is forgivable. Every bug in this family has been two of them answering differently, so the
 * property worth pinning is not any single answer but that the floor's output IS this function's
 * output. A second implementation is how the next one starts.
 */

const bank = (id: string, org: string, variants: string[]): ExperienceBankEntry =>
  ({ id, user_id: 'u', type: 'job', org, title: 'Analyst', date_range: '2026',
     location: null, bullet_variants: variants, tags: [] }) as unknown as ExperienceBankEntry;

const spec = (experience: ResumeSpec['experience']): ResumeSpec =>
  ({ school: 'USC', degree: 'BS', grad_date: 'May 2027', target_role: 'Analyst',
     skills: ['Excel'], experience }) as ResumeSpec;

test('the floor prints exactly what this function returns, entry by entry', () => {
  const shared = 'Coordinated a weekly investor update across the entire deal team';
  const alphaOnly = 'Built a discounted cash flow model for a mid market acquisition target';
  const betaOnly = 'Drafted diligence memos for three portfolio companies every quarter';
  const alpha = bank('alpha', 'Alpha Partners', [shared, alphaOnly]);
  const beta = bank('beta', 'Beta Ventures', [shared, betaOnly]);

  const printed = enforceExperienceBulletFloor(
    spec([
      { org: 'Alpha Partners', title: 'Analyst', date_range: '2026', bullets: [shared] },
      { org: 'Beta Ventures', title: 'Analyst', date_range: '2026', bullets: [shared] },
    ]),
    [alpha, beta],
    { priorityEntryId: 'beta', allowSparsePriority: true },
  );

  /* Replayed independently: the same call the floor makes, with the page accumulated by hand. If
     the floor ever grows its own copy of this logic the two diverge here. */
  const page = new Set<string>();
  const replay = [alpha, beta].map((source) => {
    const bullets = groundedBulletsForEntry([shared], source.bullet_variants, page);
    /* resumeBulletKey, NOT a hand-copy of it. A replay that normalizes with its own regex stops
       replaying the floor the moment that key changes, and this file exists to keep exactly one
       definition of these things. */
    for (const bullet of bullets.slice(0, RESUME_CONTENT_LIMITS.maxBulletsPerEntry)) {
      const key = resumeBulletKey(bullet);
      if (key) page.add(key);
    }
    return bullets;
  });

  assert.deepEqual(printed.experience.map((entry) => entry.bullets), replay);
  /* And the shape the whole bug turns on, stated outright: Alpha spends the shared sentence, so
     Beta - whose row holds two sentences - can only ever contribute one bullet to this page. */
  assert.deepEqual(replay, [[shared, alphaOnly], [betaOnly]]);
});

test('a sentence an earlier entry already printed is not one this entry can still print', () => {
  const shared = 'Coordinated a weekly investor update across the entire deal team';
  const own = 'Drafted diligence memos for three portfolio companies every quarter';
  assert.equal(groundedBulletsForEntry([], [shared, own]).length, 2, 'on an empty page the row holds two');
  assert.equal(
    groundedBulletsForEntry([], [shared, own], new Set([resumeBulletKey(shared)])).length,
    1,
    'a spent sentence must not be counted as still available',
  );
});

test('a keyless variant cannot raise an entry off the floor, but a keyless bullet already on the page counts', () => {
  /* The asymmetry is deliberate: what the model already printed is a different question from what
     the bank row can still supply. */
  assert.deepEqual(groundedBulletsForEntry([], ['...', '!!']), []);
  assert.deepEqual(groundedBulletsForEntry(['...', '!!'], []), ['...', '!!']);
});

test('the top-up stops at the floor rather than emptying the bank row onto the entry', () => {
  const four = ['Alpha one here', 'Beta two here', 'Gamma three here', 'Delta four here'];
  assert.equal(groundedBulletsForEntry([], four).length, RESUME_CONTENT_LIMITS.minBulletsPerEntry);
});
