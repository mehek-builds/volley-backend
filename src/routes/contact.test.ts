import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { contactSchema, CONTACT_REASONS } from './contact';
import { emailSender, sendEmail } from '../lib/email';

/* The route handler itself calls allowHourly, which needs a database, and this
   repo's convention is no live DB and no network in tests. So the parts that can
   be wrong on their own are tested on their own: the schema that decides what is
   allowed through, and the mail layer that decides what leaves. */

const valid = {
  name: 'Alex Rivera',
  email: 'alex@example.com',
  reason: 'Refund request',
  message: 'Charged twice for July, same card, two receipts attached.',
};

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

describe('contact submissions', () => {
  test('accepts a complete message and trims it', () => {
    const r = contactSchema.safeParse({ ...valid, name: '  Alex Rivera  ' });
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.data.name, 'Alex Rivera');
  });

  test('every reason the form offers is accepted', () => {
    for (const reason of CONTACT_REASONS) {
      assert.equal(contactSchema.safeParse({ ...valid, reason }).success, true, reason);
    }
  });

  /* The reason lands in the subject line of mail arriving in a personal inbox, so
     it is an allowlist rather than free text. A crafted POST must not be able to
     write that line. */
  test('a reason outside the allowlist is rejected', () => {
    for (const reason of ['', 'Anything else', 'Refund request\nBcc: someone@evil.test']) {
      assert.equal(contactSchema.safeParse({ ...valid, reason }).success, false, reason);
    }
  });

  test('name, email and message are all required and bounded', () => {
    assert.equal(contactSchema.safeParse({ ...valid, name: '' }).success, false);
    assert.equal(contactSchema.safeParse({ ...valid, message: '   ' }).success, false);
    assert.equal(contactSchema.safeParse({ ...valid, email: 'not-an-address' }).success, false);
    assert.equal(contactSchema.safeParse({ ...valid, message: 'x'.repeat(5001) }).success, false);
    assert.equal(contactSchema.safeParse({ ...valid, name: 'x'.repeat(121) }).success, false);
  });

  /* A real submission omits the honeypot entirely; only a filler supplies it. It
     has to be optional or every genuine message would 400. */
  test('the honeypot is optional but accepted when present', () => {
    assert.equal(contactSchema.safeParse(valid).success, true);
    assert.equal(contactSchema.safeParse({ ...valid, company: 'bot' }).success, true);
  });
});

describe('outbound mail', () => {
  test('keeps a verified mailbox and replaces a stale display name', () => {
    withEnv({ RESEND_FROM: 'Volley <onboarding@resend.dev>' }, () => {
      assert.equal(emailSender(), 'Litos <onboarding@resend.dev>');
    });
    withEnv({ RESEND_FROM: undefined }, () => {
      assert.equal(emailSender(), 'Litos <onboarding@resend.dev>');
    });
    withEnv({ RESEND_FROM: 'not a mailbox' }, () => {
      assert.throws(() => emailSender(), /RESEND_FROM/);
    });
  });

  test('sends what it was given and returns the message id', async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    const stub = (async (url: unknown, init: unknown) => {
      seen = {
        url: String(url),
        body: JSON.parse((init as { body: string }).body),
      };
      return new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 });
    }) as unknown as typeof fetch;

    const id = await sendEmail(
      { from: 'Litos <a@b.co>', to: ['inbox@example.com'], reply_to: 'alex@example.com', subject: 'S', text: 'T' },
      stub,
    );
    assert.equal(id, 'msg_123');
    assert.equal(seen!.url, 'https://api.resend.com/emails');
    /* reply_to is what makes hitting reply answer the person who wrote in rather
       than the sending domain, which nobody reads. */
    assert.equal(seen!.body.reply_to, 'alex@example.com');
    assert.equal(seen!.body.subject, 'S');
  });

  test('a non-ok response throws rather than reporting success', async () => {
    const stub = (async () => new Response('nope', { status: 422 })) as unknown as typeof fetch;
    await assert.rejects(
      () => sendEmail({ from: 'a', to: ['b@c.co'], subject: 's', text: 't' }, stub),
      /Resend API 422/,
    );
  });

  /* Resend can answer 200 with no id when something is wrong upstream. Treating
     that as success is how a form silently drops mail while telling the sender it
     went through. */
  test('a 200 with no message id is treated as a failure', async () => {
    const stub = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(
      () => sendEmail({ from: 'a', to: ['b@c.co'], subject: 's', text: 't' }, stub),
      /without returning an email id/,
    );
  });
});
