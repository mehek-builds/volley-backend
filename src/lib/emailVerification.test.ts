import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractCodeFromVerificationText,
  extractLitosVerificationCode,
  extractVerificationCode,
  findComposioVerificationCode,
  type EmailToolExecutor,
} from './emailVerification';

test('extracts only an authenticated code from the exact Litos application alias', () => {
  const requestedAt = new Date('2026-07-25T10:00:00.000Z');
  const row = (code: string, authentication: Record<string, string> | undefined) => ({
    from_email: 'Greenhouse <no-reply@us.greenhouse-mail.io>',
    to_email: 'app-2222222222-target@apply.trylitos.com',
    subject: 'Your Greenhouse security code',
    text: `Use security code ${code} to continue.`,
    html: null,
    received_at: new Date('2026-07-25T10:00:20.000Z'),
    raw_json: { authentication },
  });
  assert.equal(extractLitosVerificationCode(
    [row('EF56GH78', { spf: 'pass', dkim: 'pass', dmarc: 'pass' })],
    'https://job-boards.greenhouse.io/acme/jobs/123',
    requestedAt,
    'app-2222222222-target@apply.trylitos.com',
  )?.code, 'EF56GH78');
  assert.equal(extractLitosVerificationCode(
    [row('EF56GH78', undefined)],
    'https://job-boards.greenhouse.io/acme/jobs/123',
    requestedAt,
    'app-2222222222-target@apply.trylitos.com',
  ), null);
});

test('the local controlled Greenhouse portal accepts only the Greenhouse sender family', () => {
  const previous = process.env.LITOS_ENABLE_TEST_PORTAL;
  process.env.LITOS_ENABLE_TEST_PORTAL = 'true';
  const row = (from: string) => ({
    from_email: from,
    to_email: 'app-2222222222-target@litos-qa.resend.app',
    subject: 'Your Greenhouse security code',
    text: 'Use security code EF56GH78 to continue.',
    html: null,
    received_at: new Date('2026-07-25T10:00:20.000Z'),
    raw_json: { authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } },
  });
  const portal = 'http://localhost:3300/qa/portal-submission?board=greenhouse&shape=security-code&case=run-1';
  const requestedAt = new Date('2026-07-25T10:00:00.000Z');
  try {
    assert.equal(extractLitosVerificationCode(
      [row('Greenhouse <no-reply@greenhouse.io>')],
      portal,
      requestedAt,
      'app-2222222222-target@litos-qa.resend.app',
    )?.code, 'EF56GH78');
    assert.equal(extractLitosVerificationCode(
      [row('Lookalike <no-reply@greenhouse.example>')],
      portal,
      requestedAt,
      'app-2222222222-target@litos-qa.resend.app',
    ), null);
  } finally {
    if (previous === undefined) delete process.env.LITOS_ENABLE_TEST_PORTAL;
    else process.env.LITOS_ENABLE_TEST_PORTAL = previous;
  }
});

test('rejects ambiguous codes recorded against one Litos application alias', () => {
  const requestedAt = new Date('2026-07-25T10:00:00.000Z');
  const row = (code: string, seconds: number) => ({
    from_email: 'Greenhouse <no-reply@us.greenhouse-mail.io>',
    to_email: 'app-2222222222-target@apply.trylitos.com',
    subject: 'Your Greenhouse security code',
    text: `Use security code ${code} to continue.`,
    html: null,
    received_at: new Date(`2026-07-25T10:00:${seconds}.000Z`),
    raw_json: { authentication: { spf: 'pass', dkim: 'pass' } },
  });
  assert.equal(extractLitosVerificationCode(
    [row('AB12CD34', 10), row('EF56GH78', 20)],
    'https://job-boards.greenhouse.io/acme/jobs/123',
    requestedAt,
    'app-2222222222-target@apply.trylitos.com',
  ), null);
});

test('extracts one context-bound numeric code without returning unrelated numbers', () => {
  assert.equal(
    extractCodeFromVerificationText('Your verification code is <strong>482913</strong>. It expires in 10 minutes.'),
    '482913',
  );
  assert.equal(extractCodeFromVerificationText('Application 482913 was received on 2026-07-25.'), null);
});
test('rejects text with multiple different verification codes', () => {
  assert.equal(
    extractCodeFromVerificationText('Your old verification code is 111111. Your new verification code is 222222.'),
    null,
  );
});

