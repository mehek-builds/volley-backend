import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicationAliasFor,
  applicationEmailForwardingDecision,
  applicationEmailRouteLabel,
  applicationEmailRouteGenerationFingerprint,
  classifyApplicationEmail,
  forwardingAddressWouldLoop,
  forwardEmailPayload,
  ApplicantEmailRegenerationRequiredError,
  isAliasAddress,
  relayRecipientFor,
  resolveApplicantEmail,
  resolveFrozenApplicantEmail,
  readPinnedApplicantEmail,
  retrieveResendReceivedEmail,
  routeInboundApplicationEmail,
} from './applicationEmail';
import type { AliasDeliverability } from './applicationEmailDeliverability';

test('application aliases are deterministic and live on the configured domain', () => {
  const previousMailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  const previousDomain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  const previousSecret = process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
  delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'apply.litos.test';
  process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'secret';
  try {
    const first = applicationAliasFor(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
    const second = applicationAliasFor(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
    assert.equal(first, second);
    assert.match(first ?? '', /^app-2222222222-[a-f0-9]{12}@apply\.litos\.test$/);
  } finally {
    if (previousMailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = previousMailbox;
    if (previousDomain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = previousDomain;
    if (previousSecret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = previousSecret;
  }
});

test('applicant email regeneration errors use current user-facing vocabulary', () => {
  const error = new ApplicantEmailRegenerationRequiredError('the saved address is unavailable');
  assert.match(error.message, /^This application must be regenerated/);
  assert.doesNotMatch(error.message, /application packet/i);
});

test('application aliases can route through one main mailbox', () => {
  const previousMailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  const previousDomain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  const previousSecret = process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
  process.env.LITOS_APPLICATION_EMAIL_MAILBOX = 'applications@trylitos.com';
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'apply.litos.test';
  process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'secret';
  try {
    const alias = applicationAliasFor(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
    assert.match(alias ?? '', /^applications\+app-2222222222-[a-f0-9]{12}@trylitos\.com$/);
    assert.equal(applicationEmailRouteLabel(), 'applications@trylitos.com');
  } finally {
    if (previousMailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = previousMailbox;
    if (previousDomain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = previousDomain;
    if (previousSecret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = previousSecret;
  }
});

test('application aliases are deterministic on an explicit Resend-managed receiving domain', () => {
  const saved = {
    managed: process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN,
    domain: process.env.LITOS_APPLICATION_EMAIL_DOMAIN,
    mailbox: process.env.LITOS_APPLICATION_EMAIL_MAILBOX,
    secret: process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET,
  };
  process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = 'litos-inbound.resend.app';
  delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'managed-secret';
  try {
    const first = applicationAliasFor(USER_ID, APPLICATION_ID);
    const second = applicationAliasFor(USER_ID, APPLICATION_ID);
    assert.equal(first, second);
    assert.match(first ?? '', /^app-2222222222-[a-f0-9]{12}@litos-inbound\.resend\.app$/);
  } finally {
    if (saved.managed === undefined) delete process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
    else process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = saved.managed;
    if (saved.domain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = saved.domain;
    if (saved.mailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = saved.mailbox;
    if (saved.secret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = saved.secret;
  }
});

test('route generation fingerprint changes when the alias secret rotates on the same domain', () => {
  const savedDomain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  const savedMailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  const savedManaged = process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
  const savedSecret = process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'route.example.com';
  delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  delete process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
  try {
    process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'first-secret';
    const first = applicationEmailRouteGenerationFingerprint();
    process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'second-secret';
    const second = applicationEmailRouteGenerationFingerprint();
    assert.match(first ?? '', /^[a-f0-9]{20}$/);
    assert.match(second ?? '', /^[a-f0-9]{20}$/);
    assert.notEqual(first, second);
  } finally {
    if (savedDomain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = savedDomain;
    if (savedMailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = savedMailbox;
    if (savedManaged === undefined) delete process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
    else process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = savedManaged;
    if (savedSecret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = savedSecret;
  }
});

test('route generation fingerprint changes when the selected route mode changes', () => {
  const saved = {
    mode: process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE,
    managed: process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN,
    domain: process.env.LITOS_APPLICATION_EMAIL_DOMAIN,
    mailbox: process.env.LITOS_APPLICATION_EMAIL_MAILBOX,
    secret: process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET,
  };
  process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = 'same.resend.app';
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'same.resend.app';
  delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'same-secret';
  try {
    process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = 'managed_resend';
    const managed = applicationEmailRouteGenerationFingerprint();
    process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = 'custom_domain';
    const custom = applicationEmailRouteGenerationFingerprint();
    assert.match(managed ?? '', /^[a-f0-9]{20}$/);
    assert.match(custom ?? '', /^[a-f0-9]{20}$/);
    assert.notEqual(managed, custom);
  } finally {
    if (saved.mode === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE;
    else process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = saved.mode;
    if (saved.managed === undefined) delete process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
    else process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = saved.managed;
    if (saved.domain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = saved.domain;
    if (saved.mailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = saved.mailbox;
    if (saved.secret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = saved.secret;
  }
});

test('application aliases are disabled until a real secret is configured', () => {
  const previousMailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  const previousDomain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  const previousAliasSecret = process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
  const previousCompatSecret = process.env.LITOS_APPLICATION_EMAIL_SECRET;
  const previousJwtSecret = process.env.JWT_SIGNING_SECRET;
  delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'apply.litos.test';
  delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
  delete process.env.LITOS_APPLICATION_EMAIL_SECRET;
  delete process.env.JWT_SIGNING_SECRET;
  try {
    assert.equal(applicationAliasFor(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ), null);
  } finally {
    if (previousMailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = previousMailbox;
    if (previousDomain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = previousDomain;
    if (previousAliasSecret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = previousAliasSecret;
    if (previousCompatSecret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_SECRET = previousCompatSecret;
    if (previousJwtSecret === undefined) delete process.env.JWT_SIGNING_SECRET;
    else process.env.JWT_SIGNING_SECRET = previousJwtSecret;
  }
});

test('application email classifier recognizes employer outcomes', () => {
  assert.equal(
    classifyApplicationEmail('Thank you for applying', 'We received your application.'),
    'submission_confirmation',
  );
  assert.equal(
    classifyApplicationEmail('Interview availability', 'Can you schedule a call with our recruiter?'),
    'interview_request',
  );
  assert.equal(
    classifyApplicationEmail('Your verification code', 'Use passcode 123456.'),
    'verification_code',
  );
  assert.equal(
    classifyApplicationEmail('Interview confirmed', 'Your interview is scheduled for Tuesday at 10:00.'),
    'interview_request',
  );
  assert.equal(
    classifyApplicationEmail('Phone screen invitation', 'We invite you to a phone screen with the team.'),
    'interview_request',
  );
});

test('application email forwarding is a strict outcome whitelist', () => {
  assert.deepEqual(applicationEmailForwardingDecision('submission_confirmation'), { forward: true });
  assert.deepEqual(applicationEmailForwardingDecision('interview_request'), { forward: true });
  for (const classification of ['verification_code', 'recruiter_reply', 'applicant_reply', 'other'] as const) {
    assert.deepEqual(
      applicationEmailForwardingDecision(classification),
      { forward: false, reason: 'internal_only' },
      classification,
    );
  }
});

test('security codes and generic recruiter follow-ups are never promoted to interview mail', () => {
  assert.equal(
    classifyApplicationEmail('Confirm your interview', 'Use security code 123456 to continue.'),
    'verification_code',
  );
  assert.equal(
    classifyApplicationEmail('Following up after your interview', 'Our recruiter will share next steps soon.'),
    'recruiter_reply',
  );
  assert.equal(
    classifyApplicationEmail('Your application update', 'We decided not to proceed after your interview.'),
    'other',
  );
  assert.equal(
    classifyApplicationEmail('Interview feedback details', 'We are not moving forward.'),
    'other',
  );
  assert.equal(
    classifyApplicationEmail('Your interview details', 'We decided to pursue other candidates.'),
    'other',
  );
  assert.equal(
    classifyApplicationEmail('Interview feedback', 'Our decision update is scheduled for Tuesday.'),
    'other',
  );
  assert.equal(
    classifyApplicationEmail('A note from the hiring team', 'We enjoyed learning about your background.'),
    'recruiter_reply',
  );
});

test('resend received email hydration fetches the full body before routing', async () => {
  const previousKey = process.env.RESEND_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = 're_test';
  try {
    globalThis.fetch = (async (url, init) => {
      assert.equal(String(url), 'https://api.resend.com/emails/receiving/email_123');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer re_test');
      assert.equal((init?.headers as Record<string, string>)['User-Agent'], 'Litos/1.0');
      return new Response(JSON.stringify({
        id: 'email_123',
        to: ['app-abc@apply.litos.test'],
        from: 'recruiter@example.com',
        created_at: '2026-08-06T10:00:00.000Z',
        subject: 'Interview availability',
        text: 'Can you schedule a call?',
        html: '<p>Can you schedule a call?</p>',
        message_id: '<message@example.com>',
        headers: { 'authentication-results': 'mx.resend.com; spf=pass dkim=pass dmarc=pass' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const hydrated = await retrieveResendReceivedEmail({
      emailId: 'email_123',
      fallback: { provider: 'resend', to: [], raw: { type: 'email.received' } },
    });
    assert.equal(hydrated.providerMessageId, '<message@example.com>');
    assert.equal(hydrated.from, 'recruiter@example.com');
    assert.equal(hydrated.text, 'Can you schedule a call?');
    assert.deepEqual(hydrated.to, ['app-abc@apply.litos.test']);
    assert.deepEqual(hydrated.authentication, { spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  } finally {
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  }
});

test('resend received email hydration prefers the dedicated Receiving API key', async () => {
  const previousReceivingKey = process.env.RESEND_RECEIVING_API_KEY;
  const previousKey = process.env.RESEND_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.RESEND_RECEIVING_API_KEY = 're_receiving_scope';
  process.env.RESEND_API_KEY = 're_sending_scope';
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer re_receiving_scope');
    return new Response(JSON.stringify({ id: 'email_dedicated', to: ['alias@example.com'] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await retrieveResendReceivedEmail({
      emailId: 'email_dedicated',
      fallback: { provider: 'resend', to: ['alias@example.com'], raw: {} },
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousReceivingKey === undefined) delete process.env.RESEND_RECEIVING_API_KEY;
    else process.env.RESEND_RECEIVING_API_KEY = previousReceivingKey;
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
  }
});

/* ---- the deliverability precondition on the address employers are given ---- */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const APPLICATION_ID = '22222222-2222-4222-8222-222222222222';

function deliverability(overrides: Partial<AliasDeliverability> = {}): AliasDeliverability {
  return {
    deliverable: true,
    domain: 'apply.trylitos.com',
    reason: 'deliverable',
    mx_hosts: ['inbound-smtp.us-east-1.amazonaws.com'],
    mx_provider: 'resend',
    mx_provider_agrees: true,
    resend_domain_status: 'verified',
    resend_receiving_status: 'enabled',
    inbound_route_configured: true,
    checked_at: '2026-08-08T10:00:00.000Z',
    ...overrides,
  };
}

async function withAliasDomain<T>(run: () => Promise<T>): Promise<T> {
  const saved = {
    domain: process.env.LITOS_APPLICATION_EMAIL_DOMAIN,
    mailbox: process.env.LITOS_APPLICATION_EMAIL_MAILBOX,
    secret: process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET,
  };
  delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'apply.trylitos.com';
  process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'secret';
  try {
    return await run();
  } finally {
    if (saved.domain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = saved.domain;
    if (saved.mailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = saved.mailbox;
    if (saved.secret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = saved.secret;
  }
}

test('the alias is used when the alias domain verifies', async () => {
  await withAliasDomain(async () => {
    const written: unknown[] = [];
    const choice = await resolveApplicantEmail({
      userId: USER_ID,
      applicationId: APPLICATION_ID,
      accountEmail: 'mehekmandal05@gmail.com',
    }, {
      deliverability: async () => deliverability(),
      forwardingAddress: async () => 'mehekmandal05@gmail.com',
      ensureAlias: async (input) => {
        written.push(input);
        return { alias: 'app-2222222222-abc@apply.trylitos.com', forwards_to: input.forwardTo!, mode: 'litos_application_alias' };
      },
    });
    assert.equal(choice.address, 'app-2222222222-abc@apply.trylitos.com');
    assert.equal(choice.source, 'litos_alias');
    assert.equal(choice.tracked, true);
    assert.equal(choice.reason, 'deliverable');
    assert.equal(written.length, 1);
  });
});

test('the real email is used when the alias domain has no MX record', async () => {
  await withAliasDomain(async () => {
    const choice = await resolveApplicantEmail({
      userId: USER_ID,
      applicationId: APPLICATION_ID,
      accountEmail: 'mehekmandal05@gmail.com',
    }, {
      deliverability: async () => deliverability({ deliverable: false, reason: 'no_mx_record', mx_hosts: [], resend_domain_status: null, inbound_route_configured: false }),
      forwardingAddress: async () => 'mehekmandal05@gmail.com',
      ensureAlias: async () => { throw new Error('an alias must never be minted for an undeliverable domain'); },
    });
    assert.equal(choice.address, 'mehekmandal05@gmail.com');
    assert.equal(choice.source, 'account_email');
    assert.equal(choice.tracked, false);
    assert.equal(choice.reason, 'no_mx_record');
  });
});

test('the real email is used when the deliverability check itself throws', async () => {
  await withAliasDomain(async () => {
    const choice = await resolveApplicantEmail({
      userId: USER_ID,
      applicationId: APPLICATION_ID,
      accountEmail: 'mehekmandal05@gmail.com',
    }, {
      deliverability: async () => { throw new Error('DNS is unreachable from this function'); },
      forwardingAddress: async () => 'mehekmandal05@gmail.com',
      ensureAlias: async () => { throw new Error('an alias must never be minted when the check failed'); },
    });
    assert.equal(choice.address, 'mehekmandal05@gmail.com');
    assert.equal(choice.tracked, false);
    assert.equal(choice.reason, 'check_unavailable');
  });
});

test('a failed alias write falls back to the real email instead of blocking the application', async () => {
  await withAliasDomain(async () => {
    const choice = await resolveApplicantEmail({
      userId: USER_ID,
      applicationId: APPLICATION_ID,
      accountEmail: 'mehekmandal05@gmail.com',
    }, {
      deliverability: async () => deliverability(),
      forwardingAddress: async () => 'mehekmandal05@gmail.com',
      ensureAlias: async () => { throw new Error('database unavailable'); },
    });
    assert.equal(choice.address, 'mehekmandal05@gmail.com');
    assert.equal(choice.tracked, false);
    assert.equal(choice.reason, 'alias_write_failed');
  });
});

test('a stale alias frozen into an older packet is never reused as the real address', async () => {
  await withAliasDomain(async () => {
    const choice = await resolveApplicantEmail({
      userId: USER_ID,
      applicationId: APPLICATION_ID,
      accountEmail: 'mehekmandal05@gmail.com',
      // What routes/resume.ts wrote into spec._contact.email before this shipped.
      contactEmail: 'app-3243fe5f21-30c9245c2057@apply.trylitos.com',
    }, {
      deliverability: async () => deliverability({ deliverable: false, reason: 'no_mx_record' }),
      forwardingAddress: async () => 'mehekmandal05@gmail.com',
    });
    assert.equal(choice.address, 'mehekmandal05@gmail.com');
    assert.equal(choice.source, 'account_email');
    assert.equal(isAliasAddress('app-3243fe5f21-30c9245c2057@apply.trylitos.com'), true);
  });
});

test('retired Litos alias formats stay recognizable after a provider migration', () => {
  const previousDomain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  const previousMailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'new-mail.example';
  delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  try {
    assert.equal(isAliasAddress('app-3243fe5f21-30c9245c2057@apply.trylitos.com'), true);
    assert.equal(isAliasAddress('applications+app-3243fe5f21-30c9245c2057@trylitos.com'), true);
  } finally {
    if (previousDomain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = previousDomain;
    if (previousMailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = previousMailbox;
  }
});

test('ordinary personal addresses containing app words are not treated as Litos aliases', () => {
  assert.equal(isAliasAddress('app-support@gmail.com'), false);
  assert.equal(isAliasAddress('mehek+app-internship@gmail.com'), false);
});

test('a real contact address on the packet still wins over the account email', async () => {
  await withAliasDomain(async () => {
    const choice = await resolveApplicantEmail({
      userId: USER_ID,
      applicationId: APPLICATION_ID,
      accountEmail: 'mehekmandal05@gmail.com',
      contactEmail: 'mehek@usc.edu',
    }, {
      deliverability: async () => deliverability({ deliverable: false, reason: 'inbound_route_missing' }),
      forwardingAddress: async () => 'mehekmandal05@gmail.com',
    });
    assert.equal(choice.address, 'mehek@usc.edu');
    assert.equal(choice.source, 'contact_email');
    assert.equal(choice.tracked, false);
  });
});

test('a frozen personal applicant email is held for regeneration', async () => {
  const pinned = {
    address: 'mehek@usc.edu',
    source: 'contact_email' as const,
    reason: 'no_mx_record' as const,
    tracked: false,
    decided_at: '2026-08-09T00:00:00.000Z',
  };
  await assert.rejects(resolveFrozenApplicantEmail({
    userId: USER_ID,
    applicationId: APPLICATION_ID,
    accountEmail: 'mehekmandal05@gmail.com',
    spec: { _contact: { email: pinned.address }, _applicant_email: pinned },
  }, {
    deliverability: async () => deliverability(),
    aliasActive: async () => true,
  }), /not a tracked Litos alias/i);
  assert.deepEqual(readPinnedApplicantEmail({ _applicant_email: pinned }), pinned);
});

test('an unhealthy pinned alias holds for regeneration instead of switching the form email', async () => {
  await withAliasDomain(async () => {
    const current = applicationAliasFor(USER_ID, APPLICATION_ID);
    assert.ok(current);
    await assert.rejects(
      resolveFrozenApplicantEmail({
        userId: USER_ID,
        applicationId: APPLICATION_ID,
        accountEmail: 'mehekmandal05@gmail.com',
        spec: {
          _contact: { email: 'mehek@usc.edu' },
          _applicant_email: {
            address: current,
            source: 'litos_alias',
            reason: 'deliverable',
            tracked: true,
            decided_at: '2026-08-09T00:00:00.000Z',
          },
        },
      }, {
        deliverability: async () => deliverability({ deliverable: false, reason: 'no_mx_record' }),
        aliasActive: async () => true,
      }),
      /must be regenerated.*not receivable/i,
    );
  });
});

test('a healthy new domain still rejects a pinned alias from the retired mailbox route', async () => {
  const savedDomain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  const savedMailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  const savedSecret = process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'applications.trylitos.com';
  delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'migration-secret';
  try {
    const current = applicationAliasFor(USER_ID, APPLICATION_ID);
    assert.ok(current);
    const currentLocal = current.slice(0, current.indexOf('@'));
    const retired = `applications+${currentLocal}@trylitos.com`;
    let activeLookupCount = 0;
    await assert.rejects(
      resolveFrozenApplicantEmail({
        userId: USER_ID,
        applicationId: APPLICATION_ID,
        spec: {
          _contact: { email: 'mehek@usc.edu' },
          _applicant_email: {
            address: retired,
            source: 'litos_alias',
            reason: 'deliverable',
            tracked: true,
            decided_at: '2026-08-09T00:00:00.000Z',
          },
        },
      }, {
        deliverability: async () => deliverability({ domain: 'applications.trylitos.com' }),
        aliasActive: async () => { activeLookupCount += 1; return true; },
      }),
      /must be regenerated.*current inbound email route/i,
    );
    assert.equal(activeLookupCount, 0, 'a stale active database row must not make a retired route usable');
  } finally {
    if (savedDomain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = savedDomain;
    if (savedMailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = savedMailbox;
    if (savedSecret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = savedSecret;
  }
});

test('a pinned alias on the current healthy dedicated route passes', async () => {
  const savedDomain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  const savedMailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  const savedSecret = process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'applications.trylitos.com';
  delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'migration-secret';
  try {
    const current = applicationAliasFor(USER_ID, APPLICATION_ID);
    assert.ok(current);
    const choice = await resolveFrozenApplicantEmail({
      userId: USER_ID,
      applicationId: APPLICATION_ID,
      spec: {
        _contact: { email: 'mehek@usc.edu' },
        _applicant_email: {
          address: current,
          source: 'litos_alias',
          reason: 'deliverable',
          tracked: true,
          decided_at: '2026-08-09T00:00:00.000Z',
        },
      },
    }, {
      deliverability: async () => deliverability({ domain: 'applications.trylitos.com' }),
      aliasActive: async ({ alias }) => alias === current,
    });
    assert.equal(choice.address, current);
    assert.equal(choice.tracked, true);
  } finally {
    if (savedDomain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = savedDomain;
    if (savedMailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = savedMailbox;
    if (savedSecret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = savedSecret;
  }
});

test('managed receiving rejects an alias frozen on the previous route', async () => {
  const saved = {
    managed: process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN,
    domain: process.env.LITOS_APPLICATION_EMAIL_DOMAIN,
    mailbox: process.env.LITOS_APPLICATION_EMAIL_MAILBOX,
    secret: process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET,
    mode: process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE,
  };
  process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = 'managed_resend';
  process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = 'litos-inbound.resend.app';
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'rollback.example';
  process.env.LITOS_APPLICATION_EMAIL_MAILBOX = 'rollback@mailbox.example';
  process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'managed-secret';
  try {
    await assert.rejects(resolveFrozenApplicantEmail({
      userId: USER_ID,
      applicationId: APPLICATION_ID,
      spec: {
        _contact: { email: 'mehek@usc.edu' },
        _applicant_email: {
          address: 'app-2222222222-abcdef012345@old-route.example', source: 'litos_alias', reason: 'deliverable',
          tracked: true, decided_at: '2026-08-09T00:00:00.000Z',
        },
      },
    }, {
      deliverability: async () => deliverability({ domain: 'litos-inbound.resend.app' }),
      aliasActive: async () => true,
    }), /current inbound email route/i);
  } finally {
    if (saved.managed === undefined) delete process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
    else process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = saved.managed;
    if (saved.domain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = saved.domain;
    if (saved.mailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = saved.mailbox;
    if (saved.secret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = saved.secret;
    if (saved.mode === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE;
    else process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = saved.mode;
  }
});

test('mailbox configuration takes precedence when validating the current pinned route', async () => {
  const savedDomain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  const savedMailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  const savedSecret = process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'applications.trylitos.com';
  process.env.LITOS_APPLICATION_EMAIL_MAILBOX = 'applications@trylitos.com';
  process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'migration-secret';
  try {
    const mailboxAlias = applicationAliasFor(USER_ID, APPLICATION_ID);
    assert.ok(mailboxAlias?.startsWith('applications+app-'));
    assert.ok(mailboxAlias?.endsWith('@trylitos.com'));
    const choice = await resolveFrozenApplicantEmail({
      userId: USER_ID,
      applicationId: APPLICATION_ID,
      spec: {
        _contact: { email: 'mehek@usc.edu' },
        _applicant_email: {
          address: mailboxAlias, source: 'litos_alias', reason: 'deliverable', tracked: true,
          decided_at: '2026-08-09T00:00:00.000Z',
        },
      },
    }, {
      deliverability: async () => deliverability({ domain: 'trylitos.com' }),
      aliasActive: async ({ alias }) => alias === mailboxAlias,
    });
    assert.equal(choice.address, mailboxAlias);

    const dedicatedAlias = mailboxAlias!.slice(mailboxAlias!.indexOf('+') + 1).replace('@trylitos.com', '@applications.trylitos.com');
    await assert.rejects(
      resolveFrozenApplicantEmail({
        userId: USER_ID,
        applicationId: APPLICATION_ID,
        spec: {
          _contact: { email: 'mehek@usc.edu' },
          _applicant_email: {
            address: dedicatedAlias, source: 'litos_alias', reason: 'deliverable', tracked: true,
            decided_at: '2026-08-09T00:00:00.000Z',
          },
        },
      }, {
        deliverability: async () => deliverability({ domain: 'trylitos.com' }),
        aliasActive: async () => true,
      }),
      /current inbound email route/i,
    );
  } finally {
    if (savedDomain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = savedDomain;
    if (savedMailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = savedMailbox;
    if (savedSecret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = savedSecret;
  }
});

test('a healthy pinned alias must also be active for exactly this packet', async () => {
  await withAliasDomain(async () => {
    const current = applicationAliasFor(USER_ID, APPLICATION_ID);
    assert.ok(current);
    await assert.rejects(
      resolveFrozenApplicantEmail({
        userId: USER_ID,
        applicationId: APPLICATION_ID,
        spec: {
          _contact: { email: 'mehek@usc.edu' },
          _applicant_email: {
            address: current, source: 'litos_alias', reason: 'deliverable', tracked: true,
            decided_at: '2026-08-09T00:00:00.000Z',
          },
        },
      }, {
        deliverability: async () => deliverability(),
        aliasActive: async () => false,
      }),
      /not active for this packet/i,
    );
  });
});

test('legacy packets without a tracked alias must regenerate', async () => {
  await assert.rejects(resolveFrozenApplicantEmail({
    userId: USER_ID,
    applicationId: APPLICATION_ID,
    accountEmail: 'account@example.com',
    spec: { _contact: { email: 'printed@example.com' } },
  }), /no tracked Litos applicant email/i);
});

test('with nowhere to forward to, the alias is not minted', async () => {
  await withAliasDomain(async () => {
    const choice = await resolveApplicantEmail({
      userId: USER_ID,
      applicationId: APPLICATION_ID,
      accountEmail: 'mehekmandal05@gmail.com',
    }, {
      deliverability: async () => deliverability(),
      forwardingAddress: async () => null,
      ensureAlias: async () => { throw new Error('an alias with no destination must never be minted'); },
    });
    assert.equal(choice.reason, 'no_forwarding_address');
    assert.equal(choice.tracked, false);
  });
});

test('a forwarding address on our own alias domain is refused', async () => {
  await withAliasDomain(async () => {
    assert.equal(forwardingAddressWouldLoop('app-abc@apply.trylitos.com'), true);
    assert.equal(forwardingAddressWouldLoop('mehekmandal05@gmail.com'), false);
  });
});

/* ---- the return leg ---- */

const ALIAS = 'app-2222222222-abc@apply.trylitos.com';
const FORWARD_TO = 'mehekmandal05@gmail.com';

test('mail from the employer is forwarded in, mail from the applicant is relayed out', () => {
  assert.deepEqual(
    routeInboundApplicationEmail({ from: 'recruiter@akunacapital.com', alias: ALIAS, forwardTo: FORWARD_TO }),
    { kind: 'employer_message' },
  );
  assert.deepEqual(
    routeInboundApplicationEmail({ from: `Mehek <${FORWARD_TO}>`, alias: ALIAS, forwardTo: FORWARD_TO }),
    { kind: 'applicant_reply' },
  );
});

test('managed receiving forwards truthfully and never treats an applicant reply as relayable', () => {
  const savedMode = process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE;
  const savedManaged = process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
  const savedDomain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  const savedMailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = 'managed_resend';
  process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = 'litos-inbound.resend.app';
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'rollback.example';
  process.env.LITOS_APPLICATION_EMAIL_MAILBOX = 'rollback@mailbox.example';
  try {
    const alias = 'app-2222222222-abcdef012345@litos-inbound.resend.app';
    const forwarded = forwardEmailPayload({
      alias,
      forwardTo: FORWARD_TO,
      classification: 'recruiter_reply',
      inbound: { from: 'recruiter@example.com', to: [alias], text: 'Hello' },
    });
    assert.equal(forwarded.reply_to, undefined);
    assert.match(forwarded.text ?? '', /cannot send replies/i);
    assert.doesNotMatch(forwarded.text ?? '', /Litos sends your answer/i);
    assert.deepEqual(
      routeInboundApplicationEmail({ from: FORWARD_TO, alias, forwardTo: FORWARD_TO }),
      { kind: 'drop', reason: 'managed_reply_unsupported' },
    );
  } finally {
    if (savedManaged === undefined) delete process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
    else process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = savedManaged;
    if (savedDomain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = savedDomain;
    if (savedMailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = savedMailbox;
    if (savedMode === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE;
    else process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = savedMode;
  }
});

test('a historical managed alias stays inbound-only after configuration switches routes', () => {
  const savedManaged = process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
  const savedDomain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  const savedMailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  delete process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'applications.example.com';
  delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  try {
    const alias = 'app-2222222222-abcdef012345@historical-inbox.resend.app';
    const forwarded = forwardEmailPayload({
      alias,
      forwardTo: FORWARD_TO,
      classification: 'recruiter_reply',
      inbound: { from: 'recruiter@example.com', to: [alias], text: 'Hello' },
    });
    assert.equal(forwarded.reply_to, undefined);
    assert.match(forwarded.text ?? '', /cannot send replies/i);
    assert.doesNotMatch(forwarded.text ?? '', /Litos sends your answer/i);
    assert.deepEqual(
      routeInboundApplicationEmail({ from: FORWARD_TO, alias, forwardTo: FORWARD_TO }),
      { kind: 'drop', reason: 'managed_reply_unsupported' },
    );
  } finally {
    if (savedManaged === undefined) delete process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
    else process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = savedManaged;
    if (savedDomain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = savedDomain;
    if (savedMailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = savedMailbox;
  }
});

test('custom receiving keeps reply-as-alias behavior unchanged', () => {
  const savedManaged = process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
  delete process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
  try {
    const forwarded = forwardEmailPayload({
      alias: ALIAS,
      forwardTo: FORWARD_TO,
      classification: 'recruiter_reply',
      inbound: { from: 'recruiter@example.com', to: [ALIAS], text: 'Hello' },
    });
    assert.equal(forwarded.reply_to, ALIAS);
    assert.match(forwarded.text ?? '', /Litos sends your answer/i);
  } finally {
    if (savedManaged === undefined) delete process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
    else process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = savedManaged;
  }
});

test('mail apparently from the alias itself is dropped, because that is what a loop looks like', () => {
  assert.deepEqual(
    routeInboundApplicationEmail({ from: ALIAS, alias: ALIAS, forwardTo: FORWARD_TO }),
    { kind: 'drop', reason: 'self_addressed' },
  );
});

test('a reply whose sender authentication explicitly failed is not relayed', () => {
  assert.deepEqual(
    routeInboundApplicationEmail({
      from: FORWARD_TO,
      alias: ALIAS,
      forwardTo: FORWARD_TO,
      authentication: { spf: 'pass', dkim: 'fail' },
    }),
    { kind: 'drop', reason: 'sender_authentication_failed' },
  );
  // Silence is not a pass, but it is also not a failure: relaying still proceeds and the gap is
  // documented rather than hidden.
  assert.deepEqual(
    routeInboundApplicationEmail({ from: FORWARD_TO, alias: ALIAS, forwardTo: FORWARD_TO, authentication: {} }),
    { kind: 'applicant_reply' },
  );
});

test('the relay recipient comes from the recorded thread, newest employer first', () => {
  const thread = [
    { direction: 'outbound', from_email: ALIAS },
    { direction: 'forwarded', from_email: 'recruiter@akunacapital.com' },
    { direction: 'inbound', from_email: 'no-reply@greenhouse.io' },
  ];
  assert.equal(relayRecipientFor(thread, { alias: ALIAS, forwardTo: FORWARD_TO }), 'recruiter@akunacapital.com');
});

test('the relay never addresses the applicant or the alias, so it cannot loop', () => {
  assert.equal(
    relayRecipientFor(
      [{ direction: 'inbound', from_email: FORWARD_TO }, { direction: 'inbound', from_email: ALIAS }],
      { alias: ALIAS, forwardTo: FORWARD_TO },
    ),
    null,
  );
  assert.equal(relayRecipientFor([], { alias: ALIAS, forwardTo: FORWARD_TO }), null);
});
