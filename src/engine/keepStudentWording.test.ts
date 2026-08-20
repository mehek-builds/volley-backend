import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { keepStudentWording } from './resumePolicy';

/* THE STUDENT'S OWN SENTENCE, when the model only paraphrased one they already wrote.
 *
 * Measured across ten real generations on production 2026-08-20. Nothing was ever fabricated - the
 * numbers, employers and technologies survived every time - but the paraphrasing only ever lost
 * ground, and one case lost it on the worst possible application:
 *
 *   "Backtested a mean-reversion signal..." became "Tested a mean-reversion signal..."
 *   on a QUANTITATIVE TRADING internship, dropping the exact term a quant screener looks for.
 *
 * Tailoring earns its keep by choosing WHICH bullets to show and in what order. Rewriting a
 * sentence the student already wrote earns nothing and can only lose specificity.
 */

const OWN = [
  'Backtested a mean-reversion signal across 8 years of equities tick data in Python.',
  'Found and corrected a survivorship bias inflating reported Sharpe by 0.4.',
  'Automated a daily P&L attribution report used by a 6-person desk.',
];

describe('a paraphrase of the student\'s own bullet gives way to the original', () => {
  test('the downgrade this exists for: Backtested must not become Tested', () => {
    const paraphrased = 'Tested a mean-reversion signal across 8 years of equities tick data in Python.';
    assert.equal(keepStudentWording(paraphrased, OWN), OWN[0]);
  });

  test('a neutral synonym swap is restored too, because the original is never worse', () => {
    const paraphrased = 'Identified and resolved a survivorship bias inflating reported Sharpe by 0.4.';
    assert.equal(keepStudentWording(paraphrased, OWN), OWN[1]);
  });

  test('an untouched bullet comes back unchanged, not merely equal', () => {
    assert.equal(keepStudentWording(OWN[2], OWN), OWN[2]);
  });
});

describe('it refuses to touch anything that is not a near-copy', () => {
  test('a genuinely different sentence stands as the model wrote it', () => {
    /* The model doing its actual job. This shares a few words with the bank and must not be
       replaced by one of them, or selection would be silently undone. */
    const written = 'Presented the desk\'s quarterly risk review to twelve portfolio managers.';
    assert.equal(keepStudentWording(written, OWN), written);
  });

  test('a bullet from another job is never pulled in', () => {
    /* The guard against the worst version of this: restoring a sentence about a DIFFERENT employer
       would be a factual error rather than a wording one. Callers scope the candidates to the
       matched bank row; this checks the scoring cannot reach across on overlap alone. */
    const other = 'Built a TypeScript and React dashboard used by 40 researchers.';
    assert.equal(keepStudentWording(other, OWN), other);
  });

  test('an empty bullet and an empty bank are both left alone', () => {
    assert.equal(keepStudentWording('', OWN), '');
    assert.equal(keepStudentWording(OWN[0], []), OWN[0]);
  });

  test('a shorter bullet cannot match a longer one just by being a subset of it', () => {
    /* Scoring against the larger side is what stops "Tested a signal." scoring 1.0 against a full
       sentence it merely dropped half of. That would restore on far too little evidence. */
    assert.equal(keepStudentWording('Tested a signal.', OWN), 'Tested a signal.');
  });
});
