import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { freezePostingIdentity } from './submissionAttemptLedger';
import {
  POSTING_DISTINCTION_CANDIDATE_IDENTITY_VERSION,
  POSTING_DISTINCTION_PROOF_KIND,
  canonicalExactPostingUrl,
  postingDistinctionApplies,
  postingDistinctionCandidateIdentity,
  strongPostingSameness,
  type PostingDistinctionCandidateIdentity,
  type PostingDistinctionRecord,
} from './postingIdentityDistinction';
import { legacyProjectionRowsNotCoveredByLedger, type SubmittedTwinRow } from './duplicateApplication';

function relationFor(
  candidate: PostingDistinctionCandidateIdentity,
  over: Partial<PostingDistinctionRecord> = {},
): PostingDistinctionRecord {
  return {
    id: '019c9130-bd5c-7b3e-9233-a9ffecbdc001',
    user_id: '019c9130-bd5c-7b3e-9233-a9ffecbdc002',
    relation_id: '019c9130-bd5c-7b3e-9233-a9ffecbdc003',
    prior_attempt_id: '019c9130-bd5c-7b3e-9233-a9ffecbdc004',
    candidate_application_id: '019c9130-bd5c-7b3e-9233-a9ffecbdc005',
    candidate_packet_id: '019c9130-bd5c-7b3e-9233-a9ffecbdc006',
    candidate_identity_version: candidate.version,
    candidate_identity_digest: candidate.digest,
    candidate_identity_snapshot: {
      version: candidate.version,
      posting_key: candidate.postingKey,
      job_id: candidate.jobId,
      company_role: candidate.companyRole,
      portal_url: candidate.portalUrl,
    },
    candidate_posting_key: candidate.postingKey,
    candidate_job_id: candidate.jobId,
    candidate_company_role: candidate.companyRole,
    candidate_portal_url: candidate.portalUrl,
    proof_kind: POSTING_DISTINCTION_PROOF_KIND,
    observed_at: new Date('2026-08-26T12:00:00Z'),
    created_at: new Date('2026-08-26T12:00:00Z'),
    ...over,
  };
}

describe('server-canonical posting distinction identity', () => {
  test('provider aliases and apply steps produce one versioned digest', () => {
    const context = { company: 'Deepgram', role: 'Software Engineer Intern' };
    const direct = postingDistinctionCandidateIdentity(
      context,
      'https://jobs.ashbyhq.com/deepgram/dc8693b5-72ce-4ca3-ab15-9c8434d35da1',
    );
    const apply = postingDistinctionCandidateIdentity(
      context,
      'http://jobs.ashbyhq.com/deepgram/dc8693b5-72ce-4ca3-ab15-9c8434d35da1/application',
    );
    assert.ok(direct);
    assert.deepEqual(apply, direct);
    assert.equal(direct.version, POSTING_DISTINCTION_CANDIDATE_IDENTITY_VERSION);
    assert.match(direct.digest, /^[0-9a-f]{64}$/);
  });

  test('aggregate and query-only unknown-provider pages cannot authorize a distinction', () => {
    assert.equal(canonicalExactPostingUrl('https://careers.example.com/jobs'), null);
    assert.equal(canonicalExactPostingUrl('https://careers.example.com/jobs?query=engineer'), null);
    assert.equal(postingDistinctionCandidateIdentity(
      { company: 'Example', role: 'Engineer' },
      'https://careers.example.com/jobs/application',
    ), null);
  });

  test('candidate URL and normalized employer-role changes invalidate the digest', () => {
    const first = postingDistinctionCandidateIdentity(
      { company: 'Example', role: 'Platform Engineer' },
      'https://careers.example.com/jobs/1001',
    );
    const changedPosting = postingDistinctionCandidateIdentity(
      { company: 'Example', role: 'Platform Engineer' },
      'https://careers.example.com/jobs/1002',
    );
    const changedEmployer = postingDistinctionCandidateIdentity(
      { company: 'Another Example', role: 'Platform Engineer' },
      'https://careers.example.com/jobs/1001',
    );
    assert.ok(first && changedPosting && changedEmployer);
    assert.notEqual(first.digest, changedPosting.digest);
    assert.notEqual(first.digest, changedEmployer.digest);
  });
});

