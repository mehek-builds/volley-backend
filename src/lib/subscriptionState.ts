export type SubscriptionStatus =
  | 'checkout_pending'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'paused'
  | 'unpaid'
  | 'canceled'
  | 'expired'
  | 'refunded'
  | 'disputed'
  | 'incomplete'
  | 'incomplete_expired';

export const PAST_DUE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export type SubscriptionAccessInput = {
  status: string;
  current_period_end?: Date | string | null;
  access_ends_at?: Date | string | null;
  cancel_at_period_end?: boolean | null;
};

function instant(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

const ACCOUNT_SUBSCRIPTION_STATUS_PRIORITY: Record<string, number> = {
  active: 100,
  trialing: 95,
  past_due: 80,
  paused: 70,
  unpaid: 60,
  incomplete: 55,
  disputed: 50,
  canceled: 40,
  refunded: 30,
  expired: 20,
  incomplete_expired: 10,
  checkout_pending: 0,
};

export function chooseCanonicalAccountSubscription<T extends SubscriptionAccessInput & {
  provider_event_created_at?: Date | string | null;
  updated_at?: Date | string | null;
  provider_subscription_id?: string | null;
}>(rows: readonly T[], now = new Date()): T | null {
  let selected: T | null = null;
  const score = (row: T) => {
    const grantsAccess = subscriptionGrantsPlus(row, now);
    const endedScheduledCancellation = (row.status === 'active' || row.status === 'trialing')
      && row.cancel_at_period_end === true
      && !grantsAccess;
    return [
      grantsAccess ? 1 : 0,
      endedScheduledCancellation ? -1 : ACCOUNT_SUBSCRIPTION_STATUS_PRIORITY[row.status] ?? 0,
      instant(row.access_ends_at) ?? instant(row.current_period_end) ?? 0,
      instant(row.provider_event_created_at) ?? 0,
      instant(row.updated_at) ?? 0,
    ] as const;
  };
  for (const row of rows) {
    if (!selected) {
      selected = row;
      continue;
    }
    const candidate = score(row);
    const current = score(selected);
    let wins = false;
    for (let index = 0; index < candidate.length; index += 1) {
      if (candidate[index] === current[index]) continue;
      wins = candidate[index] > current[index];
      break;
    }
    if (!wins && candidate.every((value, index) => value === current[index])) {
      wins = (row.provider_subscription_id ?? '') > (selected.provider_subscription_id ?? '');
    }
    if (wins) selected = row;
  }
  return selected;
}

export function subscriptionAccessEndsAt(input: SubscriptionAccessInput): Date | null {
  const explicit = instant(input.access_ends_at);
  const period = instant(input.current_period_end);
  const value = explicit ?? period;
  return value === null ? null : new Date(value);
}

export function subscriptionGrantsPlus(input: SubscriptionAccessInput, now = new Date()): boolean {
  const status = input.status as SubscriptionStatus;
  const boundary = instant(input.access_ends_at) ?? instant(input.current_period_end);
  if (status === 'active' || status === 'trialing') {
    if (!input.cancel_at_period_end) return true;
    return boundary !== null && now.getTime() < boundary;
  }
  if (status === 'past_due') {
    return boundary !== null && now.getTime() < boundary + PAST_DUE_GRACE_MS;
  }
  if (status === 'paused' || status === 'canceled') {
    return boundary !== null && now.getTime() < boundary;
  }
  return false;
}

const PORTAL_RECOVERY_STATUSES = new Set<SubscriptionStatus>([
  'past_due',
  'unpaid',
  'paused',
  'incomplete',
  'disputed',
]);

export function subscriptionNeedsPortalRecovery(status: string | null | undefined): boolean {
  return PORTAL_RECOVERY_STATUSES.has(status as SubscriptionStatus);
}

const SAME_SECOND_STATE_PRIORITY: Record<string, number> = {
  checkout_pending: 0,
  trialing: 10,
  active: 10,
  past_due: 20,
  paused: 30,
  incomplete: 40,
  unpaid: 50,
  incomplete_expired: 60,
  expired: 60,
  canceled: 70,
  refunded: 80,
  disputed: 90,
};

export function shouldApplySubscriptionEvent(input: {
  storedCreatedAt: Date | string;
  storedStatus: string;
  incomingCreatedAt: Date | string;
  incomingStatus: string | null;
  eventName: string;
}): boolean {
  const storedTime = new Date(input.storedCreatedAt).getTime();
  const incomingTime = new Date(input.incomingCreatedAt).getTime();
  if (incomingTime > storedTime) return true;
  if (incomingTime < storedTime) return false;
  if (!input.incomingStatus || input.incomingStatus === input.storedStatus) return true;
  if (input.eventName === 'charge.dispute.closed' && input.storedStatus === 'disputed') return true;
  const terminal = new Set(['canceled', 'expired', 'refunded', 'disputed']);
  if (input.eventName === 'invoice.paid' && !terminal.has(input.storedStatus)) return true;
  return (SAME_SECOND_STATE_PRIORITY[input.incomingStatus] ?? 0)
    >= (SAME_SECOND_STATE_PRIORITY[input.storedStatus] ?? 0);
}

export function subscriptionEventAccessBoundary(input: {
  incomingStatus: string;
  incomingCreatedAt: Date;
  incomingAccessEndsAt: Date | null;
  storedStatus?: string | null;
  storedAccessEndsAt?: Date | null;
}): Date | null {
  if (input.incomingStatus !== 'past_due') return input.incomingAccessEndsAt;
  if (input.storedStatus === 'past_due' && input.storedAccessEndsAt) return input.storedAccessEndsAt;
  return input.incomingCreatedAt;
}

export function normalizedSubscriptionStatus(value: unknown): SubscriptionStatus {
  switch (value) {
    case 'trialing':
    case 'active':
    case 'past_due':
    case 'paused':
    case 'unpaid':
    case 'canceled':
    case 'expired':
    case 'refunded':
    case 'disputed':
    case 'incomplete':
    case 'incomplete_expired':
      return value;
    default:
      return 'incomplete';
  }
}

export function statusAfterDisputeClosed(outcome: unknown, previousStatus: unknown): SubscriptionStatus {
  if (outcome === 'won' || outcome === 'warning_closed') {
    return normalizedSubscriptionStatus(previousStatus === 'past_due' ? 'past_due' : 'active');
  }
  return 'canceled';
}
