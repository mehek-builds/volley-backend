import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index';
import { companies, contacts, email_resolutions } from '../db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { resolveEmail } from '../engine/email';
import { v4 as uuidv4 } from 'uuid';

const resolveBodySchema = z.object({
  company: z.string().min(1),
  domain: z.string().min(1),
  role: z.string().min(1),
  team: z.string().optional(),
  user_school: z.string().optional(),
});

function getSizeBucket(domain: string): { size_bucket: string; employee_count: number } {
  // Heuristic bucket assignment based on well-known companies
  // In production this would come from a data provider
  const largeDomains = ['google.com', 'meta.com', 'amazon.com', 'microsoft.com', 'apple.com', 'netflix.com', 'salesforce.com', 'oracle.com'];
  const midDomains = ['stripe.com', 'airbnb.com', 'lyft.com', 'dropbox.com', 'twilio.com', 'zendesk.com'];

  if (largeDomains.includes(domain)) return { size_bucket: 'large', employee_count: 50000 };
  if (midDomains.includes(domain)) return { size_bucket: 'mid', employee_count: 5000 };
  return { size_bucket: 'small', employee_count: 150 };
}

function generateSyntheticContacts(
  companyName: string,
  domain: string,
  role: string,
  team: string | undefined,
  userSchool: string | undefined
): Array<{
  full_name: string;
  first_name: string;
  last_name: string;
  title: string;
  persona: string;
  school_match: boolean;
  linkedin_url: string;
}> {
  const teamLabel = team || extractTeam(role);
  const companySlug = domain.split('.')[0];

  const contacts: Array<{
    full_name: string;
    first_name: string;
    last_name: string;
    title: string;
    persona: string;
    school_match: boolean;
    linkedin_url: string;
  }> = [];

  // Alumni contact (only if user_school provided)
  if (userSchool) {
    contacts.push({
      full_name: 'Priya Sharma',
      first_name: 'Priya',
      last_name: 'Sharma',
      title: `Software Engineer, ${teamLabel}`,
      persona: 'alumni',
      school_match: true,
      linkedin_url: `https://linkedin.com/in/priya-sharma-${companySlug}`,
    });
  }

  // Recruiter
  contacts.push({
    full_name: 'Jordan Lee',
    first_name: 'Jordan',
    last_name: 'Lee',
    title: `University Recruiter, ${companyName}`,
    persona: 'recruiter',
    school_match: false,
    linkedin_url: `https://linkedin.com/in/jordan-lee-${companySlug}-recruiting`,
  });

  // Hiring manager
  contacts.push({
    full_name: 'Marcus Chen',
    first_name: 'Marcus',
    last_name: 'Chen',
    title: `Engineering Manager, ${teamLabel}`,
    persona: 'hiring_manager',
    school_match: false,
    linkedin_url: `https://linkedin.com/in/marcus-chen-${companySlug}`,
  });

  // Senior IC
  contacts.push({
    full_name: 'Aisha Williams',
    first_name: 'Aisha',
    last_name: 'Williams',
    title: `Senior ${extractJobTitle(role)}, ${teamLabel}`,
    persona: 'senior_ic',
    school_match: false,
    linkedin_url: `https://linkedin.com/in/aisha-williams-${companySlug}`,
  });

  // Near-peer (2-3 years ahead)
  contacts.push({
    full_name: 'Ryan Park',
    first_name: 'Ryan',
    last_name: 'Park',
    title: `${extractJobTitle(role)}, ${teamLabel}`,
    persona: 'near_peer',
    school_match: false,
    linkedin_url: `https://linkedin.com/in/ryan-park-${companySlug}`,
  });

  return contacts;
}

function extractTeam(role: string): string {
  const lower = role.toLowerCase();
  if (lower.includes('machine learning') || lower.includes('ml')) return 'ML Platform';
  if (lower.includes('data')) return 'Data Engineering';
  if (lower.includes('frontend') || lower.includes('front-end')) return 'Frontend';
  if (lower.includes('backend') || lower.includes('back-end')) return 'Backend Infrastructure';
  if (lower.includes('mobile') || lower.includes('ios') || lower.includes('android')) return 'Mobile';
  if (lower.includes('product')) return 'Product';
  return 'Engineering';
}

