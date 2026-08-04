import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import ConnectionParameters from 'pg/lib/connection-parameters';
import { parse as parseConnectionString } from 'pg-connection-string';
import { dedicatedDatabaseUrl, sslOptionForHost, withVerifiedSslMode } from './index';

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
describe('the database connection verifies certificates by intent, not by accident', () => {
  /** The `ssl` option src/db/index.ts actually passes for a hosted database. Read from the source,
   *  not redeclared here: a constant the test owns would let the real one be flipped back to
   *  `false` with every assertion still green. */
  const FALLBACK = sslOptionForHost(false);
  /** What the OLD fallback was, kept so the regression can be stated as an assertion. */
  const OLD_FALLBACK = { rejectUnauthorized: false } as const;
  /** The resolved ssl config as pg computes it, given our exact constructor arguments. */
  const resolve = (connectionString: string, ssl: unknown) =>
    new (ConnectionParameters as unknown as new (c: unknown) => { ssl: unknown })({ connectionString, ssl }).ssl;
  const resolved = (connectionString: string) => resolve(connectionString, FALLBACK);

  test('the connection string overrides the explicit ssl option, not the other way round', () => {
    // The load-bearing precedence fact. If this ever flips, everything below is reasoning about a
    // library that no longer behaves that way, and the `ssl` option silently becomes the decider.
    assert.deepEqual(
      resolved('postgresql://u:p@h.neon.tech/d?sslmode=require'),
      {},
      'a connection string carrying sslmode must win over the explicit ssl option',
    );
    assert.deepEqual(
      resolved('postgresql://u:p@h.neon.tech/d'),
      FALLBACK,
      'with no sslmode the explicit option is what applies',
    );
  });

  test('every path the app can take resolves to a verified connection', () => {
    // `{}` carries no rejectUnauthorized key, so Node's default of true applies: verified.
    for (const raw of [
      'postgresql://u:p@h.neon.tech/d?sslmode=require',
      'postgresql://u:p@h.neon.tech/d?sslmode=verify-full',
      'postgresql://u:p@h.neon.tech/d?sslmode=prefer&application_name=litos',
      'postgresql://u:p@h.neon.tech/d',
    ]) {
      assert.deepEqual(resolved(withVerifiedSslMode(raw)), {}, `${raw} must verify`);
    }
  });

  test('a URL with no sslmode used to skip verification, and that is what changed', () => {
    // THE HOLE. Verification was on only because Neon puts `sslmode` in the URL; drop that one
    // parameter and the old fallback applied, turning certificate checking off with no error, no
    // log line and no failing test. Both halves are asserted so neither can drift alone.
    assert.deepEqual(
      resolve('postgresql://u:p@h.neon.tech/d', OLD_FALLBACK),
      OLD_FALLBACK,
      'the old fallback did apply on this path, which is why it mattered',
    );
    assert.deepEqual(
      resolved(withVerifiedSslMode('postgresql://u:p@h.neon.tech/d')),
      {},
      'the string now declares a mode, so the fallback never decides',
    );
  });

  test('the fallback fails safe wherever it still decides', () => {
    // NOT on an unparseable string, which an earlier version of this test claimed: pg parses with
    // `new URL` too, so a multi-host string throws inside pg before `ssl` is resolved at all.
    // Handing the value back untouched keeps that error where it belongs; it does not hand the
    // fallback a decision.
    const multiHost = 'postgresql://u:p@host1:5432,host2:5432/d';
    assert.equal(withVerifiedSslMode(multiHost), multiHost);
    assert.throws(() => resolved(multiHost), /Invalid URL/, 'pg throws before the option is consulted');
    // Where it DOES decide: uselibpqcompat with no mode declared.
    assert.deepEqual(
      resolved(withVerifiedSslMode('postgresql://u:p@h.neon.tech/d?uselibpqcompat=true')),
      FALLBACK,
    );
    assert.deepEqual(
      sslOptionForHost(false),
      { rejectUnauthorized: true },
      'the fallback decides on this path alone, so it must not fail open',
    );
    assert.equal(sslOptionForHost(true), undefined, 'a local Postgres needs no TLS at all');
  });

  test('only the warned aliases are rewritten, and other parameters are untouched', () => {
    assert.equal(
      withVerifiedSslMode('postgresql://u:p@h.neon.tech/d?sslmode=require'),
      'postgresql://u:p@h.neon.tech/d?sslmode=verify-full',
    );
    assert.equal(
      withVerifiedSslMode('postgresql://u:p@h.neon.tech/d?sslmode=prefer&application_name=litos'),
      'postgresql://u:p@h.neon.tech/d?sslmode=verify-full&application_name=litos',
    );
    // `disable` and `no-verify` mean something the alias set does not, so they stand.
    assert.equal(
      withVerifiedSslMode('postgresql://u:p@h.neon.tech/d?sslmode=disable'),
      'postgresql://u:p@h.neon.tech/d?sslmode=disable',
    );
    assert.equal(
      withVerifiedSslMode('postgresql://u:p@h.neon.tech/d?sslmode=verify-full'),
      'postgresql://u:p@h.neon.tech/d?sslmode=verify-full',
    );
  });

  test('pg reads sslmode case-sensitively, so an uppercase key is not a declaration', () => {
    // Verified against the installed pg: `?SSLMODE=verify-full` resolves to the ssl OPTION, not to
    // `{}`, so pg never saw it. An earlier version treated the uppercase key as a declared mode,
    // skipped adding a lowercase one, and rewrote a parameter pg ignores entirely - pinning the
    // wrong half. What matters is that pg ends up seeing a mode.
    assert.deepEqual(resolved('postgresql://u:p@h.neon.tech/d?SSLMODE=verify-full'), FALLBACK);
    assert.deepEqual(
      resolved(withVerifiedSslMode('postgresql://u:p@h.neon.tech/d?SSLMODE=require')),
      {},
      'a lowercase mode must be added, because the uppercase one is invisible to pg',
    );
  });

  test('duplicate sslmode collapses to the value pg would have used, not the first one', () => {
    // pg takes the LAST value. The first version rewrote the first key, and `searchParams.set`
    // drops the duplicate, so `require&disable` silently became verify-full: a deliberate `disable`
    // discarded and TLS turned on. Direction was safe; honouring configuration was not.
    assert.equal(
      withVerifiedSslMode('postgresql://u:p@h.neon.tech/d?sslmode=require&sslmode=disable'),
      'postgresql://u:p@h.neon.tech/d?sslmode=disable',
    );
    assert.equal(resolved('postgresql://u:p@h.neon.tech/d?sslmode=require&sslmode=disable'), false);
    assert.equal(
      resolved(withVerifiedSslMode('postgresql://u:p@h.neon.tech/d?sslmode=require&sslmode=disable')),
      false,
      'pg must reach the same answer before and after the rewrite',
    );
  });

  test('an empty sslmode value is no mode at all', () => {
    assert.deepEqual(resolved(withVerifiedSslMode('postgresql://u:p@h.neon.tech/d?sslmode=')), {});
  });


  test('a URL that declares no mode gains verify-full, and keeps every credential intact', () => {
    // THE HOLE THIS CLOSES. Without a declared mode the explicit `ssl` option applied, and it used
    // to be `{rejectUnauthorized:false}`: certificate checking was off. Verification was on only
    // because Neon happens to put `sslmode` in the URL, so dropping that one parameter from the
    // environment would have turned it off silently - no error, no log line, no failing test.
    assert.equal(
      withVerifiedSslMode('postgresql://u:p@host.neon.tech/litos'),
      'postgresql://u:p@host.neon.tech/litos?sslmode=verify-full',
    );
    // `new URL().toString()` re-encodes, and a Postgres password is exactly where reserved
    // characters live, so the round trip is checked through pg's own parser rather than by eye.
    for (const raw of [
      'postgresql://user:pa%2Fss@host.neon.tech/litos',
      'postgresql://u:p%40ss@host.neon.tech/litos?options=-c%20search_path%3Dfoo',
      'postgresql://u:p@[::1]:5432/litos',
    ]) {
      const before = parseConnectionString(raw);
      const after = parseConnectionString(withVerifiedSslMode(raw));
      // `options` is in this list because it is the field the rewrite actually perturbs:
      // URLSearchParams.toString() emits `+` for a space, so `-c%20search_path` becomes
      // `-c+search_path`. It survives only because pg reads the query through searchParams, which
      // decodes `+` back. The earlier version of this test fed an `options` string through and then
      // did not compare it, so the one hazard it was reaching for was the one it did not check.
      for (const field of ['user', 'password', 'host', 'port', 'database', 'options'] as const) {
        assert.equal(String(after[field]), String(before[field]), `${field} must survive the rewrite`);
      }
    }
  });

  test('uselibpqcompat is honoured, because under it the rewrite would not be neutral', () => {
    // Under uselibpqcompat, `require` means what libpq means and resolves to
    // {rejectUnauthorized:false}, while `verify-full` still verifies. Rewriting would tighten a
    // connection someone deliberately loosened, and would falsify the "changes nothing" claim the
    // whole change rests on.
    const raw = 'postgresql://u:p@h.neon.tech/d?uselibpqcompat=true&sslmode=require';
    assert.equal(withVerifiedSslMode(raw), raw);
    assert.deepEqual(resolved(raw), { rejectUnauthorized: false }, 'and the caller gets what they asked for');
  });

  test('sslmode=disable is honoured, not overridden', () => {
    // It means something and it is a deliberate choice where it appears. A database config that
    // ignores what it was told is worse than one that is loose.
    assert.equal(
      withVerifiedSslMode('postgresql://u:p@h.neon.tech/d?sslmode=disable'),
      'postgresql://u:p@h.neon.tech/d?sslmode=disable',
    );
    assert.equal(resolved('postgresql://u:p@h.neon.tech/d?sslmode=disable'), false);
  });

  test('an unparseable connection string is handed back rather than throwing at module load', () => {
    // This runs inside the top-level `new Pool`, and `new Pool` does not parse eagerly. Throwing
    // here turns "one route 500s at first query" into "nothing boots, including /health".
    const multiHost = 'postgresql://u:p@host1:5432,host2:5432/d?sslmode=require';
    assert.equal(withVerifiedSslMode(multiHost), multiHost);
  });
});
