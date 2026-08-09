import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicationAliasDeliverability,
  classifyAliasMxProvider,
  inboundRouteConfigured,
  mxRoutesToResend,
  resendDomainIsVerified,
  resetApplicationAliasDeliverabilityCache,
} from './applicationEmailDeliverability';

const ENDPOINT = 'https://student-outreach-backend.vercel.app/webhooks/application-email/inbound';

async function withAliasEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved = {
    domain: process.env.LITOS_APPLICATION_EMAIL_DOMAIN,
    mailbox: process.env.LITOS_APPLICATION_EMAIL_MAILBOX,
    enabled: process.env.LITOS_APPLICATION_EMAIL_INBOUND_ENABLED,
    key: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM,
    managedDomain: process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN,
    canaryId: process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_ID,
    routeMode: process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE,
  };
  delete process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
  delete process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_ID;
  delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  delete process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE;
  delete process.env.LITOS_APPLICATION_EMAIL_INBOUND_ENABLED;
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'apply.trylitos.com';
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'Litos <applications@trylitos.com>';
  resetApplicationAliasDeliverabilityCache();
  try {
    return await run();
  } finally {
    resetApplicationAliasDeliverabilityCache();
    if (saved.domain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = saved.domain;
    if (saved.mailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = saved.mailbox;
    if (saved.enabled === undefined) delete process.env.LITOS_APPLICATION_EMAIL_INBOUND_ENABLED;
    else process.env.LITOS_APPLICATION_EMAIL_INBOUND_ENABLED = saved.enabled;
    if (saved.key === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = saved.key;
    if (saved.from === undefined) delete process.env.RESEND_FROM;
    else process.env.RESEND_FROM = saved.from;
    if (saved.managedDomain === undefined) delete process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
    else process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = saved.managedDomain;
    if (saved.canaryId === undefined) delete process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_ID;
    else process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_ID = saved.canaryId;
    if (saved.routeMode === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE;
    else process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = saved.routeMode;
  }
}

async function withManagedAliasEnv<T>(run: () => Promise<T>): Promise<T> {
  return withAliasEnv(async () => {
    delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = 'litos-inbound.resend.app';
    process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_ID = 'received-canary-1';
    resetApplicationAliasDeliverabilityCache();
    return run();
  });
}

const healthyManagedProbes = {
  resendReceivedEmail: async () => ({
    id: 'received-canary-1',
    to: ['canary@litos-inbound.resend.app'],
  }),
  resendWebhooks: async () => [{ endpoint: ENDPOINT, events: ['email.received'], status: 'enabled' }],
};

const healthyProbes = {
  resolveMx: async () => [{ exchange: 'inbound-smtp.us-east-1.amazonaws.com', priority: 10 }],
  resendDomains: async () => [{
    name: 'apply.trylitos.com',
    status: 'verified',
    capabilities: { receiving: 'enabled' },
  }],
  resendWebhooks: async () => [{ endpoint: ENDPOINT, events: ['email.received'] }],
};

test('a domain with MX, Resend verification and an inbound route is deliverable', async () => {
  await withAliasEnv(async () => {
    const result = await applicationAliasDeliverability(healthyProbes);
    assert.equal(result.deliverable, true);
    assert.equal(result.reason, 'deliverable');
    assert.deepEqual(result.mx_hosts, ['inbound-smtp.us-east-1.amazonaws.com']);
    assert.equal(result.inbound_route_configured, true);
  });
});

test('managed receiving succeeds only from account-scoped canary proof and the exact active webhook', async () => {
  await withManagedAliasEnv(async () => {
    const result = await applicationAliasDeliverability({
      ...healthyManagedProbes,
      resolveMx: async () => { throw new Error('managed mode must not trust MX'); },
      resendDomains: async () => { throw new Error('managed mode must not trust /domains'); },
    });
    assert.equal(result.deliverable, true);
    assert.equal(result.domain, 'litos-inbound.resend.app');
    assert.equal(result.inbound_route_configured, true);
    assert.deepEqual(result.mx_hosts, []);
    assert.equal(result.resend_domain_status, null);
  });
});

test('explicit managed receiving proves deliverability while legacy rollback values coexist', async () => {
  await withManagedAliasEnv(async () => {
    process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = 'managed_resend';
    process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'legacy.example';
    process.env.LITOS_APPLICATION_EMAIL_MAILBOX = 'legacy@mailbox.example';
    resetApplicationAliasDeliverabilityCache();
    const result = await applicationAliasDeliverability({
      ...healthyManagedProbes,
      resolveMx: async () => { throw new Error('managed mode must not consult legacy MX'); },
      resendDomains: async () => { throw new Error('managed mode must not consult legacy domains'); },
    });
    assert.equal(result.deliverable, true);
    assert.equal(result.domain, 'litos-inbound.resend.app');
    assert.equal(result.reason, 'deliverable');
  });
});

test('invalid route mode remains unconfigured and performs no provider checks', async () => {
  await withManagedAliasEnv(async () => {
    process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = 'managed';
    resetApplicationAliasDeliverabilityCache();
    const result = await applicationAliasDeliverability({
      resendReceivedEmail: async () => { throw new Error('invalid mode must not retrieve a canary'); },
      resendWebhooks: async () => { throw new Error('invalid mode must not list webhooks'); },
    });
    assert.equal(result.deliverable, false);
    assert.equal(result.domain, null);
    assert.equal(result.reason, 'alias_not_configured');
  });
});

test('managed receiving fails closed when its canary proof is missing', async () => {
  await withManagedAliasEnv(async () => {
    delete process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_ID;
    resetApplicationAliasDeliverabilityCache();
    const result = await applicationAliasDeliverability({
      resendReceivedEmail: async () => { throw new Error('must not retrieve without an id'); },
    });
    assert.equal(result.deliverable, false);
    assert.equal(result.reason, 'managed_receiving_proof_missing');
  });
});

test('managed receiving rejects a canary from a different ID or account', async () => {
  await withManagedAliasEnv(async () => {
    const wrongId = await applicationAliasDeliverability({
      ...healthyManagedProbes,
      resendReceivedEmail: async () => ({
        id: 'received-from-another-team',
        to: ['canary@litos-inbound.resend.app'],
      }),
    });
    assert.equal(wrongId.reason, 'managed_receiving_proof_mismatch');

    resetApplicationAliasDeliverabilityCache();
    const wrongTeam = await applicationAliasDeliverability({
      ...healthyManagedProbes,
      resendReceivedEmail: async () => { throw new Error('Resend received-email lookup answered 404'); },
    });
    assert.equal(wrongTeam.reason, 'check_unavailable');
    assert.match(wrongTeam.detail ?? '', /404/);
  });
});

test('managed receiving fails closed when the configured API key is unauthorized', async () => {
  await withManagedAliasEnv(async () => {
    const result = await applicationAliasDeliverability({
      ...healthyManagedProbes,
      resendReceivedEmail: async (id) => { throw new Error(`Resend /emails/receiving/${id} answered 401`); },
    });
    assert.equal(result.deliverable, false);
    assert.equal(result.reason, 'check_unavailable');
    assert.match(result.detail ?? '', /401/);
    assert.doesNotMatch(result.detail ?? '', /received-canary-1/);
  });
});

test('managed receiving redacts its proof ID from provider and not-found errors', async () => {
  await withManagedAliasEnv(async () => {
    for (const message of [
      'provider failure while reading received-canary-1',
      'Resend /emails/receiving/received-canary-1 answered 404',
    ]) {
      resetApplicationAliasDeliverabilityCache();
      const result = await applicationAliasDeliverability({
        ...healthyManagedProbes,
        resendReceivedEmail: async () => { throw new Error(message); },
      });
      assert.equal(result.reason, 'check_unavailable');
      assert.doesNotMatch(result.detail ?? '', /received-canary-1/);
      assert.match(result.detail ?? '', /\[redacted\]|provider failure|404/);
    }
  });
});

test('managed receiving rejects canary mail delivered to another domain', async () => {
  await withManagedAliasEnv(async () => {
    const result = await applicationAliasDeliverability({
      ...healthyManagedProbes,
      resendReceivedEmail: async () => ({ id: 'received-canary-1', to: ['canary@other.resend.app'] }),
    });
    assert.equal(result.deliverable, false);
    assert.equal(result.reason, 'managed_receiving_proof_mismatch');
  });
});

test('managed receiving still requires the exact active email.received webhook', async () => {
  await withManagedAliasEnv(async () => {
    const missing = await applicationAliasDeliverability({
      ...healthyManagedProbes,
      resendWebhooks: async () => [{ endpoint: 'https://example.com/other', events: ['email.received'] }],
    });
    assert.equal(missing.reason, 'inbound_route_missing');
    resetApplicationAliasDeliverabilityCache();
    const wrongEvent = await applicationAliasDeliverability({
      ...healthyManagedProbes,
      resendWebhooks: async () => [{ endpoint: ENDPOINT, events: ['email.sent'] }],
    });
    assert.equal(wrongEvent.reason, 'inbound_route_missing');
  });
});

test('managed receiving accepts only one valid label below resend.app', async () => {
  await withManagedAliasEnv(async () => {
    for (const malformed of [
      'resend.app',
      'two.labels.resend.app',
      '*.resend.app',
      '-leading.resend.app',
      'trailing-.resend.app',
    ]) {
      process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = malformed;
      resetApplicationAliasDeliverabilityCache();
      const result = await applicationAliasDeliverability(healthyManagedProbes);
      assert.equal(result.deliverable, false, malformed);
      assert.equal(result.reason, 'alias_not_configured', malformed);
    }
  });
});

test('managed and custom receiving routes are mutually exclusive', async () => {
  await withManagedAliasEnv(async () => {
    process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'custom.example.com';
    resetApplicationAliasDeliverabilityCache();
    const result = await applicationAliasDeliverability(healthyManagedProbes);
    assert.equal(result.deliverable, false);
    assert.equal(result.reason, 'alias_not_configured');
  });
});

test('healthy inbound with forwarding disabled cannot issue a tracked alias', async () => {
  await withAliasEnv(async () => {
    assert.equal((await applicationAliasDeliverability(healthyProbes)).deliverable, true);
    delete process.env.RESEND_FROM;
    const result = await applicationAliasDeliverability(healthyProbes);
    assert.equal(result.deliverable, false);
    assert.equal(result.reason, 'forwarding_not_configured');
  });
});

test('no MX record means not deliverable, which is the 2026-08-08 production state', async () => {
  await withAliasEnv(async () => {
    const result = await applicationAliasDeliverability({ ...healthyProbes, resolveMx: async () => [] });
    assert.equal(result.deliverable, false);
    assert.equal(result.reason, 'no_mx_record');
  });
});

test('a DNS answer of NXDOMAIN is reported as a missing record, not as an unavailable check', async () => {
  await withAliasEnv(async () => {
    const result = await applicationAliasDeliverability({
      ...healthyProbes,
      resolveMx: async () => { throw Object.assign(new Error('queryMx ENOTFOUND'), { code: 'ENOTFOUND' }); },
    });
    assert.equal(result.deliverable, false);
    assert.equal(result.reason, 'no_mx_record');
  });
});

test('a DNS lookup that throws for any other reason fails safe', async () => {
  await withAliasEnv(async () => {
    const result = await applicationAliasDeliverability({
      ...healthyProbes,
      resolveMx: async () => { throw Object.assign(new Error('queryMx ESERVFAIL'), { code: 'ESERVFAIL' }); },
    });
    assert.equal(result.deliverable, false);
    assert.equal(result.reason, 'check_unavailable');
  });
});

test('MX alone is not enough: the domain must be verified in Resend', async () => {
  await withAliasEnv(async () => {
    const pending = await applicationAliasDeliverability({
      ...healthyProbes,
      resendDomains: async () => [{ name: 'apply.trylitos.com', status: 'pending' }],
    });
    assert.equal(pending.deliverable, false);
    assert.equal(pending.reason, 'domain_not_verified_in_resend');
    assert.equal(pending.resend_domain_status, 'pending');
  });
});

test('Google Workspace MX is reported as a provider mismatch before any Resend API outage', async () => {
  await withAliasEnv(async () => {
    const result = await applicationAliasDeliverability({
      ...healthyProbes,
      resolveMx: async () => [
        { exchange: 'aspmx.l.google.com', priority: 1 },
        { exchange: 'alt1.aspmx.l.google.com', priority: 5 },
      ],
      resendDomains: async () => { throw new Error('this provider call must not hide the topology mismatch'); },
    });
    assert.equal(result.deliverable, false);
    assert.equal(result.reason, 'mx_provider_mismatch');
    assert.equal(result.mx_provider, 'google_workspace');
    assert.equal(result.mx_provider_agrees, false);
    assert.match(result.detail ?? '', /dedicated Resend receiving subdomain/);
    assert.doesNotMatch(result.detail ?? '', /this provider call/);
  });
});

test('a Resend MX that loses priority to another provider is not a valid inbound route', async () => {
  const records = [
    { exchange: 'aspmx.l.google.com', priority: 1 },
    { exchange: 'inbound-smtp.us-east-1.amazonaws.com', priority: 10 },
  ];
  assert.equal(classifyAliasMxProvider(records), 'mixed');
  assert.equal(mxRoutesToResend(records), false);
});

test('a dedicated subdomain whose best MX routes to Resend satisfies the provider contract', async () => {
  const records = [{ exchange: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 }];
  assert.equal(classifyAliasMxProvider(records), 'resend');
  assert.equal(mxRoutesToResend(records), true);
});

test('verified sending without Resend receiving enabled fails closed', async () => {
  await withAliasEnv(async () => {
    const result = await applicationAliasDeliverability({
      ...healthyProbes,
      resendDomains: async () => [{
        name: 'apply.trylitos.com',
        status: 'verified',
        capabilities: { sending: 'enabled', receiving: 'disabled' },
      }],
    });
    assert.equal(result.deliverable, false);
    assert.equal(result.reason, 'receiving_not_enabled_in_resend');
    assert.equal(result.resend_receiving_status, 'disabled');
  });
});

test('a verified parent domain never vouches for the receiving subdomain', async () => {
  await withAliasEnv(async () => {
    const result = await applicationAliasDeliverability({
      ...healthyProbes,
      resendDomains: async () => [{
        name: 'trylitos.com',
        status: 'verified',
        capabilities: { receiving: 'enabled' },
      }],
    });
    assert.equal(result.deliverable, false);
    assert.equal(result.reason, 'domain_not_verified_in_resend');
    assert.equal(result.resend_domain_status, null);
  });
  assert.equal(resendDomainIsVerified([{ name: 'trylitos.com', status: 'verified' }], 'apply.trylitos.com'), false);
});

test('mail Resend accepts but never hands to us is not deliverable either', async () => {
  await withAliasEnv(async () => {
    const result = await applicationAliasDeliverability({
      ...healthyProbes,
      resendWebhooks: async () => [{ endpoint: 'https://example.com/other', events: ['email.received'] }],
    });
    assert.equal(result.deliverable, false);
    assert.equal(result.reason, 'inbound_route_missing');
  });
});

test('a Resend API failure fails safe rather than assuming the inbox works', async () => {
  await withAliasEnv(async () => {
    const result = await applicationAliasDeliverability({
      ...healthyProbes,
      resendDomains: async () => { throw new Error('Resend /domains answered 401'); },
    });
    assert.equal(result.deliverable, false);
    assert.equal(result.reason, 'check_unavailable');
    assert.match(result.detail ?? '', /401/);
  });
});

test('the operator kill switch turns aliases off without touching DNS', async () => {
  await withAliasEnv(async () => {
    process.env.LITOS_APPLICATION_EMAIL_INBOUND_ENABLED = 'false';
    resetApplicationAliasDeliverabilityCache();
    const result = await applicationAliasDeliverability({
      resolveMx: async () => { throw new Error('DNS must not be consulted when the switch is off'); },
      resendDomains: async () => { throw new Error('Resend must not be consulted when the switch is off'); },
      resendWebhooks: async () => { throw new Error('Resend must not be consulted when the switch is off'); },
    });
    assert.equal(result.deliverable, false);
    assert.equal(result.reason, 'inbound_disabled');
  });
});

test('an unconfigured alias domain is answered without any lookup', async () => {
  await withAliasEnv(async () => {
    delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    resetApplicationAliasDeliverabilityCache();
    const result = await applicationAliasDeliverability({
      resolveMx: async () => { throw new Error('DNS must not be consulted with no domain configured'); },
    });
    assert.equal(result.deliverable, false);
    assert.equal(result.reason, 'alias_not_configured');
  });
});

test('the check is cached, so a burst of submissions costs one lookup', async () => {
  await withAliasEnv(async () => {
    let mxLookups = 0;
    const probes = {
      ...healthyProbes,
      resolveMx: async () => {
        mxLookups += 1;
        return [{ exchange: 'inbound-smtp.us-east-1.amazonaws.com', priority: 10 }];
      },
    };
    const results = await Promise.all([
      applicationAliasDeliverability(probes),
      applicationAliasDeliverability(probes),
    ]);
    await applicationAliasDeliverability(probes);
    assert.equal(mxLookups, 1);
    assert.ok(results.every((result) => result.deliverable));
  });
});

test('an undeliverable result expires quickly so publishing the MX record is enough to switch aliases back on', async () => {
  await withAliasEnv(async () => {
    const start = Date.parse('2026-08-08T10:00:00.000Z');
    let hasMx = false;
    const probes = {
      resolveMx: async () => (hasMx ? [{ exchange: 'inbound-smtp.us-east-1.amazonaws.com', priority: 10 }] : []),
      resendDomains: healthyProbes.resendDomains,
      resendWebhooks: healthyProbes.resendWebhooks,
      now: () => start,
    };
    assert.equal((await applicationAliasDeliverability(probes)).reason, 'no_mx_record');
    hasMx = true;
    // Still cached one minute later.
    assert.equal((await applicationAliasDeliverability({ ...probes, now: () => start + 60_000 })).reason, 'no_mx_record');
    // Re-probed six minutes later, with no deploy and nobody flipping a variable.
    assert.equal((await applicationAliasDeliverability({ ...probes, now: () => start + 6 * 60_000 })).deliverable, true);
  });
});

test('inbound route matching ignores a trailing slash and requires the email.received event', () => {
  assert.equal(inboundRouteConfigured([{ endpoint: `${ENDPOINT}/`, events: ['email.received'] }], ENDPOINT), true);
  assert.equal(inboundRouteConfigured([{ endpoint: ENDPOINT, events: ['email.sent'] }], ENDPOINT), false);
  assert.equal(inboundRouteConfigured([{ endpoint: ENDPOINT, events: ['email.received'], status: 'disabled' }], ENDPOINT), false);
  assert.equal(inboundRouteConfigured([], ENDPOINT), false);
});
