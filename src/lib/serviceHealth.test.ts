import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateServiceHealthStatus } from './serviceHealth';

test('application email degradation is visible in top-level service health', () => {
  assert.equal(aggregateServiceHealthStatus({
    database: 'ok',
    applicationEmail: { status: 'degraded' },
  }), 'degraded');
});

test('application email being intentionally unconfigured does not report an incident', () => {
  assert.equal(aggregateServiceHealthStatus({
    database: 'ok',
    applicationEmail: { status: 'not_configured' },
  }), 'ok');
});

test('database failure remains degraded independently of application email', () => {
  assert.equal(aggregateServiceHealthStatus({
    database: 'unreachable',
    applicationEmail: { status: 'ok' },
  }), 'degraded');
});

test('an unavailable model degrades the service without pretending the API is down', () => {
  // Added 2026-08-15. Before this the aggregator could not see the model at all, so an empty
  // Anthropic balance reported 'ok' while onboarding was unusable.
  assert.equal(aggregateServiceHealthStatus({
    database: 'ok',
    applicationEmail: { status: 'ok' },
    model: { status: 'unavailable' },
  }), 'degraded');
});

test('a model that is merely unconfigured is not an incident', () => {
  assert.equal(aggregateServiceHealthStatus({
    database: 'ok',
    applicationEmail: { status: 'ok' },
    model: { status: 'not_configured' },
  }), 'ok');
});

test('an unmeasured model cannot make a degraded service look healthy', () => {
  assert.equal(aggregateServiceHealthStatus({
    database: 'unreachable',
    applicationEmail: { status: 'ok' },
  }), 'degraded');
});
