import type { FastifyReply, FastifyRequest } from 'fastify';

export type SubmissionCutoverMode = 'off' | 'drain' | 'freeze';

export interface SubmissionCutoverState {
  mode: SubmissionCutoverMode;
  config_valid: boolean;
}

export type SubmissionCutoverCode =
  | 'SUBMISSION_CUTOVER_DRAINING'
  | 'SUBMISSION_CUTOVER_FROZEN';

export interface SubmissionCutoverDecision {
  code: SubmissionCutoverCode;
  retry_after_seconds: number;
}

export const SUBMISSION_CUTOVER_RETRY_AFTER_SECONDS = 300;

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const DRAIN_APPLICATION_EVIDENCE_SINKS = new Map<string, ReadonlySet<string>>([
  ['submission/extension-outcome', new Set(['POST'])],
  ['submission/handoff-complete', new Set(['POST'])],
  ['submission/self-submitted', new Set(['POST'])],
  ['submission/unverified', new Set(['POST'])],
  ['manual-submission-outcome', new Set(['POST'])],
]);

const DRAIN_SAFE_APPLICATION_READS = new Set([
  '/applications',
  '/applications/board',
]);

function normalizedPath(rawPath: string): string {
  const queryAt = rawPath.indexOf('?');
  const fragmentAt = rawPath.indexOf('#');
  const cutAt = [queryAt, fragmentAt]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), rawPath.length);
  const withoutQuery = rawPath.slice(0, cutAt) || '/';
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;
}

function applicationRouteSuffix(path: string): string | null {
  const matched = /^\/applications\/[^/]+\/(.+)$/.exec(path);
  return matched?.[1] ?? null;
}

function isDrainEvidenceSink(method: string, path: string): boolean {
  const suffix = applicationRouteSuffix(path);
  if (!suffix) return false;
  return DRAIN_APPLICATION_EVIDENCE_SINKS.get(suffix)?.has(method) === true;
}

function isAtOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Drain is intentionally fail closed by namespace. New application, resume, or internal routes
 * cannot become submission issuers merely because somebody forgot to add their spelling here.
 * Only the exact evidence sinks needed to finish an already exposed attempt remain available.
 */
function isDrainBlocked(method: string, path: string): boolean {
  if (isDrainEvidenceSink(method, path)) return false;
  if (isAtOrBelow(path, '/internal')) return true;
  if (isAtOrBelow(path, '/resume')) return true;
  if (path === '/dashboard/bootstrap') return true;
  if (isAtOrBelow(path, '/applications')) {
    return !(method === 'GET' && DRAIN_SAFE_APPLICATION_READS.has(path));
  }
  return false;
}

/**
 * Resolve the public effective state once when an application instance starts.
 *
 * An empty value has the same behavior as an unset value. Every nonempty value outside the three
 * accepted literals fails closed to freeze. The invalid value itself is never retained or exposed.
 */
export function resolveSubmissionCutover(rawValue: string | undefined): SubmissionCutoverState {
  if (rawValue === undefined || rawValue === '' || rawValue === 'off') {
    return { mode: 'off', config_valid: true };
  }
  if (rawValue === 'drain' || rawValue === 'freeze') {
    return { mode: rawValue, config_valid: true };
  }
  return { mode: 'freeze', config_valid: false };
}

/**
 * Classify one request using either a concrete URL path or a Fastify route-template path.
 */
export function submissionCutoverDecision(
  state: SubmissionCutoverState,
  methodValue: string,
  rawPath: string,
): SubmissionCutoverDecision | null {
  const requestMethod = methodValue.toUpperCase();
  if (state.mode === 'off' || requestMethod === 'OPTIONS') return null;
  // Fastify automatically exposes HEAD for GET routes. Classifying HEAD as GET keeps it from
  // becoming a second spelling that reaches the same capability-issuing handler during cutover.
  const method = requestMethod === 'HEAD' ? 'GET' : requestMethod;

  const path = normalizedPath(rawPath);
  const drainBlocked = isDrainBlocked(method, path);
  const frozenWrite = MUTATION_METHODS.has(method)
    && (isAtOrBelow(path, '/applications') || isAtOrBelow(path, '/resume'));
  const frozenWebhook = method === 'POST' && path === '/webhooks/application-email/inbound';
  const frozenAutofillEvidence = method === 'POST' && path === '/autofill/event';

  if (state.mode === 'drain') {
    return drainBlocked
      ? {
          code: 'SUBMISSION_CUTOVER_DRAINING',
          retry_after_seconds: SUBMISSION_CUTOVER_RETRY_AFTER_SECONDS,
        }
      : null;
  }

  return drainBlocked || frozenWrite || frozenWebhook || frozenAutofillEvidence
    ? {
        code: 'SUBMISSION_CUTOVER_FROZEN',
        retry_after_seconds: SUBMISSION_CUTOVER_RETRY_AFTER_SECONDS,
      }
    : null;
}

export function createSubmissionCutoverHook(state: SubmissionCutoverState) {
  return async function submissionCutoverHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const path = request.raw.url || request.routeOptions.url || '/';
    const decision = submissionCutoverDecision(state, request.method, path);
    if (!decision) return;

    reply.header('Cache-Control', 'no-store');
    reply.header('Retry-After', String(decision.retry_after_seconds));
    await reply.status(503).send({
      error: decision.code === 'SUBMISSION_CUTOVER_DRAINING'
        ? 'Submission actions are paused while existing attempts finish.'
        : 'Submission changes are temporarily paused.',
      code: decision.code,
      retry_after_seconds: decision.retry_after_seconds,
    });
  };
}
