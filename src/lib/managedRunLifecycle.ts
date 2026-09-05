/* THE RESTART THAT STRANDS A FILL, AND THE THREE THINGS THIS FILE GIVES THE PROCESS TO STOP IT.
 *
 * MEASURED TWICE, 2026-09-04. Every merge to volley main redeploys the single Railway process
 * (`node dist/index.js`, one process, restartPolicyType ALWAYS). src/index.ts had no SIGTERM or
 * SIGINT handler, so an in-flight managed fill died mid-flight and left its row exactly where the
 * process left it:
 *
 *   Celerant run d471dcf1 (packet 4b66641d)  status 'filling', progress_stage
 *     "Opening the company form", frozen from 22:21:47Z - the moment deploys of #941/#945 landed.
 *   TWG run 985f76ac                          status 'filling', frozen from 21:20:24Z - the moment
 *     deploy adb25ea landed.
 *
 * Nothing anywhere moves a row in that shape except the unrelated three-hour silence bound in
 * stalledFillRunRelease.ts, so the applicant's dashboard read "Still working" for up to three hours
 * on a run that had not existed for however long ago the deploy finished.
 *
 * THREE PIECES, in this file and its two neighbours:
 *
 *   1. RUN_OWNER_ID, below - this process's own identity, stamped onto a row when its run starts
 *      (claimPreparation and prepareManaged's first write, in routes/submissionRunner.ts) so a
 *      LATER boot can tell its own rows apart from a dead process's. See managedRunBootSweep.ts,
 *      which is the half that survives a SIGKILL this file's own handler never got to run for.
 *   2. The registry, below - an in-memory record of which packets THIS process is actively running
 *      a managed fill for, built so a SIGTERM handler (installed in index.ts, the Railway path
 *      only - see the comment there on why not buildApp) does not have to guess or query for what
 *      it owns.
 *   3. The shutdown signal and the accepting-new-work gate, below - so a SIGTERM stops new work
 *      from starting (a typed 503 on the two routes that begin a managed run) and unsticks any
 *      stratus fetch still waiting on a response nobody will read.
 *
 * The actual release - writing an honest terminal state instead of leaving `filling` to rot - is
 * managedRunRestartRelease.ts, which both the SIGTERM handler and the boot sweep call. Nothing here
 * writes to the database at all; this file is bookkeeping only.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { normalizedRequestPath } from './httpPath';

// ---------------------------------------------------------------------------------------------
// RUN_OWNER_ID
// ---------------------------------------------------------------------------------------------

/**
 * Build this process's run-owner identity from whatever deployment metadata Railway supplies, plus
 * a fresh random component that is ALWAYS appended.
 *
 * THE RANDOM COMPONENT IS NOT DECORATION. RAILWAY_DEPLOYMENT_ID names a deployment, not a running
 * process, and a crash-and-restart under the same restartPolicyType ALWAYS keeps the same
 * deployment id for every retry (up to restartPolicyMaxRetries). Two different process lifetimes
 * that shared a bare deployment id would look like the same owner to the boot sweep in
 * managedRunBootSweep.ts, which exists specifically to tell "still running" apart from "gone" -
 * so identity has to be per PROCESS, not per deployment. A fresh randomUUID() at module load (i.e.
 * at process boot, since this runs once when the module first loads) is unique per process
 * regardless of what Railway's own identifiers do or do not supply, including in local dev where
 * neither is set at all.
 *
 * Railway's own identifiers are still worth carrying alongside it, purely for a human reading a
 * stuck row's stored `run_owner` later: RAILWAY_DEPLOYMENT_ID and RAILWAY_REPLICA_ID (checked
 * against lib/buildInfo.ts's own resolveBuild, which already reads RAILWAY_DEPLOYMENT_ID for
 * GET /health's `build` field) turn an opaque UUID into something that also names which deploy and
 * which replica it came from.
 */
export function computeRunOwnerId(env: NodeJS.ProcessEnv = process.env): string {
  const deploymentParts = [env.RAILWAY_DEPLOYMENT_ID, env.RAILWAY_REPLICA_ID]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return [...deploymentParts, randomUUID()].join(':');
}

/**
 * This process's own identity, computed once when the module first loads (i.e. at process boot)
 * and never reassigned. Stamped onto a review's `run_owner` field when a managed run starts; read
 * back by managedRunBootSweep.ts to tell this process's own rows apart from a dead one's.
 */
export const RUN_OWNER_ID: string = computeRunOwnerId();

// ---------------------------------------------------------------------------------------------
// Shutdown signal
// ---------------------------------------------------------------------------------------------

let shutdownController = new AbortController();

