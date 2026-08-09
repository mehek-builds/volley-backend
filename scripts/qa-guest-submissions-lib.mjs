import { createHash, createHmac } from 'node:crypto';

export const CONTROLLED_PORTAL_BINDING_PARAM = 'litos_qa_binding';

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
  const secret = process.env.LITOS_TEST_PORTAL_BINDING_SECRET?.trim();
  if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) && secret) {
    target.searchParams.set(CONTROLLED_PORTAL_BINDING_PARAM, controlledPortalBinding(target.toString(), secret));
  }
  return target.toString();
}

export function securityCodeMailboxUrl(base, caseId) {
  const target = new URL('/qa/portal-submission/security-code', base);
  target.searchParams.set('case', caseId);
  return target.toString();
}

export function controlledPortalBindingInput(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = '';
  url.searchParams.delete(CONTROLLED_PORTAL_BINDING_PARAM);
  url.searchParams.sort();
  return `${url.origin}${url.pathname}${url.search}`;
}

export function controlledPortalBinding(rawUrl, secret) {
  if (!secret || !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) {
    throw new Error('LITOS_TEST_PORTAL_BINDING_SECRET must contain 32 to 128 safe characters');
  }
  return createHmac('sha256', secret).update(controlledPortalBindingInput(rawUrl)).digest('hex');
}

function loopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function controlledDatabaseTarget(databaseUrl) {
  let target;
  try {
    target = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  const database = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !loopback(target.hostname)) {
    throw new Error('The security-code harness requires a loopback PostgreSQL server');
  }
  if (!/^litos_qa_[a-z0-9_]+$/.test(database)) {
    throw new Error('The controlled database name must start with litos_qa_');
  }
  return { host: target.hostname, port: target.port || '5432', database };
}

export function assertDisposableDatabaseMarker(row, expectedMarker, now = new Date()) {
  if (!expectedMarker || !/^[A-Za-z0-9_-]{24,128}$/.test(expectedMarker)) {
    throw new Error('QA_CONTROLLED_DATABASE_MARKER must contain 24 to 128 safe characters');
  }
  if (!row || row.marker !== expectedMarker) {
    throw new Error('The disposable QA database marker is missing or does not match');
  }
  const expiresAt = new Date(row.expires_at);
  const remaining = expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 24 * 60 * 60 * 1000) {
    throw new Error('The disposable QA database marker must expire within the next 24 hours');
  }
}

export function assertRemoteManagedRunner({ provider, baseUrl, apiKey, oidcToken, vercelEnv, expectedOrigin }) {
  if (provider !== 'stratus-managed') {
    throw new Error('BROWSER_PROVIDER=stratus-managed is required for the security-code harness');
  }
  const hasApiKey = Boolean(apiKey?.trim());
  const hasOidc = Boolean(oidcToken?.trim() && oidcToken.trim().split('.').length === 3 && vercelEnv === 'production');
  if (!hasApiKey && !hasOidc) {
    throw new Error('The remote managed runner requires STRATUS_API_KEY or a Vercel OIDC token with VERCEL_ENV=production');
  }
  let target;
  let expected;
  try {
    target = new URL(baseUrl);
    expected = new URL(expectedOrigin);
  } catch {
    throw new Error('STRATUS_BASE_URL and QA_EXPECTED_STRATUS_ORIGIN must be valid URLs');
  }
  if (target.protocol !== 'https:' || loopback(target.hostname) || target.origin !== expected.origin) {
    throw new Error('The remote managed runner must be HTTPS, non-loopback, and match QA_EXPECTED_STRATUS_ORIGIN');
  }
  return { origin: target.origin, authMode: hasApiKey ? 'api_key' : 'vercel_oidc' };
}

export function assertControlledSecurityCodeTarget({
  apiBase,
  websiteBase,
  portalPublicBase,
  databaseConfirmed,
  publicPortalConfirmed,
  databaseUrl,
  databaseMarker,
  portalBindingSecret,
  configuredPortalOrigin,
}) {
  const local = (value) => {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  };
  if (!local(apiBase) || !local(websiteBase)) {
    throw new Error('The security-code QA path only runs against a local API and website');
  }
  if (!databaseConfirmed) {
    throw new Error('QA_CONTROLLED_DATABASE=1 is required before the security-code harness mutates the QA database');
  }
  controlledDatabaseTarget(databaseUrl);
  if (!databaseMarker || !/^[A-Za-z0-9_-]{24,128}$/.test(databaseMarker)) {
    throw new Error('QA_CONTROLLED_DATABASE_MARKER must contain 24 to 128 safe characters');
  }
  if (!local(portalPublicBase)) {
    const target = new URL(portalPublicBase);
    if (target.protocol !== 'https:' || !publicPortalConfirmed || !portalBindingSecret
      || !/^[A-Za-z0-9_-]{32,128}$/.test(portalBindingSecret)) {
      throw new Error('A public controlled portal requires HTTPS, confirmation, and a binding secret');
    }
    if (!configuredPortalOrigin || new URL(configuredPortalOrigin).origin !== target.origin) {
      throw new Error('QA_PORTAL_PUBLIC_BASE must match LITOS_TEST_PORTAL_PUBLIC_ORIGIN exactly');
    }
  }
}
