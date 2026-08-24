import { createHash } from 'node:crypto';

export const FINAL_SUBMIT_CHOOSER_NAME = 'litos-final-submit' as const;
export const FINAL_SUBMIT_CHOOSER_VERSION_V3 = 3 as const;
export const FINAL_SUBMIT_CHOOSER_VERSION_V4 = 4 as const;
/** Compatibility alias for direct Playwright and verification flows. */
export const FINAL_SUBMIT_CHOOSER_VERSION = FINAL_SUBMIT_CHOOSER_VERSION_V3;

/** Canonical positive grammar. Keep this source byte-identical in the managed runner. */
export const FINAL_SUBMIT_PATTERN = String.raw`(?:\b(?:submit|send)\s+(?:your\s+|my\s+|the\s+|this\s+)?application\b|\bsubmit\s+with\s+(?:attachments?|resumes?|cvs?|cover\s+letters?)\b|^\s*submit\s*$|^\s*apply\s*$|^\s*apply\s+now\s*$|^\s*senden\s*$|\bfinish\s+(?:and|&)\s+apply\b)`;

/** Managed application grammar. Bare Send is admitted only by the runner's v4 DOM policy. */
export const FINAL_SUBMIT_PATTERN_V4 = String.raw`(?:\b(?:submit|send)\s+(?:your\s+|my\s+|the\s+|this\s+)?application\b|\bsubmit\s+with\s+(?:attachments?|resumes?|cvs?|cover\s+letters?)\b|^\s*submit\s*$|^\s*send\s*$|^\s*apply\s*$|^\s*apply\s+now\s*$|^\s*senden\s*$|\bfinish\s+(?:and|&)\s+apply\b)`;

/**
 * Canonical hard exclusions. The document exception keeps labels such as "Submit application
 * with attachments" and "Send application from your saved details" eligible while rejecting
 * provider handoffs. Support wording is excluded unless application identifies the employer form,
 * except for explicit application-feedback widgets.
 */
export const FINAL_SUBMIT_EXCLUSION_PATTERN = String.raw`(?:\b(?:apply|continue|autofill|import|sign\s?in|log\s?in)(?:\s+with)?\s+(?:linkedin|indeed|google|facebook|apple)\b|\b(?:apply|submit|send|autofill|sign\s?in|log\s?in|continue|register|import)\b(?:\s+\w+){0,4}\s+(?:with|using|via|from)\s+(?!(?:the\s+|your\s+|my\s+|a\s+|an\s+)?(?:attachments?|resumes?|cvs?|cover\s+letters?|documents?|files?|e-?signature|profiles?|accounts?|saved\s+(?:details|information))\b)|\bquick apply\b|\bone[-\s]?click apply\b|\bpowered\s+by\b|^\s*(?:continue|next|start(?:\s+application)?|complete|finish|review\s+(?:and\s+submit|application)|save\s+and\s+continue)\s*$|\bapplication\s+(?:feedback|survey|issue|question|review|experience)\b|\bfeedback\s+on\s+your\s+application\b|^(?!.*\bapplication\b).*\b(?:feedback|request|ticket|comment|search|report|question|issue|review|rating|survey|contact|bug)\b)`;

export const FINAL_SUBMIT_CHOOSER_GRAMMAR = `${FINAL_SUBMIT_PATTERN}\n${FINAL_SUBMIT_EXCLUSION_PATTERN}`;
export const FINAL_SUBMIT_CHOOSER_HASH = createHash('sha256')
  .update(FINAL_SUBMIT_CHOOSER_GRAMMAR)
  .digest('hex');
export const FINAL_SUBMIT_CHOOSER_GRAMMAR_V4 = `${FINAL_SUBMIT_PATTERN_V4}\n${FINAL_SUBMIT_EXCLUSION_PATTERN}`;
export const FINAL_SUBMIT_CHOOSER_HASH_V4 = createHash('sha256')
  .update(FINAL_SUBMIT_CHOOSER_GRAMMAR_V4)
  .digest('hex');

