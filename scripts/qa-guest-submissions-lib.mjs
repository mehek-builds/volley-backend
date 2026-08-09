import { createHash, createHmac } from 'node:crypto';

export function managedApplicationAlias({ aliasSecret, domain, userId, applicationId }) {
  if (!aliasSecret?.trim()) throw new Error('LITOS_APPLICATION_EMAIL_ALIAS_SECRET is required');
  if (!domain?.trim()) throw new Error('LITOS_RESEND_MANAGED_RECEIVING_DOMAIN is required');
  const token = createHash('sha256')
    .update(`${aliasSecret.trim()}:${userId}:${applicationId}`)
    .digest('hex')
    .slice(0, 12);
  const packet = applicationId.replace(/-/g, '').slice(0, 10).toLowerCase();
  return `app-${packet}-${token}@${domain.trim().toLowerCase()}`;
}

export function signedInboundRequest(payload, secret, timestamp = Date.now()) {
  if (!secret?.trim()) throw new Error('An inbound application-email webhook secret is required');
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', secret.trim())
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-Litos-Webhook-Timestamp': String(timestamp),
      'X-Litos-Webhook-Signature': signature,
    },
  };
}

export function securityCodeCase(applicationId, run) {
  return `email-${run}-${applicationId.replace(/-/g, '').slice(0, 16)}`;
}

export function securityCodePortalUrl(base, caseId) {
  const target = new URL('/qa/portal-submission', base);
  target.searchParams.set('board', 'greenhouse');
  target.searchParams.set('shape', 'security-code');
  target.searchParams.set('case', caseId);
  return target.toString();
}

export function securityCodeMailboxUrl(base, caseId) {
  const target = new URL('/qa/portal-submission/security-code', base);
  target.searchParams.set('case', caseId);
  return target.toString();
}

export function assertControlledSecurityCodeTarget({ apiBase, websiteBase, databaseConfirmed }) {
  const local = (value) => {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  };
  if (!local(apiBase) || !local(websiteBase)) {
    throw new Error('The security-code QA path only runs against local controlled services');
  }
  if (!databaseConfirmed) {
    throw new Error('QA_CONTROLLED_DATABASE=1 is required before the security-code harness mutates the QA database');
  }
}
