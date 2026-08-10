import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { SignJWT } from 'jose';

/* WHY THIS ONE IS TESTED AGAINST A REAL DATABASE.
 *
 * The claim being made is not "the function filters by user_id". It is "a password stored for one
 * person cannot be read by another, and what sits in the column is ciphertext". Both of those are
 * claims about rows, and a stub that returns whatever the test asked for can satisfy a mocked
 * version of either while the real query does neither.
 *
 * The fixture is PGlite speaking the real wire protocol over a unix socket, so the production `db`
 * module connects with the production driver, and the DDL is generated from db/schema.ts at run
 * time so it cannot drift from the real table.
 */

const ENCRYPTION_KEY = 'portal-credentials-route-test-key';
const JWT_SIGNING_SECRET = 'portal-credentials-route-test-secret';

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
  RATE_PORTAL_CREDENTIAL_REVEAL_PER_HOUR: process.env.RATE_PORTAL_CREDENTIAL_REVEAL_PER_HOUR,
};

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let pool: typeof import('../db/index')['pool'];
let credentials: typeof import('../lib/portalCredentials');

let ownerId: string;
let strangerId: string;
let ownerToken: string;
let strangerToken: string;
let credentialId: string;

const OWNER_ALIAS = 'app-4c1d9b2a7e-1f0b7c2d3e45@apply.trylitos.com';

async function token(userId: string): Promise<string> {
  return new SignJWT({ userId, isGuest: false, sessionVersion: 0, authMethod: 'email_code' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(JWT_SIGNING_SECRET));
}

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;
  // Set before the modules that read it are imported. Small enough that the ceiling is reachable
  // in a test without 20 round trips.
  process.env.RATE_PORTAL_CREDENTIAL_REVEAL_PER_HOUR = '3';

  socketDir = mkdtempSync(join(tmpdir(), 'litos-portal-cred-'));
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

  const schema = await import('../db/schema');
  const dbModule = await import('../db/index');
  pool = dbModule.pool;

  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await pglite.exec(statement);

  const { rows } = await pglite.query<{ id: string }>(
    "insert into users (email) values ('owner@example.com'), ('stranger@example.com') returning id",
  );
  ownerId = rows[0].id;
  strangerId = rows[1].id;
  ownerToken = await token(ownerId);
  strangerToken = await token(strangerId);

  credentials = await import('../lib/portalCredentials');
  const stored = await credentials.ensurePortalCredential({
    userId: ownerId,
    portalFamily: 'icims',
    tenant: 'careers-acme',
    username: OWNER_ALIAS,
  });
  credentialId = stored.id;

  const { portalCredentialRoutes } = await import('./portalCredentials');
  app = Fastify({ logger: false });
  await app.register(portalCredentialRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  await pool?.end();
  await server?.stop();
  await pglite?.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('what lands in the column is ciphertext, not the password', async () => {
  const { rows } = await pglite.query<{ password_encrypted: string; username: string }>(
    'select password_encrypted, username from portal_credentials',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].username, OWNER_ALIAS, 'the account address is the Litos application alias');

  const revealed = await credentials.revealPortalCredentialForOwner(ownerId, credentialId);
  assert.ok(revealed);
  assert.equal(credentials.passwordMeetsPortalPolicy(revealed.password, OWNER_ALIAS), true);
  assert.notEqual(rows[0].password_encrypted, revealed.password);
  assert.equal(rows[0].password_encrypted.includes(revealed.password), false);
  // A whole-table dump is the shape a leaked backup takes. The password must not be in it.
  const dump = JSON.stringify((await pglite.query('select * from portal_credentials')).rows);
  assert.equal(dump.includes(revealed.password), false);
});

test('the second call for the same tenant returns the same account, not a new one', async () => {
  const again = await credentials.ensurePortalCredential({
    userId: ownerId,
    portalFamily: 'icims',
    tenant: 'careers-acme',
    username: OWNER_ALIAS,
  });
  assert.equal(again.id, credentialId, 'one account per tenant, or the portal locks the applicant out');
  const { rows } = await pglite.query('select id from portal_credentials');
  assert.equal(rows.length, 1);
});

test('the owner can list her accounts and no password is in the listing', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/portal-credentials',
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.credentials.length, 1);
  assert.equal(body.credentials[0].tenant, 'careers-acme');
  assert.equal(body.credentials[0].portal_family, 'icims');
  assert.equal(body.credentials[0].username, OWNER_ALIAS);
  assert.equal('password' in body.credentials[0], false);
  assert.equal('password_encrypted' in body.credentials[0], false);
  assert.equal(res.headers['cache-control'], 'private, no-store');
});

