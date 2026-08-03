import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPLOYMENT_TYPE_CORPUS } from './employmentTypeCorpus';
import { resolveEmploymentType } from './compensation';

test('every posting that has ever fooled this classifier still classifies correctly', () => {
  const failures: string[] = [];
  for (const c of EMPLOYMENT_TYPE_CORPUS) {
    const actual = resolveEmploymentType(c.title, c.boardValue, c.description);
    if (actual !== c.expected) {
      failures.push(
        `\n  ${c.company} | ${c.title}\n`
        + `    expected ${String(c.expected)}, got ${String(actual)}\n`
        + `    why it is in the corpus: ${c.note}`,
      );
    }
  }
  assert.equal(failures.length, 0, `${failures.length} corpus cases regressed:${failures.join('')}`);
});

test('the corpus covers both directions and does not quietly shrink', () => {
  /* Pinned so removing a case is a deliberate edit in a diff. Every entry was a real posting on
     the wrong side of the classifier in production, so a shrinking corpus means coverage was
     dropped rather than a rule improved. */
  assert.equal(EMPLOYMENT_TYPE_CORPUS.length, 28);
  const internships = EMPLOYMENT_TYPE_CORPUS.filter((c) => c.expected === 'Internship');
  const notInternships = EMPLOYMENT_TYPE_CORPUS.filter((c) => c.expected === undefined);
  assert.ok(internships.length >= 10, 'false negatives must stay represented');
  assert.ok(notInternships.length >= 10, 'false positives must stay represented');
  for (const c of EMPLOYMENT_TYPE_CORPUS) {
    assert.ok(c.company.trim() && c.title.trim(), 'every case names its employer and title');
    assert.ok(c.note.length > 20, `${c.title} needs a note saying why it is here`);
  }
});

test('the two halves of the Jane Street pair disagree, which is the whole point', () => {
  const pair = EMPLOYMENT_TYPE_CORPUS.filter(
    (c) => c.company === 'Jane Street' && c.title === 'Software Engineer',
  );
  assert.equal(pair.length, 2, 'both halves of the pair must stay in the corpus');
  const answers = new Set(pair.map((c) => resolveEmploymentType(c.title, c.boardValue, c.description)));
  assert.equal(answers.size, 2, 'same title, same board, opposite answers');
});