/**
 * The signal every in-flight stratus provider call is combined against (see runManagedBrowser's and
 * continueManagedBrowser's `externalSignal` option in lib/browserbase.ts, and the two fenced
 * wrappers in routes/submissionRunner.ts that pass it on every call). Aborted once, by
 * triggerManagedRunShutdown, at the start of the SIGTERM/SIGINT handler.
 *
 * WHY BOTHER, WHEN process.exit() TEARS EVERYTHING DOWN ANYWAY. Two reasons this still matters
 * before that exit call fires. First, the row release in managedRunRestartRelease.ts runs
 * concurrently with whatever the original run's own promise chain is still doing, and an aborted
 * fetch lets that promise settle (into a caught, logged AbortError) within the shutdown deadline
 * instead of silently occupying the event loop for up to MANAGED_PREPARE_FILL_DEADLINE_MS (420s)
 * of a process that is trying to exit in ~10s. Second, an aborted client request is a real signal
 * to whatever is on the other end of the socket that nobody is waiting on the response any more,
 * where a bare process death is indistinguishable from a network blip.
 */
export function getManagedRunShutdownSignal(): AbortSignal {
  return shutdownController.signal;
}

/** Abort every stratus call still combined against getManagedRunShutdownSignal(). Idempotent:
 * aborting an already-aborted controller is a no-op. */
export function triggerManagedRunShutdown(): void {
  shutdownController.abort();
}

/** Test seam only. Production calls this once per process lifetime and never again. */
export function resetManagedRunShutdownSignalForTests(): void {
  shutdownController = new AbortController();
}

// ---------------------------------------------------------------------------------------------
// Accepting new work
// ---------------------------------------------------------------------------------------------

let acceptingNewManagedRuns = true;

/** Whether a NEW managed run may start. False from the moment SIGTERM/SIGINT is received. */
export function managedRunsAcceptingNewWork(): boolean {
  return acceptingNewManagedRuns;
}

/** Refuse every new managed run from this point on. One-way for the life of the process - there is
 * no un-refusing a shutdown that has already started. */
export function stopAcceptingNewManagedRuns(): void {
  acceptingNewManagedRuns = false;
}

/** Test seam only. */
export function resetManagedRunAcceptanceForTests(): void {
  acceptingNewManagedRuns = true;
}

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------

/**
 * Where a registered run is in the managed pipeline. Mirrors the three in-flight statuses named in
 * the file header, in the order a run passes through them - see ApplicationReviewState['status']
 * in lib/applicationReview.ts for the full status union this is a subset of.
 */
export type ManagedRunPhase = 'preparing' | 'filling' | 'submitting';

export interface ManagedRunRegistration {
  /** The generated_resumes row this run belongs to. Also the registry's key. */
  packetId: string;
  userId: string;
  /** The row's own submission_run_id, when the caller already knows it. Carried for logging only -
   * nothing here compares it against anything. */
  runId?: string;
  phase: ManagedRunPhase;
  /**
   * Whether this run has reached the employer boundary - a final-send lease/claim exists, or a
   * press was observed. See markManagedRunBoundaryReached. Starts false on every registration;
   * once true it never goes back to false for this registration's lifetime, which matters only in
   * that nothing in this file ever needs to unset it.
   *
   * REDUNDANT WITH PHASE FOR 'preparing'/'filling' BY CONSTRUCTION, AND THAT IS FINE. A row cannot
   * reach the employer boundary before status 'submitting' - claimSubmission,
   * authorizeFinalSubmissionBoundary and every press all happen only once a row is there - so this
   * is only ever meaningfully false while true for a 'submitting'-phase entry. It is still tracked
   * for every phase, uniformly, so a caller never has to special-case "which phases even have a
   * boundary" - it asks this one field.
   *
   * ALSO WHAT DECIDES WHETHER THE SHUTDOWN SIGNAL MAY TOUCH A GIVEN PROVIDER CALL - see
   * isManagedRunBoundaryReached and routes/submissionRunner.ts's managedProviderCallSignalFor. A
   * SIGTERM's abort must never reach the fetch that presses "submit" or a security-code
   * continuation, because an aborted fetch there makes it impossible to tell whether the employer
   * received the press; this field is already true by the time submit() is entered (see
   * processSubmissionApplication's own conservative mark, before it ever calls submit()), so gating
   * on it covers every provider call submit() makes, present and future, without a second registry
   * of "which call sites are dangerous" to keep in sync by hand.
   */
  boundaryReached: boolean;
  /**
   * The still-settling promise for whatever this registration's boundary-reached work is doing -
   * submit()'s own call, or the earlier recovery call for a row that was already claimed when this
   * function started. Set only once a boundary-reached run actually has work in flight (see
   * attachManagedRunBoundaryCompletion); read by the shutdown handler in index.ts so a SIGTERM can
   * wait, within its own deadline, for the ONE reconciliation that decides whether the employer
   * received a press, instead of exiting over it and leaving the answer to whoever reads the row
   * next. Absent for a pre-boundary registration - those are released outright, not waited on.
   */
  boundaryCompletion?: Promise<unknown>;
  registeredAt: number;
  /** Opaque per-registration identity, returned by registerManagedRun and required by
   * unregisterManagedRun - see both for why. */
  token: string;
}

