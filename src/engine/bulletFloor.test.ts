import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { enforceExperienceBulletFloor } from './resumePolicy';
import { RESUME_CONTENT_LIMITS } from './resumeContentPolicy';
import type { ExperienceBankEntry } from '../db/schema';

/* HOW SHORT AN ENTRY MAY BE, and what happens to one that is shorter.
 *
 * Mehek's call 2026-08-20, from reading a generated resume with a single job on it. The floor was
 * three and an entry that could not reach it was DROPPED ENTIRELY, so a student whose second job
 * carried two bullets on their own resume lost that job from the document. Measured across ten real
 * generations: every one printed one experience while the parse had found two.
 *
 * Two is the floor now. One is still never enough - a single-bullet entry looks like an
 * afterthought - but the student is TOLD, with the fix, instead of the job quietly disappearing.
 *
 * Both generators read RESUME_CONTENT_LIMITS: llm/resumeSpec.ts (what onboarding builds with) and
 * llm/baseResume.ts (what the platform builds with). One number, one behaviour.
 */

const bank = (org: string, bullets: string[]): ExperienceBankEntry =>
  ({ id: org, user_id: 'u', type: 'job', org, title: 'Intern', date_range: '2026', location: null,
     bullet_variants: bullets, tags: [] }) as unknown as ExperienceBankEntry;

const entry = (org: string, bullets: string[]) =>
  ({ org, title: 'Intern', date_range: '2026', bullets });

test('the floor is two, so a real job with two bullets stays on the resume', () => {
  assert.equal(RESUME_CONTENT_LIMITS.minBulletsPerEntry, 2);
  const spec = { experience: [entry('Campus Lab', ['Built a thing.', 'Measured the thing.'])] } as never;
  const out = enforceExperienceBulletFloor(spec, [bank('Campus Lab', ['Built a thing.', 'Measured the thing.'])]);
  assert.equal(out.experience.length, 1, 'a two-bullet job was dropped from the resume');
  assert.equal(out.experience[0].bullets.length, 2);
});

test('the second job survives now, which is the case this was changed for', () => {
  /* The exact production shape: three bullets on the first job, two on the second. Every one of ten
     generations printed only the first. */
  const spec = {
    experience: [
      entry('Stripe', ['One.', 'Two.', 'Three.']),
      entry('GT Systems Lab', ['Benchmarked Raft against Paxos.', 'Wrote a Python harness.']),
    ],
  } as never;
  const out = enforceExperienceBulletFloor(spec, [
    bank('Stripe', ['One.', 'Two.', 'Three.']),
    bank('GT Systems Lab', ['Benchmarked Raft against Paxos.', 'Wrote a Python harness.']),
  ]);
  assert.deepEqual(out.experience.map((e) => e.org), ['Stripe', 'GT Systems Lab']);
});

test('one bullet is still never enough', () => {
  const spec = { experience: [entry('Campus Lab', ['Built a thing.'])] } as never;
  const out = enforceExperienceBulletFloor(spec, [bank('Campus Lab', ['Built a thing.'])]);
  assert.equal(out.experience.length, 0, 'a single-bullet entry reached the resume');
});

test('a dropped entry is named, with the fix, rather than silently vanishing', () => {
  /* The half that makes the floor honest. Before this the job was simply absent and the only thing
     that knew why - one more bullet - was the code. */
  const dropped: { org: string; bullets: number; reason: string }[] = [];
  const spec = { experience: [entry('Campus Lab', ['Built a thing.'])] } as never;
  enforceExperienceBulletFloor(spec, [bank('Campus Lab', ['Built a thing.'])], {
    onDropped: (info) => dropped.push(info),
  });
  /* `reason` distinguishes this from the entry the cross-entry dedupe empties, where "add another
     bullet" is a dead end rather than the fix. This one really is short. */
  assert.deepEqual(dropped, [{ org: 'Campus Lab', bullets: 1, reason: 'below_floor' }]);
});

test('an entry topped up from the bank to two is kept, not dropped', () => {
  /* The model selected one bullet; the student's own bank holds a second. Filling from their own
     evidence is not padding, and it is preferred over losing the job. */
  const spec = { experience: [entry('Campus Lab', ['Built a thing.'])] } as never;
  const out = enforceExperienceBulletFloor(spec, [
    bank('Campus Lab', ['Built a thing.', 'Measured the thing.']),
  ]);
  assert.equal(out.experience.length, 1);
  assert.equal(out.experience[0].bullets.length, 2);
});

test('three is still the ceiling', () => {
  const four = ['One.', 'Two.', 'Three.', 'Four.'];
  const spec = { experience: [entry('Campus Lab', four)] } as never;
  const out = enforceExperienceBulletFloor(spec, [bank('Campus Lab', four)]);
  assert.equal(out.experience[0].bullets.length, RESUME_CONTENT_LIMITS.maxBulletsPerEntry);
});