function extractJobTitle(role: string): string {
  const lower = role.toLowerCase();
  if (lower.includes('engineer')) return 'Software Engineer';
  if (lower.includes('analyst')) return 'Data Analyst';
  if (lower.includes('scientist')) return 'Data Scientist';
  if (lower.includes('manager')) return 'Product Manager';
  if (lower.includes('designer')) return 'Product Designer';
  return 'Software Engineer';
}

export async function resolveRoutes(fastify: FastifyInstance) {
  fastify.post('/resolve', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof resolveBodySchema>;

    try {
      body = resolveBodySchema.parse(request.body);
    } catch (err) {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    const { company: companyName, domain, role, team, user_school } = body;

    try {
      // Step 1: Look up or create company record
      let companyRecord = await db
        .select()
        .from(companies)
        .where(eq(companies.domain, domain))
        .limit(1);

      if (companyRecord.length === 0) {
        const { size_bucket, employee_count } = getSizeBucket(domain);
        await db.insert(companies).values({
          id: uuidv4(),
          domain,
          name: companyName,
          employee_count,
          size_bucket,
        });
        companyRecord = await db.select().from(companies).where(eq(companies.domain, domain)).limit(1);
      }

      const company = companyRecord[0];

      // Step 2: Generate synthetic contacts
      const syntheticContacts = generateSyntheticContacts(
        companyName,
        domain,
        role,
        team,
        user_school
      );

      // Step 3: Insert contacts and resolve emails
      const results = [];

      for (const sc of syntheticContacts) {
        // Insert contact
        const contactId = uuidv4();
        await db.insert(contacts).values({
          id: contactId,
          full_name: sc.full_name,
          first_name: sc.first_name,
          last_name: sc.last_name,
          linkedin_url: sc.linkedin_url,
          company_domain: domain,
          title: sc.title,
          persona: sc.persona,
          school_match: sc.school_match,
        });

        // Resolve email
        const emailResult = await resolveEmail(
          {
            id: contactId,
            first_name: sc.first_name,
            last_name: sc.last_name,
            company_domain: domain,
          },
          { size_bucket: company.size_bucket }
        );

        // Store email resolution
        const resolutionId = uuidv4();
        await db.insert(email_resolutions).values({
          id: resolutionId,
          contact_id: contactId,
          email: emailResult.email,
          status: emailResult.status,
          tier: emailResult.tier,
          source: emailResult.source,
          verifier_raw_json: emailResult.verifierRawJson ?? null,
          resolved_at: new Date(),
        });

        results.push({
          contact: {
            id: contactId,
            full_name: sc.full_name,
            first_name: sc.first_name,
            last_name: sc.last_name,
            title: sc.title,
            persona: sc.persona,
            school_match: sc.school_match,
            linkedin_url: sc.linkedin_url,
            company_domain: domain,
          },
          email_resolution: {
            id: resolutionId,
            email: emailResult.email,
            status: emailResult.status,
            tier: emailResult.tier,
            source: emailResult.source,
            pattern_used: emailResult.patternUsed,
          },
        });
      }

      // Sort: green first, then amber, then blue; alumni first within same tier
      const tierOrder = { green: 0, amber: 1, blue: 2 };
      const personaOrder = { alumni: 0, hiring_manager: 1, recruiter: 2, near_peer: 3, senior_ic: 4 };

      results.sort((a, b) => {
        const tierDiff =
          (tierOrder[a.email_resolution.tier as keyof typeof tierOrder] ?? 99) -
          (tierOrder[b.email_resolution.tier as keyof typeof tierOrder] ?? 99);
        if (tierDiff !== 0) return tierDiff;
        return (
          (personaOrder[a.contact.persona as keyof typeof personaOrder] ?? 99) -
          (personaOrder[b.contact.persona as keyof typeof personaOrder] ?? 99)
        );
      });

      return reply.status(200).send({ contacts: results });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to resolve contacts' });
    }
  });
}
