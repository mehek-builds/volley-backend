/* THE REPAIR ROUTE IS THE ONLY WAY packetJdRepair CAN RUN, and these pin the properties that make
   that safe. The module itself is exhaustively tested in lib/packetJdRepair.test.ts; nothing here
   re-tests the decision. What is pinned here is the wiring: that it is per-row and owner scoped,
   that it does not write unless asked, and that it cannot grow a way around the module's refusals.

   THE REFUSAL THAT MATTERS, measured while this was written. Jane Street packet 496cff97 has
   submitted_at null but submission_attempted_at set, a security_code on the row, and an
   attention_reason reading "Litos entered the employer verification step, but could not prove the
   final result." An employer may hold that application. Its frozen description IS wrong - it is a
   consent banner and an application form - and it must still not be rewritten, because that
   description is the record of what was sent. The module refuses it; this route must never acquire
   an override. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';

const applications = readFileSync('src/routes/applications.ts', 'utf8');
const index = readFileSync('src/index.ts', 'utf8');

function jdRepairRoute(): string {
  const from = applications.indexOf("'/applications/:id/jd-repair'");
  const to = applications.indexOf("'/applications/:id/packet-audit'", from);
  assert.ok(from >= 0 && to > from, 'the jd-repair route slice was not found');
  return applications.slice(from, to);
}

describe('the jd-repair route', () => {
  test('is mounted, and reached through applicationRoutes like every other per-packet action', () => {
    assert.match(applications, /'\/applications\/:id\/jd-repair'/);
    assert.match(index, /applicationRoutes/);
  });

  test('is owner scoped and rate limited, like the other write routes on this file', () => {
    const route = jdRepairRoute();
    assert.match(route, /ownedResume\(request, reply\)/);
    assert.match(route, /allowHourly\(request\.jwtPayload!\.userId, 'jdRepair'/);
  });

  /* PLAN-ONLY BY DEFAULT is the whole reason this is safe to deploy before anyone has watched a
     write-back land. `confirm` must be tested for the literal true, not for truthiness: a body of
     {confirm: "no"} or {confirm: 1} must not write. */
  test('performs no write without an explicit confirm', () => {
    const route = jdRepairRoute();
    assert.match(route, /\.confirm === true/);
    const confirmCheck = route.indexOf('confirm');
    const write = route.indexOf('repairPacketJd(row)');
    assert.ok(confirmCheck >= 0 && write > confirmCheck, 'the confirm gate must precede the write');
    assert.match(route, /if \(!confirm\) return reply\.status\(200\)\.send\(\{ repaired: false, planned: true/);
  });

  test('plans before it writes, and never writes on a row the module declined to plan', () => {
    const route = jdRepairRoute();
    const plan = route.indexOf('planPacketJdRepair(row)');
    const write = route.indexOf('repairPacketJd(row)');
    assert.ok(plan >= 0 && write > plan, 'the plan must precede the write');
    const refusalReturn = route.indexOf('repaired: false, planned: false');
    assert.ok(refusalReturn > plan && refusalReturn < write, 'the no-plan refusal must return between the plan and the write');
  });

  /* The module's refusals are absolute. If any of these ever appear in this route, someone has
     built a way to repair a row an employer may hold, or to skip the corruption check. */
  test('carries no override for any of the module refusals', () => {
    const route = jdRepairRoute();
    for (const override of [
      'employerMayHoldApplication',
      'canonicalApplicationRecordsASubmission',
      'packetHasExtensionSubmissionOutcomeEvent',
      'packetJdStatesNoRequirement',
      'packetJdIsRepairable',
      'force',
    ]) {
      assert.doesNotMatch(
        route,
        new RegExp(override),
        `${override} must stay inside packetJdRepair, where it fails closed, and never be re-decided at the route`,
      );
    }
  });

  test('a lost CAS is surfaced rather than retried', () => {
    const route = jdRepairRoute();
    assert.match(route, /jd_repair_row_moved/);
    assert.doesNotMatch(route, /while \(|for \(|retry/i);
  });

  /* One shape for every refusal. "an employer may hold this" and "this row is fine" are different
     facts, and the route must not let a caller tell them apart by probing. */
  test('does not disclose which refusal fired', () => {
    const route = jdRepairRoute();
    /* Read the SEND, not the surrounding source: the comments here necessarily discuss the very
       facts the payload must not carry, and matching the whole slice tests the prose instead. */
    const sends = [...route.matchAll(/reply\.status\(\d+\)\.send\(([\s\S]*?)\);/g)].map((m) => m[1]);
    assert.ok(sends.length >= 3, 'expected the refusal, the preview and the write responses');
    const refusalSend = sends.find((body) => body.includes('planned: false'));
    assert.ok(refusalSend, 'the no-plan refusal response was not found');
    assert.doesNotMatch(refusalSend, /employer|submitted|attempted|security|reason|because/i);
    // And it must carry nothing beyond the two booleans.
    assert.match(refusalSend, /^\{ repaired: false, planned: false \}$/);
  });
});
