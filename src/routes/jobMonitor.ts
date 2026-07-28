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

/* One daily run has to touch EVERY enabled source, not a rotating slice of
   them. At 20 per run a 40-source board took two days to come round, and a
   source is only marked stale when it is polled, so a posting closed on Monday
   sat on the public board until Wednesday. The Vercel function ceiling is 300s
   (vercel.json) and a board fetch is one HTTP call plus one transaction, so
   eight at a time clears ~60 sources well inside the budget. Raise the source
   count past this and the limit needs raising with it, or the tail stops
   refreshing daily and nothing says so. */
const POLL_SOURCES_PER_RUN = 60;
const POLL_CONCURRENCY = 8;
const UPSERT_CHUNK = 200;

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

export async function upsertSources(sources: JobSourceInput[]) {
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

export async function pollSource(source: typeof career_page_sources.$inferSelect) {
  try {
    const jobs = await fetchSourceJobs({
      ats_name: source.ats_name as SupportedJobBoard,
      board_token: source.board_token,
    });
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(monitored_jobs).set({ is_active: false }).where(eq(monitored_jobs.source_id, source.id));
      /* One statement per posting meant 7,109 round trips for a full sweep and
         a 469s run, against a 300s Vercel ceiling (vercel.json) — the daily
         cron would have died halfway through the alphabet, leaving every
         un-reached source's jobs flipped to is_active = false by the sweep
         above. That failure empties the public board rather than staling it.
         Chunked so a single board the size of Databricks still fits well
         inside Postgres's 65,535-parameter cap: 14 columns x 200 rows. */
      for (let index = 0; index < jobs.length; index += UPSERT_CHUNK) {
        const chunk = jobs.slice(index, index + UPSERT_CHUNK).map((job) => ({
          source_id: source.id,
          company_name: source.company_name,
          ...job,
          last_seen_at: now,
          is_active: true,
        }));
        await tx.insert(monitored_jobs).values(chunk).onConflictDoUpdate({
          target: [monitored_jobs.source_id, monitored_jobs.external_id],
          set: {
            company_name: sql`excluded.company_name`,
            title: sql`excluded.title`,
            location: sql`excluded.location`,
            department: sql`excluded.department`,
            employment_type: sql`excluded.employment_type`,
            description: sql`excluded.description`,
            apply_url: sql`excluded.apply_url`,
            posting_url: sql`excluded.posting_url`,
            remote: sql`excluded.remote`,
            posted_at: sql`excluded.posted_at`,
            last_seen_at: sql`excluded.last_seen_at`,
            is_active: sql`excluded.is_active`,
            raw_json: sql`excluded.raw_json`,
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
      /* A search matches the title OR the body, and the body is the whole job
         description, so "product manager" matched 707 postings of which most
         only mention the phrase in passing ("you will work with our product
         manager"). Sorted by date alone, the top of that page was Senior
         Machine Learning Engineer — a board that looks broken to anyone who
         types what they actually want. Title hits first, then the same date
         order within each group. Recency alone stays the order when there is
         no search term, which is what a browse wants. */
      .orderBy(
        ...(q ? [sql`case when ${monitored_jobs.title} ilike ${`%${q}%`} then 0 else 1 end`] : []),
        desc(monitored_jobs.posted_at),
        desc(monitored_jobs.first_seen_at),
        desc(monitored_jobs.id),
      )
      .limit(limit + 1)
      .offset(offset);
    /* The board on trylitos.com/browse-jobs prints how many jobs there are and
       paginates over the whole set, and neither is derivable from has_more: a
       caller reading page 1 can only say "more than 24". Counted under the same
       filters as the page, so the number always describes the list beneath it
       rather than the table. */
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(monitored_jobs)
      .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
      .where(and(...conditions));
    return reply.send({ jobs: rows.slice(0, limit), total, limit, offset, has_more: rows.length > limit });
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
      .limit(POLL_SOURCES_PER_RUN);
    const results = [];
    for (let index = 0; index < sources.length; index += POLL_CONCURRENCY) {
      results.push(...await Promise.all(sources.slice(index, index + POLL_CONCURRENCY).map(pollSource)));
    }
    return reply.send({
      sources: results.length,
      jobs: results.reduce((sum, result) => sum + result.jobs, 0),
      failed: results.filter((result) => !result.ok).length,
      results,
    });
  });
}