const FINAL = new RegExp(FINAL_SUBMIT_PATTERN, 'i');
const EXCLUDED = new RegExp(FINAL_SUBMIT_EXCLUSION_PATTERN, 'i');
const EXPLICIT_APPLICATION = /\b(?:submit|send)\s+(?:your\s+|my\s+|the\s+|this\s+)?application\b/i;
const STRONG_COMPOUND = /\b(?:finish\s+(?:and|&)\s+apply|apply\s+now)\b/i;

export type FinalSubmitChooserPolicy = Readonly<{
  name: typeof FINAL_SUBMIT_CHOOSER_NAME;
  version: typeof FINAL_SUBMIT_CHOOSER_VERSION_V3 | typeof FINAL_SUBMIT_CHOOSER_VERSION_V4;
  finalPattern: typeof FINAL_SUBMIT_PATTERN | typeof FINAL_SUBMIT_PATTERN_V4;
  exclusionPattern: typeof FINAL_SUBMIT_EXCLUSION_PATTERN;
  grammarHash: string;
}>;

export const FINAL_SUBMIT_CHOOSER_POLICY_V3: FinalSubmitChooserPolicy = Object.freeze({
  name: FINAL_SUBMIT_CHOOSER_NAME,
  version: FINAL_SUBMIT_CHOOSER_VERSION_V3,
  finalPattern: FINAL_SUBMIT_PATTERN,
  exclusionPattern: FINAL_SUBMIT_EXCLUSION_PATTERN,
  grammarHash: FINAL_SUBMIT_CHOOSER_HASH,
});

export const FINAL_SUBMIT_CHOOSER_POLICY_V4: FinalSubmitChooserPolicy = Object.freeze({
  name: FINAL_SUBMIT_CHOOSER_NAME,
  version: FINAL_SUBMIT_CHOOSER_VERSION_V4,
  finalPattern: FINAL_SUBMIT_PATTERN_V4,
  exclusionPattern: FINAL_SUBMIT_EXCLUSION_PATTERN,
  grammarHash: FINAL_SUBMIT_CHOOSER_HASH_V4,
});

/** Compatibility alias. Direct Playwright intentionally retains v3 and cannot choose bare Send. */
export const FINAL_SUBMIT_CHOOSER_POLICY = FINAL_SUBMIT_CHOOSER_POLICY_V3;

export const FINAL_SUBMIT_CHOOSER_POLICIES: Readonly<Record<3 | 4, FinalSubmitChooserPolicy>> = Object.freeze({
  3: FINAL_SUBMIT_CHOOSER_POLICY_V3,
  4: FINAL_SUBMIT_CHOOSER_POLICY_V4,
});

export function exactFinalSubmitChooserPolicy(value: unknown): FinalSubmitChooserPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(',') !== 'exclusionPattern,finalPattern,grammarHash,name,version') return null;
  if (raw.version !== 3 && raw.version !== 4) return null;
  const policy = FINAL_SUBMIT_CHOOSER_POLICIES[raw.version];
  return raw.name === policy.name
    && raw.finalPattern === policy.finalPattern
    && raw.exclusionPattern === policy.exclusionPattern
    && raw.grammarHash === policy.grammarHash
    ? policy
    : null;
}

export function finalSubmitLabelScore(raw: string): number | null {
  const label = raw.replace(/\s+/g, ' ').trim();
  if (!label || EXCLUDED.test(label) || !FINAL.test(label)) return null;
  if (EXPLICIT_APPLICATION.test(label)) return 3;
  if (STRONG_COMPOUND.test(label)) return 2;
  return 1;
}

/** A tie blocks. DOM order is not semantic evidence and may change during a re-render. */
export function chooseCanonicalFinalSubmit(labels: string[]): number | null {
  const scored = labels.map((label, index) => ({ index, score: finalSubmitLabelScore(label) }))
    .filter((item): item is { index: number; score: number } => item.score !== null);
  if (scored.length === 0) return null;
  const top = Math.max(...scored.map((item) => item.score));
  const winners = scored.filter((item) => item.score === top);
  return winners.length === 1 ? winners[0]!.index : null;
}
