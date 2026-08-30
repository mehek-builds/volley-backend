import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';
import { parseAtsScrapersJobSources } from '../lib/jobSourceDiscovery';
import {
  VERIFIED_ATS_DURABLE_COPY_LOGO_METHOD,
  verifyAtsSourceBranding,
} from '../lib/atsSourceBranding';
import { persistDurableAtsLogo } from '../lib/durableAtsLogo';

/*
 * Certification is deliberately stricter than the public row count. This database-backed test
 * protects that boundary in the SQL aggregate itself: syndicated aliases still exist as two
 * browseable rows, but they can contribute only one job to the 500,000-job certificate.
 */

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
  OBJECT_STORAGE_PUBLIC_BASE_URL: process.env.OBJECT_STORAGE_PUBLIC_BASE_URL,
};

let socketDir: string;
let database: PGlite;
let socketServer: PGLiteSocketServer;
let db: typeof import('../db/index')['db'];
let pool: typeof import('../db/index')['pool'];
let schema: typeof import('../db/schema');
let boardInventoryMetrics: typeof import('./jobMonitor')['boardInventoryMetrics'];
let pollingSourceEligibilityPredicate:
  typeof import('./jobMonitor')['pollingSourceEligibilityPredicate'];
let upsertSources: typeof import('./jobMonitor')['upsertSources'];
let buildJobCertificationFingerprint:
  typeof import('../lib/jobCertificationFingerprint')['buildJobCertificationFingerprint'];