const registry = new Map<string, ManagedRunRegistration>();

/** Opaque token identifying one call to registerManagedRun. Never inspected for its shape - just
 * carried from registerManagedRun to the matching unregisterManagedRun. */
export type ManagedRunRegistrationToken = string;

/** Begin tracking a managed run this process is now executing. Overwrites any existing entry for
 * the same packet - there can only ever be one live run per packet, serialized by the same
 * per-user advisory lock every claim in this pipeline already takes.
 *
 * RETURNS A TOKEN, AND THE CALLER MUST HOLD ONTO IT. Two overlapping registrations for the same
 * packet id used to be indistinguishable to unregisterManagedRun - it deleted by packetId alone, so
 * whichever call finished first would unregister the SURVIVING registration out from under the
 * still-running second one, leaving a live run the registry (and therefore a SIGTERM) no longer
 * knows exists. The token makes each registration's own unregister call provably about ITS OWN
 * entry: see unregisterManagedRun. */
export function registerManagedRun(input: {
  packetId: string;
  userId: string;
  runId?: string;
  phase: ManagedRunPhase;
}): ManagedRunRegistrationToken {
  const token = randomUUID();
  registry.set(input.packetId, {
    packetId: input.packetId,
    userId: input.userId,
    runId: input.runId,
    phase: input.phase,
    boundaryReached: false,
    registeredAt: Date.now(),
    token,
  });
  return token;
}

/** Best-effort. A packet id the registry has no entry for (never registered, or already
 * unregistered) is silently a no-op - every call site in routes/submissionRunner.ts calls this
 * unconditionally rather than tracking for itself whether registration happened. */
export function updateManagedRunPhase(packetId: string, phase: ManagedRunPhase): void {
  const entry = registry.get(packetId);
  if (entry) entry.phase = phase;
}

/** Mark a run as having reached (or being about to reach) the employer boundary, so a shutdown or
 * a boot sweep leaves it strictly alone - see the file header on abandonedAttemptClosure.ts's own
 * SUBMISSION_BOUNDARY_STATUSES for why 'submitting' is never released by this feature: the existing
 * #912 stalled-submitting arm owns that shape, under its own claim-based proof. Same no-op-if-absent
 * discipline as updateManagedRunPhase. */
export function markManagedRunBoundaryReached(packetId: string): void {
  const entry = registry.get(packetId);
  if (entry) entry.boundaryReached = true;
}

/** Stop tracking a run, however it ended - success, a handled failure, or an uncaught throw.
 * Every registration must be paired with exactly one of these, in a `finally`.
 *
 * TOKEN-GATED: only removes the entry if it is still the one registerManagedRun handed this caller
 * its token for. A caller whose token no longer matches - because a second, later registration for
 * the same packet has already overwritten it - has nothing left to unregister and this is silently
 * a no-op, exactly like unregistering a packet id the registry never saw: the SURVIVING later
 * registration keeps its entry, and its own eventual unregister (with its own token) is the one that
 * actually clears it. */
export function unregisterManagedRun(packetId: string, token: ManagedRunRegistrationToken): void {
  const entry = registry.get(packetId);
  if (entry && entry.token === token) {
    registry.delete(packetId);
  }
}

/** Every run this process is tracking that has NOT reached the employer boundary - the shutdown
 * handler's own worklist. Does not itself decide whether release is SAFE: the caller re-reads each
 * row fresh and re-checks it against stalledFillRunReleaseIsAdmissible (via
 * managedRunRestartRelease.ts) before writing anything, exactly as if this list were a hint rather
 * than an authority - because a registry entry can go stale (a phase changed after this was last
 * updated) in ways a fresh database read cannot. */
export function listPreBoundaryManagedRuns(): ManagedRunRegistration[] {
  return [...registry.values()].filter((entry) => !entry.boundaryReached);
}

/** Whether THIS process's registry already believes this packet has reached the employer boundary.
 * The one thing routes/submissionRunner.ts's managedProviderCallSignalFor asks before deciding
 * whether a provider call may carry the shutdown signal - see boundaryReached's own doc above for
 * why gating on this single flag is enough to cover every call submit() makes, not just the ones
 * named when this was written. False for a packet the registry has no entry for at all: an absent
 * registration proves nothing about the boundary, and defaulting to "may still be aborted" matches
 * this file's existing fail-open discipline for every other best-effort read here. */
export function isManagedRunBoundaryReached(packetId: string): boolean {
  return registry.get(packetId)?.boundaryReached === true;
}

