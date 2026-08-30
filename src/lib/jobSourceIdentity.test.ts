import assert from 'node:assert/strict';
import test from 'node:test';
import { portalNameAgrees } from './sponsorIdentity';
import { JOB_SOURCES } from './jobSources';
import { POLL_SEGMENT_SIZE } from './jobPollScheduler';
import {
  MINIMUM_INDUSTRY_CLASSIFICATION_COVERAGE,
  classifyEmployerIndustry,
} from './jobVariety';

/**
 * THE GATE THAT SHOULD HAVE EXISTED FROM THE START.
 *
 * A job source is three hand-written strings, and the only check that ever ran on a new one asked
 * "does this token return postings?" - which every wrong token also answers yes to. Four boards
 * therefore sat on the list for weeks under a name that was not theirs, and were found one at a
 * time by people chasing other bugs.
 *
 * `npm run sources:verify` asks each board who it is, over the network, and runs in CI. These tests
 * pin the JUDGEMENT it applies, offline, so the rule cannot be quietly loosened to make a stubborn
 * board pass.
 */

test('the four tokens that were somebody else are rejected by name', () => {
  const wrong: [string, string][] = [
    ['sas', 'Superior Alarm Systems'],
    ['BCG', 'Bohen Consulting Group'],
    ['TCS', 'Thornbury Community Services'],
    ['Disney', "Sgt. Pepper's Lonely Hearts Club Band"],
  ];
  for (const [ours, portal] of wrong) {
    assert.equal(portalNameAgrees(ours, portal), false, `${ours} vs ${portal}`);
  }
});

test('and the ways a real name legitimately differs are accepted', () => {
  const fine: [string, string][] = [
    ['Abnormal AI', 'Abnormal'],
    ['TripAdvisor', 'Tripadvisor'],
    ['yugabyte', 'YugabyteDB'],
    ['Qube Research & Technologies', 'Qube Research and Technologies'],
    ['Chainguard', 'Chainguard'],
  ];
  for (const [ours, portal] of fine) {
    assert.equal(portalNameAgrees(ours, portal), true, `${ours} vs ${portal}`);
  }
});

test('the four mislabelled tokens are gone from the source list', () => {
  /* They were removed rather than relabelled because the companies somebody meant - SAS Institute,
     Boston Consulting Group, Tata Consultancy, Disney - publish on none of these three ATSs, which
     is exactly why a guessed token landed on someone else. */
  const tokens = new Set(JOB_SOURCES.map((source) => `${source.ats_name}/${source.board_token}`));
  for (const gone of ['greenhouse/sas', 'greenhouse/bcg', 'greenhouse/tcs', 'greenhouse/disney']) {
    assert.equal(tokens.has(gone), false, `${gone} is back on the list`);
  }
});

test('the three renamed sources carry the name their board uses', () => {
  const byToken = new Map(JOB_SOURCES.map((source) => [source.board_token, source.company_name]));
  assert.equal(byToken.get('latch'), 'LatchBio', 'the lever token `latch` is LatchBio');
  assert.equal(byToken.get('assembledhq'), 'Assembled');
  assert.equal(byToken.get('science37'), 'Science 37', 'written with a space, which the prose check needs');
});

test('the retired PhonePe Greenhouse board stays out of the source list', () => {
  const tokens = new Set(JOB_SOURCES.map((source) => `${source.ats_name}/${source.board_token}`));
  assert.equal(tokens.has('greenhouse/phonepe'), false);
});

test('Phase 2 configures exactly 49 verified Workable employers with canonical careers URLs', () => {
  const sources = JOB_SOURCES.filter((candidate) => candidate.ats_name === 'workable');
  assert.equal(sources.length, 49);
  assert.ok(sources.some((source) => source.board_token === 'suade'));
  for (const source of sources) {
    assert.equal(source.career_url, `https://apply.workable.com/${source.board_token}/`);
  }
});

test('Phase 2 keeps the verified employer catalog diverse across all seven pollable ATS families', () => {
  // 393 current sources, three seed sources, 48 new-family sources, and 25 high-yield Greenhouse sources.
  assert.equal(JOB_SOURCES.length, 469, 'the reviewed catalog must not silently shrink or grow');
  const families = new Set(JOB_SOURCES.map((source) => source.ats_name));
  assert.deepEqual(
    [...families].sort(),
    ['ashby', 'breezy', 'greenhouse', 'lever', 'recruitee', 'rippling', 'workable'],
  );
  /* A REVIEW TRIPWIRE, NOT A CAPACITY LIMIT, and the comment that used to be here was wrong.
   *
   * It claimed that past 400 "the poller leaves the tail of the catalog unpolled". It does not.
   * The follow-up segment already exists and is already tested: the poll selects only sources not
   * yet seen in this drain (drainEligible, oldest-first, limit POLL_SOURCE_LIMIT), reports
   * polling_complete: false while any remain, and .github/workflows/job-monitor.yml re-calls the
   * endpoint up to five times with the same drain_started_at. The real ceiling is five passes of
   * 400, and the test named "source 401 completes on the second pass of the same drain run"
   * covers exactly this.
   *
   * CROSSED DELIBERATELY on 2026-08-29: the autonomous-family probe round is the "source 401"
   * this comment always said would come. The daily cron now needs two passes to finish rather than
   * one, which changes its runtime and log shape - worth noticing here rather than on a slow
   * morning. The tripwire moves to the real ceiling (five passes of POLL_SEGMENT_SIZE) so the NEXT
   * deliberate crossing is the one that needs a look, not this one re-flagging itself forever. */
  assert.equal(POLL_SEGMENT_SIZE, 400, 'one segment; the drain carries whatever does not fit');
  assert.ok(
    JOB_SOURCES.length > POLL_SEGMENT_SIZE,
    'this assertion is itself the record of when the catalog first crossed one segment',
  );
  assert.ok(
    JOB_SOURCES.length <= POLL_SEGMENT_SIZE * 5,
    'the real ceiling: five drain passes of one segment each, per .github/workflows/job-monitor.yml',
  );
});

test('no two sources claim the same board, and none is blank', () => {
  // A duplicate token means one company is polled twice and counted twice on the board.
  const seen = new Set<string>();
  for (const source of JOB_SOURCES) {
    const key = `${source.ats_name}/${source.board_token}`;
    assert.equal(seen.has(key), false, `duplicate source ${key}`);
    seen.add(key);
    assert.ok(source.company_name.trim().length > 0, `${key} has no company name`);
    assert.ok(source.board_token.trim().length > 0, `${source.company_name} has no board token`);
  }
});

test('the reviewed catalog meets the configured employer-industry coverage threshold', () => {
  const classified = JOB_SOURCES.filter(
    (source) => classifyEmployerIndustry(source.company_name) !== 'unclassified',
  );
  assert.ok(
    classified.length / JOB_SOURCES.length >= MINIMUM_INDUSTRY_CLASSIFICATION_COVERAGE,
    'a source addition or rename must update the reviewed industry taxonomy',
  );
});
