import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { startsWithStrongVerb } from './resumeValidate';

/* THE GATE MUST NOT REWRITE A VERB THE POSTING NEVER ASKED FOR.
 *
 * A rejected opener is not merely flagged: the bullet is regenerated until it passes, so this
 * whitelist edits the applicant's prose. Measured across ten generations on 2026-08-20, of seven
 * openers it replaced, only two of the replacements appeared anywhere in the job description - and
 * one of those was a spelling change. The worst case ran backwards: the student wrote "Mapped a
 * 14-step assembly process", the posting itself says "map", and the gate replaced it with
 * "Documented", a word the posting never uses.
 *
 * The prompt is explicit that "action verbs are writing guidance, not candidate evidence". These
 * rewrites bought no alignment; they only cost the applicant their own words.
 */

describe('the verbs the gate was rewriting for nothing', () => {
  /* NOT "Found". A code review already ruled that one out - "founded" is admitted because founding
   * a company is a real act, and "Found and fixed 12 defects" is not that. Rewriting it to
   * "Identified" is an upgrade rather than an arbitrary swap, so it is the one of the seven worth
   * keeping. See atsGate.test.ts, which pins that decision. */
  for (const [verb, sentence] of [
    ['Mapped', 'Mapped a 14-step assembly process and removed three steps worth 90 seconds each.'],
    ['Cleaned', 'Cleaned a 4M-row household survey panel and cut processing time from 90m to 7m.'],
    ['Annotated', 'Annotated and released a 12k-sentence code-switching corpus for Igbo and English.'],
    ['Defined', 'Defined activation metrics that moved week-one retention from 22% to 31%.'],
  ] as const) {
    test(`"${verb}" stands as the applicant wrote it`, () => {
      assert.equal(startsWithStrongVerb(sentence), true);
    });
  }
});

describe('Commonwealth spellings of admitted verbs', () => {
  /* The list is written in American English. A student who writes British English is not writing a
   * weak bullet, and most of the market Litos sells into writes it. */
  for (const [british, american] of [
    ['Modelled', 'Modeled'],
    ['Analysed', 'Analyzed'],
    ['Organised', 'Organized'],
    ['Standardised', 'Standardized'],
    ['Formalised', 'Formalized'],
    ['Optimised', 'Optimized'],
    ['Synthesised', 'Synthesized'],
    ['Prioritised', 'Prioritized'],
  ] as const) {
    test(`"${british}" is accepted wherever "${american}" is`, () => {
      const sentence = (verb: string) => `${verb} the weekly reporting pipeline across three teams.`;
      assert.equal(
        startsWithStrongVerb(sentence(british)),
        startsWithStrongVerb(sentence(american)),
        `"${british}" and "${american}" are the same verb and must get the same answer`,
      );
      assert.equal(startsWithStrongVerb(sentence(british)), true);
    });
  }
});

describe('and it still refuses what it should', () => {
  /* The spelling rule only ever ADDS candidates, so it cannot admit a verb that was not already on
   * the list. These are the ones this file's docblock names as correctly rejected. */
  for (const verb of ['Assisted', 'Helped', 'Supported', 'Participated', 'Worked', 'Attended']) {
    test(`"${verb}" is still refused`, () => {
      assert.equal(startsWithStrongVerb(`${verb} with the weekly reporting process each Monday.`), false);
    });
  }

  test('a spelling variant that is not a word admits nothing', () => {
    /* "compelled" normalises to "compeled", which is neither on the list nor a word, so the extra
       candidate matches nothing and the verb stays rejected. This is the property that makes the
       rule safe: variants can only ever ADD candidates, never admit a verb the list excludes. */
    assert.equal(startsWithStrongVerb('Compelled the vendor to honour the original delivery date.'), false);
  });
});

describe('the generators are told to keep the applicant\'s spelling', () => {
  /* The gate accepting both spellings is only half of it: the model could still "correct" a
   * Commonwealth spelling on its own, and the gate would happily accept the Americanised result.
   * The instruction is what stops that, so it is asserted rather than assumed. Mehek's call
   * 2026-08-20: British spelling is allowed, and not conditional on where they are applying. */
  test('both prompts carry the rule', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const path of ['src/llm/resumeSpec.ts', 'src/llm/baseResume.ts']) {
      /* Read from the repo root rather than through `import.meta.url`. This suite runs under tsx,
         which resolves that fine, but `npm run typecheck` compiles with a module setting that
         rejects it outright - so the file passed every local run and failed CI. Both test runners
         start at the repo root, so a plain relative path is the portable answer. */
      const source = await readFile(path, 'utf8');
      assert.match(source, /KEEP THE APPLICANT'S OWN SPELLING/, `${path} lost the spelling rule`);
      // Whitespace-tolerant: the rule is wrapped in the prompt and a line break is not a change.
      assert.match(
        source,
        /Never convert\s+between British and American spelling in either direction/,
        `${path} no longer forbids converting between spellings`,
      );
    }
  });
});
