import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { planResumeLayout } from './resumeRender';
import { validateResumeSpec } from './resumeValidate';
import { RESUME_CONTENT_LIMITS } from './resumeContentPolicy';
import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';

/* FILLING AN EMPTY PAGE WITH EVIDENCE RATHER THAN AIR.
 *
 * Measured across ten real generations on 2026-08-20: every one filled 0.69 of the page with the
 * density search PINNED at its maximum, leaving 222pt - over three inches - blank at the bottom.
 * The renderer's own comment had measured the same band on five real production resumes, 0.675 to
 * 0.720, so this was every resume the platform makes rather than a fixture artifact.
 *
 * Reaching the design's own 0.94 target by spacing alone needs roughly 15pt body type, which is a
 * poster and not a resume. So the room is spent on the student's OWN unused bullets: the bank holds
 * evidence the selection did not print, and a page with three inches to spare while that sits
 * unused is padding with whitespace and discarding substance.
 */

const CONTACT = { full_name: 'A Candidate', email: 'a@example.edu', location: 'Austin, TX' };

const OWN = [
  'Rebuilt a Go payment reconciliation job, cutting nightly runtime from four hours to 38 minutes.',
  'Shipped a Kafka consumer processing 2.1M events per day at p99 under 120 milliseconds.',
  'Added idempotency keys to twelve internal endpoints, eliminating duplicate ledger writes.',
  'Benchmarked Raft against Paxos on a nine-node cluster, publishing results to 40 researchers.',
  'Automated a release checklist that cut deployment review from two hours to fifteen minutes.',
];

const bank = (bullets: string[], org = 'Stripe'): ExperienceBankEntry[] =>
  [{ id: '1', user_id: 'u', type: 'job', org, title: 'Backend Engineering Intern',
     date_range: 'Jun 2026 - Aug 2026', location: null, bullet_variants: bullets, tags: [] }] as never;

const specWith = (bullets: string[], org = 'Stripe'): ResumeSpec =>
  ({ school: 'Georgia Institute of Technology', degree: 'BS Computer Science', grad_date: 'May 2027',
     coursework: 'Distributed Systems, Databases', skills: ['Go', 'Kafka'],
     experience: [{ type: 'job', org, title: 'Backend Engineering Intern',
                    date_range: 'Jun 2026 - Aug 2026', bullets }] }) as never;

const bulletCount = (spec: ResumeSpec) =>
  spec.experience.reduce((total, entry) => total + entry.bullets.length, 0);

describe('an empty page is filled from the bank', () => {
  test('unused bullets are added, and the page fills', () => {
    const printed = OWN.slice(0, 3);
    const plan = planResumeLayout(specWith(printed), CONTACT, '', bank(OWN));
    assert.ok(
      bulletCount(plan.spec) > printed.length,
      'the page had room and the bank had unused evidence, and nothing was added',
    );
    /* Compared against the SAME document with no bank, which is the only honest baseline: an
       absolute threshold would be a statement about this fixture's length rather than about the
       pass. Production numbers are in the commit message. */
    const withoutBank = planResumeLayout(specWith(printed), CONTACT, '');
    assert.ok(
      plan.layout.fill_ratio > withoutBank.layout.fill_ratio,
      `fill ${plan.layout.fill_ratio.toFixed(3)} is no better than ${withoutBank.layout.fill_ratio.toFixed(3)} without the bank`,
    );
  });

  test('every added bullet is one the student wrote', () => {
    const plan = planResumeLayout(specWith(OWN.slice(0, 3)), CONTACT, '', bank(OWN));
    for (const bullet of plan.spec.experience[0].bullets) {
      assert.ok(OWN.includes(bullet), `"${bullet}" is not one of the applicant's own bullets`);
    }
  });

  test('an entry stops at the expanded ceiling', () => {
    const many = [...OWN, 'Documented the on-call rotation and cut escalation time by a third.',
                  'Migrated eleven services onto a shared deployment pipeline over one quarter.'];
    const plan = planResumeLayout(specWith(OWN.slice(0, 3)), CONTACT, '', bank(many));
    assert.ok(
      plan.spec.experience[0].bullets.length <= RESUME_CONTENT_LIMITS.expandedBulletsPerEntry,
      `an entry grew to ${plan.spec.experience[0].bullets.length}, past the ceiling`,
    );
  });
});

