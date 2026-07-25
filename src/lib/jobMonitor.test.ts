import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAshbyJobs,
  normalizeGreenhouseJobs,
  normalizeLeverJobs,
  sourceEndpoint,
} from './jobMonitor';

test('normalizes Greenhouse postings and strips HTML from descriptions', () => {
  const jobs = normalizeGreenhouseJobs({ jobs: [{
    id: 42,
    title: 'Software Engineer Intern',
    absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/42',
    location: { name: 'Remote, US' },
    departments: [{ name: 'Engineering' }],
    content: '<p>Build &amp; ship.</p><p>Learn quickly.</p>',
    updated_at: '2026-07-25T00:00:00Z',
  }] });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].description, 'Build & ship.\n\nLearn quickly.');
  assert.equal(jobs[0].remote, true);
  assert.equal(jobs[0].department, 'Engineering');
});

test('normalizes Lever postings with a distinct apply URL', () => {
  const jobs = normalizeLeverJobs([{ id: 'abc', text: 'Analyst', hostedUrl: 'https://jobs.lever.co/acme/abc', applyUrl: 'https://jobs.lever.co/acme/abc/apply', descriptionPlain: 'Analyze markets.', categories: { location: 'New York', team: 'Finance', commitment: 'Full-time' }, createdAt: 1_785_000_000_000 }]);
  assert.equal(jobs[0].apply_url, 'https://jobs.lever.co/acme/abc/apply');
  assert.equal(jobs[0].department, 'Finance');
  assert.equal(jobs[0].employment_type, 'Full-time');
});

test('normalizes Ashby postings and respects its remote flag', () => {
  const jobs = normalizeAshbyJobs({ jobs: [{ id: 'job-1', title: 'Product Intern', jobUrl: 'https://jobs.ashbyhq.com/acme/job-1', applyUrl: 'https://jobs.ashbyhq.com/acme/job-1/application', location: 'San Francisco', isRemote: true, descriptionPlain: 'Build products.' }] });
  assert.equal(jobs[0].remote, true);
  assert.equal(jobs[0].description, 'Build products.');
});

test('builds first-party ATS endpoints from board tokens', () => {
  assert.match(sourceEndpoint({ ats_name: 'greenhouse', board_token: 'acme' }), /boards-api\.greenhouse\.io/);
  assert.match(sourceEndpoint({ ats_name: 'lever', board_token: 'acme' }), /api\.lever\.co/);
  assert.match(sourceEndpoint({ ats_name: 'ashby', board_token: 'acme' }), /api\.ashbyhq\.com/);
});

test('rejects malformed successful payloads instead of interpreting them as an empty board', () => {
  assert.throws(() => normalizeGreenhouseJobs({ error: 'rate limited' }), /invalid jobs payload/);
  assert.throws(() => normalizeLeverJobs({ postings: [] }), /invalid jobs payload/);
  assert.throws(() => normalizeAshbyJobs({ results: [] }), /invalid jobs payload/);
});

test('accepts explicit empty job collections', () => {
  assert.deepEqual(normalizeGreenhouseJobs({ jobs: [] }), []);
  assert.deepEqual(normalizeLeverJobs([]), []);
  assert.deepEqual(normalizeAshbyJobs({ jobs: [] }), []);
});
