import assert from 'node:assert/strict';
import test from 'node:test';
import { and } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { normalizeTargeting } from '../lib/jobPreferences';
import { boardConditions } from './jobMonitor';

/* The widening the onboarding match screen depends on.
 *
 * That screen has to show a role every time: a student who has just picked one narrow field, one
 * stage and two titles can legitimately match zero live postings, and an empty match screen is the
 * one outcome the flow cannot survive, because it is the payoff every screen before it was spent
 * earning. So when the targeted query comes back empty the client asks again with the account's
 * PREFERENCES dropped.
 *
 * These cases pin the line between preference and constraint. Relaxing must reach the first and
 * must never reach the second, because a posting Litos cannot submit to, or one the applicant is
 * not eligible for, is not a worse match - it is the wrong answer. */

const dialect = new PgDialect();

/* The conditions present with no filters at all: active, source enabled, an autonomous portal
   family, and the freshness window. Everything a relaxed request must still carry. */
const BASELINE = boardConditions({});

const targeting = normalizeTargeting({
  locations: ['New York'],
  remote_only: true,
  role_types: ['internship'],
  titles: ['Software Engineer'],
  categories: ['software-engineering'],
});

function render(conditions: ReturnType<typeof boardConditions>) {
  return conditions.length ? dialect.sqlToQuery(and(...conditions)!).sql : '';
}

test('a targeted request adds preference predicates on top of the baseline', () => {
  const targeted = boardConditions({ targeting });
  assert.ok(
    targeted.length > BASELINE.length,
    'targeting contributed no predicates, so this suite would pass vacuously',
  );
});

test('relaxing drops every preference predicate and leaves exactly the baseline', () => {
  // `targeting: undefined` is how the route expresses a relaxed request.
  const relaxed = boardConditions({ targeting: undefined });
  assert.equal(relaxed.length, BASELINE.length);
  assert.equal(render(relaxed), render(BASELINE));
});

test('the four relaxed predicates are the stated preferences and nothing else', () => {
  const targetedSql = render(boardConditions({ targeting }));
  const relaxedSql = render(boardConditions({ targeting: undefined }));

  // Location goes.
  assert.match(targetedSql, /"monitored_jobs"\."location"/);
  assert.doesNotMatch(relaxedSql, /"monitored_jobs"\."location"/);

  /* Both title predicates go: the role-type pattern (`title ~* ...`) and the desired title terms
     (`title ilike ...`). Asserted on the COLUMN rather than on the word "intern", because the
     baseline freshness window mentions Internship on its own - internships get a longer window -
     so a match on that word would pass this case while proving nothing. */
  assert.match(targetedSql, /"monitored_jobs"\."title"/);
  assert.doesNotMatch(relaxedSql, /"monitored_jobs"\."title"/);

  // And the remote flag, which is only set here by the account's remote_only preference.
  assert.match(targetedSql, /"monitored_jobs"\."remote"/);
  assert.doesNotMatch(relaxedSql, /"monitored_jobs"\."remote"/);
});

test('relaxing never reaches the constraints, which is the whole point', () => {
  const relaxedSql = render(boardConditions({ targeting: undefined }));

  // A posting Litos cannot submit to must not be reachable by widening. AUTONOMOUS_PORTAL_FAMILIES
  // is the same set portalCanAutoSubmit allows, so this predicate is what keeps the match screen's
  // promise ("Litos can submit here") true on the fallback row as well as the targeted one.
  assert.match(relaxedSql, /ats_name/i, 'the portal-family constraint was dropped by relaxing');
  assert.match(relaxedSql, /is_active/i, 'the active constraint was dropped by relaxing');
  assert.match(relaxedSql, /posted_at/i, 'the freshness window was dropped by relaxing');
});

test('sponsor_only survives relaxing, because it is eligibility and not preference', () => {
  // The account's own declaration is OR-ed into this on GET /jobs and can never be turned off by
  // omitting a parameter. Widening the board must not become the way around it.
  const relaxedWithSponsor = render(boardConditions({ targeting: undefined, sponsorOnly: true }));
  const relaxedPlain = render(boardConditions({ targeting: undefined }));
  assert.notEqual(relaxedWithSponsor, relaxedPlain, 'sponsorOnly contributed nothing under relaxing');
  assert.ok(relaxedWithSponsor.length > relaxedPlain.length);
});

test('an explicit caller filter still applies while preferences are relaxed', () => {
  // employment_type, q, title, location and company are the caller's own filters, not the
  // account's saved preferences, so relaxing has no business removing them.
  const relaxed = boardConditions({ targeting: undefined, employmentType: 'Internship' });
  assert.equal(relaxed.length, BASELINE.length + 1);
  assert.match(render(relaxed), /employment_type/i);
});
