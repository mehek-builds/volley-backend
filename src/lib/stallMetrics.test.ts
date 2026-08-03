import assert from 'node:assert/strict';
import test from 'node:test';
import { nudgeableStalls, secondsToResolve, stallRate, summarizeStalls, type StallRecord } from './stallMetrics';
import { nudgeHtml, nudgeSubject, safeLink } from './stallNudge';

function stall(patch: Partial<StallRecord> = {}): StallRecord {
  return {
    kind: 'human_verification',
    stalled_at: '2026-08-04T09:00:00.000Z',
    surface: 'server_run',
    provider: 'recaptcha_v2',
    stage: 'at_submit',
    source: 'observed',
    ...patch,
  };
}

// ---- time to resolve ----

test('a resolved stall reports how long the applicant took', () => {
  assert.equal(secondsToResolve(stall({ resolved_at: '2026-08-04T09:00:45.000Z' })), 45);
});

test('an open stall has no duration yet', () => {
  assert.equal(secondsToResolve(stall()), null);
});

// One bad row must not distort the answer the metric exists to give.
test('clocks that disagree are dropped rather than counted as negative', () => {
  assert.equal(secondsToResolve(stall({ resolved_at: '2026-08-04T08:00:00.000Z' })), null);
  assert.equal(secondsToResolve(stall({ resolved_at: 'not a date' })), null);
});

// ---- the summary ----

test('an empty period reports nothing rather than a misleading zero', () => {
  const summary = summarizeStalls([]);
  assert.equal(summary.stalled, 0);
  assert.equal(summary.medianSecondsToResolve, null);
});

test('open and resolved are counted apart, since only one of them is a cost', () => {
  const summary = summarizeStalls([
    { stall: stall({ resolved_at: '2026-08-04T09:00:30.000Z' }) },
    { stall: stall() },
    { stall: stall() },
  ]);
  assert.equal(summary.stalled, 3);
  assert.equal(summary.resolved, 1);
  assert.equal(summary.open, 2);
});

// Median, not mean: one application someone returned to a week later would drag an average into
// meaninglessness, and the useful question is what the ordinary case costs.
test('the typical wait is the median, so one forgotten application cannot set it', () => {
  const summary = summarizeStalls([
    { stall: stall({ resolved_at: '2026-08-04T09:00:10.000Z' }) },
    { stall: stall({ resolved_at: '2026-08-04T09:00:20.000Z' }) },
    { stall: stall({ resolved_at: '2026-08-11T09:00:00.000Z' }) },
  ]);
  assert.equal(summary.medianSecondsToResolve, 20);
});

test('providers, boards and surfaces are broken out', () => {
  const summary = summarizeStalls([
    { atsName: 'greenhouse', stall: stall({ provider: 'recaptcha_v2', surface: 'server_run' }) },
    { atsName: 'greenhouse', stall: stall({ provider: 'hcaptcha', surface: 'extension' }) },
    { stall: stall({ provider: 'hcaptcha', surface: 'extension' }) },
  ]);
  assert.deepEqual(summary.byProvider, { recaptcha_v2: 1, hcaptcha: 2 });
  assert.deepEqual(summary.byAts, { greenhouse: 2, unknown: 1 });
  assert.deepEqual(summary.bySurface, { server_run: 1, extension: 2 });
});

/* An inferred provider is not evidence. Counted separately so the metric cannot confirm its own
 * assumption about which portal families use which vendor. */
test('observed and assumed providers are counted apart', () => {
  const summary = summarizeStalls([
    { stall: stall({ source: 'observed' }) },
    { stall: stall({ source: 'assumed' }) },
    { stall: stall({ source: 'assumed' }) },
  ]);
  assert.equal(summary.observedProviders, 1);
  assert.equal(summary.assumedProviders, 2);
});

// ---- the rate ----

/* "8% of six" and "8% of six hundred" are different facts, and a bare percentage hides which one it
 * is - which invites a decision the data cannot support. */
test('the rate always carries its denominator', () => {
  assert.deepEqual(stallRate(2, 25), { rate: 2 / 25, of: 25 });
  assert.deepEqual(stallRate(0, 0), { rate: null, of: 0 });
});

// ---- the nudge selection ----

const NOW = Date.parse('2026-08-04T21:00:00.000Z');
const TWELVE_HOURS = 12 * 60 * 60 * 1000;

