export type ServiceHealthStatus = 'ok' | 'degraded';

/**
 * Capability failures must be visible at the top level without converting the API's liveness
 * response into an outage. Database health still controls the HTTP status code. This value tells
 * operators that an important flow is unavailable while unrelated endpoints remain reachable.
 */
export function aggregateServiceHealthStatus(input: {
  database: 'ok' | 'unreachable';
  applicationEmail: { status: 'ok' | 'degraded' | 'not_configured' };
}): ServiceHealthStatus {
  if (input.database !== 'ok') return 'degraded';
  return input.applicationEmail.status === 'degraded' ? 'degraded' : 'ok';
}
