import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getTableColumns } from 'drizzle-orm';
import { autofillEventSchema } from './resume';
import { db } from '../db/index';
import { autofill_events } from '../db/schema';

// R-030 landing-zone coverage. The extension branch fix/r027-tags-r030-log ships
// r030_candidate_labels in AUTOFILL_EVENT so the register's "get a real label off a real board"
// step can actually happen; the backend's strip-mode schema and column-less table were silently
// dropping every sample. These tests pin both halves: the schema passes the field through (and
// still accepts events without it), and the insert the route builds really writes the column.
// No live DB in the test env, so storage is asserted on the SQL drizzle generates - the same
// query the route executes - per this repo's no-network test convention.

const UID = '00000000-0000-4000-8000-000000000001';

function event(over: Record<string, unknown> = {}) {
  return {
    ats_name: 'ashby',
    job_context: { company: 'Ramp', role: 'SWE Intern' },
    fields_filled: 6,
    fields_skipped: 2,
    auto_submitted: false,
    ...over,
  };
}

const LABELS = ['Do you have experience with GitHub Actions?', 'Which of these have you used: GitHub, GitLab, Bitbucket?'];

describe('autofill event schema (R-030 telemetry)', () => {
  test('accepts an event WITH candidate labels and passes them through intact', () => {
    const r = autofillEventSchema.safeParse(event({ r030_candidate_labels: LABELS }));
    assert.equal(r.success, true);
    assert.deepEqual(r.success && r.data.r030_candidate_labels, LABELS);
  });

  test('events WITHOUT the field still work - older extensions must not start 400ing', () => {
    const r = autofillEventSchema.safeParse(event());
    assert.equal(r.success, true);
    assert.equal(r.success && 'r030_candidate_labels' in r.data && r.data.r030_candidate_labels !== undefined, false);
  });

  test('an empty labels array is a valid "no candidates on this form"', () => {
    const r = autofillEventSchema.safeParse(event({ r030_candidate_labels: [] }));
    assert.equal(r.success, true);
  });

  test('bounds hold: max 50 labels of max 200 chars, strings only', () => {
    assert.equal(autofillEventSchema.safeParse(event({ r030_candidate_labels: Array(50).fill('x') })).success, true);
    assert.equal(autofillEventSchema.safeParse(event({ r030_candidate_labels: Array(51).fill('x') })).success, false);
    assert.equal(autofillEventSchema.safeParse(event({ r030_candidate_labels: ['y'.repeat(200)] })).success, true);
    assert.equal(autofillEventSchema.safeParse(event({ r030_candidate_labels: ['y'.repeat(201)] })).success, false);
    assert.equal(autofillEventSchema.safeParse(event({ r030_candidate_labels: [42] })).success, false);
    assert.equal(autofillEventSchema.safeParse(event({ r030_candidate_labels: 'GitHub' })).success, false);
  });
});

describe('autofill event storage (R-030 telemetry)', () => {
  test('the table declares the column, nullable, so db:push has something additive to apply', () => {
    const cols = getTableColumns(autofill_events);
    assert.ok('r030_candidate_labels' in cols, 'autofill_events must declare r030_candidate_labels');
    assert.equal(cols.r030_candidate_labels.notNull, false, 'must be nullable: old extensions omit it');
    assert.equal(cols.r030_candidate_labels.getSQLType(), 'jsonb');
  });

  test('the insert the route builds writes the labels', () => {
    // Exactly the route's statement: db.insert(autofill_events).values({ user_id, ...body }).
    const body = autofillEventSchema.parse(event({ r030_candidate_labels: LABELS }));
    const q = db.insert(autofill_events).values({ user_id: UID, ...body }).toSQL();
    assert.match(q.sql, /"r030_candidate_labels"/);
    assert.ok(
      q.params.some((p) => typeof p === 'string' && p.includes('GitHub Actions')),
      'the labels must ride the insert as a bound parameter',
    );
  });

  test('the insert still builds without the field - the column falls back to NULL', () => {
    const body = autofillEventSchema.parse(event());
    const q = db.insert(autofill_events).values({ user_id: UID, ...body }).toSQL();
    assert.doesNotMatch(q.sql, /r030_candidate_labels.*\$\d+.*r030/); // sanity: no stray binding
    assert.equal(q.params.some((p) => typeof p === 'string' && p.includes('GitHub')), false);
  });
});
