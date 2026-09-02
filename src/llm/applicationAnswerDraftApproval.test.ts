import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HONEST_SUBSTITUTE_INSTRUCTION,
  draftApplicationAnswer,
  questionExperienceTerms,
  unheldExperienceTerms,
} from './applicationAnswer';
import type { ExperienceBankEntry } from '../db/schema';

/* THE MEASURED QUESTION. Prod, 2026-09-02: EQL Tech "Founding AI Engineer (Computer Vision)" on
 * Workable, packet 9bbf3ba1-19ab-4a40-9e03-58049b36fb32, question 3 of 5, REQUIRED, type text. The
 * applicant has no computer-vision system in production, the premise rule refused, and Litos left
 * the box empty behind a disabled Save and next with no Skip. The refusal was right. Leaving her
 * with nothing was the defect. */
const EQL_QUESTION = 'Describe a multimodal/cv system you personally shipped to production, and your role in it.';

const bankEntry = (over: Partial<ExperienceBankEntry>): ExperienceBankEntry => ({
  id: 'entry-1',
  user_id: 'user-1',
  org: 'Acme Labs',
  title: 'Software Engineer',
  type: 'work',
  date_range: '2025',
  location: null,
  bullet_variants: ['Built a Python ingestion pipeline that cut nightly load time'],
  tags: ['Python', 'Postgres'],
  created_at: new Date(),
  ...over,
} as ExperienceBankEntry);

const BANK_WITHOUT_CV = [bankEntry({})];
const FACTS = { school: 'USC', major: 'Computer Science' };
const SKILLS = ['Python', 'TypeScript', 'Postgres'];

describe('the honest substitute: what the second ask is allowed to say', () => {
  const flat = HONEST_SUBSTITUTE_INSTRUCTION.replace(/\s+/g, ' ');

  test('it refuses the question as asked rather than re-attempting it', () => {
    assert.match(flat, /do NOT answer it as asked/);
    assert.match(flat, /CLOSEST real work in the experience bank/);
  });

  test('it forbids naming the thing the question presumes, and the posting as evidence', () => {
    assert.match(flat, /Do NOT claim, imply, or even name the thing the question presumes/);
    assert.match(flat, /never evidence she has done it/);
  });

  test('it keeps the house voice rules, em dash included', () => {
    assert.match(flat, /no em dash/);
    assert.match(flat, /output ONLY the answer text/);
  });
});

describe('questionExperienceTerms reads a free-text question for technology claims', () => {
  test('it splits the slash pair the measured question wrote', () => {
    const terms = questionExperienceTerms(EQL_QUESTION).map((term) => term.toLowerCase());
    assert.ok(terms.includes('multimodal'), terms.join(','));
    assert.ok(terms.includes('cv'), terms.join(','));
  });

  test('it keeps acronyms, camel case and symbol-bearing names', () => {
    const terms = questionExperienceTerms('Have you used PyTorch, NLP tooling, C++ or K8s in production?');
    assert.ok(terms.includes('PyTorch'), terms.join(','));
    assert.ok(terms.includes('NLP'), terms.join(','));
    assert.ok(terms.includes('C++'), terms.join(','));
    assert.ok(terms.includes('K8s'), terms.join(','));
  });

  test('it does not turn ordinary prose into a technology claim', () => {
    assert.deepEqual(questionExperienceTerms('Tell us why you want to work here and what you would bring.'), []);
  });
});

describe('THE GROUNDING GUARANTEE: the job description is never evidence of experience', () => {
  test('a term the question names and her resume does not hold is unheld', () => {
    const unheld = unheldExperienceTerms(EQL_QUESTION, BANK_WITHOUT_CV, FACTS, SKILLS)
      .map((term) => term.toLowerCase());
    assert.ok(unheld.includes('cv'), unheld.join(','));
    assert.ok(unheld.includes('multimodal'), unheld.join(','));
  });

  test('a term her own bank evidences is held, so the draft may use it', () => {
    const unheld = unheldExperienceTerms(
      'Describe a Python/Postgres system you shipped to production.',
      BANK_WITHOUT_CV,
      FACTS,
      SKILLS,
    );
    assert.deepEqual(unheld, []);
  });

  test('a declared skill counts as held even when no bank bullet names it', () => {
    assert.deepEqual(
      unheldExperienceTerms('Have you written TypeScript?', [bankEntry({ bullet_variants: [], tags: [] })], FACTS, SKILLS),
      [],
    );
  });
});

