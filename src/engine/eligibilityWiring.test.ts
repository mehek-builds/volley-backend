import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decide, isBlocked } from './eligibility';

const read = (p: string) => readFileSync(path.join(__dirname, p), 'utf8');

/* These assert on SOURCE, and only where the property is structural rather than behavioural.
   Both wiring points sit inside route handlers that open database and browser sessions on their
   next lines, so "does the gate run before the spend" cannot be observed from a unit. What CAN be
   pinned is the ordering and the placement, which is exactly what was got wrong before: a gate
   that only covered submit while prepare ran first and independently. The verdict logic itself is
   tested behaviourally in eligibility.test.ts. */

describe('the board gate is applied where it has to be', () => {
  const board = read('../routes/jobMonitor.ts');

  test('it runs across the ranked list, not the cut page', () => {
    // Filtering an already-cut page returns short pages and a has_more that lies.
    const gateAt = board.indexOf('const gradDate = await studentGradDate');
    const pageAt = board.indexOf('const pageIds = eligibleIds.slice(offset');
    assert.ok(gateAt > 0 && pageAt > gateAt, 'the gate precedes the page cut');
  });

  test('the page, the count and has_more all come from the surviving list', () => {
    /* Cutting the page from eligibleIds while reporting ranking.ids.length would tell the client
       there are more pages made entirely of hidden rows, and it would page into emptiness. */
    assert.match(board, /const pageIds = eligibleIds\.slice\(offset, offset \+ limit\)/);
    assert.match(board, /has_more: eligibleIds\.length > offset \+ limit/);
    assert.match(board, /ranked_pool: eligibleIds\.length/);
  });

  test('it is not baked into the shared ranking cache', () => {
    // readRankingShared is keyed by filters and shared between accounts; eligibility is per student.
    const writeAt = board.indexOf('writeRankingShared(cacheKey');
    assert.ok(board.indexOf('studentGradDate(request.jwtPayload') > writeAt, 'gate is after the shared write');
  });

  test('what it hid is logged and returned, because nothing says so on screen', () => {
    assert.match(board, /graduation gate hid postings/);
    assert.match(board, /eligibility_hidden: hiddenByGraduation/);
  });
});

describe('the autopilot block runs before anything is spent', () => {
  const runner = read('../routes/submissionRunner.ts');

  test('it precedes the controlled-browser path and the account-walled stop', () => {
    /* prepareControlled opens a browser; the account-walled branch is the existing example of a
       stop that had to move above it for the same reason. A graduation block below either would
       bill calls for an application it then refuses to send. */
    const gateAt = runner.indexOf("'autopilot blocked: graduation'");
    assert.ok(gateAt > 0, 'the block exists');
    assert.ok(gateAt < runner.indexOf('await prepareControlled('), 'above the controlled browser');
    assert.ok(gateAt < runner.indexOf('isAccountWalledFamily(portal)'), 'above the walled-portal stop');
  });

  test('it applies only to the unattended path', () => {
    // A student who clicked Prepare chose this role; arithmetic over a title does not overrule her.
    const gateAt = runner.indexOf("'autopilot blocked: graduation'");
    const guardAt = runner.lastIndexOf('if (unattended) {', gateAt);
    assert.ok(guardAt > 0 && guardAt < gateAt, 'the block is inside an unattended guard');
  });

  test('the student is told why, in terms of the role and not of an error', () => {
    assert.match(runner, /Autopilot does not apply to roles you are not eligible for/);
  });
});

describe('the two gates agree, because they are the same function', () => {
  test('the case the board hides is the case autopilot refuses', () => {
    const role = { title: 'Software Engineer Intern, Summer 2027', employment_type: 'Internship' };
    assert.ok(isBlocked(decide(role, 'May 2026')), 'blocked in both');
    assert.ok(!isBlocked(decide(role, 'May 2028')), 'allowed in both');
  });

  test('an unreadable record blocks nothing, on either path', () => {
    // The default the whole design leans on: silence is not a reason to hide a role.
    assert.ok(!isBlocked(decide({ title: '' }, null)));
    assert.ok(!isBlocked(decide({ title: 'Software Engineer Intern' }, 'May 2020')));
  });
});
