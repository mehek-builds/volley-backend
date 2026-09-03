import assert from 'node:assert/strict';
import test from 'node:test';
import {
  judgeSourceIdentity,
  livenessCeilings,
  type SourceVerdict,
  type VerifiedSource,
} from './sourceIdentityVerdict';

/**
 * THE POINT OF THE SPLIT, PINNED.
 *
 * These tests exist so the exit code cannot drift back to "whatever the internet did today". The
 * shapes below are real runs of `source-identity` on main, taken from the job logs, and the rule
 * is asserted against them: the run that mattered has to be red, and the runs that were red for
 * nothing have to be green.
 */

let serial = 0;
function rows(verdict: SourceVerdict, count: number, detail = 'detail'): VerifiedSource[] {
  return Array.from({ length: count }, () => {
    serial += 1;
    return {
      company_name: `Company ${serial}`,
      ats_name: 'greenhouse',
      board_token: `token${serial}`,
      verdict,
      detail,
    };
  });
}

/** main at 9c7aee2, CI run 33791515908, the run this change was written against. */
function mainAt9c7aee2(): VerifiedSource[] {
  return [
    ...rows('named-ok', 894),
    ...rows('prose-ok', 140),
    ...rows('cannot-tell', 2),
    ...rows('empty', 11),
    ...rows('dead', 1),
  ];
}

test('the run that was red for nothing is green', () => {
  /* 894 named-ok, 140 prose-ok, 0 named-mismatch, 2 cannot-tell, 11 empty, 1 dead. Not one source
     is misattributed. It exited 1 anyway, because greenhouse/solarisbank had started returning 404
     four hours earlier, and it stayed red until somebody merged a retirement. */
  const results = mainAt9c7aee2();
  const judgement = judgeSourceIdentity(results, results.length, new Set());
  assert.equal(judgement.exitCode, 0);
  assert.deepEqual(judgement.failures, []);
});

test('one mislabelled source is red, on its own, with nothing else wrong', () => {
  /* The whole reason the check is required. `sas` was Superior Alarm Systems for weeks. */
  const results = [
    ...rows('named-ok', 1047),
    {
      company_name: 'SAS',
      ats_name: 'greenhouse',
      board_token: 'sas',
      verdict: 'named-mismatch' as const,
      detail: 'Superior Alarm Systems',
    },
  ];
  const judgement = judgeSourceIdentity(results, results.length, new Set());
  assert.equal(judgement.exitCode, 1);
  assert.equal(judgement.failures.length, 1);
  assert.match(judgement.failures[0], /Superior Alarm Systems/);
  assert.match(judgement.report[0], /^IDENTITY: FAIL\. 1 of 1048 sources is mislabelled\./);
});

test('a mislabelled source is still red when the boards are also having a bad day', () => {
  /* The failure mode being designed out is a real alarm going unread inside a noisy one, so the
     noisy one must not be able to suppress it either. */
  const results = [...mainAt9c7aee2(), ...rows('named-mismatch', 1, 'Bohen Consulting Group')];
  const judgement = judgeSourceIdentity(results, results.length, new Set());
  assert.equal(judgement.exitCode, 1);
  assert.ok(judgement.failures.some((line) => line.includes('Bohen Consulting Group')));
});

test('the summary leads with the correctness verdict, not the weather', () => {
  const results = mainAt9c7aee2();
  const judgement = judgeSourceIdentity(results, results.length, new Set());
  assert.match(judgement.report[0], /^IDENTITY: PASS\. 0 of 1048 sources are mislabelled\./);
  assert.ok(
    judgement.report.findIndex((line) => line.startsWith('LIVENESS:')) > 0,
    'liveness reports below the verdict, never above it',
  );
});

test('the 2026-09-01 mass-empty run is red, where it used to be green', () => {
  /* 06:29 to 09:35 UTC on 2026-09-01, seven consecutive runs on main: 204 of 1048 boards empty,
     196 of them Greenhouse, Airbnb and Asana and AQR among them. Airbnb does not have zero open
     roles. `source-identity` reported SUCCESS on every one of those seven runs. */
  const results = [...rows('named-ok', 704), ...rows('prose-ok', 138), ...rows('cannot-tell', 2), ...rows('empty', 204)];
  const judgement = judgeSourceIdentity(results, results.length, new Set());
  assert.equal(judgement.exitCode, 1);
  assert.equal(judgement.mislabelled.length, 0, 'not a correctness failure');
  assert.ok(
    judgement.failures.some((line) => line.startsWith('NOT A RESULT:') && line.includes('empty')),
    'it fails as a non-result, because the measurement broke, not the boards',
  );
});

