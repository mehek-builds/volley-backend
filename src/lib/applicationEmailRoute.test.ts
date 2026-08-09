import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationEmailRouteSelection } from './applicationEmailRoute';

const KEYS = [
  'LITOS_APPLICATION_EMAIL_ROUTE_MODE',
  'LITOS_RESEND_MANAGED_RECEIVING_DOMAIN',
  'LITOS_APPLICATION_EMAIL_DOMAIN',
  'LITOS_APPLICATION_EMAIL_MAILBOX',
] as const;

async function withRouteEnv(run: () => void | Promise<void>): Promise<void> {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  try {
    await run();
  } finally {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('explicit managed receiving ignores present rollback values without exposing them', async () => {
  await withRouteEnv(() => {
    process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = 'managed_resend';
    process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = 'litos-inbound.resend.app';
    process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'legacy-domain.example';
    process.env.LITOS_APPLICATION_EMAIL_MAILBOX = 'legacy-mailbox@example.com';
    assert.deepEqual(applicationEmailRouteSelection(), {
      mode: 'managed_resend',
      explicit: true,
      invalid_mode_present: false,
      domain: 'litos-inbound.resend.app',
      mailbox: null,
      route_label: 'litos-inbound.resend.app',
      ignored_legacy_domain_present: true,
      ignored_legacy_mailbox_present: true,
    });
  });
});

test('invalid and conflicting implicit route selection fail closed', async () => {
  await withRouteEnv(() => {
    process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = 'managed-resend';
    process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = 'litos-inbound.resend.app';
    assert.equal(applicationEmailRouteSelection().route_label, null);
    assert.equal(applicationEmailRouteSelection().invalid_mode_present, true);

    delete process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE;
    process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'rollback.example';
    const conflict = applicationEmailRouteSelection();
    assert.equal(conflict.mode, null);
    assert.equal(conflict.route_label, null);
    assert.equal(conflict.explicit, false);
  });
});

test('explicit rollback modes select only their named route', async () => {
  await withRouteEnv(() => {
    process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = 'litos-inbound.resend.app';
    process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'custom.example';
    process.env.LITOS_APPLICATION_EMAIL_MAILBOX = 'applications@mailbox.example';

    process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = 'custom_domain';
    const custom = applicationEmailRouteSelection();
    assert.equal(custom.route_label, 'custom.example');
    assert.equal(custom.mailbox, null);
    assert.equal(custom.ignored_legacy_mailbox_present, true);

    process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = 'mailbox';
    const mailbox = applicationEmailRouteSelection();
    assert.equal(mailbox.route_label, 'applications@mailbox.example');
    assert.equal(mailbox.domain, 'mailbox.example');
    assert.equal(mailbox.ignored_legacy_domain_present, true);
  });
});
