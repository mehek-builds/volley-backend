import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { ats_adapters } from '../db/schema';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';

// Scheduled spot-check for the ATS field-mapping adapters (PRD-v2 Section 7's "adapter
// maintenance is an ongoing cost" note + Section 9's monitoring gap). Fetches each ATS's
// known live test posting server-side and checks for the DOM markers each extension
// adapter depends on, so breakage is caught by a cron rather than by a student hitting a
// silently-broken fill. This is a structural spot-check (do the expected ids/attributes
// still exist in the served HTML), not a full fill-and-verify - it can't run the actual
// content-script logic outside a real browser, and can't see anything client-rendered.
//
// Lever and Greenhouse serve their core identity fields server-rendered, so their
// selectors are checked directly against the fetched HTML. Ashby's board is a fully
// client-rendered SPA (confirmed 2026-07-02: raw fetch returns only a `<div id="root">`
// shell, no _systemfield_* markers) - a server-side fetch structurally cannot verify its
// form fields, so Ashby's check only confirms the board is still live and still an Ashby
// deployment (cdn.ashbyprd.com asset references present), and reports 'unknown' rather
// than a false 'healthy'.
const CHECKS: Array<{
  ats_name: string;
  version: string;
  test_url: string;
  selectors: string[];
  // Returns true if the fetched HTML shows the adapter's markers are still present.
  // Returns null when the check structurally can't confirm health (client-rendered).
  verify: (html: string) => boolean | null;
}> = [
  {
    ats_name: 'lever',
    version: '2026-07-01',
    test_url: 'https://jobs.lever.co/palantir/e27af7ab-41fc-40c9-b31d-02c6cb1c505c/apply',
    selectors: ['name="name"', 'name="email"', 'name="phone"', 'name="resume"'],
    verify: (html) => ['name="name"', 'name="email"', 'name="phone"', 'name="resume"'].every((s) => html.includes(s)),
  },
  {
    ats_name: 'greenhouse',
    version: '2026-07-01',
    test_url: 'https://job-boards.greenhouse.io/gemini/jobs/7875125',
    selectors: ['#first_name', '#last_name', '#email', '#phone', '#resume'],
    verify: (html) => ['id="first_name"', 'id="last_name"', 'id="email"', 'id="phone"', 'id="resume"'].every((s) => html.includes(s)),
  },
  {
    ats_name: 'ashby',
    version: '2026-07-01',
    test_url: 'https://jobs.ashbyhq.com/notion',
    selectors: ['#_systemfield_resume', '#_systemfield_name', '#_systemfield_email'],
    // Client-rendered SPA: can only confirm the board is still live and still Ashby.
    verify: (html) => (html.includes('cdn.ashbyprd.com') && html.includes('id="root"') ? null : false),
  },
  {
    ats_name: 'smartrecruiters',
    version: '2026-07-25',
    test_url: 'https://jobs.smartrecruiters.com/WesternDigital',
    selectors: ['#first-name-input', '#last-name-input', '#email-input', '#resume-input'],
    // The company page and application form are client-rendered. Confirm the deployment identity
    // without claiming that a server-side fetch has verified live form selectors.
    verify: (html) => (/smartrecruiters/i.test(html) ? null : false),
  },
];

async function runCheck(check: (typeof CHECKS)[number]): Promise<{ ats_name: string; status: string; note: string }> {
  let html: string;
  try {
    const res = await fetch(check.test_url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      return { ats_name: check.ats_name, status: 'broken', note: `test posting returned HTTP ${res.status}` };
    }
    html = await res.text();
  } catch (err) {
    return { ats_name: check.ats_name, status: 'broken', note: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const result = check.verify(html);
  if (result === null) {
    return { ats_name: check.ats_name, status: 'unknown', note: 'client-rendered board; server-side fetch cannot verify form fields, only that the board is still live' };
  }
  if (result) {
    return { ats_name: check.ats_name, status: 'healthy', note: 'all expected selectors present in served HTML' };
  }
  return { ats_name: check.ats_name, status: 'degraded', note: 'test posting reachable but one or more expected selectors missing - the adapter may need re-verification against a live posting' };
}

async function handleHealthCheck(request: FastifyRequest, reply: FastifyReply, fastify: FastifyInstance) {
  if (!isCronConfigured()) {
    return reply.status(503).send({ error: 'adapter health check not configured (set INTERNAL_CRON_SECRET or CRON_SECRET)' });
  }
  if (!isCronAuthorized(request)) {
    return reply.status(401).send({ error: 'unauthorized' });
  }

  const results = await Promise.all(CHECKS.map(runCheck));

  for (const check of CHECKS) {
    const result = results.find((r) => r.ats_name === check.ats_name)!;
    try {
      await db
        .insert(ats_adapters)
        .values({
          ats_name: check.ats_name,
          version: check.version,
          selectors: check.selectors,
          last_verified_at: new Date(),
          status: result.status,
        })
        .onConflictDoUpdate({
          target: ats_adapters.ats_name,
          set: {
            version: check.version,
            selectors: check.selectors,
            last_verified_at: new Date(),
            status: result.status,
          },
        });
    } catch (err) {
      fastify.log.error({ err, ats_name: check.ats_name }, 'failed to persist adapter health check result');
    }
  }

  return reply.status(200).send({ checked_at: new Date().toISOString(), results });
}

export async function adapterHealthRoutes(fastify: FastifyInstance) {
  // POST for manual/tooling triggers (curl + x-internal-secret); GET for Vercel Cron,
  // which only issues GET requests and authenticates via the Authorization header.
  fastify.post('/internal/adapter-health-check', (request, reply) => handleHealthCheck(request, reply, fastify));
  fastify.get('/internal/adapter-health-check', (request, reply) => handleHealthCheck(request, reply, fastify));

  // GET /internal/adapter-health - read the last-known status per ATS (for a dashboard
  // or a manual glance), same secret gate as the check endpoint.
  fastify.get('/internal/adapter-health', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isCronAuthorized(request)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const rows = await db.select().from(ats_adapters);
    return reply.status(200).send({ adapters: rows });
  });
}
