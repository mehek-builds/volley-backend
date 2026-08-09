import { createHash, createHmac } from 'node:crypto';

export const CONTROLLED_PORTAL_BINDING_PARAM = 'litos_qa_binding';

export const CONTROLLED_QA_JD = `Software Engineering Intern

Responsibilities:
- Build TypeScript workflows that automate internal application review steps
- Test controlled portal submissions across browser and API checkpoints`;

export const CONTROLLED_QA_LEAD_EVIDENCE =
  'Built TypeScript workflows that automated internal application review steps.';

export function controlledQaPacketSpec({ run, email, portalUrl, alias, forwardTo, now }) {
  const experience = [{
    type: 'job',
    org: 'Northwind Labs',
    title: 'Software Engineering Intern',
    date_range: 'Summer 2026',
    bullets: [
      CONTROLLED_QA_LEAD_EVIDENCE,
      'Added dashboard states that surfaced missing applicant inputs before submit.',
      'Tested controlled portal submissions across browser and API checkpoints.',
    ],
  }];
  const spec = {
    school: 'Litos Test University',
    degree: 'Computer Science',
    grad_date: '2027',
    coursework: '',
    experience,
    skills: ['TypeScript'],
    lead_alignment: {
      entry_org: experience[0].org,
      requirement: 'Build TypeScript workflows that automate internal application review steps',
      evidence: CONTROLLED_QA_LEAD_EVIDENCE,
      jd_hash: createHash('sha256').update(CONTROLLED_QA_JD).digest('hex').slice(0, 16),
    },
    _contact: { full_name: `Guest Tester ${run}`, email },
    _review: {
      jd_text: CONTROLLED_QA_JD,
      role: 'Software Engineering Intern',
      portal_url: portalUrl,
      ats_name: 'controlled_test',
      status: 'ready_to_submit',
      edited_terms: [],
      questions: [],
      skipped_reasons: [],
      updated_at: now,
    },
  };
  if (!alias) return spec;
  return {
    ...spec,
    _applicant_email: {
      address: alias,
      source: 'litos_alias',
      reason: 'deliverable',
      tracked: true,
      decided_at: now,
    },
    _application_email: {
      alias,
      forwards_to: forwardTo,
      mode: 'litos_application_alias',
    },
  };
}

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

export function controlledForwardedEmailForRun(messages, { subject, to, alias }) {
  return messages.find((message) => message.subject === subject
    && Array.isArray(message.to)
    && message.to.includes(to)
    && typeof message.html === 'string'
    && message.html.includes(alias));
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

const KNOWN_PRODUCTION_PORTAL_HOSTNAMES = new Set([
  'trylitos.com',
  'www.trylitos.com',
]);

export function controlledEmailCaptureTarget(rawUrl, token) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error('Provisioning blocker: LITOS_QA_EMAIL_CAPTURE_URL must be a valid URL');
  }
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port
    || target.pathname !== '/emails' || target.search || target.hash || target.username || target.password) {
    throw new Error('Provisioning blocker: the QA email capture adapter must be http://127.0.0.1:<port>/emails');
  }
  if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new Error('Provisioning blocker: LITOS_QA_EMAIL_CAPTURE_TOKEN must contain 32 to 128 safe characters');
  }
  return target;
}

export function controlledReceiptCaptureTarget(rawUrl, token) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error('Provisioning blocker: LITOS_QA_RECEIPT_CAPTURE_URL must be a valid URL');
  }
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port
    || target.pathname !== '/receipts' || target.search || target.hash || target.username || target.password) {
    throw new Error('Provisioning blocker: the QA receipt capture adapter must be http://127.0.0.1:<port>/receipts');
  }
  if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new Error('Provisioning blocker: LITOS_QA_RECEIPT_CAPTURE_TOKEN must contain 32 to 128 safe characters');
  }
  return target;
}

export function controlledScreenshotObjectKey(kind, userId, submissionRunId) {
  const filename = kind === 'filled_preview' ? 'filled' : kind === 'submission_receipt' ? 'receipt' : null;
  if (!filename || !/^[A-Za-z0-9_-]+$/.test(userId ?? '') || !/^[A-Za-z0-9_-]+$/.test(submissionRunId ?? '')) {
    throw new Error('Controlled screenshot evidence requires a valid kind, user, and submission run');
  }
  return `users/${userId}/submission-runs/${submissionRunId}/${filename}.png`;
}

