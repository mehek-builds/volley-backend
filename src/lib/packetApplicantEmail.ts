import {
  applicationAliasFor,
  applicationForwardingAddress,
  type ApplicantEmailChoice,
  type ApplicationEmailIdentity,
} from './applicationEmail';
import {
  applicationAliasDeliverability,
  type AliasDeliverability,
} from './applicationEmailDeliverability';

/* WHICH ADDRESS A NEW PACKET IS FROZEN TO, decided once, for every packet, on every path.
 *
 * This used to be four inline expressions in POST /resume/generate, and all four were gated on
 * `body.application`: the optional portal link a caller may or may not have in hand at generation
 * time. That gate is what this module exists to remove, and the reason is measured, not
 * theoretical.
 *
 * Packet cbebbfaa (2026-08-11, Flow Traders on Greenhouse) was generated with no portal link, so
 * no alias row was written and no `_applicant_email` was pinned. The portal was recovered
 * afterwards from the monitored posting, which is a supported and desirable repair, and the packet
 * then became a real application. By then there was no alias to use, so the submission fell back
 * to the applicant's personal mailbox, the employer emailed an eight character security code
 * there, and Litos could not read it. The run is still stuck at awaiting_security_code.
 *
 * A packet without a portal link is therefore not "not an application". It is an application whose
 * link has not been found YET. The email decision cannot be conditioned on a fact that arrives
 * later, so it is conditioned on the only thing that is knowable now: whether Litos can actually
 * receive mail for this account.
 *
 * The planner still reports why an alias is unavailable so non-application consumers can explain
 * the configuration problem. Application packet generation treats every fallback as a hold. It
 * never puts the personal resume address into an employer form and never prints the routing alias
 * in the PDF. See routes/resume.ts for that strict boundary. */

export type PacketApplicantEmailDeps = {
  deliverability?: () => Promise<AliasDeliverability>;
  forwardingAddress?: (userId: string, accountEmail?: string | null) => Promise<string | null>;
  aliasFor?: (userId: string, applicationId: string) => string | null;
  executor?: Parameters<typeof applicationForwardingAddress>[2];
};

export type PacketApplicantEmailPlan = {
  /** Non-null only when an alias row must be written for this packet before it can be used. */
  identity: ApplicationEmailIdentity | null;
  /** The frozen decision stored on the packet. Null only when the account has no email at all. */
  choice: ApplicantEmailChoice | null;
  /** A sentence for the applicant whenever employer replies will NOT come back through Litos. */
  notice: string | null;
};

/* The reasons that mean "this deployment or this account is not set up for Litos-routed mail",
 * as opposed to "it is set up and something went wrong". Only the second kind is worth failing a
 * generation over: the first is the ordinary state of a guest account, a fresh deployment, or a
 * domain whose inbound route is deliberately off, and refusing to build resumes for those would
 * break people who never asked for tracked mail in the first place. */
const ROUTE_NOT_CONFIGURED_REASONS = new Set<string>([
  'alias_not_configured',
  'inbound_disabled',
  'inbound_route_missing',
  'forwarding_not_configured',
  'no_forwarding_address',
]);

export function applicantEmailRouteIsConfigured(reason: string): boolean {
  return !ROUTE_NOT_CONFIGURED_REASONS.has(reason);
}

/** The sentence shown to the applicant when a packet is not routed through Litos. */
export function applicantEmailNotice(choice: ApplicantEmailChoice): string | null {
  if (choice.tracked) return null;
  const where = `Employer replies for this application go to ${choice.address}, not through Litos.`;
  const consequence = 'Litos cannot read a security code sent there, so you may have to finish this application yourself.';
  if (choice.reason === 'no_forwarding_address') {
    return `${where} Litos has no confirmed address to forward employer mail to yet. ${consequence}`;
  }
  if (ROUTE_NOT_CONFIGURED_REASONS.has(choice.reason)) {
    return `${where} Litos application email is not switched on for this account (${choice.reason}). ${consequence}`;
  }
  return `${where} Litos cannot receive mail on its application address right now (${choice.reason}). ${consequence}`;
}

function unavailableDeliverability(checkedAt: string): AliasDeliverability {
  return {
    deliverable: false,
    domain: null,
    reason: 'check_unavailable',
    mx_hosts: [],
    mx_provider: 'unknown',
    mx_provider_agrees: false,
    resend_domain_status: null,
    resend_receiving_status: null,
    inbound_route_configured: false,
    checked_at: checkedAt,
  };
}

export async function planPacketApplicantEmail(input: {
  userId: string;
  applicationId: string;
  /** The address the resume would print if there were no alias. */
  contactEmail?: string | null;
  accountEmail?: string | null;
  /** True when the caller supplied the contact address, which is what names the fallback source. */
  contactFromRequest?: boolean;
}, deps: PacketApplicantEmailDeps = {}): Promise<PacketApplicantEmailPlan> {
  const decidedAt = new Date().toISOString();
  const contactEmail = input.contactEmail?.trim();
  /* No email on the packet at all means there is nothing to freeze and nothing to forward. The
   * route refuses that packet a few lines earlier unless a phone number carries it, and a
   * phone-only resume keeps behaving exactly as it does today. */
  if (!contactEmail) return { identity: null, choice: null, notice: null };

  const fallback = (reason: ApplicantEmailChoice['reason']): PacketApplicantEmailPlan => {
    const choice: ApplicantEmailChoice = {
      address: contactEmail,
      source: input.contactFromRequest ? 'contact_email' : 'account_email',
      reason,
      tracked: false,
      decided_at: decidedAt,
    };
    return { identity: null, choice, notice: applicantEmailNotice(choice) };
  };

  /* The alias is frozen into the portal packet, so deliverability must be known before generation
   * completes. The personal resume address remains in the PDF. The check is cached per domain with
   * a TTL, so this costs one lookup an hour across the deployment rather than one per generation,
   * and it turns itself back on without a deploy once the MX record exists. */
  const deliverability = await (deps.deliverability ?? applicationAliasDeliverability)()
    .catch(() => unavailableDeliverability(decidedAt));
  if (!deliverability.deliverable) return fallback(deliverability.reason);

  const alias = (deps.aliasFor ?? applicationAliasFor)(input.userId, input.applicationId);
  if (!alias) return fallback('alias_not_configured');

  // The stored preference, not whichever address this request happened to carry.
  const forwardingAddress = deps.forwardingAddress
    ?? ((userId: string, accountEmail?: string | null) =>
      applicationForwardingAddress(userId, accountEmail, deps.executor));
  const forwardTo = await forwardingAddress(input.userId, contactEmail)
    .catch(() => null);
  const normalizedForwardTo = forwardTo?.trim().toLowerCase();
  if (!normalizedForwardTo) return fallback('no_forwarding_address');

  return {
    identity: { alias, forwards_to: normalizedForwardTo, mode: 'litos_application_alias' },
    choice: {
      address: alias,
      source: 'litos_alias',
      reason: 'deliverable',
      tracked: true,
      decided_at: decidedAt,
    },
    notice: null,
  };
}
