import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db } from '../db/index';
import type { ApplicationReviewState } from './applicationReview';
import {
  repairHistoryReviewPortalFromMonitoredJob,
  repairReviewPortalFromMonitoredJob,
} from './applicationPortalRepair';
import { monitoredDescriptionHash } from './monitoredPortalRepair';

type RepairRow = Parameters<typeof repairReviewPortalFromMonitoredJob>[0];

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const DESCRIPTION = 'Build reliable systems for customers and work closely with the product team.';

function row(jobContext: Record<string, unknown>): RepairRow {
  return { job_context: jobContext } as RepairRow;
}

function review(portalUrl: string, atsName: string): ApplicationReviewState {
  return {
    jd_text: DESCRIPTION,
    status: 'resume_ready',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: '2026-08-31T00:00:00.000Z',
    portal_url: portalUrl,
    ats_name: atsName,
    portal_supported: true,
  };
}

function jobContext() {
  return {
    job_id: JOB_ID,
    company: 'Acme',
    role: 'Software Engineer',
    jd_hash: monitoredDescriptionHash(DESCRIPTION),
  };
}

function mockMonitoredJob(rows: unknown[]) {
  return mock.method(db, 'select', (() => ({
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          limit: async () => rows,
        }),
      }),
    }),
  })) as unknown as typeof db.select);
}

test('a job-bound packet replaces a supported cross-family URL with its source-owned URL', async () => {
  const select = mockMonitoredJob([{
    external_id: 'ashby-job-1',
    apply_url: 'https://jobs.ashbyhq.com/acme/ashby-job-1',
    ats_name: 'ashby',
    board_token: 'acme',
    company_name: 'Acme',
    title: 'Software Engineer',
    description: DESCRIPTION,
  }]);
  try {
    const repaired = await repairReviewPortalFromMonitoredJob(
      row(jobContext()),
      review('https://jobs.lever.co/other/lever-job-1/apply', 'lever'),
    );
    assert.equal(repaired.portal_url, 'https://jobs.ashbyhq.com/acme/ashby-job-1/application');
    assert.equal(repaired.ats_name, 'ashby');
    assert.equal(repaired.portal_supported, true);
  } finally {
    select.mock.restore();
  }
});

test('a job-bound packet replaces a supported wrong-tenant URL with its source-owned tenant', async () => {
  const select = mockMonitoredJob([{
    external_id: 'lever-job-1',
    apply_url: 'https://jobs.lever.co/acme/lever-job-1',
    ats_name: 'lever',
    board_token: 'acme',
    company_name: 'Acme',
    title: 'Software Engineer',
    description: DESCRIPTION,
  }]);
  try {
    const repaired = await repairReviewPortalFromMonitoredJob(
      row(jobContext()),
      review('https://jobs.lever.co/other/lever-job-1/apply', 'lever'),
    );
    assert.equal(repaired.portal_url, 'https://jobs.lever.co/acme/lever-job-1/apply');
    assert.equal(repaired.ats_name, 'lever');
  } finally {
    select.mock.restore();
  }
});

test('a job-bound packet fails closed when its enabled source-owned row is unavailable', async () => {
  const select = mockMonitoredJob([]);
  try {
    const repaired = await repairReviewPortalFromMonitoredJob(
      row(jobContext()),
      review('https://jobs.lever.co/other/lever-job-1/apply', 'lever'),
    );
    assert.equal(repaired.portal_url, undefined);
    assert.equal(repaired.ats_name, undefined);
    assert.equal(repaired.portal_supported, false);
  } finally {
    select.mock.restore();
  }
});

test('a manual packet with no monitored job keeps its supported portal URL without a database read', async () => {
  const select = mock.method(db, 'select', (() => {
    throw new Error('manual packets must not query monitored jobs');
  }) as unknown as typeof db.select);
  const current = review('https://jobs.lever.co/manual/manual-job-1/apply', 'lever');
  try {
    assert.deepEqual(
      await repairReviewPortalFromMonitoredJob(row({ company: 'Manual' }), current),
      current,
    );
  } finally {
    select.mock.restore();
  }
});

test('history rebinds a job-bound supported URL before preserving generic portal state', () => {
  const current = review('https://jobs.lever.co/other/lever-job-1/apply', 'lever');
  const repaired = repairHistoryReviewPortalFromMonitoredJob(
    row(jobContext()),
    current,
    new Map([[JOB_ID, {
      applyUrl: 'https://jobs.ashbyhq.com/acme/ashby-job-1/application',
      company: 'Acme',
      role: 'Software Engineer',
      description: DESCRIPTION,
      jdHash: monitoredDescriptionHash(DESCRIPTION),
    }]]),
  );
  assert.equal(repaired.portal_url, 'https://jobs.ashbyhq.com/acme/ashby-job-1/application');
  assert.equal(repaired.ats_name, 'ashby');
});

test('history preserves generic portal behavior only for a manual packet with no monitored job', () => {
  const current = review('https://jobs.lever.co/manual/manual-job-1/apply', 'lever');
  assert.deepEqual(
    repairHistoryReviewPortalFromMonitoredJob(row({ company: 'Manual' }), current, new Map()),
    current,
  );
});