test('the stable empty set sits far enough under the ceiling to stay quiet', () => {
  /* 11 of 1048, the same 11 boards in every run sampled between 2026-09-01 10:41 and 2026-09-03
     18:36. If that baseline ever sat close to its ceiling, the ceiling would be the wrong number. */
  const ceilings = livenessCeilings(1048);
  assert.ok(ceilings.empty >= 11 * 4, `11 empty needs real headroom under ${ceilings.empty}`);
  assert.ok(ceilings.empty < 204, 'and the 204-board event must still be over it');
});

test('a board that dies on its own is reported, not fatal', () => {
  const results = [...rows('named-ok', 1047), ...rows('dead', 1, 'HTTP 404')];
  const judgement = judgeSourceIdentity(results, results.length, new Set());
  assert.equal(judgement.exitCode, 0);
  assert.ok(
    judgement.annotations.some((line) => line.startsWith('::warning title=Board no longer resolves::')),
    'it still has to be visible on the pull request',
  );
});

test('a board this change ADDED and that does not resolve is ours, and fatal', () => {
  /* A token nobody has ever polled that answers 404 is a typo in a hand-written string. That is
     the same class of bug as a mislabelling, and the only reason `dead` could stop being fatal. */
  const dead: VerifiedSource = {
    company_name: 'Typo Co',
    ats_name: 'greenhouse',
    board_token: 'tpyoco',
    verdict: 'dead',
    detail: 'HTTP 404',
  };
  const results = [...rows('named-ok', 1047), dead];
  const added = new Set(['greenhouse/tpyoco']);
  const judgement = judgeSourceIdentity(results, results.length, added);
  assert.equal(judgement.exitCode, 1);
  assert.deepEqual(judgement.deadOnArrival.map((row) => row.board_token), ['tpyoco']);
  assert.ok(judgement.failures.some((line) => line.includes('added by this pull request')));
});

test('and the same dead board is not fatal once it is part of the catalog', () => {
  const dead: VerifiedSource = {
    company_name: 'Typo Co',
    ats_name: 'greenhouse',
    board_token: 'tpyoco',
    verdict: 'dead',
    detail: 'HTTP 404',
  };
  const judgement = judgeSourceIdentity([...rows('named-ok', 1047), dead], 1048, new Set(['greenhouse/somethingelse']));
  assert.equal(judgement.exitCode, 0);
  assert.deepEqual(judgement.deadOnArrival, []);
});

test('a dead-on-arrival source is reported once, as the error, not twice', () => {
  const dead: VerifiedSource = {
    company_name: 'Typo Co',
    ats_name: 'greenhouse',
    board_token: 'tpyoco',
    verdict: 'dead',
    detail: 'HTTP 404',
  };
  const judgement = judgeSourceIdentity([dead], 1, new Set(['greenhouse/tpyoco']));
  const mentions = judgement.annotations.filter((line) => line.includes('greenhouse/tpyoco'));
  assert.equal(mentions.length, 1);
  assert.ok(mentions[0].startsWith('::error '));
});

test('an unreadable base revision never manufactures a failure, and says so', () => {
  /* Passing null has to be the safe direction: a check that goes red because a git object was
     missing is the exact behaviour this change exists to delete. */
  const dead: VerifiedSource = {
    company_name: 'Typo Co',
    ats_name: 'greenhouse',
    board_token: 'tpyoco',
    verdict: 'dead',
    detail: 'HTTP 404',
  };
  const judgement = judgeSourceIdentity([...rows('named-ok', 1047), dead], 1048, null);
  assert.equal(judgement.exitCode, 0);
  assert.ok(judgement.report.some((line) => line.includes('Base revision unavailable')));
});

test('cannot-tell never decides the exit code', () => {
  /* It is a board somebody has to open, which is a task, not a regression. Two of them sat there
     for the life of the check and neither was a real problem: both were the name comparator
     dropping a two-letter company name. */
  const results = [...rows('named-ok', 1000), ...rows('cannot-tell', 48)];
  const judgement = judgeSourceIdentity(results, results.length, new Set());
  assert.equal(judgement.exitCode, 0);
  assert.equal(judgement.counts['cannot-tell'], 48, 'all 48 are counted');
  /* Annotated up to what GitHub will keep, with the shortfall named rather than dropped. The step
     summary and the log still carry all 48. */
  assert.ok(
    judgement.annotations.some((line) => line.startsWith('::warning title=Board identity unresolved::')),
  );
  assert.ok(judgement.annotations.some((line) => line.includes('39 further findings')));
});

test('every source unreachable is a non-result, as it always was', () => {
  const results = rows('unreachable', 1048, 'connect ETIMEDOUT');
  const judgement = judgeSourceIdentity(results, results.length, new Set());
  assert.equal(judgement.exitCode, 1);
  assert.ok(judgement.failures.some((line) => line.includes('unreachable')));
});

