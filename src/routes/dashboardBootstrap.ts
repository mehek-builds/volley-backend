import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const OPTIONAL_DEFAULTS = {
  targeting: {
    categories: null,
    titles: null,
    role_types: null,
    primary_period: null,
    backup_period: null,
  },
  profile: { skills: [], target_roles: [] },
  resume_history: { resumes: [] },
  application_profile: {},
  outreach: [],
  onboarding: { automatic_submission_enabled: false },
} as const;

export type DashboardBootstrapResource =
  | 'me'
  | 'jobs'
  | keyof typeof OPTIONAL_DEFAULTS;

export type DashboardBootstrapFetcher = (
  resource: DashboardBootstrapResource,
) => Promise<unknown>;

export type DashboardBootstrapResponse = {
  schema_version: 1;
  me: unknown;
  jobs: unknown;
  targeting: unknown;
  profile: unknown;
  resume_history: unknown;
  application_profile: unknown;
  outreach: unknown;
  onboarding: unknown;
  warnings: DashboardBootstrapResource[];
};

/**
 * Compose the dashboard's first-screen projection without coupling the contract to Fastify.
 *
 * Identity and jobs are critical because the page cannot render honestly without either one.
 * The remaining resources preserve the dashboard's previous fail-soft behavior: a missing profile
 * or outreach history becomes an explicit default and a warning, not a total page outage.
 */
export async function composeDashboardBootstrap(
  fetchResource: DashboardBootstrapFetcher,
): Promise<DashboardBootstrapResponse> {
  // Start the critical reads first so a nearly exhausted per-IP bucket cannot be spent on
  // fail-soft projections before identity and jobs have a chance to complete.
  const criticalEntriesPromise = Promise.all([fetchResource('me'), fetchResource('jobs')]);
  const optionalEntriesPromise = Promise.all(
    (Object.keys(OPTIONAL_DEFAULTS) as Array<keyof typeof OPTIONAL_DEFAULTS>).map(async (resource) => {
      try {
        return [resource, await fetchResource(resource), false] as const;
      } catch {
        return [resource, OPTIONAL_DEFAULTS[resource], true] as const;
      }
    }),
  );
  const [[me, jobs], optionalResults] = await Promise.all([
    criticalEntriesPromise,
    optionalEntriesPromise,
  ]);
  const warnings = optionalResults
    .filter(([, , degraded]) => degraded)
    .map(([resource]) => resource);
  const optionalEntries = optionalResults.map(([resource, value]) => [resource, value] as const);

  return {
    schema_version: 1,
    me,
    jobs,
    ...Object.fromEntries(optionalEntries),
    warnings,
  } as DashboardBootstrapResponse;
}

const RESOURCE_URLS: Record<DashboardBootstrapResource, string> = {
  me: '/me',
  jobs: '/jobs?offset=0',
  targeting: '/profile/targeting',
  profile: '/profile',
  resume_history: '/resume/history',
  application_profile: '/profile/application',
  outreach: '/track/events',
  onboarding: '/onboarding/state',
};

function forwardedHeaders(request: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ['authorization', 'x-litos-client', 'x-litos-version'] as const) {
    const value = request.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}

export async function dashboardBootstrapRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/dashboard/bootstrap',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Authentication is enforced by every private resource below, with /me acting as the
      // critical gate for the aggregate response. Avoiding a second outer requireAuth check keeps
      // one bootstrap equivalent to the eight authenticated reads it replaces, not nine.
      const headers = forwardedHeaders(request);
      const fetchResource: DashboardBootstrapFetcher = async (resource) => {
        const response = await fastify.inject({
          method: 'GET',
          url: RESOURCE_URLS[resource],
          headers,
          // Preserve the caller's rate-limit identity. Injected requests otherwise all appear as
          // 127.0.0.1 and unrelated users in one warm instance would consume one shared bucket.
          remoteAddress: request.ip,
        });

        const body = response.json();
        if (response.statusCode >= 400) {
          const message = typeof body?.error === 'string'
            ? body.error
            : `Could not load dashboard resource: ${resource}`;
          throw Object.assign(new Error(message), { statusCode: response.statusCode });
        }
        return body;
      };

      try {
        const payload = await composeDashboardBootstrap(fetchResource);
        return reply
          .header('Cache-Control', 'private, max-age=15, stale-while-revalidate=30')
          .header('Vary', 'Authorization')
          .status(200)
          .send(payload);
      } catch (error) {
        const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
          ? (error as { statusCode: number }).statusCode
          : 503;
        request.log.error({ err: error }, 'dashboard bootstrap critical dependency failed');
        return reply.status(statusCode).send({
          error: error instanceof Error ? error.message : 'Could not load dashboard',
        });
      }
    },
  );
}
