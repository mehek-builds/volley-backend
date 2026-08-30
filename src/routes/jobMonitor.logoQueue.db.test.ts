import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
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

  ({ selectProviderBalancedLogoVerificationCandidates: selectCandidates } = await import('./jobMonitor'));

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
  assert.deepEqual(
    Object.fromEntries([...selectedByProvider].sort(([left], [right]) => left.localeCompare(right))),
    Object.fromEntries([...PROVIDERS].sort().map((provider) => [provider, 2])),
  );
});