before(async () => {
  process.env.ENCRYPTION_KEY = 'certified-inventory-test-key';
  process.env.JWT_SIGNING_SECRET = 'certified-inventory-test-secret';
  process.env.OBJECT_STORAGE_PUBLIC_BASE_URL = 'https://api.trylitos.com';

  socketDir = mkdtempSync(join(tmpdir(), 'litos-certified-inventory-'));
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

  ({ boardInventoryMetrics, pollingSourceEligibilityPredicate, upsertSources } = await import('./jobMonitor'));
  ({ buildJobCertificationFingerprint } = await import('../lib/jobCertificationFingerprint'));
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

test('certified inventory deduplicates aliases and excludes legacy null fingerprints', async () => {
  const { career_page_sources, monitored_jobs } = schema;
  const verifiedAt = new Date();
  const drainStartedAt = new Date(verifiedAt.getTime() - 1_000);
  const staleDetailAt = new Date(drainStartedAt.getTime() - 1_000);
  const [greenhouseSource, leverSource] = await db.insert(career_page_sources).values([
    {
      company_name: 'Acme, Inc.',
      ats_name: 'greenhouse',
      board_token: 'acme-greenhouse',
      career_url: 'https://job-boards.greenhouse.io/acme-greenhouse',
      company_logo_url: 'https://assets.example/acme-greenhouse-logo.png',
      logo_verification_status: 'verified',
      logo_verification_method: 'first_party_ats_employer_logo',
      logo_verified_at: verifiedAt,
      last_successful_poll_at: verifiedAt,
      portal_company_name: 'Acme, Inc.',
      portal_name_mismatch: false,
      enabled: true,
    },
    {
      company_name: 'ACME',
      ats_name: 'lever',
      board_token: 'acme-lever',
      career_url: 'https://jobs.lever.co/acme-lever',
      company_logo_url: 'https://assets.example/acme-lever-logo.png',
      logo_verification_status: 'verified',
      logo_verification_method: 'first_party_ats_identity_and_homepage_logo_asset',
      logo_verified_at: verifiedAt,
      last_successful_poll_at: verifiedAt,
      portal_company_name: 'ACME',
      portal_name_mismatch: false,
      enabled: true,
    },
  ]).returning();

  const description = [
    'Build reliable distributed systems for a global product team.',
    'The role includes architecture, implementation, testing, incident response, and mentoring.',
    'Visa sponsorship is available for this role.',
  ].join(' ');
  const greenhouseFingerprint = buildJobCertificationFingerprint({
    employer_name: greenhouseSource.portal_company_name!,
    title: 'Software Engineering Intern',
    description,
  });
  const leverFingerprint = buildJobCertificationFingerprint({
    employer_name: leverSource.portal_company_name!,
    title: 'Software Engineering Intern',
    description,
  });
  assert.ok(greenhouseFingerprint);
  assert.equal(leverFingerprint, greenhouseFingerprint,
    'provider and legal-suffix aliases should produce the same certification identity');

  await db.insert(monitored_jobs).values([
    {
      source_id: greenhouseSource.id,
      external_id: 'greenhouse-requisition-101',
      company_name: 'Acme, Inc.',
      title: 'Software Engineering Intern',
      location: 'New York, United States',
      employment_type: 'Internship',
      description,
      ingest_eligible: true,
      certification_fingerprint: greenhouseFingerprint,
      apply_url: 'https://job-boards.greenhouse.io/acme-greenhouse/jobs/101#apply',
      posting_url: 'https://job-boards.greenhouse.io/acme-greenhouse/jobs/101',
      sponsorship_status: 'offers',
      sponsorship_scope: 'job_country',
      job_country: 'us',
      last_seen_at: staleDetailAt,
      is_active: true,
    },
    {
      source_id: leverSource.id,
      external_id: 'lever-posting-9f31',
      company_name: 'ACME',
      title: 'Software Engineering Intern',
      location: 'Toronto, Canada',
      employment_type: 'Internship',
      description,
      ingest_eligible: true,
      certification_fingerprint: leverFingerprint,
      apply_url: 'https://jobs.lever.co/acme-lever/9f31/apply',
      posting_url: 'https://jobs.lever.co/acme-lever/9f31',
      sponsorship_status: 'offers',
      sponsorship_scope: 'job_country',
      job_country: 'non_us',
      last_seen_at: staleDetailAt,
      is_active: true,
    },
  ]);

  assert.deepEqual(await boardInventoryMetrics(), {
    surfacedPostings: 2,
    surfacedGroupedRoles: 2,
    surfacedSponsorOnly: 2,
    surfacedInternships: 2,
    certifiedUniqueJobs: 1,
    certifiedUniqueGroupedRoles: 1,
    certifiedUniqueSponsorJobs: 1,
    certifiedUniqueInternships: 1,
  });

  assert.deepEqual(
    await boardInventoryMetrics(db, drainStartedAt),
    {
      surfacedPostings: 2,
      surfacedGroupedRoles: 2,
      surfacedSponsorOnly: 2,
      surfacedInternships: 2,
      certifiedUniqueJobs: 0,
      certifiedUniqueGroupedRoles: 0,
      certifiedUniqueSponsorJobs: 0,
      certifiedUniqueInternships: 0,
    },
    'a current source-level success cannot certify jobs whose own details were not refreshed in the drain',
  );

  await db.insert(monitored_jobs).values({
    source_id: greenhouseSource.id,
    external_id: 'legacy-null-fingerprint',
    company_name: 'Legacy Company',
    title: 'Legacy Product Internship',
    location: 'London, United Kingdom',
    employment_type: 'Internship',
    description: 'A complete legacy internship description with responsibilities, requirements, qualifications, and confirmed visa sponsorship for the role.',
    ingest_eligible: true,
    certification_fingerprint: null,
    apply_url: 'https://job-boards.greenhouse.io/acme-greenhouse/jobs/legacy/apply',
    posting_url: 'https://job-boards.greenhouse.io/acme-greenhouse/jobs/legacy',
    sponsorship_status: 'offers',
    sponsorship_scope: 'job_country',
    job_country: 'non_us',
    last_seen_at: new Date(),
    is_active: true,
  });

  assert.deepEqual(await boardInventoryMetrics(), {
    surfacedPostings: 3,
    surfacedGroupedRoles: 3,
    surfacedSponsorOnly: 3,
    surfacedInternships: 3,
    certifiedUniqueJobs: 1,
    certifiedUniqueGroupedRoles: 1,
    certifiedUniqueSponsorJobs: 1,
    certifiedUniqueInternships: 1,
  }, 'legacy rows remain browseable but add zero to every certified counter until repolled');
});

test('a discovery-only Rippling source reaches current-drain certification only through durable logo proof', async () => {
  const { career_page_sources, monitored_jobs } = schema;
  await db.delete(monitored_jobs);
  await db.delete(career_page_sources);

  const [candidate] = parseAtsScrapersJobSources('rippling', [
    'name,slug,url',
    'Utility,utility,https://ats.rippling.com/utility/jobs',
    '',
  ].join('\n'));
  assert.ok(candidate);
  await upsertSources([candidate]);

  const signedLogo = 'https://prod-images.rippling.com/64467cdc6e33ba842961d4e1510e94b8aff1b3a0.png?Expires=4102444800&Signature=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789~safe&Key-Pair-Id=K2Y26R2ZPP26PH';
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const branding = await verifyAtsSourceBranding({
    ats_name: candidate.ats_name,
    board_token: candidate.board_token,
    company_name: candidate.company_name,
    identity_mode: 'provisional',
  }, async (input) => {
    if (String(input) === signedLogo) {
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    }
    return new Response(`<html><head><title>Utility Careers</title>
      <link rel="prefetch" href="${signedLogo.replace(/&/g, '&amp;')}"></head>
      <body><h1><span>Utility</span> Careers</h1></body></html>`, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }, (asset) => persistDurableAtsLogo(asset, async (pathname) => ({
    url: `https://api.trylitos.com/storage/logo/rippling/utility/${pathname.split('/').at(-1)}`,
  })));
  assert.equal(branding.verified, true);
  if (!branding.verified) return;
  assert.equal(branding.method, VERIFIED_ATS_DURABLE_COPY_LOGO_METHOD);

  const verifiedAt = new Date();
  const drainStartedAt = new Date(verifiedAt.getTime() - 1_000);
  const [source] = await db.select().from(career_page_sources)
    .where(eq(career_page_sources.board_token, 'utility')).limit(1);
  assert.ok(source);
  await db.update(career_page_sources).set({
    company_name: branding.company_name,
    company_logo_url: branding.company_logo_url,
    logo_verification_status: 'verified',
    logo_verification_method: branding.method,
    logo_verified_at: verifiedAt,
    logo_last_checked_at: verifiedAt,
    portal_company_name: branding.company_name,
    portal_name_mismatch: false,
    last_successful_poll_at: verifiedAt,
  }).where(eq(career_page_sources.id, source.id));

  const eligible = await db.select({ id: career_page_sources.id }).from(career_page_sources)
    .where(pollingSourceEligibilityPredicate());
  assert.deepEqual(eligible.map((row) => row.id), [source.id]);

  const description = [
    'Build and operate reliable utility software used by teams around the world.',
    'This role owns implementation, testing, incident response, and technical documentation.',
    'Country-specific visa sponsorship is available for qualified applicants.',
  ].join(' ');
  const fingerprint = buildJobCertificationFingerprint({
    employer_name: branding.company_name,
    title: 'Platform Engineer',
    description,
  });
  assert.ok(fingerprint);
  await db.insert(monitored_jobs).values({
    source_id: source.id,
    external_id: 'platform-engineer-1',
    company_name: branding.company_name,
    title: 'Platform Engineer',
    location: 'London, United Kingdom',
    employment_type: 'Full-time',
    description,
    ingest_eligible: true,
    certification_fingerprint: fingerprint,
    apply_url: 'https://ats.rippling.com/utility/jobs/platform-engineer-1/apply',
    posting_url: 'https://ats.rippling.com/utility/jobs/platform-engineer-1',
    sponsorship_status: 'offers',
    sponsorship_scope: 'job_country',
    job_country: 'non_us',
    last_seen_at: verifiedAt,
    is_active: true,
  });
  assert.deepEqual(await boardInventoryMetrics(db, drainStartedAt), {
    surfacedPostings: 1,
    surfacedGroupedRoles: 1,
    surfacedSponsorOnly: 1,
    surfacedInternships: 0,
    certifiedUniqueJobs: 1,
    certifiedUniqueGroupedRoles: 1,
    certifiedUniqueSponsorJobs: 1,
    certifiedUniqueInternships: 0,
  });

  const [unsafeCandidate] = parseAtsScrapersJobSources('rippling', [
    'name,slug,url',
    'Unsafe,unsafe,https://ats.rippling.com/unsafe/jobs',
    '',
  ].join('\n'));
  assert.ok(unsafeCandidate);
  await upsertSources([unsafeCandidate]);
  const wrongLogo = signedLogo.replace('prod-images.rippling.com', 'attacker.example');
  const unsafeBranding = await verifyAtsSourceBranding({
    ats_name: unsafeCandidate.ats_name,
    board_token: unsafeCandidate.board_token,
    company_name: unsafeCandidate.company_name,
    identity_mode: 'provisional',
  }, async () => new Response(`<title>Unsafe Careers</title>
    <link rel="preload" as="image" href="${wrongLogo.replace(/&/g, '&amp;')}">`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }), async () => 'https://litos.public.blob.vercel-storage.com/unreachable.png');
  assert.deepEqual(unsafeBranding, {
    verified: false,
    reason: 'logo_missing',
    identity_verified: true,
    company_name: 'Unsafe',
  });
  const eligibleAfterUnsafe = await db.select({ token: career_page_sources.board_token })
    .from(career_page_sources).where(pollingSourceEligibilityPredicate());
  assert.deepEqual(eligibleAfterUnsafe.map((row) => row.token), ['utility']);
  assert.equal((await boardInventoryMetrics(db, drainStartedAt)).certifiedUniqueJobs, 1);
});