test('a short --only run cannot trip a ceiling on one flaky board', () => {
  /* `sources:verify -- --only stripe,notion` is two sources. A percentage alone would make one
     empty board 50% of the run. */
  const judgement = judgeSourceIdentity(rows('empty', 1), 2, new Set());
  assert.equal(judgement.exitCode, 0);
  const ceilings = livenessCeilings(2);
  assert.ok(ceilings.empty >= 25 && ceilings.dead >= 10 && ceilings.unreachable >= 5);
});

test('annotations stay on one line, or GitHub reads the rest as nothing', () => {
  /* A `::warning ...::` command ends at the newline, so a detail carrying one would truncate the
     message and drop everything after it. An unreachable board's detail is an error message
     straight off the wire, which is exactly where a newline comes from. */
  const results: VerifiedSource[] = [
    {
      company_name: 'Multiline Co',
      ats_name: 'lever',
      board_token: 'multi',
      verdict: 'unreachable',
      detail: 'first line\nsecond line\r\n  third',
    },
    {
      company_name: 'Wrong Co',
      ats_name: 'greenhouse',
      board_token: 'wrong',
      verdict: 'named-mismatch',
      detail: 'Somebody Else\nLimited',
    },
  ];
  const judgement = judgeSourceIdentity(results, 2, new Set());
  assert.equal(judgement.annotations.length, 2);
  for (const annotation of judgement.annotations) {
    assert.ok(!/[\r\n]/.test(annotation), `annotation must be one line: ${annotation}`);
  }
  const warning = judgement.annotations.find((line) => line.startsWith('::warning '));
  assert.ok(warning?.includes('first line second line third'), warning);
});

test('no annotation is dropped without the run saying how many', () => {
  /* GitHub keeps ten per level per step and discards the rest in silence. On this change's own
     first CI run eleven boards were empty, eleven warnings were written and ten came back:
     lever/trustly went missing. The eleventh slot now reports the shortfall instead. */
  const judgement = judgeSourceIdentity(rows('empty', 11), 1048, new Set());
  const warnings = judgement.annotations.filter((line) => line.startsWith('::warning '));
  assert.equal(warnings.length, 10, 'never more than GitHub will keep');
  assert.equal(
    warnings.filter((line) => line.includes('title=More not shown::')).length,
    1,
    'and the last one accounts for the rest',
  );
  assert.ok(warnings.at(-1)?.includes('2 further findings'));
});

test('a bucket that fits is annotated in full, with no roll-up line', () => {
  const judgement = judgeSourceIdentity(rows('empty', 10), 1048, new Set());
  const warnings = judgement.annotations.filter((line) => line.startsWith('::warning '));
  assert.equal(warnings.length, 10);
  assert.ok(!warnings.some((line) => line.includes('More not shown')));
});

test('errors and warnings get their own ten, because GitHub counts them separately', () => {
  const results = [...rows('named-mismatch', 12, 'Someone Else'), ...rows('empty', 12)];
  const judgement = judgeSourceIdentity(results, 1048, new Set());
  assert.equal(judgement.annotations.filter((line) => line.startsWith('::error ')).length, 10);
  assert.equal(judgement.annotations.filter((line) => line.startsWith('::warning ')).length, 10);
  assert.equal(judgement.exitCode, 1, 'and truncating the display never touches the verdict');
  assert.equal(judgement.failures.length, 12, 'every mislabelling is still reported in full');
});

test('the counts line still carries every bucket, so old runs stay comparable', () => {
  /* Three days of CI archaeology went through this line. Reformatting it would cost the next
     person the same evidence. */
  const results = mainAt9c7aee2();
  const judgement = judgeSourceIdentity(results, results.length, new Set());
  const counts = judgement.report.find((line) => /^\d+ sources: /.test(line));
  assert.ok(counts, 'the per-bucket counts line survives');
  assert.match(
    counts,
    /^1048 sources: 894 named-ok, 140 prose-ok, 0 cleared-by-hand, 0 named-mismatch, 2 cannot-tell, 11 empty, 0 unreachable, 1 dead\.$/,
  );
});

test('the step summary names the retirement path for a board that is gone', () => {
  /* A dead board that nobody retires is reported as news forever, which is how the EMPTY list
     stops being read. The summary has to say where the board goes. */
  const judgement = judgeSourceIdentity(rows('dead', 1, 'HTTP 404'), 1048, new Set());
  assert.match(judgement.stepSummary, /RETIRED_ENTRIES/);
  assert.match(judgement.stepSummary, /identity PASS/);
});