export function controlledScreenshotForRun(captures, { kind, userId, submissionRunId, url }) {
  const objectKey = controlledScreenshotObjectKey(kind, userId, submissionRunId);
  return captures.find((entry) => entry.kind === kind && entry.object_key === objectKey && entry.url === url);
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

export function controlledManagedReceivingProof({
  routeMode,
  domain,
  aliasSecret,
  canaryToken,
  webhookEndpoint,
  webhookSecret,
  receivingApiKey,
  databaseMarker,
}) {
  if (routeMode !== 'managed_resend') throw new Error('The controlled receiving proof requires managed_resend mode');
  if (!domain || !/^[a-z0-9-]+\.resend\.app$/i.test(domain)) throw new Error('A valid managed Resend domain is required');
  if (!aliasSecret?.trim() || !webhookSecret?.trim() || !receivingApiKey?.trim()) {
    throw new Error('Alias, Resend webhook, and Receiving API secrets are required');
  }
  if (!canaryToken || !/^[A-Za-z0-9_-]{32,128}$/.test(canaryToken)) throw new Error('A valid managed receiving canary token is required');
  if (!databaseMarker || !/^[A-Za-z0-9_-]{24,128}$/.test(databaseMarker)) throw new Error('A valid database marker is required');
  const endpoint = new URL(webhookEndpoint);
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/webhooks/application-email/inbound'
    || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    throw new Error('The managed receiving webhook endpoint is invalid');
  }
  const routeFingerprint = createHash('sha256').update(
    `managed-receiving-proof-v3:${routeMode}:${domain.toLowerCase()}:${aliasSecret.trim()}:${canaryToken.toLowerCase()}:${endpoint.origin}${endpoint.pathname}:${webhookSecret.trim()}:${receivingApiKey.trim()}`,
  ).digest('hex');
  const providerMessageHash = createHash('sha256')
    .update(`controlled-qa-receiving-proof-v1:${databaseMarker}:${routeFingerprint}`)
    .digest('hex');
  return {
    provider_message_hash: providerMessageHash,
    route_fingerprint: routeFingerprint,
    proof_version: 3,
    domain: domain.toLowerCase(),
  };
}

export function controlledResendReceivingApiKey(env = process.env) {
  return env.RESEND_RECEIVING_API_KEY?.trim() || env.RESEND_API_KEY?.trim();
}

export function assertControlledManagedReceivingProofRow(row, expected, now = new Date()) {
  if (!row
    || row.provider_message_hash !== expected.provider_message_hash
    || row.route_fingerprint !== expected.route_fingerprint
    || row.proof_version !== expected.proof_version
    || row.domain !== expected.domain) {
    throw new Error('The controlled managed receiving proof was not seeded before backend startup');
  }
  const verifiedAt = new Date(row.verified_at);
  const age = now.getTime() - verifiedAt.getTime();
  if (!Number.isFinite(age) || age < 0 || age > 7 * 24 * 60 * 60 * 1000) {
    throw new Error('The controlled managed receiving proof is not current');
  }
}

export function assertRemoteManagedRunner({
  provider,
  baseUrl,
  apiKey,
  oidcToken,
  expectedOrigin,
  credentialScope,
}) {
  if (provider !== 'stratus-managed') {
    throw new Error('BROWSER_PROVIDER=stratus-managed is required for the security-code harness');
  }
  if (credentialScope !== 'dedicated-nonproduction') {
    throw new Error('Provisioning blocker: QA_STRATUS_CREDENTIAL_SCOPE=dedicated-nonproduction is required');
  }
  const hasApiKey = Boolean(apiKey?.trim());
  const hasOidc = Boolean(oidcToken?.trim() && oidcToken.trim().split('.').length === 3);
  if (!hasApiKey && !hasOidc) {
    throw new Error('Provisioning blocker: the dedicated nonproduction Stratus service requires STRATUS_API_KEY or VERCEL_OIDC_TOKEN');
  }
  let target;
  let expected;
  try {
    target = new URL(baseUrl);
    expected = new URL(expectedOrigin);
  } catch {
    throw new Error('STRATUS_BASE_URL and QA_EXPECTED_STRATUS_ORIGIN must be valid URLs');
  }
  const rootOnly = (url) => !url.username && !url.password && !url.search && !url.hash
    && (url.pathname === '/' || url.pathname === '');
  if (target.protocol !== 'https:' || loopback(target.hostname) || target.origin !== expected.origin
    || !rootOnly(target) || !rootOnly(expected)) {
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
    if (KNOWN_PRODUCTION_PORTAL_HOSTNAMES.has(target.hostname.toLowerCase())) {
      throw new Error('Known production Litos origins cannot be used as controlled QA portals');
    }
    if (target.protocol !== 'https:' || !publicPortalConfirmed || !portalBindingSecret
      || !/^[A-Za-z0-9_-]{32,128}$/.test(portalBindingSecret)) {
      throw new Error('A public controlled portal requires HTTPS, confirmation, and a binding secret');
    }
    if (!configuredPortalOrigin || new URL(configuredPortalOrigin).origin !== target.origin) {
      throw new Error('QA_PORTAL_PUBLIC_BASE must match LITOS_TEST_PORTAL_PUBLIC_ORIGIN exactly');
    }
  }
}
