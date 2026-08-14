import assert from 'node:assert/strict';
import test from 'node:test';
import { and } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { normalizeTargeting, type JobTargeting } from '../lib/jobPreferences';
import { boardConditions } from './jobMonitor';

const dialect = new PgDialect();
const baselineConditionCount = boardConditions({}).length;

function renderedLocationConditions(filters: {
  location?: string;
  targeting?: JobTargeting;
}) {
  const addedConditions = boardConditions(filters).slice(baselineConditionCount);
  return {
    addedConditions,
    query: addedConditions.length
      ? dialect.sqlToQuery(and(...addedConditions)!)
      : null,
  };
}

test('saved United States includes onsite and remote US jobs, but excludes foreign and unknown jobs', () => {
  const { query } = renderedLocationConditions({
    targeting: normalizeTargeting({ locations: ['United States'] }),
  });

  assert.ok(query);
  assert.match(query.sql, /^\"monitored_jobs\"\.\"job_country\" = \$1$/);
  assert.deepEqual(query.params, ['us']);
  assert.doesNotMatch(query.sql, /remote/, 'both onsite and remote US rows remain eligible');
});

test('explicit United States uses the same structured country filter', () => {
  const { query } = renderedLocationConditions({ location: 'United States' });

  assert.ok(query);
  assert.match(query.sql, /^\"monitored_jobs\"\.\"job_country\" = \$1$/);
  assert.deepEqual(query.params, ['us']);
});

test('remote-only composes with saved United States', () => {
  const { addedConditions, query } = renderedLocationConditions({
    targeting: normalizeTargeting({ locations: ['United States'], remote_only: true }),
  });

  assert.equal(addedConditions.length, 2);
  assert.ok(query);
  assert.match(query.sql, /\"monitored_jobs\"\.\"job_country\" = \$1/);
  assert.match(query.sql, /\"monitored_jobs\"\.\"remote\" = \$2/);
  assert.deepEqual(query.params, ['us', true]);
});

test('null saved locations remain global', () => {
  const { addedConditions, query } = renderedLocationConditions({
    targeting: normalizeTargeting({ locations: null }),
  });

  assert.deepEqual(addedConditions, []);
  assert.equal(query, null);
});

test('city and global Remote choices keep their existing behavior', () => {
  const city = renderedLocationConditions({
    targeting: normalizeTargeting({ locations: ['London'] }),
  }).query;
  assert.ok(city);
  assert.match(city.sql, /^\"monitored_jobs\"\.\"location\" ilike \$1$/);
  assert.deepEqual(city.params, ['%London%']);

  const remote = renderedLocationConditions({
    targeting: normalizeTargeting({ locations: ['Remote'] }),
  }).query;
  assert.ok(remote);
  assert.match(remote.sql, /^\"monitored_jobs\"\.\"remote\" = \$1$/);
  assert.deepEqual(remote.params, [true]);
});
