import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicationAliasDeliverability,
  inboundRouteConfigured,
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
  };
  delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  delete process.env.LITOS_APPLICATION_EMAIL_INBOUND_ENABLED;
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'apply.trylitos.com';
  process.env.RESEND_API_KEY = 're_test';
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
  }
}

const healthyProbes = {
  resolveMx: async () => [{ exchange: 'inbound-smtp.us-east-1.amazonaws.com', priority: 10 }],
  resendDomains: async () => [{ name: 'apply.trylitos.com', status: 'verified' }],
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

test('a verified parent domain never vouches for the receiving subdomain', async () => {
  await withAliasEnv(async () => {
    const result = await applicationAliasDeliverability({
      ...healthyProbes,
      resendDomains: async () => [{ name: 'trylitos.com', status: 'verified' }],
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
