import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationReviewState } from './applicationReview';
import {
  buildUnsupportedPortalApplicationEmail,
  sendUnsupportedPortalApplicationEmail,
  unsupportedPortalFallbackRecipient,
} from './unsupportedPortalEmailFallback';
import type { SubmissionPacket } from './portalSubmission';
import { coverLetterFileNameForRole, resumeFileNameForRole } from './resumeFileName';

function withEnv(values: Record<string, string | undefined>, run: () => void | Promise<void>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve(run()).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const review = {
  jd_text: 'Build useful software.',
  role: 'Backend Engineer',
  portal_url: 'https://example.com/careers/backend-engineer',
  status: 'ready_to_submit',
  edited_terms: [],
  questions: [],
  skipped_reasons: [],
  updated_at: '2026-08-05T00:00:00.000Z',
} satisfies ApplicationReviewState;

const packet = {
  fullName: 'Taylor Applicant',
  email: 'taylor@example.com',
  resume: Buffer.from('%PDF resume'),
  resumeName: 'Taylor_Applicant_Resume.pdf',
  coverLetter: Buffer.from('%PDF cover'),
  coverLetterName: 'Taylor_Applicant_Cover_Letter.pdf',
  questions: [],
} satisfies SubmissionPacket;

test('recipient comes from stored application metadata before env fallback', async () => {
  await withEnv({
    LITOS_UNSUPPORTED_PORTAL_APPLICATION_TO: 'fallback@example.com',
    LITOS_UNSUPPORTED_PORTAL_FALLBACK_TO: undefined,
  }, () => {
    assert.equal(
      unsupportedPortalFallbackRecipient(
        { ...review, company_email: 'recruiting@example.com' } as ApplicationReviewState,
        { id: 'app-1', job_context: {}, spec: {} },
      ),
      'recruiting@example.com',
    );
    assert.equal(
      unsupportedPortalFallbackRecipient(review, {
        id: 'app-1',
        job_context: { employer_email: 'jobs@example.com' },
        spec: {},
      }),
      'jobs@example.com',
    );
  });
});

test('recipient can be configured with a fallback env var', async () => {
  await withEnv({
    LITOS_UNSUPPORTED_PORTAL_APPLICATION_TO: undefined,
    LITOS_UNSUPPORTED_PORTAL_FALLBACK_TO: 'fallback@example.com',
  }, () => {
    assert.equal(
      unsupportedPortalFallbackRecipient(review, { id: 'app-1', job_context: {}, spec: {} }),
      'fallback@example.com',
    );
  });
});

test('application email uses applicant reply-to and attaches packet PDFs', async () => {
  await withEnv({ RESEND_FROM: 'Litos <apply@litos.example>' }, () => {
    const role = 'Hardware Product Management Intern';
    const email = buildUnsupportedPortalApplicationEmail({
      application: { id: 'app-1', job_context: { company: 'Acme', role }, spec: {} },
      review: { ...review, role },
      packet: {
        ...packet,
        resumeName: resumeFileNameForRole(packet.fullName, role),
        coverLetterName: coverLetterFileNameForRole(packet.fullName, role),
      },
      to: 'jobs@example.com',
    });
    assert.equal(email.reply_to, 'taylor@example.com');
    assert.equal(email.to[0], 'jobs@example.com');
    assert.match(email.subject, /Hardware Product Management Intern/);
    assert.match(email.subject, /Acme/);
    assert.match(email.html ?? '', /<p>/);
    assert.match(email.html ?? '', /not supported for direct Litos submission yet/);
    assert.doesNotMatch(email.text, /application packet/);
    assert.doesNotMatch(email.html ?? '', /application packet/);
    assert.equal(email.attachments?.length, 2);
    assert.deepEqual(email.attachments?.map((item) => item.filename), [
      'Taylor_Applicant_Hardware_Product_Management_Intern_Resume.pdf',
      'Taylor_Applicant_Hardware_Product_Management_Intern_Cover_Letter.pdf',
    ]);
    assert.equal(email.attachments?.[0]?.content, Buffer.from('%PDF resume').toString('base64'));
    assert.equal(email.attachments?.[0]?.content_type, 'application/pdf');
  });
});

test('application email still sends HTML and text when no cover letter is attached', async () => {
  await withEnv({ RESEND_FROM: 'Litos <apply@litos.example>' }, () => {
    const email = buildUnsupportedPortalApplicationEmail({
      application: { id: 'app-1', job_context: { company: 'Acme' }, spec: {} },
      review,
      packet: { ...packet, coverLetter: undefined, coverLetterName: undefined },
      to: 'jobs@example.com',
    });
    assert.match(email.text, /The resume is attached\./);
    assert.doesNotMatch(email.text, /cover letter is attached/);
    assert.match(email.html ?? '', /<p>The resume is attached\.<\/p>/);
    assert.doesNotMatch(email.html ?? '', /cover letter is attached/);
    assert.equal(email.attachments?.length, 1);
    assert.equal(email.attachments?.[0]?.filename, 'Taylor_Applicant_Resume.pdf');
  });
});

test('email fallback does not promise or attach an unapproved generated cover letter', async () => {
  await withEnv({ RESEND_FROM: 'Litos <apply@litos.example>' }, () => {
    const email = buildUnsupportedPortalApplicationEmail({
      application: { id: 'app-1', job_context: { company: 'Acme' }, spec: {} },
      review,
      packet: {
        ...packet,
        coverLetter: undefined,
        coverLetterName: 'Taylor_Applicant_Cover_Letter.pdf',
      },
      to: 'jobs@example.com',
    });
    assert.equal(email.attachments?.length, 1);
    assert.equal(email.attachments?.[0]?.filename, 'Taylor_Applicant_Resume.pdf');
    assert.doesNotMatch(email.text, /cover letter is attached/);
    assert.doesNotMatch(email.html ?? '', /cover letter is attached/);
  });
});

test('an unconfigured fallback rejects before sending', async () => {
  await withEnv({
    RESEND_FROM: 'Litos <apply@litos.example>',
    LITOS_UNSUPPORTED_PORTAL_APPLICATION_TO: undefined,
    LITOS_UNSUPPORTED_PORTAL_FALLBACK_TO: undefined,
  }, async () => {
    let calls = 0;
    const stub = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => sendUnsupportedPortalApplicationEmail({
        application: { id: 'app-1', job_context: {}, spec: {} },
        review,
        packet,
        fetchImpl: stub,
      }),
      /recipient is not configured/,
    );
    assert.equal(calls, 0);
  });
});

test('send forwards the reply-to and attachment payload to Resend', async () => {
  await withEnv({
    RESEND_FROM: 'Litos <apply@litos.example>',
    LITOS_UNSUPPORTED_PORTAL_APPLICATION_TO: 'jobs@example.com',
    LITOS_UNSUPPORTED_PORTAL_FALLBACK_TO: undefined,
  }, async () => {
    const bodies: Record<string, unknown>[] = [];
    const stub = (async (_url: unknown, init: unknown) => {
      bodies.push(JSON.parse((init as { body: string }).body));
      return new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 });
    }) as unknown as typeof fetch;
    const sent = await sendUnsupportedPortalApplicationEmail({
      application: { id: 'app-1', job_context: { company: 'Acme' }, spec: {} },
      review,
      packet,
      fetchImpl: stub,
    });
    assert.deepEqual(sent, { messageId: 'msg_123', recipient: 'jobs@example.com' });
    const body = bodies[0];
    assert.equal(body?.reply_to, 'taylor@example.com');
    assert.equal((body?.attachments as unknown[])?.length, 2);
    assert.match(String(body?.html), /<p>/);
  });
});
