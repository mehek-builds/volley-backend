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
