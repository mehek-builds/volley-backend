import { applicationAliasDeliverability } from './applicationEmailDeliverability';
import { hasActiveEmailConnection } from './composioConnections';

export type VerificationEmailSource = 'application_alias' | 'connected_inbox';

type VerificationEmailSourceDependencies = {
  applicationAliasDeliverability: typeof applicationAliasDeliverability;
  hasActiveEmailConnection: typeof hasActiveEmailConnection;
};

const defaultDependencies: VerificationEmailSourceDependencies = {
  applicationAliasDeliverability,
  hasActiveEmailConnection,
};

/**
 * The application alias is the preferred verification inbox because it is the address Litos puts
 * on the employer form. Gmail and Outlook remain a fallback for older packets that used the
 * account address. Both probes fail closed so a temporary provider outage cannot grant consent.
 */
export async function verificationEmailSource(
  userId: string,
  dependencies: VerificationEmailSourceDependencies = defaultDependencies,
): Promise<VerificationEmailSource | null> {
  const alias = await dependencies.applicationAliasDeliverability().catch(() => null);
  if (alias?.deliverable) return 'application_alias';

  const connected = await dependencies.hasActiveEmailConnection(userId).catch(() => false);
  return connected ? 'connected_inbox' : null;
}
