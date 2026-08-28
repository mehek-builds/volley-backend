import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema';
import { duplicateApplicationVerdict } from './duplicateApplication';
import {
  POSTING_DISTINCTION_CANDIDATE_IDENTITY_VERSION,
  PostingDistinctionError,
  appendPostingDistinction,
  loadPostingDistinctionCandidate,
  type PostingDistinctionExecutor,
} from './postingIdentityDistinction';

test('appender is pair-idempotent and stale relations never clear the duplicate guard', async () => {
  const database = await PGlite.create();
  try {
    const initial = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson(schema as unknown as Record<string, unknown>),
    );
    for (const statement of initial) await database.exec(statement);
    const executor = drizzle(database, { schema }) as unknown as PostingDistinctionExecutor;

    const userId = '29c9130b-d5c7-43e9-a233-a9ffecbdc001';
    const priorAttemptId = '29c9130b-d5c7-43e9-a233-a9ffecbdc002';
    const priorPacketId = '29c9130b-d5c7-43e9-a233-a9ffecbdc003';
    const candidateApplicationId = '29c9130b-d5c7-43e9-a233-a9ffecbdc004';
    const candidatePacketId = '29c9130b-d5c7-43e9-a233-a9ffecbdc005';
    const relationId = '29c9130b-d5c7-43e9-a233-a9ffecbdc006';
    const candidateContext = { company: 'Candidate Co', role: 'Platform Engineer' };
    const candidateUrl = 'https://candidate.example/jobs/2002';

    await database.exec(`
      insert into users (id, email) values ('${userId}', 'distinction@example.test');
      insert into generated_resumes (
        id, user_id, job_context, spec, resume_object_key
      ) values (
        '${candidatePacketId}', '${userId}',
        '{"company":"Candidate Co","role":"Platform Engineer"}'::jsonb,
        '{"_review":{"portal_url":"${candidateUrl}"}}'::jsonb,
        'resumes/candidate.pdf'
      );
      insert into applications (
        id, user_id, legacy_generated_resume_id, company_scope_key, company_name, role,
        portal_url, source_surface, application_fingerprint
      ) values (
        '${candidateApplicationId}', '${userId}', '${candidatePacketId}',
        'domain:candidate.example', 'Candidate Co', 'Platform Engineer',
        '${candidateUrl}', 'dashboard', 'distinction-candidate'
      );
      insert into application_submission_attempt_bindings (
        user_id, attempt_id, packet_id, source, operation,
        company_name, role, portal_url, portal_identity
      ) values (
        '${userId}', '${priorAttemptId}', '${priorPacketId}', 'legacy_backfill',
        'initial_submission', 'Prior Co', 'Backend Engineer',
        'https://prior.example/jobs/1001', 'https://prior.example'
      );
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        company_name, role, portal_url, portal_identity, observed_at, created_at
      ) values
      (
        '${userId}', '${priorPacketId}', '29c9130b-d5c7-43e9-a233-a9ffecbdc010',
        '${priorAttemptId}', 'attempt_opened', 'legacy_backfill', 'initial_submission',
        'Prior Co', 'Backend Engineer', 'https://prior.example/jobs/1001',
        'https://prior.example', '2026-08-26T10:00:00Z', '2026-08-26T10:00:00Z'
      ),
      (
        '${userId}', '${priorPacketId}', '29c9130b-d5c7-43e9-a233-a9ffecbdc011',
        '${priorAttemptId}', 'submission_confirmed', 'legacy_backfill', 'initial_submission',
        'Prior Co', 'Backend Engineer', 'https://prior.example/jobs/1001',
        'https://prior.example', '2026-08-26T10:01:00Z', '2026-08-26T10:01:00Z'
      )
    `);

    const candidate = await loadPostingDistinctionCandidate(
      userId,
      candidateApplicationId,
      candidatePacketId,
      executor,
    );
    const input = {
      userId,
      relationId,
      priorAttemptId,
      candidateApplicationId,
      candidatePacketId,
      expectedCandidateIdentityVersion: POSTING_DISTINCTION_CANDIDATE_IDENTITY_VERSION,
      expectedCandidateIdentityDigest: candidate.identity.digest,
    } as const;
    const first = await appendPostingDistinction(input, { executor });
    assert.equal(first.replay, false);
    const replay = await appendPostingDistinction(input, { executor });
    assert.equal(replay.replay, true);
    assert.equal(replay.distinction.id, first.distinction.id);

    const clear = await duplicateApplicationVerdict({
      userId,
      applicationId: candidatePacketId,
      jobContext: candidateContext,
      portalUrl: candidateUrl,
    }, executor);
    assert.equal(clear.kind, 'clear');

    await database.exec(`
      update applications
      set portal_url = 'https://candidate.example/jobs/3003'
      where id = '${candidateApplicationId}';
      update generated_resumes
      set spec = jsonb_set(spec, '{_review,portal_url}', '"https://candidate.example/jobs/3003"')
      where id = '${candidatePacketId}'
    `);
    const stale = await duplicateApplicationVerdict({
      userId,
      applicationId: candidatePacketId,
      jobContext: candidateContext,
      portalUrl: 'https://candidate.example/jobs/3003',
    }, executor);
    assert.equal(stale.kind, 'unidentifiable');

    const replayAfterDrift = await appendPostingDistinction(input, { executor });
    assert.equal(replayAfterDrift.replay, true);
    assert.equal(replayAfterDrift.distinction.id, first.distinction.id);
    assert.notEqual(
      replayAfterDrift.candidate.identity.digest,
      replayAfterDrift.distinction.candidate_identity_digest,
      'an exact write replay returns the current candidate, not the stale stored snapshot',
    );
    const replayGuard = await duplicateApplicationVerdict({
      userId,
      applicationId: replayAfterDrift.candidate.applicationId,
      jobContext: replayAfterDrift.candidate.jobContext,
      portalUrl: replayAfterDrift.candidate.portalUrl,
    }, executor);
    assert.equal(replayGuard.kind, 'unidentifiable');

    await assert.rejects(
      appendPostingDistinction({
        ...input,
        relationId: '29c9130b-d5c7-43e9-a233-a9ffecbdc012',
      }, { executor }),
      (error: unknown) => error instanceof PostingDistinctionError && error.code === 'stale_candidate',
    );
  } finally {
    await database.close();
  }
});
