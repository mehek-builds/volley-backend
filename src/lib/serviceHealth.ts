export type ServiceHealthStatus = 'ok' | 'degraded';

/**
 * Capability failures must be visible at the top level without converting the API's liveness
 * response into an outage. Database health still controls the HTTP status code. This value tells
 * operators that an important flow is unavailable while unrelated endpoints remain reachable.
 */
export function aggregateServiceHealthStatus(input: {
  database: 'ok' | 'unreachable';
  applicationEmail: { status: 'ok' | 'degraded' | 'not_configured' };
  /* Optional so existing callers and older tests keep compiling, and absent means "not measured",
     which must never read as healthy. Added 2026-08-15: the Anthropic balance ran out, every
     model-backed flow failed, and this function returned 'ok' because nothing asked it about the
     model. `not_configured` is not degraded, for the same reason it is not for the inbox: a preview
     deployment without a key is a configuration state, not an incident. */
  model?: { status: 'ok' | 'unavailable' | 'not_configured' };
}): ServiceHealthStatus {
  if (input.database !== 'ok') return 'degraded';
  if (input.model?.status === 'unavailable') return 'degraded';
  return input.applicationEmail.status === 'degraded' ? 'degraded' : 'ok';
}
