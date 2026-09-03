import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pruneUngroundedContent } from '../engine/resumeValidate';
import type { ResumeSpec } from '../llm/resumeSpec';
import type { ExperienceBankEntry } from '../db/schema';

/* WHERE THE MISSING ENTRY WENT, at the refusal that names it as missing.
 *
 * /resume/generate collects omissions from two places, six hundred lines apart. The floor and the
 * one-page fit report what they left off into `layoutOmissions`. The GROUNDING PRUNER reports into
 * `groundingRemoved`, and it removes an entry SILENTLY - it has no onDropped, so it contributes
 * nothing to droppedForLength and nothing to layoutOmissions.
 *
 * So the final content-validation 422 could refuse a build for a required entry being absent while
 * every line it showed the student explained a different absence. The failure is silent in exactly
 * the way the lead-fallback note's was (see leadFallbackNote.test.ts): the response is well-formed,
 * schema-valid and simply incomplete, which is why the whole suite stayed green with this wrong.
 */

const bankEntry = (partial: Partial<ExperienceBankEntry>): ExperienceBankEntry =>
  ({
    id: 'e1', user_id: 'u1', type: 'job', org: 'Acme', title: 'Engineer',
    date_range: '2024', bullet_variants: [], tags: [], created_at: new Date(),
    ...partial,
  }) as ExperienceBankEntry;

const spec = (experience: ResumeSpec['experience']): ResumeSpec =>
  ({
    school: 'USC', degree: 'BS Computer Science', grad_date: 'May 2027',
    target_role: 'Analyst', skills: ['Excel'], experience,
  }) as ResumeSpec;

test('the grounding pruner removes an entry and says so, which is the thing worth carrying', () => {
  /* The behavioural half. A source pin alone would still pass if the pruner stopped reporting, so
     this asserts there is a real, populated report for the 422 below to carry. */
  const grounded = bankEntry({
    id: 'grounded',
    org: 'Alpha Partners',
    title: 'Analyst',
    bullet_variants: ['Built a discounted cash flow model for a mid market acquisition target'],
  });
  const pruned = pruneUngroundedContent(
    spec([
      {
        org: grounded.org,
        title: grounded.title ?? '',
        date_range: grounded.date_range ?? '',
        bullets: grounded.bullet_variants as string[],
      },
      {
        org: 'Never Worked Here Holdings',
        title: 'Vice President',
        date_range: '2025 - Present',
        bullets: ['Directed a nine figure balance sheet across four continents'],
      },
    ]),
    [grounded],
    ['Excel'],
  );

  assert.deepEqual(
    pruned.spec.experience.map((entry) => entry.org),
    ['Alpha Partners'],
    'the ungrounded entry should have been pruned',
  );
  assert.ok(pruned.removed.length > 0, 'the pruner removed an entry without reporting it');
  assert.ok(
    pruned.removed.some((line) => line.includes('Never Worked Here Holdings')),
    pruned.removed.join('; '),
  );
});

test('the final content-validation refusal carries the pruner removals, not only the layout ones', () => {
  /* Pinned against the source because there is no other way to see it: the two lists are built
     hundreds of lines apart and a refusal carrying the wrong one is a valid 422 that simply does
     not explain itself.

     ANCHORED ON THE 422's OWN LOG LINE and sliced to that one statement, NOT searched for across
     the whole file. `groundingRemoved` is named at four other points in this route - two earlier
     refusals that send it alone, the stored quality record and the returned result - so a bare
     file-wide substring search for it still passes while THIS statement carries only
     layoutOmissions, which is the regression the pin exists to catch. */
  const source = fs.readFileSync(path.join(__dirname, 'resume.ts'), 'utf8');

  const anchor = source.indexOf("'resume blocked after final content validation'");
  assert.ok(anchor > 0, 'the final content-validation refusal is no longer identifiable by its log line');
  const end = source.indexOf('}));', anchor);
  assert.ok(end > anchor, 'could not find the end of the final content-validation reply');
  const refusal = source.slice(anchor, end);

  const omissions = refusal.match(/omissions: [^\n]*/);
  assert.ok(omissions, `the final content-validation refusal sends no omissions at all: ${refusal}`);
  assert.match(
    omissions[0],
    /\.\.\.layoutOmissions/,
    'the floor and one-page fit removals must still be explained',
  );
  assert.match(
    omissions[0],
    /\.\.\.groundingRemoved/,
    'a required entry the grounding pruner removed would be refused with nothing saying where it went',
  );
});