test('the owner can reveal her own password, and the reveal is recorded', async () => {
  const before = await pglite.query<{ reveal_count: number }>('select reveal_count from portal_credentials');
  const res = await app.inject({
    method: 'POST',
    url: `/portal-credentials/${credentialId}/reveal`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.username, OWNER_ALIAS);
  assert.equal(credentials.passwordMeetsPortalPolicy(body.password, OWNER_ALIAS), true);
  assert.equal(res.headers['cache-control'], 'private, no-store');

  const after = await pglite.query<{ reveal_count: number; last_revealed_at: Date | null }>(
    'select reveal_count, last_revealed_at from portal_credentials',
  );
  assert.equal(after.rows[0].reveal_count, before.rows[0].reveal_count + 1);
  assert.ok(after.rows[0].last_revealed_at, 'a reveal must leave a timestamp the owner can read');
});

test('another user cannot read the credential, by id or by tenant', async () => {
  const counted = await pglite.query<{ reveal_count: number }>(
    `select reveal_count from portal_credentials where id = '${credentialId}'`,
  );
  const revealsBeforeTheDeniedRead = counted.rows[0].reveal_count;

  // Through the route, with a valid session that simply is not hers.
  const res = await app.inject({
    method: 'POST',
    url: `/portal-credentials/${credentialId}/reveal`,
    headers: { authorization: `Bearer ${strangerToken}` },
  });
  assert.equal(res.statusCode, 404, 'a credential id must not be a capability');
  assert.equal(JSON.stringify(res.json()).toLowerCase().includes('password'), false);

  const listed = await app.inject({
    method: 'GET',
    url: '/portal-credentials',
    headers: { authorization: `Bearer ${strangerToken}` },
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().credentials, []);

  // And directly, below the route, so the denial is the query's and not the handler's.
  assert.equal(await credentials.revealPortalCredentialForOwner(strangerId, credentialId), null);
  assert.equal(await credentials.portalCredentialSecretForOwner(strangerId, 'icims', 'careers-acme'), null);
  assert.ok(await credentials.portalCredentialSecretForOwner(ownerId, 'icims', 'careers-acme'));

  // A denied read must not count as a reveal on somebody else's row.
  const { rows } = await pglite.query<{ reveal_count: number }>(
    `select reveal_count from portal_credentials where id = '${credentialId}'`,
  );
  assert.equal(rows[0].reveal_count, revealsBeforeTheDeniedRead);
});

test('an anonymous caller gets nothing', async () => {
  const listed = await app.inject({ method: 'GET', url: '/portal-credentials' });
  assert.equal(listed.statusCode, 401);
  const revealed = await app.inject({ method: 'POST', url: `/portal-credentials/${credentialId}/reveal` });
  assert.equal(revealed.statusCode, 401);
});

test('two users on the same tenant get two separate accounts', async () => {
  const strangerAlias = 'app-77aa11bb22-9c8d7e6f5a4b@apply.trylitos.com';
  const theirs = await credentials.ensurePortalCredential({
    userId: strangerId,
    portalFamily: 'icims',
    tenant: 'careers-acme',
    username: strangerAlias,
  });
  assert.notEqual(theirs.id, credentialId);

  const mine = await credentials.portalCredentialSecretForOwner(ownerId, 'icims', 'careers-acme');
  const hers = await credentials.portalCredentialSecretForOwner(strangerId, 'icims', 'careers-acme');
  assert.ok(mine && hers);
  assert.notEqual(mine.password, hers.password, 'a password is per account, never shared');
  assert.notEqual(mine.username, hers.username);
});

test('revealing on a loop is rate limited', async () => {
  /* A stored password is worth more to a stolen session than anything else this API returns, and
   * the cheapest version of that theft is a script that walks every credential. The hourly ceiling
   * is deliberately generous for a person copying a password and mean to a loop. One reveal has
   * already been spent above, so the ceiling of 3 is two requests away. */
  const reveal = () => app.inject({
    method: 'POST',
    url: `/portal-credentials/${credentialId}/reveal`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal((await reveal()).statusCode, 200);
  assert.equal((await reveal()).statusCode, 200);
  const refused = await reveal();
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.json().code, 'rate_limited');
  assert.equal(JSON.stringify(refused.json()).toLowerCase().includes('password'), false);
});
