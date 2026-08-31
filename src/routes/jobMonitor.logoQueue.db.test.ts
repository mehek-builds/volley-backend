import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';

const PROVIDERS = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'rippling',
  'breezy',
  'recruitee',
  'crelate',
] as const;
const SOURCES_PER_PROVIDER = 201;

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
};

let socketDir: string;
let database: PGlite;
let socketServer: PGLiteSocketServer;
let db: typeof import('../db/index')['db'];
let pool: typeof import('../db/index')['pool'];
let schema: typeof import('../db/schema');
let selectCandidates:
  typeof import('./jobMonitor')['selectProviderBalancedLogoVerificationCandidates'];
let acquireCrelateClaim:
  typeof import('./jobMonitor')['acquireCrelateLogoVerificationClaim'];
let closeCrelateCircuit:
  typeof import('./jobMonitor')['closeCrelateLogoVerificationCircuit'];
let openCrelateCircuit:
  typeof import('./jobMonitor')['openCrelateLogoVerificationCircuit'];
let readCrelateBlock:
  typeof import('./jobMonitor')['readCrelateLogoVerificationBlock'];
let releaseCrelateClaim:
  typeof import('./jobMonitor')['releaseCrelateLogoVerificationClaim'];

before(async () => {
  process.env.ENCRYPTION_KEY = 'logo-queue-database-test-key';
  process.env.JWT_SIGNING_SECRET = 'logo-queue-database-test-secret';

  socketDir = mkdtempSync(join(tmpdir(), 'litos-logo-queue-'));
  database = await PGlite.create();
  socketServer = new PGLiteSocketServer({
    db: database,
    path: join(socketDir, '.s.PGSQL.5432'),
    maxConnections: 10,
  });
  await socketServer.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

  schema = await import('../db/schema');
  const dbModule = await import('../db/index');
  db = dbModule.db;
  pool = dbModule.pool;
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await database.exec(statement);

  ({
    acquireCrelateLogoVerificationClaim: acquireCrelateClaim,
    closeCrelateLogoVerificationCircuit: closeCrelateCircuit,
    openCrelateLogoVerificationCircuit: openCrelateCircuit,
    readCrelateLogoVerificationBlock: readCrelateBlock,
    releaseCrelateLogoVerificationClaim: releaseCrelateClaim,
    selectProviderBalancedLogoVerificationCandidates: selectCandidates,
  } = await import('./jobMonitor'));

  const sourceRows = PROVIDERS.flatMap((provider) => Array.from(
    { length: SOURCES_PER_PROVIDER },
    (_, index) => ({
      company_name: `${provider} logo queue company ${index}`,
      ats_name: provider,
      board_token: `${provider}-logo-queue-${index}`,
      career_url: `https://example.com/${provider}/logo-queue-${index}`,
      logo_verification_status: 'unverified',
      logo_verification_method: 'mit_ats_scrapers_board_candidate',
      enabled: true,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)),
    }),
  ));
  await db.insert(schema.career_page_sources).values(sourceRows);
});

beforeEach(async () => {
  await db.delete(schema.logo_verification_provider_circuits);
});

after(async () => {
  await pool?.end();
  await socketServer?.stop();
  await database?.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('provider-balanced SQL cannot starve a family behind more than 200 older due rows', async () => {
  const candidates = await selectCandidates(
    eq(schema.career_page_sources.enabled, true),
    200,
  );

  assert.equal(candidates.length, 16);
  const selectedByProvider = new Map<string, number>();
  for (const candidate of candidates) {
    selectedByProvider.set(
      candidate.ats_name,
      (selectedByProvider.get(candidate.ats_name) ?? 0) + 1,
    );
  }
  assert.equal(selectedByProvider.get('crelate'), 1);
  for (const provider of PROVIDERS.filter((value) => value !== 'crelate')) {
    assert.ok((selectedByProvider.get(provider) ?? 0) >= 2, `${provider} should retain a fair turn`);
  }
});

test('Crelate provider state admits one active request and one half-open probe', async () => {
  const openedAt = new Date('2026-09-01T00:00:00.000Z');
  const first = await acquireCrelateClaim(openedAt, 'closed-claim');
  assert.deepEqual(first, {
    token: 'closed-claim',
    halfOpen: false,
    leaseExpiresAt: new Date('2026-09-01T00:05:00.000Z'),
  });
  assert.equal(await acquireCrelateClaim(openedAt, 'overlap-claim'), null);
  assert.equal(await openCrelateCircuit('closed-claim', openedAt), true);

  const open = await readCrelateBlock(new Date('2026-09-01T00:14:59.999Z'));
  assert.equal(open.blocked, true);
  assert.equal(open.reason, 'open');
  assert.equal(open.blockedUntil?.toISOString(), '2026-09-01T00:15:00.000Z');
  assert.equal(
    await acquireCrelateClaim(new Date('2026-09-01T00:14:59.999Z'), 'early-half-open'),
    null,
  );
  assert.deepEqual(
    await readCrelateBlock(new Date('2026-09-01T00:15:00.000Z')),
    { blocked: false, blockedUntil: null, reason: 'half_open' },
  );

  const halfOpen = await acquireCrelateClaim(
    new Date('2026-09-01T00:15:00.000Z'),
    'half-open-claim',
  );
  assert.equal(halfOpen?.halfOpen, true);
  assert.equal(
    await acquireCrelateClaim(new Date('2026-09-01T00:15:00.001Z'), 'second-half-open'),
    null,
  );
  assert.equal(
    await closeCrelateCircuit('half-open-claim', new Date('2026-09-01T00:15:01.000Z')),
    true,
  );
  assert.deepEqual(
    await readCrelateBlock(new Date('2026-09-01T00:15:01.001Z')),
    { blocked: false, blockedUntil: null, reason: 'closed' },
  );

  const afterClose = await acquireCrelateClaim(
    new Date('2026-09-01T00:15:02.000Z'),
    'after-close',
  );
  assert.equal(afterClose?.halfOpen, false);
  assert.equal(await releaseCrelateClaim('after-close'), true);
});
