import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index';
import { outreach_events, learning_signals, contacts, domain_patterns } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { v4 as uuidv4 } from 'uuid';

const trackEventBodySchema = z.object({
  contact_id: z.string().uuid(),
  channel: z.enum(['email', 'linkedin']),
  subject: z.string().optional(),
  draft_text: z.string().optional(),
  outcome: z.enum(['sent', 'opened', 'replied', 'bounced']),
});

export async function trackRoutes(fastify: FastifyInstance) {
  // POST /track/event
  fastify.post('/track/event', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    let body: z.infer<typeof trackEventBodySchema>;

    try {
      body = trackEventBodySchema.parse(request.body);
    } catch (err) {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    const { contact_id, channel, subject, draft_text, outcome } = body;

    try {
      // Fetch contact to get company domain + persona
      const contactRecords = await db
        .select()
        .from(contacts)
        .where(eq(contacts.id, contact_id))
        .limit(1);

      if (contactRecords.length === 0) {
        return reply.status(404).send({ error: 'Contact not found' });
      }

      const contact = contactRecords[0];

      // Find existing outreach event for this user+contact+channel combination
      const existing = await db
        .select()
        .from(outreach_events)
        .where(
          and(
            eq(outreach_events.user_id, userId),
            eq(outreach_events.contact_id, contact_id),
            eq(outreach_events.channel, channel)
          )
        )
        .limit(1);

      const now = new Date();

      if (existing.length > 0) {
        // Update existing event
        const update: Record<string, unknown> = {};

        if (outcome === 'sent') update.sent_at = now;
        if (outcome === 'opened') update.opened_at = now;
        if (outcome === 'replied') update.replied_at = now;
        if (outcome === 'bounced') update.bounced = true;
        if (subject) update.subject = subject;
        if (draft_text) update.draft_text = draft_text;
        if (outcome === 'sent') {
          update.follow_up_count = (existing[0].follow_up_count ?? 0) + 1;
        }

        await db
          .update(outreach_events)
          .set(update)
          .where(eq(outreach_events.id, existing[0].id));
      } else {
        // Create new event
        await db.insert(outreach_events).values({
          id: uuidv4(),
          user_id: userId,
          contact_id,
          channel,
          subject: subject ?? null,
          draft_text: draft_text ?? null,
          follow_up_count: 0,
          bounced: outcome === 'bounced',
          sent_at: outcome === 'sent' ? now : null,
          opened_at: outcome === 'opened' ? now : null,
          replied_at: outcome === 'replied' ? now : null,
        });
      }

      // Write learning signal
      await db.insert(learning_signals).values({
        id: uuidv4(),
        persona: contact.persona,
        channel,
        company_size: null, // would be populated by joining with companies
        template_id: null,
        outcome,
        user_id: userId,
        created_at: now,
      });

      // If replied: boost domain_patterns confidence for this domain
      if (outcome === 'replied' && contact.company_domain) {
        const domainPattern = await db
          .select()
          .from(domain_patterns)
          .where(eq(domain_patterns.domain, contact.company_domain))
          .limit(1);

        if (domainPattern.length > 0) {
          const newConfidence = Math.min(0.99, (domainPattern[0].confidence ?? 0.5) + 0.15);
          const newConfirmations = (domainPattern[0].confirmations ?? 1) + 1;
          await db
            .update(domain_patterns)
            .set({
              confidence: newConfidence,
              confirmations: newConfirmations,
              last_confirmed_at: now,
            })
            .where(eq(domain_patterns.domain, contact.company_domain));

          fastify.log.info(
            `[track] Reply boosted domain_patterns for ${contact.company_domain}: confidence=${newConfidence}`
          );
        }
      }

      return reply.status(200).send({ success: true, outcome });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to track event' });
    }
  });

  // GET /track/events
  fastify.get('/track/events', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    try {
      const events = await db
        .select({
          event: outreach_events,
          contact: contacts,
        })
        .from(outreach_events)
        .leftJoin(contacts, eq(outreach_events.contact_id, contacts.id))
        .where(eq(outreach_events.user_id, userId));

      const formatted = events.map(({ event, contact }) => {
        const status =
          event.bounced ? 'bounced'
          : event.replied_at ? 'replied'
          : event.sent_at ? 'sent'
          : 'drafted';
        return {
          id: event.id,
          channel: event.channel,
          subject: event.subject,
          draft_text: event.draft_text,
          sent_at: event.sent_at,
          opened_at: event.opened_at,
          replied_at: event.replied_at,
          bounced: event.bounced,
          follow_up_count: event.follow_up_count,
          status,
          contact: contact
            ? {
                id: contact.id,
                full_name: contact.full_name,
                title: contact.title,
                persona: contact.persona,
                company_domain: contact.company_domain,
                linkedin_url: contact.linkedin_url,
              }
            : null,
        };
      });

      return reply.status(200).send(formatted);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to retrieve events' });
    }
  });
}
