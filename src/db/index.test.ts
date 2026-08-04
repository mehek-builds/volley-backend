import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import ConnectionParameters from 'pg/lib/connection-parameters';
import { dedicatedDatabaseUrl, normalizeSslMode } from './index';

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
 * THE ASSERTION THAT MATTERS IS ON ConnectionParameters, NOT ON Pool.options.
 *
 * The first version of this suite asserted `pool.options.ssl` and passed. That is the object handed
 * to the constructor, returned by identity, so the assertion held under every possible precedence
 * rule - including the one actually in effect, which was the opposite of what the code assumed. It
 * was a tautology dressed as a safety net, and it kept CI green over a change that would have
 * turned off certificate verification against the production database.
 *
 * ConnectionParameters is what pg derives and what reaches tls.connect. pg 8.21.0,
 * connection-parameters.js:58, does `Object.assign({}, config, parse(config.connectionString))`, so
 * the CONNECTION STRING overrides the explicit `ssl` option. That is the fact the code depends on,
 * so it is the fact pinned here: `pg` is a caret range (^8.11.0), and if a minor bump reverses that
 * ordering these tests fail instead of production quietly changing how it verifies certificates.
 */
describe('sslmode is normalized, and TLS behaviour is unchanged by it', () => {
  const OVERRIDE = { rejectUnauthorized: false } as const;
  /** The resolved ssl config as pg computes it, given our exact constructor arguments. */
  const resolved = (connectionString: string) =>
    new (ConnectionParameters as unknown as new (c: unknown) => { ssl: unknown })({
      connectionString,
      ssl: OVERRIDE,
    }).ssl;

  test('the connection string overrides the explicit ssl option, not the other way round', () => {
    // The load-bearing precedence fact. If this ever flips, everything below is reasoning about a
    // library that no longer behaves that way.
    assert.deepEqual(
      resolved('postgresql://u:p@h.neon.tech/d?sslmode=require'),
      {},
      'a connection string carrying sslmode must win over the explicit ssl option',
    );
    assert.deepEqual(
      resolved('postgresql://u:p@h.neon.tech/d'),
      OVERRIDE,
      'with no sslmode the explicit option is what applies',
    );
  });

  test('rewriting require to verify-full leaves the resolved config byte-identical', () => {
    // The safety argument for the whole change, stated as an assertion. `{}` means no
    // rejectUnauthorized key, so Node's default of true applies: the certificate IS verified.
    const before = resolved('postgresql://u:p@h.neon.tech/d?sslmode=require');
    const after = resolved(normalizeSslMode('postgresql://u:p@h.neon.tech/d?sslmode=require'));
    assert.deepEqual(after, before);
    assert.deepEqual(after, {});
  });

  test('DELETING sslmode would have disabled certificate verification', () => {
    // The regression this suite exists for, pinned as the negative. This is what the first version
    // of normalizeSslMode did, and what the first version of this test could not see.
    const deleted = resolved('postgresql://u:p@h.neon.tech/d');
    assert.deepEqual(deleted, OVERRIDE);
    assert.notDeepEqual(
      deleted,
      resolved('postgresql://u:p@h.neon.tech/d?sslmode=require'),
      'if these ever match, dropping sslmode is safe and this test should be revisited',
    );
  });

  test('only the warned aliases are rewritten, and other parameters are untouched', () => {
    assert.equal(
      normalizeSslMode('postgresql://u:p@h.neon.tech/d?sslmode=require'),
      'postgresql://u:p@h.neon.tech/d?sslmode=verify-full',
    );
    assert.equal(
      normalizeSslMode('postgresql://u:p@h.neon.tech/d?sslmode=prefer&application_name=litos'),
      'postgresql://u:p@h.neon.tech/d?sslmode=verify-full&application_name=litos',
    );
    // `disable` and `no-verify` mean something the alias set does not, so they stand.
    assert.equal(
      normalizeSslMode('postgresql://u:p@h.neon.tech/d?sslmode=disable'),
      'postgresql://u:p@h.neon.tech/d?sslmode=disable',
    );
    assert.equal(
      normalizeSslMode('postgresql://u:p@h.neon.tech/d?sslmode=verify-full'),
      'postgresql://u:p@h.neon.tech/d?sslmode=verify-full',
    );
  });

  test('an uppercase sslmode key is rewritten, not just detected', () => {
    // The guard regex is case-insensitive and `searchParams` is not, so an uppercase key would
    // otherwise pass the guard, change nothing, and still round-trip the string through URL.
    assert.equal(
      normalizeSslMode('postgresql://u:p@h.neon.tech/d?SSLMODE=require'),
      'postgresql://u:p@h.neon.tech/d?SSLMODE=verify-full',
    );
  });

  test('a string with no sslmode is returned byte-identical, not round-tripped through URL', () => {
    // `new URL(x).toString()` normalises: it appends a trailing slash to a bare host and re-encodes
    // reserved characters, and a Postgres password is exactly where reserved characters live. The
    // early return is what keeps this function from rewriting a string it has no reason to touch.
    for (const raw of [
      'postgresql://u:p@host.neon.tech/litos',
      'postgresql://user:pa%2Fss@host.neon.tech/litos',
      'postgresql://postgres:password@localhost:5432/student_outreach',
    ]) {
      assert.equal(normalizeSslMode(raw), raw);
    }
  });

  test('an unparseable connection string is handed back rather than throwing at module load', () => {
    // This runs inside the top-level `new Pool`, and `new Pool` does not parse eagerly. Throwing
    // here turns "one route 500s at first query" into "nothing boots, including /health".
    const multiHost = 'postgresql://u:p@host1:5432,host2:5432/d?sslmode=require';
    assert.equal(normalizeSslMode(multiHost), multiHost);
  });
});
