import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { allowHourly, rateLimitedReply } from '../middleware/quota';
import { emailSender, sendEmail } from '../lib/email';

/* POST /contact. The marketing site's contact form posts here.
 *
 * It lives in the backend rather than the website because this process already
 * sends mail: RESEND_API_KEY and a verified RESEND_FROM are configured here for
 * the six-digit verification codes. The website has neither and now needs
 * neither. One transport, one secret, one place mail can break.
 *
 * Unauthenticated on purpose. Someone whose autofill just failed, or who wants a
 * refund, may well not be able to sign in, and a contact form behind a login is
 * not a contact form. The trade is that it must be hardened like a public
 * endpoint, which is what the rest of this file is.
 *
 * The destination is CONTACT_INBOX, read here and never sent to a browser, so no
 * address appears in any page a scraper can read. */

const INBOX = () => process.env.CONTACT_INBOX?.trim() || 'mehekbuilds@gmail.com';

/* The reasons the form offers. Validated against rather than accepted, so a
   crafted POST cannot put arbitrary text in the subject line of mail arriving in
   a personal inbox. The website renders its own copy of this list; if the two
   drift, this one wins and the request is rejected. */
export const CONTACT_REASONS = [
  'Something is not working',
  'Refund request',
  'Billing question',
  'Career centre or university',
  'Privacy or my data',
  'Something else',
] as const;

/* Limits are per hour and deliberately low. This endpoint's whole job is to put
   text in a person's inbox, so the cost of abuse is paid in attention rather than
   compute. A real person sending more than five messages an hour is not writing,
   they are having a problem that another message will not solve. */
const PER_EMAIL_HOURLY = 5;
const PER_IP_HOURLY = 10;

export const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  reason: z.enum(CONTACT_REASONS),
  message: z.string().trim().min(1).max(5000),
  /* Honeypot. Present in the form, hidden from sight and from screen readers, so
     only an automated filler supplies it. Optional here because a real submission
     omits it entirely. */
  company: z.string().max(200).optional(),
});

export async function contactRoutes(fastify: FastifyInstance) {
  fastify.post('/contact', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = contactSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Name, email, a reason and a message are all needed.',
        code: 'invalid_contact',
      });
    }
    const { name, email, reason, message, company } = parsed.data;

    /* Answered with a 200 so a bot cannot tell a swallowed message from a
       delivered one and start probing for the shape that gets through. */
    if (company && company.trim().length > 0) {
      request.log.info({ reason }, 'contact: honeypot filled, dropping');
      return reply.status(200).send({ ok: true });
    }

    const ip = request.ip || 'unknown';
    const [emailAllowed, ipAllowed] = await Promise.all([
      allowHourly(`contact:email:${email.toLowerCase()}`, 'contact', PER_EMAIL_HOURLY),
      allowHourly(`contact:ip:${ip}`, 'contact', PER_IP_HOURLY),
    ]);
    if (!emailAllowed || !ipAllowed) return rateLimitedReply(reply);

    try {
      await sendEmail({
        from: emailSender(),
        to: [INBOX()],
        /* So hitting reply in the inbox answers the person who wrote in, rather
           than the verified sending domain, which nobody reads. */
        reply_to: email,
        subject: `Litos contact: ${reason}`,
        /* Plain text only. This is mail to one person, not a broadcast, and the
           body is untrusted input: sending it as text means nothing a stranger
           types can render as markup in the reader's client. */
        text: [
          `Reason:  ${reason}`,
          `Name:    ${name}`,
          `Email:   ${email}`,
          '',
          message,
        ].join('\n'),
      });
    } catch (error) {
      /* Logged loudly and answered honestly. A contact form that silently drops
         mail is worse than none, because the sender believes they have been
         heard. 503 rather than 500: the message was fine, the transport was not,
         and trying again later is the right advice. */
      request.log.error({ err: error, reason }, 'contact: send failed');
      return reply.status(503).send({
        error: 'We could not send that just now. Please try again shortly.',
        code: 'contact_unavailable',
      });
    }

    return reply.status(200).send({ ok: true });
  });
}
