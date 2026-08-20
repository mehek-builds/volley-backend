import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { keepStudentWording } from './resumePolicy';
import { startsWithStrongVerb } from './resumeValidate';

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
    // Opener only: "Found" -> "Identified", every other word untouched. Exactly what production did.
    const paraphrased = 'Identified and corrected a survivorship bias inflating reported Sharpe by 0.4.';
    assert.equal(keepStudentWording(paraphrased, OWN), OWN[1]);
  });

  test('a two-word rewrite is NOT an opening-verb swap and stands', () => {
    /* "Found and corrected" -> "Identified and resolved" changes the body as well as the opener, so
       it is the model editing the sentence rather than satisfying the verb gate. Out of scope. */
    const rewritten = 'Identified and resolved a survivorship bias inflating reported Sharpe by 0.4.';
    assert.equal(keepStudentWording(rewritten, OWN), rewritten);
  });

  test('an untouched bullet comes back unchanged, not merely equal', () => {
    assert.equal(keepStudentWording(OWN[2], OWN), OWN[2]);
  });
});

describe('it leaves the JD-terminology alignment the prompt asks for alone', () => {
  /* THE DEFECT IN THE FIRST VERSION OF THIS, caught before it reached production but after it was
   * written. That one restored on content overlap, so it reverted every one of these - and the
   * prompt explicitly asks for them: "copy the JD's exact multi-word terminology into the bullet"
   * when the student's evidence supports the same idea. Reverting keyword alignment is undoing the
   * tailoring, which is the opposite of the point.
   *
   * All three change the BODY of the bullet. Only the opener is this function's business. */
  const OWN_LONG = ['Shipped a Kafka consumer processing 2.1M events per day at p99 under 120ms.'];

  test('a JD term swapped inside the bullet is kept', () => {
    const aligned = 'Shipped a Kafka streaming pipeline processing 2.1M events per day at p99 under 120ms.';
    assert.equal(keepStudentWording(aligned, OWN_LONG, startsWithStrongVerb), aligned);
  });

  test('a one-word terminology change in a short bullet is kept', () => {
    const own = ['Cut PostgreSQL query time 60% by adding covering indexes.'];
    const aligned = 'Cut PostgreSQL query latency 60% by adding covering indexes.';
    assert.equal(keepStudentWording(aligned, own, startsWithStrongVerb), aligned);
  });

  test('a JD phrase adopted for the same idea is kept', () => {
    const own = ['Built a TypeScript and React dashboard used by 40 researchers.'];
    const aligned = 'Built a TypeScript and React analytics dashboard used by 40 researchers.';
    assert.equal(keepStudentWording(aligned, own, startsWithStrongVerb), aligned);
  });

  test('a changed number is never restored away either, because that is not a verb question', () => {
    /* Grounding owns fabricated metrics (engine/grounding.ts) and rejects them outright. This must
       not quietly paper over one by swapping the sentence back and hiding that it happened. */
    const own = ['Cut nightly runtime from 4h to 38m across the reconciliation job.'];
    const wrong = 'Cut nightly runtime from 4h to 12m across the reconciliation job.';
    assert.equal(keepStudentWording(wrong, own, startsWithStrongVerb), wrong);
  });
});

describe('it refuses to touch anything that is not an opening-verb swap', () => {
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

  test('a shortened bullet is not an opening-verb swap and is left alone', () => {
    /* Same opener family, half the sentence gone. Restoring here would be putting back words the
       model deliberately cut, which is a length decision rather than a verb one. */
    assert.equal(keepStudentWording('Tested a signal.', OWN), 'Tested a signal.');
  });
});

describe('the restored sentence still has to pass the gate the model was satisfying', () => {
  /* THE REGRESSION THIS EXISTS FOR, found on the first production run of the restore. The model
   * paraphrases weak openers because the validator REQUIRES an action-verb-first bullet, so putting
   * the student's verb back put a rejected verb back and the whole resume was refused with
   * `resume_quality_hold` - a worse outcome than the paraphrase by any measure. */
  test('the verbs that caused this are admitted now, so the student keeps their own word', () => {
    for (const verb of ['Rewrote', 'Backtested', 'Resequenced', 'Reordered', 'Restructured']) {
      assert.equal(
        startsWithStrongVerb(`${verb} something measurable for the team.`),
        true,
        `"${verb}" is still rejected, so restoring it would refuse the resume`,
      );
    }
  });

  /* An opener-only swap where the student's own opener is genuinely weak, so these two cases differ
     by the GATE alone rather than by anything about the sentence. "Assisted" is one of the verbs
     resumeValidate deliberately keeps out, and that rejection is correct: the bullet is weak. */
  const WEAK = ['Assisted twelve researchers collecting samples across three sites.'];
  const REWRITTEN = 'Coordinated twelve researchers collecting samples across three sites.';

  test('a genuinely weak opener keeps the model\'s rewrite rather than losing the resume', () => {
    // A bullet nobody can attach helps no one, so here the gate wins and the student keeps a resume.
    assert.equal(keepStudentWording(REWRITTEN, WEAK, startsWithStrongVerb), REWRITTEN);
  });

  test('without a gate it would restore, which is why the caller always passes one', () => {
    assert.equal(keepStudentWording(REWRITTEN, WEAK), WEAK[0]);
  });
});
