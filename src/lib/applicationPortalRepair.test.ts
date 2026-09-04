import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db } from '../db/index';
import type { ApplicationReviewState } from './applicationReview';
import {
  POSTING_CLOSED_BY_MONITOR_REASON,
  postingStatusBlocksSend,
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

test('a malformed declared monitored job id fails closed instead of becoming a manual packet', async () => {
  const select = mock.method(db, 'select', (() => {
    throw new Error('an invalid monitored id must fail before a database read');
  }) as unknown as typeof db.select);
  try {
    const repaired = await repairReviewPortalFromMonitoredJob(
      row({ job_id: 'not-a-uuid', company: 'Acme' }),
      review('https://jobs.lever.co/other/lever-job-1/apply', 'lever'),
    );
    assert.equal(repaired.portal_url, undefined);
    assert.equal(repaired.ats_name, undefined);
    assert.equal(repaired.portal_supported, false);
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

/* MEASURED 2026-09-02 21:10:30 on Hudson River Trading (packet 4a79eec1): the greenhouse fill had
 * just completed 41 fields when a read-time repair could not re-prove the monitored row (its text
 * had been refreshed, so the hash no longer matched) and stripped portal_url and ats_name; the
 * dashboard then offered "Add the job again" on a packet one press from ready. */
test('a refreshed posting text does not erase the URL: identity agrees, so the source-owned URL is restored', async () => {
  const select = mockMonitoredJob([{
    external_id: 'lever-job-1',
    apply_url: 'https://jobs.lever.co/acme/lever-job-1',
    ats_name: 'lever',
    board_token: 'acme',
    company_name: 'Acme',
    title: 'Software Engineer',
    description: `${DESCRIPTION}\n\nUpdated: we now also hire in Austin.`,
  }]);
  try {
    // The stripped shape an earlier pass left behind: no URL at all.
    const stripped = { ...review('https://jobs.lever.co/acme/lever-job-1/apply', 'lever'), portal_url: undefined, ats_name: undefined, portal_supported: false };
    const healed = await repairReviewPortalFromMonitoredJob(row(jobContext()), stripped as ApplicationReviewState);
    assert.equal(healed.portal_url, 'https://jobs.lever.co/acme/lever-job-1/apply');
    assert.equal(healed.ats_name, 'lever');
    assert.equal(healed.portal_supported, true);
  } finally {
    select.mock.restore();
  }
});

test('an unavailable monitored row keeps a URL a managed run has already used', async () => {
  const select = mockMonitoredJob([]);
  try {
    const used = { ...review('https://jobs.lever.co/acme/lever-job-1/apply', 'lever'), filled_fields: ['first_name', 'resume'], submission_run_id: 'd712aa9f-0000-4000-8000-000000000000' };
    const kept = await repairReviewPortalFromMonitoredJob(row(jobContext()), used as ApplicationReviewState);
    assert.equal(kept.portal_url, 'https://jobs.lever.co/acme/lever-job-1/apply');
    assert.equal(kept.ats_name, 'lever');
    assert.equal(kept.portal_supported, true);
  } finally {
    select.mock.restore();
  }
});

test('an unavailable monitored row still strips a URL no run has used', async () => {
  const select = mockMonitoredJob([]);
  try {
    const unused = review('https://jobs.lever.co/acme/lever-job-1/apply', 'lever');
    const stripped = await repairReviewPortalFromMonitoredJob(row(jobContext()), unused);
    assert.equal(stripped.portal_url, undefined);
    assert.equal(stripped.portal_supported, false);
  } finally {
    select.mock.restore();
  }
});

/* c047282's tenant defense has to survive the JD-drift restore: identity agrees, the description
 * has drifted, and the packet is carrying a WRONG current URL. The source-owned URL must win. */
test('a drifted description still rebinds a wrong-tenant URL to the source-owned one', async () => {
  const select = mockMonitoredJob([{
    external_id: 'lever-job-1',
    apply_url: 'https://jobs.lever.co/acme/lever-job-1',
    ats_name: 'lever',
    board_token: 'acme',
    company_name: 'Acme',
    title: 'Software Engineer',
    description: `${DESCRIPTION}\n\nUpdated: we now also hire in Austin.`,
  }]);
  try {
    const wrongTenant = { ...review('https://jobs.lever.co/evil/lever-job-1/apply', 'lever'), filled_fields: ['first_name'] };
    const repaired = await repairReviewPortalFromMonitoredJob(row(jobContext()), wrongTenant as ApplicationReviewState);
    assert.equal(repaired.portal_url, 'https://jobs.lever.co/acme/lever-job-1/apply');
    assert.equal(repaired.ats_name, 'lever');
  } finally {
    select.mock.restore();
  }
});

test('a submit request alone is not "used": an unavailable row still strips a run-id-only packet', async () => {
  const select = mockMonitoredJob([]);
  try {
    // submission_run_id is minted when the submit is REQUESTED, before any browser opens.
    const requested = { ...review('https://jobs.lever.co/acme/lever-job-1/apply', 'lever'), submission_run_id: 'd712aa9f-0000-4000-8000-000000000000' };
    const stripped = await repairReviewPortalFromMonitoredJob(row(jobContext()), requested as ApplicationReviewState);
    assert.equal(stripped.portal_url, undefined);
    assert.equal(stripped.portal_supported, false);
  } finally {
    select.mock.restore();
  }
});

/* THE MONITOR'S OWN VERDICT, is_active = false: the posting still names this exact packet (company
 * and title both agree) but the regular sweep has stopped seeing it. Measured live, Genovice
 * a6c39c87 - "The employer has taken this posting down: the page says 'This job posting is no
 * longer available'" - except there this was only discovered because a fill run happened to open
 * the page; the point of this check is to know it from the monitor alone, before any run tries. */
test('a monitored job the sweep stopped seeing reads posting_status closed and is not sendable', async () => {
  const select = mockMonitoredJob([{
    external_id: 'lever-job-1',
    apply_url: 'https://jobs.lever.co/acme/lever-job-1',
    ats_name: 'lever',
    board_token: 'acme',
    company_name: 'Acme',
    title: 'Software Engineer',
    description: DESCRIPTION,
    is_active: false,
    last_seen_at: new Date('2026-09-01T12:00:00.000Z'),
  }]);
  try {
    const repaired = await repairReviewPortalFromMonitoredJob(
      row(jobContext()),
      review('https://jobs.lever.co/acme/lever-job-1/apply', 'lever'),
    );
    assert.deepEqual(repaired.posting_status, {
      state: 'closed',
      reason: 'monitor_inactive',
      observed_at: '2026-09-01T12:00:00.000Z',
    });
    assert.equal(repaired.attention_reason, POSTING_CLOSED_BY_MONITOR_REASON);
    assert.deepEqual(repaired.attention_categories, ['posting_closed']);
    assert.equal(repaired.portal_supported, false);
    // The URL itself is kept (not stripped) so a caller reading portal_url still knows where the
    // posting was, and monitoredPortalProofUnavailable's generic 409 does not shadow this specific
    // one - see closedPostingReview's own doc comment.
    assert.equal(repaired.portal_url, 'https://jobs.lever.co/acme/lever-job-1/apply');
    assert.equal(postingStatusBlocksSend(repaired), true);
  } finally {
    select.mock.restore();
  }
});

test('the same monitor verdict is read identically on the /resume/history projection', () => {
  const repaired = repairHistoryReviewPortalFromMonitoredJob(
    row(jobContext()),
    review('https://jobs.lever.co/acme/lever-job-1/apply', 'lever'),
    new Map([[JOB_ID, {
      applyUrl: 'https://jobs.lever.co/acme/lever-job-1',
      company: 'Acme',
      role: 'Software Engineer',
      description: DESCRIPTION,
      jdHash: monitoredDescriptionHash(DESCRIPTION),
      isActive: false,
      lastSeenAt: new Date('2026-09-01T12:00:00.000Z'),
    }]]),
  );
  assert.equal(repaired.posting_status?.state, 'closed');
  assert.equal(repaired.portal_supported, false);
  assert.equal(postingStatusBlocksSend(repaired), true);
});

/* A run mid-flight, or one already with the employer, must not be relitigated just because the
 * monitor's sweep happened to flip is_active in the middle of it - see
 * POSTING_CLOSED_MID_RUN_STATUSES's own doc comment for why this has to hold even for a status
 * that has nothing to do with a browser being open right now (submission_claimed,
 * awaiting_security_code, submitted). */
for (const midRunStatus of ['submitting', 'submission_claimed', 'awaiting_security_code', 'submitted'] as const) {
  test(`a "${midRunStatus}" row is left completely untouched when its posting goes inactive mid-run`, async () => {
    const select = mockMonitoredJob([{
      external_id: 'lever-job-1',
      apply_url: 'https://jobs.lever.co/acme/lever-job-1',
      ats_name: 'lever',
      board_token: 'acme',
      company_name: 'Acme',
      title: 'Software Engineer',
      description: DESCRIPTION,
      is_active: false,
      last_seen_at: new Date('2026-09-01T12:00:00.000Z'),
    }]);
    try {
      const inFlight = { ...review('https://jobs.lever.co/acme/lever-job-1/apply', 'lever'), status: midRunStatus };
      const repaired = await repairReviewPortalFromMonitoredJob(row(jobContext()), inFlight as ApplicationReviewState);
      assert.deepEqual(repaired, inFlight);
      assert.equal(repaired.posting_status, undefined);
    } finally {
      select.mock.restore();
    }
  });
}

test('an explicit is_active: true is unaffected, same as an absent value', async () => {
  const select = mockMonitoredJob([{
    external_id: 'lever-job-1',
    apply_url: 'https://jobs.lever.co/acme/lever-job-1',
    ats_name: 'lever',
    board_token: 'acme',
    company_name: 'Acme',
    title: 'Software Engineer',
    description: DESCRIPTION,
    is_active: true,
    last_seen_at: new Date('2026-09-01T12:00:00.000Z'),
  }]);
  try {
    const repaired = await repairReviewPortalFromMonitoredJob(
      row(jobContext()),
      review('https://jobs.lever.co/acme/lever-job-1/apply', 'lever'),
    );
    assert.equal(repaired.posting_status, undefined);
    assert.equal(repaired.portal_supported, true);
  } finally {
    select.mock.restore();
  }
});
