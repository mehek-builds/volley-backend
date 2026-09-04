import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalApplicationMatchesFrozenPosting,
  frozenPostingIdentitiesMatch,
  sameApplicationPageOrigin,
  sameApplicationPageUrl,
} from './canonicalPacketBinding';
import { freezePostingIdentity } from './submissionAttemptLedger';
import type { applications } from '../db/schema';

type Row = Pick<typeof applications.$inferSelect, 'company_name' | 'role' | 'job_id' | 'portal_url'>;

/* Sage application 8b0202e4, measured on Railway prod 2026-09-04: the canonical row stores the
   legacy embed URL, the runner now lands on the current host with the same path and query. */
const SAGE = {
  company: 'Sage',
  role: 'Software Engineering Intern (Full Stack) - Summer 2027',
  job_id: '5d1c0a9e-1c1a-4b7e-9c7e-2a3f4b5c6d7e',
};
const LEGACY = 'https://boards.greenhouse.io/embed/job_app?for=sage49&token=6131185004';
const CURRENT = 'https://job-boards.greenhouse.io/embed/job_app?for=sage49&token=6131185004';

function row(portal_url: string | null, overrides: Partial<Row> = {}): Row {
  return { company_name: SAGE.company, role: SAGE.role, job_id: SAGE.job_id, portal_url, ...overrides };
}

test('a row that stored the legacy Greenhouse host matches a run that landed on the current host', () => {
  assert.equal(canonicalApplicationMatchesFrozenPosting(row(LEGACY), freezePostingIdentity(SAGE, CURRENT)), true);
  // And the other way round: a row written after the move against a packet still frozen on the old host.
  assert.equal(canonicalApplicationMatchesFrozenPosting(row(CURRENT), freezePostingIdentity(SAGE, LEGACY)), true);
  // Exact equality is untouched.
  assert.equal(canonicalApplicationMatchesFrozenPosting(row(CURRENT), freezePostingIdentity(SAGE, CURRENT)), true);
});

test('the same origin move never widens the posting: board, token, and job id still decide', () => {
  const landed = freezePostingIdentity(SAGE, CURRENT);
  assert.equal(canonicalApplicationMatchesFrozenPosting(
    row('https://boards.greenhouse.io/embed/job_app?for=sage49&token=6131185005'), landed,
  ), false);
  assert.equal(canonicalApplicationMatchesFrozenPosting(
    row('https://boards.greenhouse.io/embed/job_app?for=janestreet&token=6131185004'), landed,
  ), false);
  assert.equal(canonicalApplicationMatchesFrozenPosting(
    row(LEGACY, { job_id: '00000000-0000-4000-8000-000000000001' }), landed,
  ), false);
  assert.equal(canonicalApplicationMatchesFrozenPosting(row(LEGACY, { company_name: 'Jane Street' }), landed), false);
});

test('only the measured pair is one boundary: EU silo, http, and lookalike hosts stay distinct', () => {
  assert.equal(sameApplicationPageOrigin('https://boards.greenhouse.io', 'https://job-boards.greenhouse.io'), true);
  assert.equal(sameApplicationPageOrigin('https://job-boards.greenhouse.io', 'https://boards.greenhouse.io'), true);
  assert.equal(sameApplicationPageOrigin('https://boards.eu.greenhouse.io', 'https://job-boards.eu.greenhouse.io'), false);
  assert.equal(sameApplicationPageOrigin('http://boards.greenhouse.io', 'https://job-boards.greenhouse.io'), false);
  assert.equal(sameApplicationPageOrigin('https://boards.greenhouse.io.evil.example', 'https://job-boards.greenhouse.io'), false);
  assert.equal(sameApplicationPageOrigin('https://jobs.lever.co', 'https://job-boards.greenhouse.io'), false);
  assert.equal(sameApplicationPageOrigin(null, 'https://job-boards.greenhouse.io'), false);
  assert.equal(sameApplicationPageOrigin(null, null), true);
});

test('the URL fallback tier accepts the legacy-host twin only with identical path and query', () => {
  // No provider key and no job id: only company-and-role plus the URL can decide, as before.
  const context = { company: 'Sage', role: 'Engineer' };
  const frozen = freezePostingIdentity(context, 'https://boards.greenhouse.io/sage49/jobs/not-a-number');
  assert.equal(frozen.postingKey, null);
  assert.equal(frozen.jobId, null);
  const twin = { company_name: 'Sage', role: 'Engineer', job_id: null, portal_url: 'https://job-boards.greenhouse.io/sage49/jobs/not-a-number' };
  assert.equal(canonicalApplicationMatchesFrozenPosting(twin, frozen), true);
  assert.equal(canonicalApplicationMatchesFrozenPosting({ ...twin, portal_url: 'https://job-boards.greenhouse.io/sage49/jobs/other' }, frozen), false);
  assert.equal(sameApplicationPageUrl(LEGACY, CURRENT), true);
  assert.equal(sameApplicationPageUrl(CURRENT, LEGACY), true);
  assert.equal(sameApplicationPageUrl(LEGACY, 'https://job-boards.greenhouse.io/embed/job_app?for=sage49&token=6131185005'), false);
  assert.equal(sameApplicationPageUrl(null, CURRENT), false);
  assert.equal(sameApplicationPageUrl(null, null), true);
});

test('a row that stored no URL still cannot pass the strict match on its own', () => {
  // The strict match is unchanged for absence; completing the row is the attempt-open path's job,
  // proven in canonicalPacketBinding.db.test.ts.
  assert.equal(canonicalApplicationMatchesFrozenPosting(row(null), freezePostingIdentity(SAGE, CURRENT)), false);
  assert.equal(frozenPostingIdentitiesMatch(freezePostingIdentity(SAGE, null), freezePostingIdentity(SAGE, CURRENT)), false);
  // Absent on both sides is what it always was: the job id decides.
  assert.equal(frozenPostingIdentitiesMatch(freezePostingIdentity(SAGE, null), freezePostingIdentity(SAGE, null)), true);
});
