/**
 * THE CARD GATE, split out of onboarding.ts so middleware/auth.ts can enforce it without
 * importing a route file (and without onboarding.ts importing back from auth.ts).
 *
 * onboarding.ts re-exports cardGateInstant and requiresPaymentMethodFor from here so existing
 * imports of them (including onboarding.test.ts) keep working unchanged.
 */

import { isAtOrBelowPath, normalizedRequestPath } from './httpPath';
import { hasApprovedSubmittedApplication } from './approvedApplicationSubmissions';

/**
 * The instant the card gate starts applying to newly created accounts, or null.
 *
 * Null -- the unset default, and also what an unparseable value gives -- means no
 * account is gated. See THE CARD GATE in onboarding.ts's /onboarding/state handler for why this
 * reads its own env var instead of borrowing the entitlement cutover.
 */
export function cardGateInstant(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.CARD_GATE_FROM?.trim();
  if (!raw) return null;
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Whether this account still owes us a card before the dashboard opens.
 *
 * Pure, exported, and separate from any route handler or middleware because it is the single
 * sentence that decides whether a student can use the product at all, and a rule that important
 * has to be readable and testable without standing up a request.
 */
export function requiresPaymentMethodFor(
  user: {
    billing_provider?: string | null;
    billing_customer_id?: string | null;
    created_at?: Date | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const from = cardGateInstant(env);
  if (from === null) return false;
  /* GUESTS ARE NOT EXEMPT. Mehek's call 2026-08-19, and it reverses the exemption
     that shipped a few hours earlier in this same file.
     The exemption was added for a real reason: /billing/checkout refuses a guest
     outright ("Verify an email before starting checkout"), so a gated guest was
     redirected to /start, handed the plan screen, and 409ed by the only control on
     it. But exempting them fixed the brick wall by opening a door instead -- Guest
     mode is a button on the front of /login, so anyone could walk around the payment
     gate by using it, which is the opposite of what the gate is for.
     So the gate applies to everyone and the WAY OUT is what changed: a guest who
     hits checkout now gets sent to claim an email (components/start/PlanStep.tsx
     reads the claim_required code), and a claimed account can pay like any other.
     Guests are gated; they are simply gated one step earlier. */
  if (!user.created_at || user.created_at.getTime() < from) return false;
  const paymentMethodOnFile = user.billing_provider === 'stripe' && Boolean(user.billing_customer_id);
  return !paymentMethodOnFile;
}

/**
 * Whether requireAuth (and optionalAuth, for a signed-in caller) should turn a request away for
 * owing a card.
 *
 * THIS USED TO ALSO REQUIRE onboarding_completed_at, and that was the bug a code review caught
 * (2026-08-29): onboarding_completed_at is written ONLY by POST /onboarding/complete, which the
 * frontend calls exclusively from the /start flow's terminal "done" screen -- reachable only after
 * the 'plan' (payment) step has already resolved. So a gated, never-paid account NEVER carries a
 * set onboarding_completed_at, which made the old `Boolean(onboarding_completed_at) &&
 * requiresPaymentMethodFor(...)` condition a no-op for the exact bypass this mechanism exists to
 * close: it could build and send a real application through /start's own routes, called directly
 * and out of order, and never once trip the gate.
 *
 * "Locked" is now requiresPaymentMethodFor ALONE -- true from the moment a gated account is
 * created, exactly like the frontend's own non-deferrable redirect already treats it
 * (dashboard-shell.tsx: `if (state.requires_payment_method) { router.replace("/start"); return; }`,
 * checked unconditionally, before anything else on the dashboard runs).
 *
 * Locking the account from creation, rather than from onboarding_completed_at, means the allowlist
 * below has to cover everything the LEGITIMATE /start flow calls to build and send its one
 * onboarding application -- see cardGateRouteReachable and the three tiers above it for how that is
 * done without reopening the routes a locked account would otherwise use to avoid paying
 * indefinitely.
 */
export function accountIsCardGateLocked(
  user: {
    billing_provider?: string | null;
    billing_customer_id?: string | null;
    created_at?: Date | null;
    // No longer read (see the FINDING #1 note above): kept as an accepted, ignored field rather
    // than removed from the type, so resolveToken's full user-row read -- which still selects it
    // for other reasons -- and any caller still passing it stay compiling unchanged.
    onboarding_completed_at?: Date | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return requiresPaymentMethodFor(user, env);
}

/**
 * TIER A -- path ROOTS a locked account may reach permanently, for as long as it is locked:
 * paying, checking billing/onboarding state, managing its session, and managing the account
 * itself (export/delete, #4 below). None of these routes let a locked account use the product
 * (browse jobs, build or send an application, see the dashboard); they are exactly what "pay or
 * leave" requires to stay reachable.
 *
 * /account was missing from this list before the same review that found the onboarding_completed_at
 * bug above: GET /account/export and DELETE /account both sit under requireAuth, so a locked
 * account could not export its own data or delete its account without paying first -- a data-rights
 * problem, not just a product one.
 *
 * A route that is not on this list, and not on either TIER B list below, is walled off the moment
 * an account is locked -- fail closed by default, exactly like submissionCutover's
 * DRAIN_APPLICATION_EVIDENCE_SINKS allowlist.
 */
const CARD_GATE_ALLOWED_PATH_ROOTS: readonly string[] = [
  '/onboarding',
  '/billing',
  '/auth',
  '/me',
  '/v1/meta',
  '/account',
];

/**
 * TIER B1 -- exact route templates a locked account may reach for as long as it is locked,
 * regardless of how far through onboarding it has gotten.
 *
 * These are the account's own intake facts (parsed resume, application profile, role targeting,
 * the recent-experience review) rather than anything that lets it use the product. They stay open
 * for the account's whole locked lifetime -- not just while it is actively moving through
 * setup -- because /start's own "change something you answered" revisit affordance
 * (components/start/ui.tsx, REVISITABLE) lets a student return to the 'focus', 'resume' and
 * 'sponsorship' screens from as late as the 'plan' screen itself, after the application sequence
 * that TIER B2 below gates has already finished. A locked account sitting on the payment screen has
 * to be able to fix a typo in its own profile without being told to pay first.
 *
 * The tradeoff this accepts, and the reason it belongs in code review rather than only here: a
 * locked account can read and edit these facts indefinitely without ever paying. That is a real,
 * bounded product decision -- it grants no ability to browse jobs, build or send an application, or
 * see the dashboard, only to keep its own intake answers current -- and it is called out explicitly
 * in this PR for that reason.
 *
 * NOTIFICATION SETTINGS JOINED THIS TIER in the same review that fixed FINDING #1 below (2026-08-29).
 * /notifications/preferences (both GET and PUT -- this is a template set, not method-aware, see
 * cardGateRouteReachable) used to live in TIER B2 because NotificationsStep.tsx happens to be the
 * screen that reads and writes it during onboarding. But there is nothing about a notification
 * preference, or a push subscription token, that belongs behind "have you used your one free
 * build" -- they are ordinary account settings, exactly like the profile facts above, and gating
 * them on TIER B2 produced two real bugs: FINDING #2 (POST /notifications/push/subscribe and
 * /unsubscribe were reachable from NO tier at all, so a locked account's own "daily summary" toggle
 * 402ed, and the frontend's catch-all swallowed the real error behind an unrelated Safari message)
 * and half of FINDING #1 (closing TIER B2 correctly, on a real send, would otherwise have walled a
 * locked account off from ever changing its notification settings again -- exactly the kind of
 * "poking the API to avoid paying" TIER B2 exists to stop, applied to a route that was never product
 * access in the first place). Moving all three routes here fixes both by removing the premise: they
 * are not part of the one free build, so they do not belong on the tier that is limited to it.
 */
const CARD_GATE_PROFILE_PATHS: ReadonlySet<string> = new Set([
  '/profile',
  '/profile/application',
  '/profile/targeting',
  '/profile/recent-experience',
  '/notifications/preferences',
  '/notifications/push/subscribe',
  '/notifications/push/unsubscribe',
]);

/**
 * TIER B2 -- exact route templates a locked account may reach ONLY while it has not yet finished
 * the one application /start's own flow builds and sends it: match, build (folded into 'match' on
 * the wire, see onboarding.ts's Step union), the questions screen, and review/send. Traced from
 * role-quick-website origin/main by reading every step component /start renders
 * (components/start/MatchStep.tsx, BuildStep.tsx, ReviewStep.tsx) and following each api() call to
 * lib/api.ts.
 *
 * hasSpentFreeOnboardingBuild (below) is what turns this tier off, and what it reads is a SERVER-OWNED
 * fact -- an actual submitted application -- rather than a client-driven acknowledgement. THE FINDING
 * #1 FIX (2026-08-29 code review): this used to close on `flow.acknowledged.includes('notifications')`,
 * a voluntary POST to /onboarding/flow/steps with no server-side ordering or requirement, and that had
 * two confirmed failure modes. (a) NEVER CLOSES: nothing required a client to ever send
 * `step:'notifications'`, so this tier stayed open indefinitely -- free, personalized job-board
 * browsing forever, no payment. (b) CLOSES TOO EARLY: 'notifications' is an APPLICATION_STEPS member,
 * not a replay step, so onboarding.ts's replay-ordering check (isReplayStep, POST
 * /onboarding/flow/steps) never engaged for it -- a client could POST `step:'notifications'` as its
 * literal first call, before building anything, and slam this tier shut on a fresh account that had
 * built and seen nothing, defeating the whole "see it work before paying" point of the redesign
 * (see onboardingBuildGrant.ts's own comment).
 *
 * Once an account has at least one submission that clears approvedSubmissionPredicate
 * (lib/approvedApplicationSubmissions.ts) -- status='submitted', written only by submissionRunner.ts
 * after a REAL, VERIFIED send, and submission_authorization.source='per_application_approval', the
 * one authorization value the student's own review-and-send screen (POST
 * /applications/:id/submit-request, itself on this tier) writes -- it has used everything on this
 * list already and has nothing left to build. From then on a locked account is at the payment wall
 * with nothing to do but pay, check its own profile or settings (TIER B1) or leave (TIER A) -- it
 * must not be able to keep building or sending MORE applications, browse the job board, or attach
 * another job via /applications/from-job, all of which is exactly "poking the API to avoid paying"
 * rather than finishing the one free application onboarding grants. This signal cannot trip
 * prematurely (nothing writes 'submitted' before a verified send actually happens, so mid-review or
 * mid-claim states never count) and cannot be left open forever by a voluntary client action (there is
 * no request a client can send that fabricates a real send).
 *
 * '/jobs' is listed bare rather than as a path root on purpose: '/jobs/grouped' and '/jobs/facets'
 * (jobMonitor.ts) are ordinary dashboard job-board browsing and must never be open here, even during
 * the match-step window -- only the exact templates '/jobs' (the ranked board /start's own
 * MatchStep.tsx pulls from) and '/jobs/:id' (a single posting, for BuildStep.tsx's lookup and for a
 * job-first account's pinned job) are. Fastify has already resolved routing by the time a preHandler
 * runs, so request.routeOptions.url is exactly one of these literal templates, never a path with the
 * dynamic segment substituted in -- exact-set membership is precise here in a way a prefix could not
 * be, which is also why TIER B1/B2 use a Set rather than isAtOrBelowPath the way TIER A does.
 */
const CARD_GATE_ONBOARDING_BUILD_PATHS: ReadonlySet<string> = new Set([
  '/jobs',
  '/jobs/:id',
  '/resume/generate',
  '/resume/base',
  '/resume/base/stream',
  '/postings/:jobId/questions',
  '/applications/from-job',
  '/applications/:id/submit-request',
]);

export function isCardGateAllowedPath(rawPath: string): boolean {
  const path = normalizedRequestPath(rawPath);
  return CARD_GATE_ALLOWED_PATH_ROOTS.some((root) => isAtOrBelowPath(path, root));
}

/**
 * Whether `rawPath` is one of TIER B1's permanent, locked-lifetime profile-fact and account-setting
 * routes. Exported separately from isCardGateAllowedPath (TIER A) so a caller that wants to charge
 * the TIER B2 submission lookup only when it might actually matter can check the free tiers first --
 * see cardGateRouteReachable below.
 */
export function isCardGateProfilePath(rawPath: string): boolean {
  return CARD_GATE_PROFILE_PATHS.has(normalizedRequestPath(rawPath));
}

function isCardGateOnboardingBuildPath(rawPath: string): boolean {
  return CARD_GATE_ONBOARDING_BUILD_PATHS.has(normalizedRequestPath(rawPath));
}

/**
 * Per-userId in-flight dedup for hasSpentFreeOnboardingBuild's DB call, mirroring
 * middleware/auth.ts's inFlightSessions for resolveToken's user-row read.
 *
 * FINDING #4: worth doing here for the same reason it is worth doing there -- TIER B2's own
 * templates are exactly the kind of routes a single /start screen fires several of at once
 * (BuildStep.tsx alone calls /resume/generate, /jobs/:id and /postings/:jobId/questions together),
 * so more than one TIER B2 request for the same account can land in the same tick. Keyed by userId
 * rather than by token: unlike resolveSession, the caller here (cardGateRouteReachable) is already
 * one layer past the token, so userId is what every concurrent caller actually shares.
 */
const inFlightSubmissionChecks = new Map<string, Promise<boolean>>();

function dedupedHasApprovedSubmittedApplication(userId: string): Promise<boolean> {
  const existing = inFlightSubmissionChecks.get(userId);
  if (existing) return existing;
  const check = hasApprovedSubmittedApplication(userId);
  inFlightSubmissionChecks.set(userId, check);
  const cleanup = () => {
    if (inFlightSubmissionChecks.get(userId) === check) inFlightSubmissionChecks.delete(userId);
  };
  check.then(cleanup, cleanup);
  return check;
}

/**
 * Whether this (already known locked) account has not yet finished the one application /start's
 * flow builds and sends -- i.e. TIER B2 should still be open for it.
 *
 * See CARD_GATE_ONBOARDING_BUILD_PATHS above (THE FINDING #1 FIX) for the full history of why this
 * reads a real submission rather than a ledger acknowledgement. There is no failure-open branch here
 * the way the old ledger-backed version needed one for an unmigrated table: generated_resumes is a
 * long-established table with no migration-window concern, and hasApprovedSubmittedApplication
 * simply returns false (tier stays open) for an account with no matching row, which is exactly right
 * for a brand new account that has not built anything yet.
 */
async function hasSpentFreeOnboardingBuild(userId: string): Promise<boolean> {
  return dedupedHasApprovedSubmittedApplication(userId);
}

/**
 * THE CARD GATE's full per-request reachability decision, folding all three tiers together.
 *
 * Deliberately cheap in the common case: TIER A and TIER B1 are pure path checks, and the one
 * DB-backed check (TIER B2's submission lookup, deduped across concurrent requests -- see
 * dedupedHasApprovedSubmittedApplication) only runs when the path is actually one of the TIER B2
 * templates -- every other blocked route (dashboard bootstrap, network, documents, the applications
 * list, ordinary job-board browsing once onboarding is behind the account) is turned away on the
 * path check alone, with no extra query.
 */
export async function cardGateRouteReachable(rawPath: string, userId: string): Promise<boolean> {
  if (isCardGateAllowedPath(rawPath) || isCardGateProfilePath(rawPath)) return true;
  if (!isCardGateOnboardingBuildPath(rawPath)) return false;
  return !(await hasSpentFreeOnboardingBuild(userId));
}
