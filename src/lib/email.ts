import { z } from 'zod';
import { PRODUCT_NAME } from './product';

/* One outbound-email path for the whole backend.
 *
 * Extracted from routes/auth.ts, which was the only thing that sent mail until the
 * contact form needed to. Two copies of a Resend call would have meant two places
 * for a timeout, an auth failure or a sender-domain mistake to be handled
 * differently, and the sender rules below are subtle enough that a second copy
 * would have drifted from them within a release.
 *
 * The website deliberately does NOT talk to Resend itself. It has no key, no
 * verified sender and no reason to hold either: it posts to /contact and this is
 * the only process that can send. One transport, one secret, one place mail
 * breaks. */

/* RESEND_FROM must be a mailbox on a domain verified in Resend, or Resend rejects
   the send outright. The display name is deliberately ignored and replaced with
   the current product name: the env var has outlived two renames already, and a
   stale "Volley <...>" in production would put a retired brand in a student's
   inbox while the mailbox itself stayed correct. Keep the mailbox, replace the
   name. */
export function emailSender(): string {
  const configured = process.env.RESEND_FROM?.trim() || 'onboarding@resend.dev';
  const openBracket = configured.lastIndexOf('<');
  const mailbox =
    openBracket >= 0 && configured.endsWith('>')
      ? configured.slice(openBracket + 1, -1).trim()
      : configured;

  if (!z.string().email().safeParse(mailbox).success) {
    throw new Error('RESEND_FROM must contain a valid email address');
  }

  return `${PRODUCT_NAME} <${mailbox}>`;
}

export type OutboundEmail = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  reply_to?: string;
  attachments?: Array<{
    filename: string;
    content: string;
    content_type?: string;
  }>;
};

export function controlledQaEmailCapture(): { url: string; token: string } | null {
  if (process.env.NODE_ENV === 'production' || process.env.LITOS_QA_EMAIL_CAPTURE_ENABLED !== 'true') return null;
  const rawUrl = process.env.LITOS_QA_EMAIL_CAPTURE_URL?.trim();
  const token = process.env.LITOS_QA_EMAIL_CAPTURE_TOKEN?.trim();
  if (!rawUrl || !token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  try {
    const target = new URL(rawUrl);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port
      || target.pathname !== '/emails' || target.search || target.hash || target.username || target.password) return null;
    return { url: target.toString(), token };
  } catch {
    return null;
  }
}

/* Returns Resend's message id, which is the only proof the send was accepted.
   Resend can answer 200 with a body that has no id when something is wrong
   upstream, so a missing id is treated as a failure rather than a success: a
   caller that believed a 200 would silently drop mail. */
export async function sendEmail(
  payload: OutboundEmail,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const capture = controlledQaEmailCapture();
  const endpoint = capture?.url ?? 'https://api.resend.com/emails';
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    // Bound the wait so a hung Resend cannot hold the request open indefinitely; the
    // caller treats a throw here as "email unavailable" and answers 503.
    signal: AbortSignal.timeout(10000),
    headers: {
      ...(capture
        ? { 'X-Litos-QA-Capture-Token': capture.token }
        : { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${capture ? 'Controlled QA email capture' : 'Resend API'} ${res.status}: ${text}`);
  }

  const result = (await res.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof result?.id !== 'string' || result.id.length === 0) {
    throw new Error(`${capture ? 'Controlled QA email capture' : 'Resend API'} accepted the request without returning an email id`);
  }
  return result.id;
}
