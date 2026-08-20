import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reviewCanBeSent,
  packetMatchesJob,
  nextPreferredReadyPacket,
  type MatchablePacket,
  type MatchableJob,
} from './autopilotMatch';

function packet(overrides: Partial<MatchablePacket> = {}): MatchablePacket {
  return {
    id: 'packet-1',
    created_at: '2026-08-01T00:00:00.000Z',
    job_context: { company: 'Acme', role: 'Software Engineer Intern', job_id: null },
    review: { status: 'ready_to_submit', portal_supported: true },
    reviewUpdatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function job(overrides: Partial<MatchableJob> = {}): MatchableJob {
  return { id: 'job-1', company_name: 'Acme', title: 'Software Engineer Intern', ...overrides };
}

test('reviewCanBeSent accepts every ready status, on a supported portal', () => {
  for (const status of ['resume_ready', 'questions_ready', 'ready_to_submit']) {
    assert.equal(reviewCanBeSent({ status, portal_supported: true }), true, status);
  }
});

test('reviewCanBeSent refuses an unsupported portal even at ready_to_submit', () => {
  assert.equal(reviewCanBeSent({ status: 'ready_to_submit', portal_supported: false }), false);
});

test('reviewCanBeSent refuses every non-ready status', () => {
  for (const status of ['needs_attention', 'ready_for_final_approval', 'failed', 'submitted', 'submit_requested', 'submitting']) {
    assert.equal(reviewCanBeSent({ status, portal_supported: true }), false, status);
  }
});

test('reviewCanBeSent refuses a missing review', () => {
  assert.equal(reviewCanBeSent(null), false);
  assert.equal(reviewCanBeSent(undefined), false);
  assert.equal(reviewCanBeSent({}), false);
});

test('packetMatchesJob prefers the posting id when the packet has one', () => {
  const p = packet({ job_context: { company: 'Wrong Co', role: 'Wrong Role', job_id: 'job-1' } });
  assert.equal(packetMatchesJob(p, job()), true, 'the id matches even though company/role do not');
  assert.equal(packetMatchesJob(p, job({ id: 'job-2' })), false, 'a different id refuses regardless of company/role');
});

test('packetMatchesJob falls back to normalized company+role only when there is no id', () => {
  // normalized() here lowercases and collapses punctuation to spaces, but does not strip legal
  // suffixes the way applicationKey's flatten() does elsewhere - "Acme" and "ACME, Inc." are
  // different strings under it, correctly, since that stricter equivalence is a different
  // function's job. This only exercises what normalized() actually promises: case and punctuation.
  const p = packet({ job_context: { company: 'ACME', role: 'software   engineer, intern', job_id: null } });
  assert.equal(packetMatchesJob(p, job()), true, 'punctuation and case are normalized away');
  assert.equal(packetMatchesJob(p, job({ title: 'Product Manager Intern' })), false);
});

test('nextPreferredReadyPacket picks the first job in ranked order with any ready match', () => {
  const packets = [
    packet({ id: 'low-rank-match', job_context: { company: 'Beta', role: 'Backend Intern', job_id: null } }),
    packet({ id: 'top-rank-match', job_context: { company: 'Acme', role: 'Software Engineer Intern', job_id: null } }),
  ];
  const jobs = [job({ id: 'job-1', company_name: 'Acme', title: 'Software Engineer Intern' }), job({ id: 'job-2', company_name: 'Beta', title: 'Backend Intern' })];
  const chosen = nextPreferredReadyPacket(packets, jobs);
  assert.equal(chosen?.id, 'top-rank-match', 'the higher-ranked job wins even though both packets are ready');
});

test('nextPreferredReadyPacket skips a top-ranked job with no ready packet and falls through', () => {
  const packets = [packet({ id: 'only-ready', job_context: { company: 'Beta', role: 'Backend Intern', job_id: null } })];
  const jobs = [job({ id: 'job-1', company_name: 'Acme', title: 'Software Engineer Intern' }), job({ id: 'job-2', company_name: 'Beta', title: 'Backend Intern' })];
  const chosen = nextPreferredReadyPacket(packets, jobs);
  assert.equal(chosen?.id, 'only-ready');
});

test('nextPreferredReadyPacket never returns a packet the job ranking no longer carries', () => {
  const packets = [packet({ id: 'stale', job_context: { company: 'Rotated Off', role: 'Old Role', job_id: null } })];
  const chosen = nextPreferredReadyPacket(packets, []);
  assert.equal(chosen, null, 'a packet for a posting that has rotated off the current ranked list must not be chosen');
});

test('nextPreferredReadyPacket ignores a matching packet that is not sendable', () => {
  const packets = [packet({ review: { status: 'needs_attention', portal_supported: true } })];
  assert.equal(nextPreferredReadyPacket(packets, [job()]), null);
});

test('nextPreferredReadyPacket breaks ties on the same job by most recently updated review', () => {
  const packets = [
    packet({ id: 'older', reviewUpdatedAt: '2026-08-01T00:00:00.000Z' }),
    packet({ id: 'newer', reviewUpdatedAt: '2026-08-19T00:00:00.000Z' }),
  ];
  const chosen = nextPreferredReadyPacket(packets, [job()]);
  assert.equal(chosen?.id, 'newer');
});
