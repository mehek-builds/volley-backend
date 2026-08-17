import {
  MANAGED_RECEIVING_PROOF_MAX_AGE_MS,
  MANAGED_RECEIVING_PROOF_VERSION,
  configuredManagedReceivingCanaryRecipient,
  databaseManagedReceivingProofStore,
  managedReceivingProofRouteFingerprint,
  type ManagedReceivingProofStore,
} from './applicationEmailReceivingProof';
import { applicationEmailRouteSelection } from './applicationEmailRoute';

/* Nothing was refreshing the receiving proof, and it expires.
 *
 * acceptSignedManagedReceivingCanary writes a proof row when Resend delivers an inbound email
 * addressed to the canary recipient, and recentManagedReceivingProof only counts a row for
 * MANAGED_RECEIVING_PROOF_MAX_AGE_MS. Before this file the recipient had no sender anywhere in the
 * product: it was read to VERIFY an arriving webhook and to test configuration, never mailed. So
 * the proof could only ever be established by hand, and seven days later production degraded on
 * its own.
 *
 * Measured on prod 2026-08-17: the single v3 row was written 2026-08-10 10:21:45Z, aged out at
 * 10:21:45 the same hour this was written, and every POST /applications/:id/packet-audit then
 * refused with `the pinned Litos email is not receivable (managed_receiving_proof_mismatch)`.
 * No credential had rotated and no DNS record had changed - garaierkaa.resend.app still publishes
 * inbound-smtp.us-east-1.amazonaws.com, which RESEND_INBOUND_MX matches. The clock ran out.
 *
 * A self-sent canary proves exactly what the manual one proved, which is why automating it is safe:
 * Resend accepted mail for our receiving domain, delivered `email.received` to our endpoint signed
 * with our signing secret, and the receiving key could read the message back. */

/* How long before expiry the canary starts trying.
 *
 * Refreshing only once the proof had expired would guarantee a degraded window on every cycle. The
 * cron is daily and must stay daily - src/routes/cronSchedule.test.ts records that a sub-daily
 * schedule anywhere in vercel.json fails Vercel Hobby at DEPLOY time and blocks every production
 * deploy of this repo - so two days of lead buys two independent attempts before expiry.
 *
 * It also means that if inbound is genuinely broken, /health reads `degraded` for two days BEFORE
 * the first packet is refused. That ordering is the point of the lead rather than a side effect:
 * the operator sees it while submissions still work. */
export const MANAGED_RECEIVING_CANARY_REFRESH_LEAD_MS = 2 * 24 * 60 * 60 * 1000;

const RESEND_SEND_TIMEOUT_MS = 5_000;

export type ManagedReceivingCanaryReason =
  | 'sent'
  | 'proof_is_fresh'
  | 'not_configured'
  | 'sender_not_configured'
  | 'send_failed';

export type ManagedReceivingCanaryOutcome = {
  sent: boolean;
  reason: ManagedReceivingCanaryReason;
  detail?: string;
};

/**
 * HTTP status for a canary outcome, so a failure is visible without reading logs.
 *
 * A 200 on a failed send is the shape of the bug this file exists to remove: the damage is delayed
 * by the refresh lead and lands days later as a refused packet audit, so the cron invocation that
 * failed must itself read as failed in Vercel's cron history rather than as a success carrying a
 * quiet `sent: false`.
 *
 * `not_configured` stays 200 deliberately. It means this environment has no managed receiving route
 * at all, so there is no proof to keep fresh and nothing has gone wrong.
 */
export function managedReceivingCanaryHttpStatus(reason: ManagedReceivingCanaryReason): number {
  if (reason === 'send_failed') return 502;
  if (reason === 'sender_not_configured') return 503;
  return 200;
}

/**
 * True when the newest usable proof is inside the refresh lead of expiry, or absent.
 *
 * Returns false when the route is not managed Resend or the fingerprint cannot be built, because
 * there is no proof to keep fresh in that case. Callers must test configuration separately rather
 * than reading a false here as "healthy" - sendManagedReceivingCanary does.
 */
export async function managedReceivingProofNeedsRefresh(options: {
  store?: ManagedReceivingProofStore;
  now?: Date;
} = {}): Promise<boolean> {
  const route = applicationEmailRouteSelection();
  const fingerprint = managedReceivingProofRouteFingerprint();
  if (route.mode !== 'managed_resend' || !route.domain || !fingerprint) return false;
  const now = options.now ?? new Date();
  const notBefore = new Date(
    now.getTime() - (MANAGED_RECEIVING_PROOF_MAX_AGE_MS - MANAGED_RECEIVING_CANARY_REFRESH_LEAD_MS),
  );
  const proof = await (options.store ?? databaseManagedReceivingProofStore)
    .findCurrent(fingerprint, route.domain, MANAGED_RECEIVING_PROOF_VERSION, notBefore);
  return !proof;
}

/**
 * Mails the canary recipient so an inbound delivery refreshes the proof.
 *
 * The recipient carries the canary token and is never returned or logged, matching the contract on
 * configuredManagedReceivingCanaryRecipient. The outcome names what happened and nothing else.
 */
export async function sendManagedReceivingCanary(options: {
  store?: ManagedReceivingProofStore;
  now?: Date;
  force?: boolean;
  fetchImpl?: typeof fetch;
} = {}): Promise<ManagedReceivingCanaryOutcome> {
  const recipient = configuredManagedReceivingCanaryRecipient();
  const fingerprint = managedReceivingProofRouteFingerprint();
  if (!recipient || !fingerprint) return { sent: false, reason: 'not_configured' };

  if (!options.force
    && !(await managedReceivingProofNeedsRefresh({ store: options.store, now: options.now }))) {
    return { sent: false, reason: 'proof_is_fresh' };
  }

  const key = process.env.RESEND_API_KEY?.trim();
  const sender = process.env.RESEND_FROM?.trim();
  if (!key || !sender) return { sent: false, reason: 'sender_not_configured' };

  try {
    const response = await (options.fetchImpl ?? fetch)('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: sender,
        to: recipient,
        subject: 'Litos managed receiving canary',
        text: 'Automated Litos receiving check. No action is required.',
      }),
      signal: AbortSignal.timeout(RESEND_SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { sent: false, reason: 'send_failed', detail: `Resend /emails returned ${response.status}` };
    }
    return { sent: true, reason: 'sent' };
  } catch (error) {
    return {
      sent: false,
      reason: 'send_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