test('an application that has waited long enough is nudgeable', () => {
  const rows = [{ stall: stall({ stalled_at: '2026-08-04T06:00:00.000Z' }) }];
  assert.equal(nudgeableStalls(rows, NOW, TWELVE_HOURS).length, 1);
});

// A nudge that arrives while someone is still looking at the page teaches them to ignore the next.
test('an application that stalled minutes ago is left alone', () => {
  const rows = [{ stall: stall({ stalled_at: '2026-08-04T20:45:00.000Z' }) }];
  assert.equal(nudgeableStalls(rows, NOW, TWELVE_HOURS).length, 0);
});

test('a resolved stall is never nudged, however old it is', () => {
  const rows = [{ stall: stall({ stalled_at: '2026-08-01T06:00:00.000Z', resolved_at: '2026-08-01T06:01:00.000Z' }) }];
  assert.equal(nudgeableStalls(rows, NOW, TWELVE_HOURS).length, 0);
});

test('an unreadable timestamp is skipped rather than nudged forever', () => {
  assert.equal(nudgeableStalls([{ stall: stall({ stalled_at: 'not a date' }) }], NOW, TWELVE_HOURS).length, 0);
});

/* The rule that keeps this a nudge rather than a daily letter. A stall stays open until the
 * applicant acts, so without it every open stall re-qualifies on every run and someone who saw the
 * check and decided not to finish that application hears about it again every day. Declining is an
 * answer. */
test('an application that has already been nudged is never nudged again', () => {
  const rows = [{ stall: stall({ stalled_at: '2026-08-01T06:00:00.000Z', nudged_at: '2026-08-01T18:00:00.000Z' }) }];
  assert.equal(nudgeableStalls(rows, NOW, TWELVE_HOURS).length, 0);
});

// ---- the email ----

const APP = { company: 'Acme', role: 'Analyst', portalUrl: 'https://boards.greenhouse.io/acme/jobs/1', stall: stall() };

test('a single nudge names the company in the subject', () => {
  assert.match(nudgeSubject([APP]), /Acme/);
});

test('several applications are counted rather than listed in the subject', () => {
  assert.match(nudgeSubject([APP, APP, APP]), /^3 applications/);
});

test('the body is HTML with semantic tags, per the standing rule', () => {
  const html = nudgeHtml([APP]);
  assert.match(html, /^<p>Hi,<\/p>/);
  assert.match(html, /<ul><li>/);
  assert.match(html, /<a href="https:\/\/boards\.greenhouse\.io\/acme\/jobs\/1">Analyst at Acme<\/a>/);
});

// The signature used to accept a name and every caller passed undefined, which reads as
// personalised mail that silently never was.
test('the greeting is plain rather than pretending to be personalised', () => {
  assert.match(nudgeHtml([APP]), /^<p>Hi,<\/p>/);
});

// The email says what is actually left, the same distinction every other surface draws.
test('the two stages get different sentences', () => {
  assert.match(nudgeHtml([APP]), /Everything else is filled in/);
  assert.match(nudgeHtml([{ ...APP, stall: stall({ stage: 'before_fill' }) }]), /Nothing is filled in yet/);
});

/* This lands in an email client rather than a page we control, and the recipient is being invited
 * to click it. */
test('only an https url becomes a link', () => {
  assert.equal(safeLink('javascript:alert(1)'), undefined);
  assert.equal(safeLink('http://boards.greenhouse.io/acme/jobs/1'), undefined);
  assert.equal(safeLink('not a url'), undefined);
  assert.equal(safeLink('https://boards.greenhouse.io/acme/jobs/1'), 'https://boards.greenhouse.io/acme/jobs/1');
});

test('an application with an unsafe url still appears, just not as a link', () => {
  const html = nudgeHtml([{ ...APP, portalUrl: 'javascript:alert(1)' }]);
  assert.match(html, /<li>Analyst at Acme/);
  assert.doesNotMatch(html, /<a href/);
});

test('company and role are escaped, since both come from employer data', () => {
  const html = nudgeHtml([{ ...APP, company: 'Acme <script>alert(1)</script>', portalUrl: undefined }]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

// Litos never claims it could have passed the check.
test('the body never offers to solve the check', () => {
  const html = nudgeHtml([APP]);
  assert.match(html, /Litos cannot pass that check for you/);
});
