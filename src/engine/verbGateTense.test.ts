import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';
import { startsWithStrongVerb, validateResumeSpec } from './resumeValidate';

/* A CURRENT ROLE IS WRITTEN IN THE PRESENT TENSE, AND THAT IS NOT A WEAK BULLET.
 *
 * resumeValidate already settled that the present SIMPLE is fine - "Synthesize organic ligands" is
 * a chemistry CV describing a job the student still holds, not a rule violation. It then derived
 * only that tense, and never the present PARTICIPLE, which is how most resumes actually write a
 * current role.
 *
 * Measured 2026-09-01 on Mehek's own account, at /start step 6 of 10, on an Exa "Software Engineer,
 * Intern" packet. The send gate refused the finished resume with three issues at once:
 *
 *     bullet not action-verb-first ("Driving"): "Driving full SDLC for iMessage add-on,..."
 *     bullet not action-verb-first ("Facilitating"): "Facilitating cross-functional..."
 *     bullet not action-verb-first ("Aggregated"): "Aggregated 350+ survey responses and..."
 *
 * `facilitated` is on the whitelist verbatim and `drive` maps to `drove` in IRREGULAR_PAST, so two
 * of the three were the gate refusing verbs it already calls strong, in the one tense it never
 * learned. All three bullets sat under an entry dated "September 2025 - Present".
 *
 * The third was a genuine vocabulary gap and is fixed the way this file fixes those: `aggregated`
 * admitted against compiled, consolidated, collected and synthesized, which are all on the list.
 */

const PRESENT_TENSE_BULLETS = [
  'Driving full SDLC for an iMessage add-on, from requirements through prototyping to Agile sprints.',
  'Facilitating cross-functional collaboration across engineering, design and marketing each week.',
  'Aggregated 350+ survey responses into a roadmap projected to grow weekly sessions 12 percent.',
] as const;

describe('the bullets the send gate refused on a finished packet', () => {
  for (const bullet of PRESENT_TENSE_BULLETS) {
    test(`"${bullet.split(' ')[0]}" opens a resume bullet the gate accepts`, () => {
      assert.equal(startsWithStrongVerb(bullet), true);
    });
  }
});

describe('every admitted verb answers the same in both tenses', () => {
  /* Pairs, not a bare list, because the property under test is AGREEMENT: the participle must get
   * whatever answer the past tense gets. Asserting only `true` would pass just as well if a future
   * edit dropped the past form from the list, and would say nothing about the two drifting apart. */
  for (const [participle, past] of [
    ['Driving', 'Drove'],
    ['Facilitating', 'Facilitated'],
    ['Building', 'Built'],
    ['Leading', 'Led'],
    ['Writing', 'Wrote'],
    ['Growing', 'Grew'],
    ['Winning', 'Won'],
    ['Teaching', 'Taught'],
    ['Rebuilding', 'Rebuilt'],
    ['Shipping', 'Shipped'],
    ['Running', 'Ran'],
    ['Cutting', 'Cut'],
    ['Managing', 'Managed'],
    ['Designing', 'Designed'],
    ['Owning', 'Owned'],
    ['Adding', 'Added'],
    ['Identifying', 'Identified'],
    ['Founding', 'Founded'],
  ] as const) {
    test(`"${participle}" is accepted wherever "${past}" is`, () => {
      const sentence = (verb: string) => `${verb} the weekly reporting pipeline across three teams.`;
      assert.equal(
        startsWithStrongVerb(sentence(participle)),
        startsWithStrongVerb(sentence(past)),
        `"${participle}" and "${past}" are the same verb and must get the same answer`,
      );
      assert.equal(startsWithStrongVerb(sentence(participle)), true);
    });
  }

  test('a Commonwealth participle reaches the same twin its past tense does', () => {
    /* The spelling rule used to run over the opening word alone. Once the participle produces
       candidates of its own, "modelling" only reaches `modeled` if the variants are taken over
       every candidate rather than over the word the student typed. */
    for (const verb of ['Modelling', 'Analysing', 'Optimising', 'Organising']) {
      assert.equal(startsWithStrongVerb(`${verb} the weekly reporting pipeline across three teams.`), true, verb);
    }
  });
});

