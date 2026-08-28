/**
 * THE CARD GATE, split out of onboarding.ts so middleware/auth.ts can enforce it without
 * importing a route file (and without onboarding.ts importing back from auth.ts).
 *
 * onboarding.ts re-exports cardGateInstant and requiresPaymentMethodFor from here so existing
 * imports of them (including onboarding.test.ts) keep working unchanged.
 */

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
 * Whether requireAuth should actually turn a request away for owing a card.
 *
 * requiresPaymentMethodFor alone is true for the entire life of a gated account, from the moment
 * it is created until a card lands on file -- that is what lets /onboarding/state warn the client
 * the whole way through setup. Enforcing on that signal alone would also lock the account out of
 * the onboarding routes it legitimately needs to reach 'done' in the first place (resume upload,
 * profile facts, building and sending its first application), which is exactly the failure mode
 * onboarding.ts's own "THE CARD GATE" comment warned about: a guard broad enough to cover the data
 * routes would have to allow almost every one of them just to let setup run.
 *
 * onboarding_completed_at is the fix: it is the same stored consent boundary onboarding.ts already
 * uses (see the application-sequence guard and lib/onboardingBuildGrant.ts) to mean "setup itself
 * is done." /onboarding/complete is the last write before the flow would otherwise resolve to
 * 'done', and it is precisely then that requiresPaymentMethodFor forces the served step to 'plan'.
 * So gating on requiresPaymentMethodFor && onboarding_completed_at fires at exactly the moment the
 * UI would show the card screen -- never mid-setup -- which means the enforcement needs no
 * allowlist of onboarding's own data routes, only of the routes a gated-and-completed account must
 * still reach: onboarding (to see its own state and finish automation consent), billing/auth (to
 * pay or manage its session), and the couple of small account routes covered below.
 */
export function accountIsCardGateLocked(
  user: {
    billing_provider?: string | null;
    billing_customer_id?: string | null;
    created_at?: Date | null;
    onboarding_completed_at?: Date | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(user.onboarding_completed_at) && requiresPaymentMethodFor(user, env);
}

/**
 * Path roots a card-gate-locked account may still reach.
 *
 * Deliberately a SHORT allowlist, not the routes onboarding needs to build and send its first
 * application (those are covered by onboarding_completed_at being unset while that happens, see
 * accountIsCardGateLocked above). This list only has to cover what remains true once setup is
 * otherwise finished: paying, checking billing/onboarding state, and managing the session itself.
 * A route that is not on this list is walled off the moment onboarding_completed_at is set and
 * this account still owes a card -- fail closed by default, exactly like submissionCutover's
 * DRAIN_APPLICATION_EVIDENCE_SINKS allowlist.
 */
const CARD_GATE_ALLOWED_PATH_ROOTS: readonly string[] = [
  '/onboarding',
  '/billing',
  '/auth',
  '/me',
  '/v1/meta',
];

function normalizedGatePath(rawPath: string): string {
  const queryAt = rawPath.indexOf('?');
  const withoutQuery = queryAt >= 0 ? rawPath.slice(0, queryAt) : rawPath;
  const path = withoutQuery || '/';
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function isAtOrBelowGateRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function isCardGateAllowedPath(rawPath: string): boolean {
  const path = normalizedGatePath(rawPath);
  return CARD_GATE_ALLOWED_PATH_ROOTS.some((root) => isAtOrBelowGateRoot(path, root));
}
