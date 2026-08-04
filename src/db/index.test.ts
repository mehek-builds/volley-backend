import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { Pool } from 'pg';
import { dedicatedDatabaseUrl, withoutSslMode } from './index';

test('derives a direct Neon endpoint for connection-bound advisory locks', () => {
  const url = dedicatedDatabaseUrl({
    DATABASE_URL: 'postgresql://user:secret@ep-example-pooler.us-east-2.aws.neon.tech/litos?sslmode=require',
  });
  assert.equal(new URL(url).hostname, 'ep-example.us-east-2.aws.neon.tech');
});

test('prefers an explicit direct database URL and rejects unknown poolers', () => {
  const direct = 'postgresql://user:secret@direct.example.com/litos';
  assert.equal(dedicatedDatabaseUrl({ DATABASE_URL: 'postgresql://ignored', DATABASE_DIRECT_URL: direct }), direct);
  assert.throws(
    () => dedicatedDatabaseUrl({ DATABASE_URL: 'postgresql://user:secret@pgbouncer.example.com/litos' }),
    /session-pinned/,
  );
});

/**
 * The pg SECURITY WARNING was the project's ONLY runtime error group: 59 occurrences across 7
 * users since 2026-07-01, from `?sslmode=require` on the Neon URL DEPLOY.md tells you to use.
 *
 * The whole safety argument for deleting the parameter is that the explicit `ssl` option already
 * decides the TLS config, so removing it changes nothing. That is a claim about a third-party
 * library's precedence rules, so it is pinned here rather than trusted: if a pg upgrade ever makes
 * the connection string win, this test fails instead of production quietly changing how it
 * verifies certificates.
 */
describe('the connection string does not carry sslmode into pg', () => {
  const SSL = { rejectUnauthorized: false } as const;

  test('an explicit ssl option decides the config, with or without sslmode', async () => {
    const withMode = new Pool({
      connectionString: 'postgresql://u:p@ep-example.us-east-2.aws.neon.tech/litos?sslmode=require',
      ssl: SSL,
    });
    const without = new Pool({
      connectionString: 'postgresql://u:p@ep-example.us-east-2.aws.neon.tech/litos',
      ssl: SSL,
    });
    assert.deepEqual(withMode.options.ssl, SSL);
    assert.deepEqual(without.options.ssl, SSL, 'stripping sslmode must not change the resolved TLS config');
    assert.deepEqual(withMode.options.ssl, without.options.ssl);
    await Promise.all([withMode.end(), without.end()]);
  });

  test('sslmode is removed and every other parameter is left alone', () => {
    assert.equal(
      withoutSslMode('postgresql://u:p@host.neon.tech/litos?sslmode=require'),
      'postgresql://u:p@host.neon.tech/litos',
    );
    assert.equal(
      withoutSslMode('postgresql://u:p@host.neon.tech/litos?sslmode=require&application_name=litos'),
      'postgresql://u:p@host.neon.tech/litos?application_name=litos',
    );
    assert.equal(
      withoutSslMode('postgresql://u:p@host.neon.tech/litos?application_name=litos'),
      'postgresql://u:p@host.neon.tech/litos?application_name=litos',
    );
  });

  test('a string with no sslmode is returned byte-identical, not round-tripped through URL', () => {
    // `new URL(x).toString()` normalises: it appends a trailing slash to a bare host and re-encodes
    // reserved characters, and a Postgres password is exactly where reserved characters live. The
    // early return is what keeps this function from rewriting a connection string it has no reason
    // to touch, so it is pinned rather than left to the next reader to notice.
    for (const raw of [
      'postgresql://u:p@host.neon.tech/litos',
      'postgresql://user:pa%2Fss@host.neon.tech/litos',
      'postgresql://postgres:password@localhost:5432/student_outreach',
    ]) {
      assert.equal(withoutSslMode(raw), raw);
    }
  });
});