describe('and it still refuses what it should', () => {
  /* The participle rule only ever ADDS candidates, so it cannot admit a verb the vocabulary rules
   * already reject. These are the weak openers resumeValidate's docblock names as correctly
   * refused, in the tense the new derivation reaches. */
  for (const verb of [
    'Assisting', 'Answering', 'Helping', 'Supporting', 'Participating',
    'Attending', 'Working', 'Engaging', 'Maintaining', 'Selecting',
  ]) {
    test(`"${verb}" is still refused`, () => {
      assert.equal(startsWithStrongVerb(`${verb} with the weekly reporting process each Monday.`), false);
    });
  }

  test('"Finding" cannot ride in on "founded", and "Founding" still can', () => {
    /* DERIVATION_BLOCKED exists because *found* is ambiguous - past of "find", present of "found a
       company" - and "Found and fixed 12 defects" must not reach `founded`. The participle carries
       no such ambiguity, which is why it is derived without consulting that block: "Finding"
       derives to `finded`, a word on no list, while "Founding" reaches the real act the list
       admits `founded` for. */
    assert.equal(startsWithStrongVerb('Finding and fixing 12 defects across the payments service.'), false);
    assert.equal(startsWithStrongVerb('Found and fixed 12 defects across the payments service.'), false);
    assert.equal(startsWithStrongVerb('Founding a student consultancy that billed 40k in its first year.'), true);
  });

  test('an "-ing" word that is not a verb on the list admits nothing', () => {
    assert.equal(startsWithStrongVerb('Marketing collateral for the spring intake sat with the agency.'), false);
    assert.equal(startsWithStrongVerb('Shadowing a senior nurse across three wards for six weeks.'), false);
  });
});

describe('aggregated, against the twins it was rejected beside', () => {
  test('it is accepted wherever compiled, consolidated and collected are', () => {
    const sentence = (verb: string) => `${verb} 350 survey responses into one weekly operations report.`;
    for (const twin of ['Compiled', 'Consolidated', 'Collected', 'Synthesized']) {
      assert.equal(startsWithStrongVerb(sentence('Aggregated')), startsWithStrongVerb(sentence(twin)), twin);
    }
    assert.equal(startsWithStrongVerb(sentence('Aggregated')), true);
  });
});

describe('the whole packet clears the send gate, not just the helper', () => {
  /* startsWithStrongVerb passing is necessary and not sufficient: what refused Mehek's Exa packet
   * was validateResumeSpec, called by preSendResumeVerificationIssues in routes/applications.ts.
   * This asserts the issue string that reached her screen is gone from the real gate's output. */
  const bank: ExperienceBankEntry[] = [{
    id: 'tonee',
    user_id: 'user-1',
    type: 'job',
    org: 'Tonee',
    title: 'Founder',
    date_range: 'September 2025 - Present',
    bullet_variants: [...PRESENT_TENSE_BULLETS],
    tags: [],
    created_at: new Date('2026-09-01T00:00:00Z'),
  } as ExperienceBankEntry];

  const spec: ResumeSpec = {
    school: 'University of Southern California',
    degree: 'BS Computer Science and Business Administration',
    grad_date: 'December 2027',
    coursework: '',
    experience: [{
      type: 'job',
      org: 'Tonee',
      title: 'Founder',
      date_range: 'September 2025 - Present',
      bullets: [...PRESENT_TENSE_BULLETS],
    }],
    skills: ['TypeScript', 'Swift'],
  };

  test('no bullet on a current-role packet is reported as not action-verb-first', () => {
    const validation = validateResumeSpec(spec, '', bank);
    assert.deepEqual(
      validation.issues.filter((issue) => issue.startsWith('bullet not action-verb-first')),
      [],
      validation.issues.join('; '),
    );
  });
});

describe('the generators are told the present tense is approved', () => {
  /* The gate accepting both tenses is only half of it. Both prompts hand the model a past-tense
   * verb list and a rule that outranks verbatim reuse, so without this line the model keeps
   * re-tensing a current role to satisfy a gate that no longer asks it to - which is the exact
   * silent prose-editing this file's docblock was written about. */
  test('both prompts carry the rule', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const path of ['src/llm/resumeSpec.ts', 'src/llm/baseResume.ts']) {
      const source = await readFile(path, 'utf8');
      assert.match(source, /A CURRENT role may keep the present tense/, `${path} lost the tense rule`);
      assert.match(
        source,
        /Do NOT re-tense a bullet to the past\s+to\s+satisfy the rule above/,
        `${path} no longer forbids re-tensing a current role`,
      );
    }
  });
});
