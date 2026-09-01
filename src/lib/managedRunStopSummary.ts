import type { ManagedBrowserResult } from './browserbase';

/**
 * What a managed run said about itself, in one bounded sentence, for the moment litos-api has to
 * refuse it for a reason that is not the run's own.
 *
 * The prepare fill hard-fails on a missing preview screenshot. Measured live 2026-09-01: the
 * refusal fired two seconds after the fill was requested, which is not the shape of a
 * seven-question fill that captured nothing; it is the shape of a run that stopped early (a
 * blocker, a challenge, a refused page) and whose stop reason the screenshot check threw away.
 * The stored submission_error read "did not return a preview screenshot" three times in a row
 * while the real cause stayed invisible. This summary rides on that error so the row, the log and
 * the person reading either can see what the run actually reported. Bounded and free of page
 * text: blockers and outcomes are the provider's finished sentences, never the employer page.
 */
export type ManagedRunStopSummary = {
  sentence: string | null;
  detail: {
    url: string | null;
    title: string | null;
    textLength: number;
    filledFields: number;
    blockers: string[];
    skipped: string[];
    humanVerification: string | null;
    submitOutcome: string | null;
    requiredFieldConfirmation: string | null;
    blockedSubmits: number;
    actionOutcomes: Record<string, number>;
    exactPageUrlProof: string | null;
  };
};

const SENTENCE_LIMIT = 600;

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export function managedRunStopSummary(result: Partial<ManagedBrowserResult> | null | undefined): ManagedRunStopSummary {
  const blockers = (result?.blockers ?? []).filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  const skipped = (result?.skipped ?? []).filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  const actionOutcomes = countBy((result?.actionDiagnostics ?? []).map((entry) => String(entry?.outcome ?? 'unknown')));
  const submit = result?.submitOutcome ?? null;
  const submitOutcome = submit
    ? [submit.pressed ? 'pressed' : 'not pressed', submit.state ?? null, submit.message ?? null].filter(Boolean).join(', ')
    : null;
  const detail: ManagedRunStopSummary['detail'] = {
    url: typeof result?.url === 'string' && result.url ? result.url : null,
    title: typeof result?.title === 'string' && result.title ? result.title : null,
    textLength: typeof result?.text === 'string' ? result.text.length : 0,
    filledFields: result?.filledFields?.length ?? 0,
    blockers,
    skipped,
    humanVerification: result?.humanVerification?.kind ?? null,
    submitOutcome,
    requiredFieldConfirmation: result?.requiredFieldConfirmation?.status ?? null,
    blockedSubmits: result?.blockedSubmits ?? 0,
    actionOutcomes,
    exactPageUrlProof: result?.exactPageUrlProof?.beforeActions ?? null,
  };
  const parts: string[] = [];
  if (blockers.length > 0) parts.push(`blockers: ${blockers.join(' | ')}`);
  if (skipped.length > 0) parts.push(`skipped: ${skipped.join(' | ')}`);
  if (detail.humanVerification) parts.push(`human verification: ${detail.humanVerification}`);
  if (submitOutcome) parts.push(`submit: ${submitOutcome}`);
  if (detail.requiredFieldConfirmation) parts.push(`required-field confirmation: ${detail.requiredFieldConfirmation}`);
  if (detail.blockedSubmits > 0) parts.push(`blocked submits: ${detail.blockedSubmits}`);
  const outcomes = Object.entries(actionOutcomes).map(([outcome, count]) => `${outcome} ${count}`).join(', ');
  if (outcomes) parts.push(`actions: ${outcomes}`);
  parts.push(`filled ${detail.filledFields}, page text ${detail.textLength} chars${detail.title ? `, title "${clip(detail.title, 80)}"` : ''}${detail.textLength === 0 && !detail.title ? ' (the page never rendered)' : ''}`);
  return { sentence: clip(parts.join('; '), SENTENCE_LIMIT), detail };
}

export function previewScreenshotMissingError(result: Partial<ManagedBrowserResult> | null | undefined): Error & { stop: ManagedRunStopSummary } {
  const stop = managedRunStopSummary(result);
  const error = new Error(
    `Stratus managed browser did not return a preview screenshot; the run reported: ${stop.sentence}`,
  ) as Error & { stop: ManagedRunStopSummary };
  error.stop = stop;
  return error;
}