describe('what it refuses to add', () => {
  test('nothing, when the bank holds nothing the selection did not already print', () => {
    /* The common case for a student whose resume is genuinely short. There is no more evidence, so
       the page stays as empty as their material makes it rather than being padded. */
    const printed = OWN.slice(0, 3);
    const plan = planResumeLayout(specWith(printed), CONTACT, '', bank(printed));
    assert.equal(bulletCount(plan.spec), printed.length);
  });

  test('nothing, without a bank at all', () => {
    // The edit and replay paths pass no bank, and must behave exactly as they did before.
    const printed = OWN.slice(0, 3);
    assert.equal(bulletCount(planResumeLayout(specWith(printed), CONTACT, '').spec), printed.length);
  });

  test('a bullet from a DIFFERENT employer is never pulled in', () => {
    /* The worst version of this: filling a page by attributing one job's work to another. The
       matcher is the same one the bullet floor uses, so the bank row has to be this entry's. */
    const plan = planResumeLayout(specWith(OWN.slice(0, 3), 'Stripe'), CONTACT, '', bank(OWN, 'Rivian'));
    assert.equal(bulletCount(plan.spec), 3, 'a bullet was taken from another employer to fill the page');
  });

  test('a weak opener is not smuggled onto the page', () => {
    /* Unused bank text has not necessarily been through the opener rule. Adding one blindly puts a
       bullet on the page the validator then refuses, turning an empty page into no page at all. */
    const weak = [...OWN.slice(0, 3), 'Assisted the team with various deployment tasks each week.'];
    const plan = planResumeLayout(specWith(OWN.slice(0, 3)), CONTACT, '', bank(weak));
    assert.ok(
      !plan.spec.experience[0].bullets.some((b) => b.startsWith('Assisted')),
      'a bullet the verb gate rejects was added to fill the page',
    );
  });

  test('a page with no room is left alone', () => {
    /* A dense resume must come out unchanged: the expand pass measures against the COMPACT design,
       so a spec that already fills that has nothing spare under any design the search can pick. */
    const dense = {
      ...specWith(OWN.slice(0, 3)),
      experience: [0, 1, 2, 3].map((i) => ({
        type: 'job', org: `Employer ${i}`, title: 'Engineer', date_range: '2026',
        bullets: OWN.slice(0, 3),
      })),
    } as never as ResumeSpec;
    const before = bulletCount(dense);
    const plan = planResumeLayout(dense, CONTACT, '', bank(OWN, 'Employer 0'));
    assert.equal(bulletCount(plan.spec), before, 'a page spacing can fill was expanded anyway');
  });
});

describe('the validator accepts what the expand pass produces', () => {
  test('a five-bullet entry is legal, because a full page is not a defect', () => {
    /* THE REGRESSION THIS EXISTS FOR, found on the first production run after the expand pass
     * shipped: "Stripe: 5 bullets (max 3)" - a hard quality hold on a resume whose only sin was
     * being full. The validator was gating on the SELECTION target while the renderer was legally
     * printing up to the EXPANDED one. */
    const spec = specWith(OWN.slice(0, RESUME_CONTENT_LIMITS.expandedBulletsPerEntry));
    const result = validateResumeSpec(spec, '', bank(OWN));
    assert.ok(
      !result.issues.some((issue) => /bullets \(max/.test(issue)),
      `a legal expanded entry was refused: ${result.issues.join('; ')}`,
    );
  });

  test('and one bullet past that ceiling is still refused', () => {
    const tooMany = [...OWN, 'Documented the on-call rotation and cut escalation time by a third.'];
    const result = validateResumeSpec(specWith(tooMany), '', bank(tooMany));
    assert.ok(
      result.issues.some((issue) => /bullets \(max/.test(issue)),
      'the ceiling is not enforced at all any more',
    );
  });
});
