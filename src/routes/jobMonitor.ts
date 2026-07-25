import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import { career_page_sources, monitored_jobs } from '../db/schema';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { fetchSourceJobs, type JobSourceInput, type SupportedJobBoard } from '../lib/jobMonitor';

const sourceSchema = z.object({
  company_name: z.string().trim().min(1).max(200),
  ats_name: z.enum(['greenhouse', 'lever', 'ashby']),
  board_token: z.string().trim().min(1).max(300),
  career_url: z.string().url().max(4000),
  enabled: z.boolean().optional().default(true),
});

const sourcesBodySchema = z.object({ sources: z.array(sourceSchema).min(1).max(100) });
const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  location: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  remote: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const jobParamsSchema = z.object({ id: z.string().uuid() });

function requireOperator(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!isCronConfigured() || !isCronAuthorized(request)) {
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function configuredSources(): JobSourceInput[] {
  const raw = process.env.JOB_MONITOR_SOURCES_JSON;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('JOB_MONITOR_SOURCES_JSON must be valid JSON');
  }
  const result = z.array(sourceSchema).max(100).safeParse(parsed);
  if (!result.success) throw new Error('JOB_MONITOR_SOURCES_JSON contains an invalid source');
  return result.data;
}

async function upsertSources(sources: JobSourceInput[]) {
  for (const source of sources) {
    const rows = await db.insert(career_page_sources).values(source).onConflictDoUpdate({
      target: [career_page_sources.ats_name, career_page_sources.board_token],
      set: {
        company_name: source.company_name,
        career_url: source.career_url,
        enabled: source.enabled ?? true,
      },
    }).returning({ id: career_page_sources.id });
    if (source.enabled === false && rows[0]) {
      await db.update(monitored_jobs).set({ is_active: false }).where(eq(monitored_jobs.source_id, rows[0].id));
    }
  }
}

async function pollSource(source: typeof career_page_sources.$inferSelect) {
  try {
    const jobs = await fetchSourceJobs({
      ats_name: source.ats_name as SupportedJobBoard,
      board_token: source.board_token,
    });
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(monitored_jobs).set({ is_active: false }).where(eq(monitored_jobs.source_id, source.id));
      for (const job of jobs) {
        await tx.insert(monitored_jobs).values({
          source_id: source.id,
          company_name: source.company_name,
          ...job,
          last_seen_at: now,
          is_active: true,
        }).onConflictDoUpdate({
          target: [monitored_jobs.source_id, monitored_jobs.external_id],
          set: {
            company_name: source.company_name,
            title: job.title,
            location: job.location,
            department: job.department,
            employment_type: job.employment_type,
            description: job.description,
            apply_url: job.apply_url,
            posting_url: job.posting_url,
            remote: job.remote,
            posted_at: job.posted_at,
            last_seen_at: now,
            is_active: true,
            raw_json: job.raw_json,
          },
        });
      }
    });
    await db.update(career_page_sources).set({ last_polled_at: now, last_error: null }).where(eq(career_page_sources.id, source.id));
    return { source_id: source.id, company: source.company_name, jobs: jobs.length, ok: true as const };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2000) : 'Career page poll failed';
    await db.update(career_page_sources).set({ last_polled_at: new Date(), last_error: message }).where(eq(career_page_sources.id, source.id));
    return { source_id: source.id, company: source.company_name, jobs: 0, ok: false as const, error: message };
  }
}

export async function jobMonitorRoutes(fastify: FastifyInstance) {
  fastify.get('/jobs', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid job filters' });
    const { q, location, company, remote, limit, offset } = parsed.data;
    const conditions = [eq(monitored_jobs.is_active, true), eq(career_page_sources.enabled, true)];
    if (q) conditions.push(or(ilike(monitored_jobs.title, `%${q}%`), ilike(monitored_jobs.description, `%${q}%`))!);
    if (location) conditions.push(ilike(monitored_jobs.location, `%${location}%`));
    if (company) conditions.push(ilike(monitored_jobs.company_name, `%${company}%`));
    if (remote) conditions.push(eq(monitored_jobs.remote, remote === 'true'));
    const rows = await db
      .select({
        id: monitored_jobs.id,
        company_name: monitored_jobs.company_name,
        title: monitored_jobs.title,
        location: monitored_jobs.location,
        department: monitored_jobs.department,
        employment_type: monitored_jobs.employment_type,
        description: sql<string>`left(${monitored_jobs.description}, 600)`,
        apply_url: monitored_jobs.apply_url,
        posting_url: monitored_jobs.posting_url,
        remote: monitored_jobs.remote,
        posted_at: monitored_jobs.posted_at,
        first_seen_at: monitored_jobs.first_seen_at,
        ats_name: career_page_sources.ats_name,
      })
      .from(monitored_jobs)
      .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
      .where(and(...conditions))
      .orderBy(desc(monitored_jobs.posted_at), desc(monitored_jobs.first_seen_at), desc(monitored_jobs.id))
      .limit(limit + 1)
      .offset(offset);
    return reply.send({ jobs: rows.slice(0, limit), limit, offset, has_more: rows.length > limit });
  });

  fastify.get('/jobs/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = jobParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid job id' });
    const rows = await db
      .select({
        id: monitored_jobs.id,
        company_name: monitored_jobs.company_name,
        title: monitored_jobs.title,
        location: monitored_jobs.location,
        department: monitored_jobs.department,
        employment_type: monitored_jobs.employment_type,
        description: monitored_jobs.description,
        apply_url: monitored_jobs.apply_url,
        posting_url: monitored_jobs.posting_url,
        remote: monitored_jobs.remote,
        posted_at: monitored_jobs.posted_at,
        first_seen_at: monitored_jobs.first_seen_at,
        is_active: monitored_jobs.is_active,
        ats_name: career_page_sources.ats_name,
      })
      .from(monitored_jobs)
      .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
      .where(and(
        eq(monitored_jobs.id, parsed.data.id),
        eq(monitored_jobs.is_active, true),
        eq(career_page_sources.enabled, true),
      ))
      .limit(1);
    if (!rows[0]) return reply.status(404).send({ error: 'Job not found' });
    return reply.send({ job: rows[0] });
  });

  fastify.post('/internal/job-monitor/sources', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireOperator(request, reply)) return;
    const parsed = sourcesBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid career page sources', detail: parsed.error.issues });
    await upsertSources(parsed.data.sources);
    return reply.status(204).send();
  });

  fastify.get('/internal/job-monitor', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireOperator(request, reply)) return;
    const envSources = configuredSources();
    if (envSources.length > 0) await upsertSources(envSources);
    const sources = await db.select().from(career_page_sources)
      .where(eq(career_page_sources.enabled, true))
      .orderBy(sql`${career_page_sources.last_polled_at} asc nulls first`)
      .limit(20);
    const results = [];
    for (let index = 0; index < sources.length; index += 4) {
      results.push(...await Promise.all(sources.slice(index, index + 4).map(pollSource)));
    }
    return reply.send({
      sources: results.length,
      jobs: results.reduce((sum, result) => sum + result.jobs, 0),
      failed: results.filter((result) => !result.ok).length,
      results,
    });
  });
}