test('extracts a contextual Greenhouse alphanumeric code but rejects ordinary nearby words', () => {
  assert.equal(
    extractCodeFromVerificationText('Enter this security code to continue: HJJ53KPD'),
    'HJJ53KPD',
  );
  assert.equal(extractCodeFromVerificationText('Your application for ENGINEER was received.'), null);
});

/* THE CODES GREENHOUSE ACTUALLY SENDS, three of which used to be invisible.
 *
 * The shape rule required an 8-character candidate to hold at least one letter AND at least one
 * digit. Real Greenhouse codes are not built that way. These four are the ones on record: three read
 * out of this applicant's own mailbox on 2026-08-09 during a live Cresta application, and one from
 * Greenhouse's own support copy. Only LH0Yjubx has a digit in it.
 *
 * That is not a rare edge. It means automatic retrieval could read roughly one code in four, so
 * three applications in four parked on 'awaiting_security_code' asking a person for something Litos
 * had already been emailed - and asking for it in a form that could never be used, because the
 * employer replaces the code on the next send. It is the reason the automated half of this feature
 * has never visibly worked, and every other fix in the held-session path is worthless without it.
 */
test('reads the mixed-case, digitless codes Greenhouse really sends', () => {
  const email = (code: string) => 'Hi Mehek,\n\nCopy and paste this code into the security code field '
    + `on your application: ${code}. After you enter the code, resubmit your application.`;
  for (const code of ['LSlOXjvZ', 'LH0Yjubx', 'yFxeFpSl', 'TPHJrFMJ']) {
    assert.equal(extractCodeFromVerificationText(email(code)), code, code);
  }
});

test('an eight-letter word is not a code, and internal capitals alone do not make one', () => {
  // 'Security' is eight letters with a capital, and its only capital is the first: a capitalised
  // word is not a random string. The rule is an uppercase that FOLLOWS a lowercase.
  assert.equal(extractCodeFromVerificationText('Your security code request was received. Security matters.'), null);
  // Two shaped candidates and no hand-over sentence is a message this cannot read, and it says so
  // rather than choosing. Widening the shape widened this risk, and the refusal is what bounds it.
  assert.equal(extractCodeFromVerificationText('security code McDonald and also iPhoneXs'), null);
});

test('a code the message hands over by name wins over one that merely looks like a code', () => {
  assert.equal(
    extractCodeFromVerificationText(
      'Copy and paste this code into the security code field on your application: yFxeFpSl. '
      + 'Sent on behalf of McDonald Corp.',
    ),
    'yFxeFpSl',
  );
});

test('accepts recent Gmail messages only from the portal sender allowlist', () => {
  const requestedAt = new Date('2026-07-25T10:00:00.000Z');
  const match = extractVerificationCode([{
    provider: 'gmail',
    data: {
      messages: [{
        payload: {
          headers: [
            { name: 'Subject', value: 'Your Greenhouse verification code' },
            { name: 'From', value: 'Greenhouse <no-reply@greenhouse.io>' },
            { name: 'Date', value: '2026-07-25T10:00:20.000Z' },
          ],
          body: { data: Buffer.from('Use verification code 482913 to continue.').toString('base64url') },
        },
      }],
    },
  }], 'https://boards.greenhouse.io/acme/jobs/123', requestedAt);
  assert.deepEqual(match, {
    code: '482913',
    provider: 'gmail',
    receivedAt: '2026-07-25T10:00:20.000Z',
    senderDomain: 'greenhouse.io',
  });
});

