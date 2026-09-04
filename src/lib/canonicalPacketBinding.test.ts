import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CanonicalPacketBindingError,
  canonicalApplicationStandsInWithoutPortal,
  oneExactCandidate,
} from './canonicalPacketBinding';
import { freezePostingIdentity } from './submissionAttemptLedger';
import type { applications } from '../db/schema';

type Row = typeof applications.$inferSelect;

/* The exact shape measured on Railway prod 2026-09-04: application f10ece44 for Hudson River
   Trading, created from monitored job 943f67c5 with no portal URL, refused at send once the run
   landed on job-boards.greenhouse.io. */
const JOB_ID = '943f67c5-fdbe-41c8-834f-84ab05e37dfb';
const HRT = {
  company: 'Hudson River Trading',
  role: 'Software Engineering Internship (C++ or Python) – Summer 2027',
  job_id: JOB_ID,
};
const LANDED_URL = 'https://job-boards.greenhouse.io/embed/job_app?for=wehrtyou&token=8052083';
const LEGACY_URL = 'https://boards.greenhouse.io/embed/job_app?for=wehrtyou&token=8052083';

function row(overrides: Partial<Row> & { id: string }): Row {
  return {
    company_name: HRT.company,
    role: HRT.role,
    job_id: JOB_ID,
    portal_url: null,
    user_id: 'a18f774b-a306-4804-93f3-cd6020c27fb3',
    ...overrides,
  } as Row;
}

const landed = freezePostingIdentity(HRT, LANDED_URL);

test('a canonical row that stored no portal URL binds through its identical monitored job id', () => {
  const canonical = row({ id: 'f10ece44' });
  assert.equal(oneExactCandidate([canonical], landed).id, 'f10ece44');
  assert.equal(oneExactCandidate([canonical], freezePostingIdentity(HRT, LEGACY_URL)).id, 'f10ece44');
  assert.equal(canonicalApplicationStandsInWithoutPortal(canonical, landed), true);
});

test('a row without a URL and a different job id is still missing, never a stand-in', () => {
  const other = row({ id: 'other-job', job_id: '00000000-0000-4000-8000-000000000001' });
  assert.throws(
    () => oneExactCandidate([other], landed),
    (error: unknown) => error instanceof CanonicalPacketBindingError
      && error.code === 'CANONICAL_PACKET_BINDING_MISSING',
  );
  assert.equal(canonicalApplicationStandsInWithoutPortal(other, landed), false);
});

test('a row without a URL and without a job id has no exact scope', () => {
  const scopeless = row({ id: 'scopeless', job_id: null });
  assert.throws(
    () => oneExactCandidate([scopeless], landed),
    (error: unknown) => error instanceof CanonicalPacketBindingError
      && error.code === 'CANONICAL_PACKET_BINDING_MISSING',
  );
  // With no job id on either side there is nothing immutable to agree on.
  assert.equal(canonicalApplicationStandsInWithoutPortal(row({ id: 'x', job_id: null }), freezePostingIdentity({ ...HRT, job_id: undefined }, LANDED_URL)), false);
});

test('the stand-in keeps the company-and-role guard the strict tiers apply', () => {
  const renamed = row({ id: 'renamed', company_name: 'Jane Street' });
  assert.equal(canonicalApplicationStandsInWithoutPortal(renamed, landed), false);
  assert.throws(() => oneExactCandidate([renamed], landed), CanonicalPacketBindingError);
});

test('a row that does carry a URL is never widened by the stand-in tier', () => {
  const otherBoard = row({ id: 'other-board', portal_url: 'https://job-boards.greenhouse.io/embed/job_app?for=janestreet&token=1' });
  assert.equal(canonicalApplicationStandsInWithoutPortal(otherBoard, landed), false);
  assert.throws(
    () => oneExactCandidate([otherBoard], landed),
    (error: unknown) => error instanceof CanonicalPacketBindingError
      && error.code === 'CANONICAL_PACKET_BINDING_MISSING',
  );
});

test('the strict match decides first: a URL-bearing exact row wins over a URL-less alias with the same job id', () => {
  const exact = row({ id: 'exact', portal_url: LANDED_URL });
  const alias = row({ id: 'alias' });
  assert.equal(oneExactCandidate([alias, exact], landed).id, 'exact');
  assert.equal(oneExactCandidate([exact, alias], landed).id, 'exact');
});

test('two URL-less rows naming the same job id are ambiguous, not a coin flip', () => {
  assert.throws(
    () => oneExactCandidate([row({ id: 'a' }), row({ id: 'b' })], landed),
    (error: unknown) => error instanceof CanonicalPacketBindingError
      && error.code === 'CANONICAL_PACKET_BINDING_AMBIGUOUS',
  );
  // The same row listed twice is one candidate, exactly as the strict tier already treats it.
  const same = row({ id: 'same' });
  assert.equal(oneExactCandidate([same, same], landed).id, 'same');
});

test('a packet that has not landed anywhere still binds exactly as before', () => {
  const canonical = row({ id: 'f10ece44' });
  assert.equal(oneExactCandidate([canonical], freezePostingIdentity(HRT, null)).id, 'f10ece44');
});