describe('pair-specific distinction safety', () => {
  const candidate = postingDistinctionCandidateIdentity(
    { company: 'Candidate Co', role: 'Platform Engineer' },
    'https://candidate.example/jobs/2002',
  )!;
  const prior = freezePostingIdentity(
    { company: 'Prior Co', role: 'Backend Engineer' },
    'https://prior.example/jobs/1001',
  );

  function applies(
    relation: PostingDistinctionRecord,
    over: Partial<Parameters<typeof postingDistinctionApplies>[0]> = {},
  ) {
    return postingDistinctionApplies({
      relation,
      priorAttemptId: relation.prior_attempt_id,
      candidateApplicationId: relation.candidate_application_id,
      candidatePacketId: relation.candidate_packet_id,
      candidateIdentity: candidate,
      priorIdentity: prior,
      ...over,
    });
  }

  test('only the exact prior, exact candidate pair, digest, proof, and snapshot apply', () => {
    const relation = relationFor(candidate);
    assert.equal(applies(relation), true);
    assert.equal(applies(relation, { priorAttemptId: '019c9130-bd5c-7b3e-9233-a9ffecbdc099' }), false);
    assert.equal(applies(relation, { candidatePacketId: '019c9130-bd5c-7b3e-9233-a9ffecbdc099' }), false);
    assert.equal(applies(relationFor(candidate, { proof_kind: 'invented' })), false);
    assert.equal(applies(relationFor(candidate, {
      candidate_identity_snapshot: {
        version: candidate.version,
        posting_key: candidate.postingKey,
        job_id: candidate.jobId,
        company_role: candidate.companyRole,
        portal_url: 'https://candidate.example/jobs/changed',
      },
    })), false);
    const staleCandidate = { ...candidate, digest: '0'.repeat(64) };
    assert.equal(applies(relation, { candidateIdentity: staleCandidate }), false);
  });

  test('weak prior identity and every strong sameness signal veto the relation', () => {
    const relation = relationFor(candidate);
    assert.equal(applies(relation, {
      priorIdentity: freezePostingIdentity({ company: 'Prior Co', role: 'Backend Engineer' }, null),
    }), false);
    assert.equal(applies(relation, {
      priorIdentity: freezePostingIdentity(
        { company: 'Candidate Co', role: 'Platform Engineer' },
        candidate.portalUrl,
      ),
    }), false);

    const candidateWithJob = postingDistinctionCandidateIdentity(
      { company: 'Candidate Co', role: 'Platform Engineer', job_id: 'same-job' },
      'https://candidate.example/jobs/2002',
    )!;
    assert.equal(strongPostingSameness(
      {
        postingKey: candidateWithJob.postingKey,
        jobId: candidateWithJob.jobId,
        portalUrl: candidateWithJob.portalUrl,
      },
      freezePostingIdentity(
        { company: 'Other Label', role: 'Other Label', job_id: 'SAME-JOB' },
        'https://other.example/jobs/9009',
      ),
    ), 'job_id');
  });
});

test('a ledger-covered packet removes only its own mutable legacy projection', () => {
  const legacy = (id: string): SubmittedTwinRow => ({
    id,
    job_context: {},
    portal_url: null,
    submitted_at: null,
  });
  const covered = legacy('019c9130-bd5c-7b3e-9233-a9ffecbdc011');
  const unrelated = legacy('019c9130-bd5c-7b3e-9233-a9ffecbdc012');
  const ledger: SubmittedTwinRow = {
    ...legacy('019c9130-bd5c-7b3e-9233-a9ffecbdc013'),
    packet_id: covered.id,
    attempt_id: '019c9130-bd5c-7b3e-9233-a9ffecbdc014',
  };
  assert.deepEqual(
    legacyProjectionRowsNotCoveredByLedger([covered, unrelated], [ledger]),
    [unrelated],
  );
});
