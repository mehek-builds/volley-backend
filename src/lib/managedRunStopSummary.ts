import type { ManagedBrowserResult } from './browserbase';

/**
 * What a managed run said about itself, in one bounded, value-free sentence, for the moment
 * litos-api has to refuse it for a reason that is not the run's own.
 *
 * The prepare fill hard-fails on a missing preview screenshot. Measured live 2026-09-01: the
 * refusal fired two seconds after the fill was requested, three runs in a row, which is not the
 * shape of a seven-question fill that captured nothing; it is the shape of a run that stopped
 * early (a blocker, a challenge, a page that never rendered) and whose stop reason the screenshot
 * check threw away. The stored submission_error read "did not return a preview screenshot" three
 * times while the real cause stayed invisible.
 *
 * VALUE-FREE ON PURPOSE. This sentence is stored as submission_error, which the review screen
 * renders to the student verbatim, and it is logged. The run's `blockers` and `skipped` arrays are
 * NOT the provider's finished sentences: `skipped` embeds the value Litos typed (a date of birth,
 * a free-text answer) beside an internal control label, and the student-facing path for those
 * strings (managedAnswerLossReasons) deliberately rewrites them. So the sentence carries counts
 * and enum states only, never a blocker or skip sentence, never the page title or URL. The same
 * shape goes to the log. Counts are bucketed coarsely in the SENTENCE so one failure keeps one
 * error fingerprint across runs; the exact numbers travel in the structured detail.
 */
export type ManagedRunStopDetail = {
  textLength: number;
  filledFields: number;
  blockerCount: number;
  skippedCount: number;
  humanVerification: string | null;
  submitPressed: boolean;
  submitState: string | null;
  requiredFieldConfirmation: string | null;
  blockedSubmits: number;
  actionOutcomes: Record<string, number>;
  exactPageUrlProof: boolean;
};

export type ManagedRunStopSummary = { sentence: string; detail: ManagedRunStopDetail };

const OUTCOME_KEY = /^[a-z][a-z0-9_-]{0,39}$/i;

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function bucket(count: number): string {
  if (count <= 0) return 'none';
  if (count === 1) return 'one';
  return 'several';
}

export function managedRunStopSummary(result: Partial<ManagedBrowserResult> | null | undefined): ManagedRunStopSummary {
  const blockerCount = Array.isArray(result?.blockers) ? result.blockers.length : 0;
  const skippedCount = Array.isArray(result?.skipped) ? result.skipped.length : 0;
  /* Outcome names are the runner's own enum words; anything else is folded to "other" so a
     free-text value can never ride along as a key. */
  const actionOutcomes = countBy((result?.actionDiagnostics ?? []).map((entry) => {
    const outcome = typeof entry?.outcome === 'string' ? entry.outcome : '';
    return OUTCOME_KEY.test(outcome) ? outcome : 'other';
  }));
  const submit = result?.submitOutcome ?? null;
  const detail: ManagedRunStopDetail = {
    textLength: typeof result?.text === 'string' ? result.text.length : 0,
    filledFields: Array.isArray(result?.filledFields) ? result.filledFields.length : 0,
    blockerCount,
    skippedCount,
    humanVerification: result?.humanVerification?.kind ?? null,
    submitPressed: submit?.pressed === true,
    submitState: typeof submit?.state === 'string' ? submit.state : null,
    requiredFieldConfirmation: typeof result?.requiredFieldConfirmation?.status === 'string'
      ? result.requiredFieldConfirmation.status
      : null,
    blockedSubmits: typeof result?.blockedSubmits === 'number' ? result.blockedSubmits : 0,
    actionOutcomes,
    exactPageUrlProof: Boolean(result?.exactPageUrlProof?.beforeActions),
  };
  const parts: string[] = [];
  parts.push(detail.textLength === 0 ? 'the page never rendered' : 'the page rendered');
  parts.push(`${bucket(detail.filledFields)} fields filled`);
  if (blockerCount > 0) parts.push(`${bucket(blockerCount)} blocker${blockerCount === 1 ? '' : 's'}`);
  if (skippedCount > 0) parts.push(`${bucket(skippedCount)} answer${skippedCount === 1 ? '' : 's'} left for you`);
  if (detail.humanVerification) parts.push(`a ${detail.humanVerification.replace(/_/g, ' ')} challenge`);
  if (submit) parts.push(`submit ${detail.submitPressed ? 'pressed' : 'not pressed'}${detail.submitState ? ` (${detail.submitState.replace(/_/g, ' ')})` : ''}`);
  if (detail.requiredFieldConfirmation) parts.push(`required-field check ${detail.requiredFieldConfirmation}`);
  if (detail.blockedSubmits > 0) parts.push(`${bucket(detail.blockedSubmits)} blocked submit${detail.blockedSubmits === 1 ? '' : 's'}`);
  const outcomes = Object.keys(actionOutcomes).sort().join('/');
  if (outcomes) parts.push(`action outcomes ${outcomes}`);
  return { sentence: parts.join(', '), detail };
}

/**
 * The error and its structured detail, SEPARATELY: nothing is attached to the Error object, because
 * pino's error serializer copies every own property of a logged error, and the whole point of the
 * split is that the log line carries the counts once, deliberately, and never by accident.
 */
export function previewScreenshotMissing(result: Partial<ManagedBrowserResult> | null | undefined): {
  error: Error;
  detail: ManagedRunStopDetail;
} {
  const { sentence, detail } = managedRunStopSummary(result);
  return {
    error: new Error(`Stratus managed browser did not return a preview screenshot; the run reported: ${sentence}`),
    detail,
  };
}