test('matches a code only to the applicant email pinned into this application', () => {
  const requestedAt = new Date('2026-07-25T10:00:00.000Z');
  const payloads = [{
    provider: 'gmail' as const,
    data: {
      messages: [{
        payload: {
          headers: [
            { name: 'Subject', value: 'Your Greenhouse verification code' },
            { name: 'From', value: 'Greenhouse <no-reply@greenhouse.io>' },
            { name: 'To', value: 'applications+app-123@trylitos.com' },
            { name: 'Authentication-Results', value: 'spf=pass dkim=pass dmarc=pass' },
            { name: 'Date', value: '2026-07-25T10:00:20.000Z' },
          ],
          body: { data: Buffer.from('Use verification code 482913 to continue.').toString('base64url') },
        },
      }],
    },
  }];
  assert.equal(extractVerificationCode(
    payloads,
    'https://boards.greenhouse.io/acme/jobs/123',
    requestedAt,
    'applications+app-other@trylitos.com',
  ), null);
  assert.equal(extractVerificationCode(
    payloads,
    'https://boards.greenhouse.io/acme/jobs/123',
    requestedAt,
    'applications+app-123@trylitos.com',
  )?.code, '482913');
});

test('rejects a fresh code from a lookalike sender', () => {
  const match = extractVerificationCode([{
    provider: 'outlook',
    data: {
      value: [{
        subject: 'Your verification code',
        sender: { emailAddress: { address: 'security@greenhouse.example' } },
        receivedDateTime: '2026-07-25T10:00:20.000Z',
        body: { content: 'Your verification code is 482913.' },
      }],
    },
  }], 'https://boards.greenhouse.io/acme/jobs/123', new Date('2026-07-25T10:00:00.000Z'));
  assert.equal(match, null);
});

test('accepts Greenhouse codes from the observed regional mail domain', () => {
  const match = extractVerificationCode([{
    provider: 'gmail',
    data: {
      messages: [{
        subject: 'Your security code is HJJ53KPD',
        from: 'Greenhouse <no-reply@us.greenhouse-mail.io>',
        receivedAt: '2026-07-25T10:00:20.000Z',
        text: 'Use verification code HJJ53KPD to continue.',
      }],
    },
  }], 'https://job-boards.greenhouse.io/acme/jobs/123', new Date('2026-07-25T10:00:00.000Z'));
  assert.deepEqual(match, {
    code: 'HJJ53KPD',
    provider: 'gmail',
    receivedAt: '2026-07-25T10:00:20.000Z',
    senderDomain: 'us.greenhouse-mail.io',
  });
});

test('rejects codes that predate the active browser request', () => {
  const match = extractVerificationCode([{
    provider: 'outlook',
    data: {
      value: [{
        subject: 'Your SmartRecruiters verification code',
        from: 'no-reply@smartrecruiters.com',
        receivedDateTime: '2026-07-25T09:55:00.000Z',
        bodyPreview: 'Your verification code is 482913.',
      }],
    },
  }], 'https://jobs.smartrecruiters.com/acme/123', new Date('2026-07-25T10:00:00.000Z'));
  assert.equal(match, null);
});

test('queries only read tools and tolerates an unconnected provider', async () => {
  const calls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  const executor: EmailToolExecutor = async (tool, input) => {
    calls.push({ tool, arguments: input.arguments });
    if (tool.startsWith('OUTLOOK_')) throw new Error('No connected Outlook account');
    return {
      successful: true,
      data: {
        messages: [{
          subject: 'Your Ashby verification code',
          from: 'verify@ashbyhq.com',
          to: 'app-2222222222-test@apply.trylitos.com',
          authenticationResults: 'spf=pass dkim=pass dmarc=pass',
          internalDate: '1784973620000',
          text: 'Your one-time code is 482913.',
        }],
      },
    };
  };
  const match = await findComposioVerificationCode({
    userId: 'user-123',
    portalUrl: 'https://jobs.ashbyhq.com/acme/123',
    requestedAt: new Date('2026-07-25T10:00:00.000Z'),
    expectedRecipient: 'app-2222222222-test@apply.trylitos.com',
    applicationId: '22222222-2222-4222-8222-222222222222',
    executor,
  });
  assert.equal(match?.code, '482913');
  assert.deepEqual(calls.map(({ tool }) => tool).sort(), ['GMAIL_FETCH_EMAILS', 'OUTLOOK_SEARCH_MESSAGES']);
  assert.deepEqual(calls.find(({ tool }) => tool === 'OUTLOOK_SEARCH_MESSAGES')?.arguments, {
    query: 'to:app-2222222222-test@apply.trylitos.com AND ("verification code" OR "security code" OR passcode OR OTP)',
    size: 5,
    enable_top_results: false,
  });
});

