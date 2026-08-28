/**
 * THE CARD GATE, split out of onboarding.ts so middleware/auth.ts can enforce it without
 * importing a route file (and without onboarding.ts importing back from auth.ts).
 *
 * onboarding.ts re-exports cardGateInstant and requiresPaymentMethodFor from here so existing
 * imports of them (including onboarding.test.ts) keep working unchanged.
 */

import { isAtOrBelowPath, normalizedRequestPath } from './httpPath';
import { onboardingFlowLedger } from './onboardingFlowLedger';

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
 */
const CARD_GATE_PROFILE_PATHS: ReadonlySet<string> = new Set([
  '/profile',
  '/profile/application',
  '/profile/targeting',
  '/profile/recent-experience',
]);

/**
 * TIER B2 -- exact route templates a locked account may reach ONLY while it has not yet finished
 * the one application /start's own flow builds and sends it: match, build (folded into 'match' on
 * the wire, see onboarding.ts's Step union), the questions screen, review/send, and the base-resume
 * screen mid-setup. Traced from role-quick-website origin/main by reading every step component
 * /start renders (components/start/MatchStep.tsx, BuildStep.tsx, ReviewStep.tsx,
 * BaseResumeStep.tsx, NotificationsStep.tsx) and following each api() call to lib/api.ts.
 *
 * isBuildingFirstOnboardingApplication (below) is what turns this tier off: once notifications --
 * the last data-consuming screen /start walks before 'plan' -- has been acknowledged, an account has
 * used everything on this list already and has nothing left to build. From then on a locked account
 * is at the payment wall with nothing to do but pay, check its own profile (TIER B1) or leave
 * (TIER A) -- it must not be able to keep building or sending MORE applications, browse the job
 * board, or attach another job via /applications/from-job, all of which is exactly "poking the API
 * to avoid paying" rather than finishing the one free application onboarding grants.
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
  // NotificationsStep.tsx: the 'notifications' screen itself reads and writes the two permissions
  // before acknowledging -- has to be reachable up to and including the moment that acknowledgement
  // is what CLOSES this tier (see isBuildingFirstOnboardingApplication above).
  '/notifications/preferences',
]);

export function isCardGateAllowedPath(rawPath: string): boolean {
  const path = normalizedRequestPath(rawPath);
  return CARD_GATE_ALLOWED_PATH_ROOTS.some((root) => isAtOrBelowPath(path, root));
}

/**
 * Whether `rawPath` is one of TIER B1's permanent, locked-lifetime profile-fact routes.
 * Exported separately from isCardGateAllowedPath (TIER A) so a caller that wants to charge the
 * TIER B2 ledger lookup only when it might actually matter can check the free tiers first -- see
 * cardGateRouteReachable below.
 */
export function isCardGateProfilePath(rawPath: string): boolean {
  return CARD_GATE_PROFILE_PATHS.has(normalizedRequestPath(rawPath));
}

function isCardGateOnboardingBuildPath(rawPath: string): boolean {
  return CARD_GATE_ONBOARDING_BUILD_PATHS.has(normalizedRequestPath(rawPath));
}

/**
 * Whether this (already known locked) account has not yet finished the one application /start's
 * flow builds and sends -- i.e. TIER B2 should still be open for it.
 *
 * 'notifications' is the boundary: it is the last APPLICATION_STEPS entry the flow walks before
 * 'plan' (onboarding.ts), and unlike 'sponsorship' it is never conditionally skipped, so
 * "notifications has been acknowledged" means the account has already used every TIER B2 route it
 * is ever going to need and is now sitting at the payment screen with nothing left to build.
 *
 * Fails OPEN (keeps TIER B2 available) when the ledger table has not migrated yet. onboarding.ts's
 * own /onboarding/state handler takes the same posture for the same reason: the alternative is
 * blocking a legitimate, still-mid-setup account out of the one flow that lets it finish, in a
 * deploy window nobody chose to be in.
 */
async function isBuildingFirstOnboardingApplication(userId: string): Promise<boolean> {
  const flow = await onboardingFlowLedger(userId);
  if (!flow.available) return true;
  return !flow.acknowledged.includes('notifications');
}

/**
 * THE CARD GATE's full per-request reachability decision, folding all three tiers together.
 *
 * Deliberately cheap in the common case: TIER A and TIER B1 are pure path checks, and the one
 * DB-backed check (TIER B2's ledger lookup) only runs when the path is actually one of the TIER B2
 * templates -- every other blocked route (dashboard bootstrap, network, documents, the applications
 * list, ordinary job-board browsing once onboarding is behind the account) is turned away on the
 * path check alone, with no extra query.
 */
export async function cardGateRouteReachable(rawPath: string, userId: string): Promise<boolean> {
  if (isCardGateAllowedPath(rawPath) || isCardGateProfilePath(rawPath)) return true;
  if (!isCardGateOnboardingBuildPath(rawPath)) return false;
  return isBuildingFirstOnboardingApplication(userId);
}
