import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { db } from '../db/index';
import { career_page_sources } from '../db/schema';
import {
  LOGO_VERIFICATION_GLOBAL_CONCURRENCY,
  LOGO_VERIFICATION_PROVIDER_CANDIDATES,
  LOGO_VERIFICATION_PROVIDER_CONCURRENCY,
  LOGO_VERIFICATION_REQUEST_CANDIDATES,
  LOGO_VERIFICATION_WORKABLE_CANDIDATES,
  LOGO_VERIFICATION_WORKABLE_START_INTERVAL_MS,
  boundedLogoVerificationCandidates,
  logoVerificationQueueOrder,
  pollingSourceEligibilityPredicate,
  runProviderAwareLogoQueue,
  sourceLogoIdentityMode,
} from './jobMonitor';
import { normalizeEmployerCertificationIdentity } from '../lib/jobCertificationFingerprint';

test('polling eligibility requires current verified logo proof and an autonomous matched source', () => {
  const query = db.select().from(career_page_sources)
    .where(pollingSourceEligibilityPredicate())
    .toSQL();

  assert.match(query.sql, /"career_page_sources"\."enabled" = /);
  assert.match(query.sql, /"career_page_sources"\."ats_name" in /);
  assert.match(query.sql, /"career_page_sources"\."portal_name_mismatch" = /);
  assert.match(query.sql, /"career_page_sources"\."logo_verification_status" = /);
  assert.match(query.sql, /"career_page_sources"\."logo_verified_at" >= now\(\)/);
  assert.match(query.sql, /"career_page_sources"\."company_logo_url" ~ /);
  assert.ok(query.params.includes('verified'));
  assert.ok(query.params.includes(30));
});

test('poll selection and completion count reuse the exact same queue predicate', () => {
  const source = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  assert.match(source, /const pollQueueEligible = and\(pollEligible, drainEligible\)!/);
  assert.equal(
    source.match(/\.where\(pollQueueEligible\)/g)?.length,
    2,
    'selection and remaining count must not drift to different source eligibility rules',
  );
});

test('verified logo rechecks lead never-checked and failed candidates', () => {
  const query = db.select().from(career_page_sources)
    .orderBy(...logoVerificationQueueOrder())
    .toSQL();

  assert.match(query.sql, /case when "career_page_sources"\."logo_verification_status" = 'verified' then 0 else 1 end/);
  assert.match(query.sql, /"career_page_sources"\."logo_verified_at" asc nulls last/);
  assert.match(query.sql, /"career_page_sources"\."logo_last_checked_at" asc nulls first/);
});

test('a routine logo recheck retains certification when employer identity is unchanged', () => {
  assert.equal(
    normalizeEmployerCertificationIdentity('Acme, Inc.'),
    normalizeEmployerCertificationIdentity('ACME'),
  );
  const source = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  assert.match(source, /certificationIdentityChanged \? \{ certification_fingerprint: null \} : \{\}/);
});

test('untrusted catalog identities remain provisional until the ATS names the employer', () => {
  assert.equal(sourceLogoIdentityMode('cc0_board_identifier_candidate'), 'provisional');
  assert.equal(sourceLogoIdentityMode('mit_freehire_board_candidate'), 'provisional');
  assert.equal(sourceLogoIdentityMode('mit_ats_scrapers_board_candidate'), 'provisional');
  assert.equal(sourceLogoIdentityMode('catalog_company_domain_candidate'), 'provisional');
  assert.equal(sourceLogoIdentityMode('reviewed_company_domain_candidate'), 'asserted');
});

test('monitoring reports candidate and activated discovery counts separately', () => {
  const source = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  assert.match(source, /discovery_candidate_sources: discoveryCandidateSourceCount/);
  assert.match(source, /discovery_activated_sources: discoveredSources\.length/);
  assert.match(source, /discoveryCandidateSourceCount = discovery\.candidateSources\.length/);
  assert.match(source, /discoveredSources = discovery\.sources/);
});

test('logo verification bounds each provider and spaces Workable starts', async () => {
  const candidates = [
    ...Array.from({ length: 6 }, (_, index) => ({ ats_name: 'greenhouse', index })),
    ...Array.from({ length: 3 }, (_, index) => ({ ats_name: 'lever', index })),
    ...Array.from({ length: 3 }, (_, index) => ({ ats_name: 'workable', index })),
  ];
  let clock = 0;
  let active = 0;
  let maximumActive = 0;
  const activeByProvider = new Map<string, number>();
  const maximumByProvider = new Map<string, number>();
  const workableStarts: number[] = [];

  await runProviderAwareLogoQueue(candidates, async (candidate) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const providerActive = (activeByProvider.get(candidate.ats_name) ?? 0) + 1;
    activeByProvider.set(candidate.ats_name, providerActive);
    maximumByProvider.set(
      candidate.ats_name,
      Math.max(maximumByProvider.get(candidate.ats_name) ?? 0, providerActive),
    );
    if (candidate.ats_name === 'workable') workableStarts.push(clock);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    activeByProvider.set(candidate.ats_name, providerActive - 1);
  }, {
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });

  assert.ok(maximumActive <= LOGO_VERIFICATION_GLOBAL_CONCURRENCY);
  assert.ok((maximumByProvider.get('greenhouse') ?? 0) <= LOGO_VERIFICATION_PROVIDER_CONCURRENCY);
  assert.ok((maximumByProvider.get('lever') ?? 0) <= LOGO_VERIFICATION_PROVIDER_CONCURRENCY);
  assert.equal(maximumByProvider.get('workable'), 1);
  assert.deepEqual(workableStarts, [
    0,
    LOGO_VERIFICATION_WORKABLE_START_INTERVAL_MS,
    LOGO_VERIFICATION_WORKABLE_START_INTERVAL_MS * 2,
  ]);
  assert.equal(
    clock,
    LOGO_VERIFICATION_WORKABLE_START_INTERVAL_MS * 3,
    'the response must retain the final cooldown before a subsequent HTTP pass can start',
  );
});

test('one degraded provider cannot make a logo request exceed its bounded candidate budget', () => {
  const candidates = [
    ...Array.from({ length: 200 }, (_, index) => ({ ats_name: 'greenhouse', index })),
    ...Array.from({ length: 20 }, (_, index) => ({ ats_name: 'workable', index })),
  ];
  const selected = boundedLogoVerificationCandidates(candidates);
  assert.equal(LOGO_VERIFICATION_REQUEST_CANDIDATES, 16);
  assert.equal(LOGO_VERIFICATION_PROVIDER_CANDIDATES, 4);
  assert.equal(LOGO_VERIFICATION_WORKABLE_CANDIDATES, 2);
  assert.ok(selected.length <= LOGO_VERIFICATION_REQUEST_CANDIDATES);
  assert.equal(
    selected.filter((candidate) => candidate.ats_name === 'greenhouse').length,
    LOGO_VERIFICATION_PROVIDER_CANDIDATES,
  );

  const workableOnly = boundedLogoVerificationCandidates(
    Array.from({ length: 200 }, (_, index) => ({ ats_name: 'workable', index })),
  );
  assert.equal(workableOnly.length, LOGO_VERIFICATION_WORKABLE_CANDIDATES);
});

test('scheduled transient logo failures remain in completion evidence without a due-now hot loop', () => {
  const source = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  assert.match(source, /scheduled_transient_sources: scheduledTransientSources/);
  assert.match(source, /remainingSources = dueSources \+ scheduledTransientSources/);
  assert.match(source, /verification_complete: remainingSources === 0/);
  assert.match(source, /retry_after_ms: retryAfterMs/);
});