test('recipient correlation rejects another application code and ambiguous codes', () => {
  const requestedAt = new Date('2026-07-25T10:00:00.000Z');
  const message = (to: string, code: string, seconds: number) => ({
    subject: 'Your Greenhouse security code',
    from: 'Greenhouse <no-reply@us.greenhouse-mail.io>',
    to,
    authenticationResults: 'spf=pass dkim=pass dmarc=pass',
    receivedAt: `2026-07-25T10:00:${String(seconds).padStart(2, '0')}.000Z`,
    text: `Use security code ${code} to continue.`,
  });
  const expected = 'app-2222222222-target@apply.trylitos.com';
  const other = 'app-3333333333-other@apply.trylitos.com';
  const isolated = extractVerificationCode([{
    provider: 'gmail',
    data: { messages: [message(other, 'AB12CD34', 10), message(expected, 'EF56GH78', 20)] },
  }], 'https://job-boards.greenhouse.io/acme/jobs/123', requestedAt, expected, '22222222-2222-4222-8222-222222222222');
  assert.equal(isolated?.code, 'EF56GH78');

  const ambiguous = extractVerificationCode([{
    provider: 'gmail',
    data: { messages: [message(expected, 'AB12CD34', 10), message(expected, 'EF56GH78', 20)] },
  }], 'https://job-boards.greenhouse.io/acme/jobs/123', requestedAt, expected, '22222222-2222-4222-8222-222222222222');
  assert.equal(ambiguous, null);
});

test('correlated lookup fails closed without authenticated sender metadata', () => {
  const match = extractVerificationCode([{
    provider: 'gmail',
    data: { messages: [{
      subject: 'Your Greenhouse security code',
      from: 'Greenhouse <no-reply@us.greenhouse-mail.io>',
      to: 'app-2222222222-target@apply.trylitos.com',
      receivedAt: '2026-07-25T10:00:20.000Z',
      text: 'Use security code EF56GH78 to continue.',
    }] },
  }], 'https://job-boards.greenhouse.io/acme/jobs/123', new Date('2026-07-25T10:00:00.000Z'),
  'app-2222222222-target@apply.trylitos.com', '22222222-2222-4222-8222-222222222222');
  assert.equal(match, null);
});

test('rejects a spoofed allowlisted From address when authentication is not aligned', () => {
  const match = extractVerificationCode([{
    provider: 'gmail',
    data: { messages: [{
      subject: 'Your Greenhouse security code',
      from: 'Greenhouse <no-reply@us.greenhouse-mail.io>',
      to: 'app-2222222222-target@apply.trylitos.com',
      authenticationResults: 'spf=pass smtp.mailfrom=attacker.example dkim=pass header.d=attacker.example',
      receivedAt: '2026-07-25T10:00:20.000Z',
      text: 'Use security code EF56GH78 to continue.',
    }] },
  }], 'https://job-boards.greenhouse.io/acme/jobs/123', new Date('2026-07-25T10:00:00.000Z'),
  'app-2222222222-target@apply.trylitos.com', '22222222-2222-4222-8222-222222222222');
  assert.equal(match, null);
});

test('accepts an aligned authenticated identity when DMARC metadata is unavailable', () => {
  const match = extractVerificationCode([{
    provider: 'gmail',
    data: { messages: [{
      subject: 'Your Greenhouse security code',
      from: 'Greenhouse <no-reply@us.greenhouse-mail.io>',
      to: 'app-2222222222-target@apply.trylitos.com',
      authenticationResults: 'dkim=pass header.d=us.greenhouse-mail.io',
      receivedAt: '2026-07-25T10:00:20.000Z',
      text: 'Use security code EF56GH78 to continue.',
    }] },
  }], 'https://job-boards.greenhouse.io/acme/jobs/123', new Date('2026-07-25T10:00:00.000Z'),
  'app-2222222222-target@apply.trylitos.com', '22222222-2222-4222-8222-222222222222');
  assert.equal(match?.code, 'EF56GH78');
});
