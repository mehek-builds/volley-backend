import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractCodeFromVerificationText,
  extractVerificationCode,
  findComposioVerificationCode,
  type EmailToolExecutor,
} from './emailVerification';

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
    executor,
  });
  assert.equal(match?.code, '482913');
  assert.deepEqual(calls.map(({ tool }) => tool).sort(), ['GMAIL_FETCH_EMAILS', 'OUTLOOK_SEARCH_MESSAGES']);
  assert.deepEqual(calls.find(({ tool }) => tool === 'OUTLOOK_SEARCH_MESSAGES')?.arguments, {
    query: '"verification code" OR "security code" OR passcode OR OTP',
    size: 5,
    enable_top_results: false,
  });
});