describe('a premise refusal now produces an honest draft instead of a blank required box', () => {
  test('the second ask runs, and its paragraph comes back marked as a substitute', async () => {
    const asks: string[] = [];
    const result = await draftApplicationAnswer(
      EQL_QUESTION,
      'EQL Tech',
      'Founding AI Engineer (Computer Vision)',
      'You will own our multimodal perception stack. Must have shipped CV systems to production.',
      BANK_WITHOUT_CV,
      FACTS,
      SKILLS,
      async ({ user }) => {
        asks.push(user);
        return asks.length === 1
          ? 'CANNOT_DRAFT'
          : 'The system I would point to is the ingestion pipeline I built at Acme Labs. I owned it end to end in Python, from the Postgres schema through the nightly load, and I was the person paged when it broke.';
      },
    );
    assert.equal(asks.length, 2, 'a refusal must open the second ask');
    assert.match(asks[1], /do NOT answer it as asked/);
    assert.match(result.answer, /Acme Labs/);
    assert.equal(result.honestSubstitute, true);
    assert.ok(
      result.warnings.some((warning) => /closest real work/.test(warning)),
      'she is told the draft answers a narrower question than the employer asked',
    );
  });

  test('a substitute that claims the unheld thing is regenerated, then refused outright', async () => {
    const asks: string[] = [];
    const result = await draftApplicationAnswer(
      EQL_QUESTION,
      'EQL Tech',
      'Founding AI Engineer (Computer Vision)',
      'Must have shipped CV systems to production.',
      BANK_WITHOUT_CV,
      FACTS,
      SKILLS,
      async ({ user }) => {
        asks.push(user);
        return asks.length === 1
          ? 'CANNOT_DRAFT'
          : 'I shipped a production CV pipeline at Acme Labs and owned the model rollout end to end.';
      },
    );
    assert.equal(asks.length, 3, 'one feedback regeneration, and no more');
    assert.match(asks[2], /which the applicant's own experience does not evidence/);
    assert.equal(result.answer, '', 'a claim she does not hold fails closed rather than shipping');
  });

  /* THE JOB DESCRIPTION IS SATURATED WITH THE TERM, which is what makes this the load-bearing
     case. The ordinary answer corpus contains the posting, so every ungrounded-content check that
     reads it would call "CV" grounded here. The experience corpus deliberately does not, and this
     is the test that says so end to end rather than at the helper. */
  const CV_SATURATED_JD = 'Multimodal CV, CV, multimodal perception, CV at scale. We want multimodal CV people.';

  test('a posting full of the word does not make the word sayable', async () => {
    const asks: string[] = [];
    const result = await draftApplicationAnswer(
      EQL_QUESTION,
      'EQL Tech',
      'Founding AI Engineer (Computer Vision)',
      CV_SATURATED_JD,
      BANK_WITHOUT_CV,
      FACTS,
      SKILLS,
      async ({ user }) => {
        asks.push(user);
        return asks.length === 1
          ? 'CANNOT_DRAFT'
          : 'I built the multimodal CV ingestion pipeline at Acme Labs and owned it end to end.';
      },
    );
    assert.equal(asks.length, 3, 'the claim is fed back once and no more');
    assert.equal(result.answer, '', 'the posting is not evidence, so the claim never ships');
  });

  test('a substitute that stays inside her own material is kept', async () => {
    const asks: string[] = [];
    const result = await draftApplicationAnswer(
      EQL_QUESTION,
      'EQL Tech',
      'Founding AI Engineer (Computer Vision)',
      CV_SATURATED_JD,
      BANK_WITHOUT_CV,
      FACTS,
      SKILLS,
      async ({ user }) => {
        asks.push(user);
        return asks.length === 1
          ? 'CANNOT_DRAFT'
          : 'I built the nightly ingestion pipeline at Acme Labs in Python, owned its Postgres schema, and was the person paged when a load failed.';
      },
    );
    assert.equal(asks.length, 2, 'a clean substitute needs no feedback round');
    assert.match(result.answer, /Acme Labs/);
    assert.doesNotMatch(result.answer, /\bCV\b/i, 'the substitute must not carry the word she cannot claim');
    assert.equal(result.honestSubstitute, true);
  });

  test('a second refusal still leaves the field to her, with nothing invented in it', async () => {
    const result = await draftApplicationAnswer(
      EQL_QUESTION,
      'EQL Tech',
      'Founding AI Engineer (Computer Vision)',
      CV_SATURATED_JD,
      [],
      FACTS,
      SKILLS,
      async () => 'CANNOT_DRAFT',
    );
    assert.equal(result.answer, '');
    assert.equal(result.honestSubstitute, false);
  });
});

describe('the drafting call sites carry the draft provenance', () => {
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');

  test('the essay drafter stores its paragraph as an unapproved Litos draft', () => {
    const push = runner.slice(runner.indexOf('const fitted = answer ? fitToBudget('));
    assert.match(push.slice(0, 2000), /kind: 'essay',[\s\S]*?answer_source: 'litos_draft',/);
  });

  test('the cover-letter text control does too', () => {
    const push = runner.slice(runner.indexOf('const coverLetterTextControl = isCoverLetterTextQuestion(label)'));
    assert.match(push.slice(0, 2500), /kind: 'essay',[\s\S]*?answer_source: 'litos_draft',/);
  });

  test('a required blank an earlier run parked is offered to the drafter again', () => {
    assert.match(runner, /const blankRequiredExistingIsDraftable = Boolean\(existing\)/);
    assert.match(runner, /if \(existing && !blankRequiredExistingIsDraftable\) \{/);
    // Only a deliberate outcome is protected: a refusal, a skip, or the optional mint.
    assert.match(runner, /&& existing!\.answer_state === undefined/);
    assert.match(runner, /&& existing!\.required/);
  });

  test('the draft carries the parked record identity rather than minting a new one', () => {
    const push = runner.slice(runner.indexOf('const fitted = answer ? fitToBudget('));
    assert.match(push.slice(0, 800), /id: existing\?\.id \?\? randomUUID\(\)/);
  });

  test("a draft sorts as machine-authored, so she is never told the packet was tampered with", () => {
    assert.match(runner, /const machineAuthored = \(source: unknown\): boolean => source === undefined \|\| source === 'litos_draft';/);
    assert.match(runner, /unacknowledged: extras\.filter\(\(q\) => machineAuthored\(q\.answerSource\)\)/);
    assert.match(runner, /forged: extras\.filter\(\(q\) => !machineAuthored\(q\.answerSource\)\)/);
  });

  test('the review reason is written whether or not standing consent is on', () => {
    const site = runner.slice(runner.indexOf("answer_source: 'litos_draft',"));
    const reason = site.indexOf('AI-drafted answer needs your review');
    const consentGate = site.indexOf('!automaticSubmissionEnabled');
    assert.ok(reason > 0, 'the reason is still written');
    assert.ok(consentGate === -1 || consentGate > reason + 400, 'it is not gated on standing consent');
  });
});
