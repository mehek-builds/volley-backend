/* TELLING "THE MODEL REFUSED US" APART FROM "THIS DOCUMENT IS BAD".
 *
 * Written after a live incident on 2026-08-15. The Anthropic account ran out of credit, so every
 * resume upload returned 400 invalid_request_error "Your credit balance is too low". The student
 * saw "Failed to parse resume with AI" under their own file, on the first screen of onboarding,
 * with a Choose a file button underneath it: every signal on that screen said the resume was the
 * problem and invited them to go and find a different one. There was no different one to find.
 *
 * The log was no better. parseResumeWithClaude wrapped EVERY throw, including HTTP errors, in
 * "Claude returned invalid JSON for resume parsing", so the production log recorded a billing
 * failure as a JSON failure. Whoever read it next would have gone looking at the parser.
 *
 * TWO RULES COME OUT OF THAT, and both are cheap:
 *
 *   1. Never relabel someone else's error. An error that arrived with an HTTP status came from the
 *      API, not from our JSON validation, and it keeps its own message. Only errors we produced
 *      get our wording.
 *   2. An upstream refusal is a 503 about us, not a 500 about the upload. The student is told it
 *      is our side and to come back, which is both true and actionable, instead of being sent to
 *      re-export a file that was fine.
 *
 * RELATED, NOT THE SAME: isTransientOverload in routes/resume.ts answers "should I retry this
 * within the request", which is a narrower question. A 529 is transient and worth retrying; an
 * exhausted balance is not transient at all and no amount of retrying inside one request will fix
 * it. Both are nonetheless "not the student's fault", which is what this module answers.
 */

/** The HTTP status an Anthropic SDK error carries, if this is one. */
function apiStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Application-owned timeout sentinel. It is not an upstream HTTP response. */
export class ModelTimeoutError extends Error {
  readonly kind = 'model_timeout';

  constructor(message = 'Model request exceeded its latency budget') {
    super(message);
    this.name = 'ModelTimeoutError';
  }
}

/**
 * Did this error come from the API rather than from our own validation?
 *
 * The test is the presence of a numeric HTTP status. Our parse and truncation errors are plain
 * Errors built in llm/*.ts and carry none, so this cleanly separates "they said no" from "we could
 * not read what they said" without matching on message text, which is the check that would rot the
 * moment a provider reworded anything.
 */
export function isUpstreamApiError(error: unknown): boolean {
  return apiStatus(error) !== undefined;
}

/**
 * Is this a refusal to serve us at all, as opposed to a complaint about what we sent?
 *
 * Account-level refusals: an exhausted balance (400 with a credit message), a bad or revoked key
 * (401, 403), payment required (402), rate limiting (429), and any 5xx. Each one means every
 * request will fail the same way for every user until somebody changes something on our side, so
 * telling one student their resume is unreadable is both wrong and a lie that scales.
 *
 * A 400 is deliberately NOT enough on its own. Most 400s genuinely are our request being wrong
 * (a prompt too long, a malformed document), and those should keep failing loudly as bugs rather
 * than being smoothed into "try again later" and hidden.
 */
export function isModelUnavailable(error: unknown): boolean {
  if (error instanceof ModelTimeoutError) return true;
  const status = apiStatus(error);
  if (status === undefined) return false;
  if (status === 401 || status === 402 || status === 403 || status === 429) return true;
  if (status >= 500) return true;
  if (status === 400) return /credit balance|billing|quota|insufficient/i.test(messageOf(error));
  return false;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

/**
 * Coarse enough to be safe on a public endpoint, specific enough to shorten an investigation.
 *
 * Same reasoning as classifyDatabaseError in healthProbe.ts, and `credit` earns its own value for
 * the same reason `quota` does there: it is the failure this was written for, it is
 * indistinguishable from any other 400 at the HTTP layer, and knowing it instantly is the
 * difference between opening a billing page and debugging a parser.
 */
export type ModelFailureReason = 'credit' | 'auth' | 'rate_limit' | 'overloaded' | 'timeout' | 'error';

/** Categorise a model failure without leaking the provider's message onto a public endpoint. */
export function modelFailureReason(error: unknown): ModelFailureReason {
  if (error instanceof ModelTimeoutError) return 'timeout';
  const status = apiStatus(error);
  const message = messageOf(error).toLowerCase();
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'credit';
  if (status !== undefined && status >= 500) return 'overloaded';
  if (status === 400 && /credit balance|billing|quota|insufficient/.test(message)) return 'credit';
  if (/timeout|etimedout|aborted/.test(message)) return 'timeout';
  return 'error';
}

/** What the student is told when the model is unavailable. Says whose fault it is, and what to do. */
export const MODEL_UNAVAILABLE_MESSAGE =
  'Litos could not read your resume just now. This is a problem on our side, not with your file. Please try again in a few minutes.';

/** Machine-readable companion to the message above, so a client can retry rather than give up. */
export const MODEL_UNAVAILABLE_CODE = 'model_unavailable';
