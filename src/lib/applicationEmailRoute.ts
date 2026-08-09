export type ApplicationEmailRouteMode = 'managed_resend' | 'custom_domain' | 'mailbox';

export type ApplicationEmailMailboxRoute = {
  local: string;
  domain: string;
  address: string;
};

export type ApplicationEmailRouteSelection = {
  mode: ApplicationEmailRouteMode | null;
  explicit: boolean;
  invalid_mode_present: boolean;
  domain: string | null;
  mailbox: ApplicationEmailMailboxRoute | null;
  route_label: string | null;
  ignored_legacy_domain_present: boolean;
  ignored_legacy_mailbox_present: boolean;
};

const MANAGED_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.resend\.app$/i;
const CUSTOM_DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
const MAILBOX_LOCAL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i;

function managedDomain(): string | null {
  const domain = process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN?.trim().toLowerCase();
  return domain && MANAGED_DOMAIN.test(domain) ? domain : null;
}

function customDomain(): string | null {
  const domain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN?.trim().toLowerCase();
  return domain && CUSTOM_DOMAIN.test(domain) ? domain : null;
}

function mailboxRoute(): ApplicationEmailMailboxRoute | null {
  const mailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX?.trim().toLowerCase();
  const match = mailbox?.match(/^([^@\s]+)@([a-z0-9.-]+\.[a-z]{2,})$/i);
  if (!match || !MAILBOX_LOCAL.test(match[1])) return null;
  const local = match[1];
  const domain = match[2];
  return { local, domain, address: `${local}@${domain}` };
}

function selected(
  mode: ApplicationEmailRouteMode,
  explicit: boolean,
  domain: string | null,
  mailbox: ApplicationEmailMailboxRoute | null,
  ignoredLegacyDomain: boolean,
  ignoredLegacyMailbox: boolean,
): ApplicationEmailRouteSelection {
  return {
    mode,
    explicit,
    invalid_mode_present: false,
    domain,
    mailbox,
    route_label: mailbox?.address ?? domain,
    ignored_legacy_domain_present: ignoredLegacyDomain,
    ignored_legacy_mailbox_present: ignoredLegacyMailbox,
  };
}

function unselected(explicit: boolean, invalidModePresent: boolean): ApplicationEmailRouteSelection {
  return {
    mode: null,
    explicit,
    invalid_mode_present: invalidModePresent,
    domain: null,
    mailbox: null,
    route_label: null,
    ignored_legacy_domain_present: false,
    ignored_legacy_mailbox_present: false,
  };
}

/**
 * Selects exactly one application-email route without mutating or exposing configuration values.
 *
 * An explicit mode is the operator's migration boundary. In managed_resend mode the two legacy
 * rollback values may stay deployed, but cannot influence alias generation. With no mode set, the
 * selector preserves the previous behavior, including refusing managed receiving when either
 * legacy route is also present. An invalid non-empty mode always fails closed.
 */
export function applicationEmailRouteSelection(): ApplicationEmailRouteSelection {
  const rawMode = process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE?.trim().toLowerCase();
  const legacyDomainPresent = Boolean(process.env.LITOS_APPLICATION_EMAIL_DOMAIN?.trim());
  const legacyMailboxPresent = Boolean(process.env.LITOS_APPLICATION_EMAIL_MAILBOX?.trim());
  const explicit = Boolean(rawMode);

  if (explicit) {
    if (rawMode === 'managed_resend') {
      const domain = managedDomain();
      return selected(rawMode, true, domain, null, legacyDomainPresent, legacyMailboxPresent);
    }
    if (rawMode === 'custom_domain') {
      const domain = customDomain();
      return selected(rawMode, true, domain, null, false, legacyMailboxPresent);
    }
    if (rawMode === 'mailbox') {
      const mailbox = mailboxRoute();
      return selected(rawMode, true, mailbox?.domain ?? null, mailbox, legacyDomainPresent, false);
    }
    return unselected(true, true);
  }

  if (process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN?.trim()) {
    if (legacyDomainPresent || legacyMailboxPresent) return unselected(false, false);
    return selected('managed_resend', false, managedDomain(), null, false, false);
  }
  const mailbox = mailboxRoute();
  if (mailbox) return selected('mailbox', false, mailbox.domain, mailbox, false, false);
  const domain = customDomain();
  if (domain) return selected('custom_domain', false, domain, null, false, false);
  return unselected(false, false);
}

export function configuredResendManagedReceivingDomain(): string | null {
  const selection = applicationEmailRouteSelection();
  return selection.mode === 'managed_resend' ? selection.domain : null;
}