/** Attach the still-settling promise for a boundary-reached run's own reconciliation work, so a
 * later shutdown can wait on it - see boundaryCompletion's own doc. A no-op for a packet with no
 * entry, or one whose boundary has not been marked reached: nothing before the employer boundary is
 * ever worth blocking a shutdown for, since listPreBoundaryManagedRuns already releases those
 * outright. Overwrites any earlier completion for the same packet - there is only ever one boundary-
 * reached call in flight per packet at a time, serialized the same way registration itself is. */
export function attachManagedRunBoundaryCompletion(packetId: string, completion: Promise<unknown>): void {
  const entry = registry.get(packetId);
  if (entry && entry.boundaryReached) {
    entry.boundaryCompletion = completion;
  }
}

/** Every boundary-reached run this process is currently tracking that also has an attached,
 * still-relevant completion promise - the shutdown handler's second worklist, alongside
 * listPreBoundaryManagedRuns's release candidates. Unlike that list, nothing here is ever written
 * to: the caller only awaits, within its own deadline, and leaves the row exactly as-is if the
 * deadline wins - see index.ts's releaseManagedRunsBeforeExit. */
export function listInFlightManagedRunBoundaryCompletions(): Array<{
  packetId: string;
  userId: string;
  promise: Promise<unknown>;
}> {
  return [...registry.values()]
    .filter((entry): entry is ManagedRunRegistration & { boundaryCompletion: Promise<unknown> } =>
      entry.boundaryReached && entry.boundaryCompletion !== undefined)
    .map((entry) => ({ packetId: entry.packetId, userId: entry.userId, promise: entry.boundaryCompletion }));
}

/** Observability only - how many runs this process currently believes it owns. */
export function managedRunRegistrySize(): number {
  return registry.size;
}

/** Test seam only. */
export function resetManagedRunRegistryForTests(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------------------------
// The acceptance gate
// ---------------------------------------------------------------------------------------------

export type ManagedRunAcceptanceCode = 'MANAGED_RUN_SHUTDOWN';

export interface ManagedRunAcceptanceDecision {
  code: ManagedRunAcceptanceCode;
  retry_after_seconds: number;
}

/** POST /applications/:id/submit-request, matched the same way submissionCutover.ts matches its own
 * per-application routes: by suffix after the id segment, never by a route template string that a
 * refactor could silently rename out from under this. */
const SUBMIT_REQUEST_PATH = /^\/applications\/[^/]+\/submit-request$/;

/**
 * Whether this exact request is one of the two doors a NEW managed run walks in through, and
 * whether this process is still answering them.
 *
 * NAMED, NARROW, AND FAIL-OPEN BY DEFAULT - the opposite discipline from submissionCutover.ts's
 * fail-closed drain, and deliberately so. Cutover is a manually operated, indefinite freeze that
 * has to distrust every route it has not explicitly cleared. This gate is automatic, self-clearing
 * (the process either finishes shutting down or it does not exist to answer anything), and lasts
 * at most the shutdown deadline in index.ts - so it only ever needs to name the two routes that
 * actually start a brand-new managed run. Every other route, prepare or submit alike, is either a
 * read, or a write against a run that ALREADY exists and this gate has no opinion on.
 */
export function managedRunAcceptanceDecision(
  accepting: boolean,
  method: string,
  rawPath: string,
): ManagedRunAcceptanceDecision | null {
  if (accepting) return null;
  if (method.toUpperCase() !== 'POST') return null;
  const path = normalizedRequestPath(rawPath);
  if (path === '/applications/managed-prepare' || SUBMIT_REQUEST_PATH.test(path)) {
    return { code: 'MANAGED_RUN_SHUTDOWN', retry_after_seconds: 5 };
  }
  return null;
}

/**
 * Global onRequest hook, registered unconditionally in buildApp() (the check itself is two string
 * comparisons and a boolean read, cheap enough to always run - see submissionCutoverHook, which
 * this is modelled on directly, for the same "match on the raw path before routing/auth/parsing"
 * shape). Refuses with a typed 503 rather than letting a POST reach managed-prepare or
 * submit-request and start a run this process will not be alive to finish.
 */
export function createManagedRunAcceptanceGateHook() {
  return async function managedRunAcceptanceGateHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const path = request.raw.url || request.routeOptions?.url || '/';
    const decision = managedRunAcceptanceDecision(managedRunsAcceptingNewWork(), request.method, path);
    if (!decision) return;

    reply.header('Cache-Control', 'no-store');
    reply.header('Retry-After', String(decision.retry_after_seconds));
    await reply.status(503).send({
      error: 'Litos is restarting and cannot start a new managed run right now. Try again in a few seconds.',
      code: decision.code,
      retry_after_seconds: decision.retry_after_seconds,
    });
  };
}
