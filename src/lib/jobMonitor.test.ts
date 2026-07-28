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

test('strips tags from Greenhouse content that arrives HTML-escaped', () => {
  /* boards-api.greenhouse.io escapes the whole `content` document, so the tags
   * show up as &lt;p&gt; and text-level entities are double-escaped. Stripping
   * before decoding left literal <p>/<em> tags in the stored description. */
  const jobs = normalizeGreenhouseJobs({ jobs: [{
    id: 7,
    title: 'Associate Growth Marketing Manager',
    absolute_url: 'https://job-boards.greenhouse.io/datadog/jobs/7',
    location: { name: 'New York, USA' },
    content: '&lt;p&gt;Datadog is looking for a &lt;strong&gt;data-driven&lt;/strong&gt; marketer.&lt;/p&gt;&lt;p&gt;Research &amp;amp; development, &lt;em&gt;fast&lt;/em&gt;.&lt;/p&gt;',
    updated_at: '2026-07-25T00:00:00Z',
  }] });
  assert.equal(
    jobs[0].description,
    'Datadog is looking for a data-driven marketer.\n\nResearch & development, fast.',
  );
  assert.doesNotMatch(jobs[0].description, /<[a-z/]/i);
  assert.doesNotMatch(jobs[0].description, /&(amp|lt|gt|#\d+);/i);
});

test('decodes the double-escaped text entities Greenhouse actually sends', () => {
  /* Greenhouse escapes the whole document, so an `&` in the posting's prose
   * arrives as `&amp;amp;`. Measured 185-581 occurrences per board. */
  const jobs = normalizeGreenhouseJobs({ jobs: [{
    id: 9,
    title: 'Research Engineer',
    absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/9',
    content: '&lt;p&gt;Research &amp;amp; development, R&amp;amp;D.&lt;/p&gt;',
  }] });
  assert.equal(jobs[0].description, 'Research & development, R&D.');
});

test('keeps angle brackets that appear in prose rather than markup', () => {
  /* The tag strip runs only while the text is still known to be markup. A strip
   * after the final decode would eat "<b and c>", which is indistinguishable
   * from a bold tag with attributes. */
  const jobs = normalizeGreenhouseJobs({ jobs: [{
    id: 11,
    title: 'Analyst',
    absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/11',
    content: '&lt;p&gt;Use it if a&amp;lt;b and c&amp;gt;d. Latency &amp;lt; 100ms, &amp;gt; 5 years.&lt;/p&gt;',
  }] });
  assert.equal(jobs[0].description, 'Use it if a<b and c>d. Latency < 100ms, > 5 years.');
});

test('drops character references Postgres cannot store', () => {
  /* A NUL fails the whole 200-row upsert chunk with "invalid byte sequence for
   * encoding UTF8: 0x00", taking that board's poll down with it. */
  const jobs = normalizeGreenhouseJobs({ jobs: [{
    id: 13,
    title: 'Engineer',
    absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/13',
    content: '&lt;p&gt;Senior&#0;Engineer&#1;role&#x7f;here&lt;/p&gt;',
  }] });
  assert.equal(jobs[0].description, 'SeniorEngineerrolehere');
  assert.doesNotMatch(jobs[0].description, /[\u0000-\u001f\u007f-\u009f]/);
  assert.equal(Buffer.from(jobs[0].description, 'utf8').toString('utf8'), jobs[0].description);
});

test('drops lone surrogates that would not survive a UTF-8 roundtrip', () => {
  const jobs = normalizeGreenhouseJobs({ jobs: [{
    id: 14,
    title: 'Engineer',
    absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/14',
    content: '&lt;p&gt;a&#xD800;b&lt;/p&gt;',
  }] });
  assert.equal(jobs[0].description, 'ab');
  assert.equal(Buffer.from(jobs[0].description, 'utf8').toString('utf8'), jobs[0].description);
});

test('still decodes legitimate numeric and hex references', () => {
  const jobs = normalizeGreenhouseJobs({ jobs: [{
    id: 15,
    title: 'Engineer',
    absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/15',
    content: '&lt;p&gt;caf&#233; &#x2022; r&#233;sum&#233;&lt;/p&gt;',
  }] });
  assert.equal(jobs[0].description, 'caf\u00e9 \u2022 r\u00e9sum\u00e9');
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

test('strips markup that leaks into the providers\' descriptionPlain fields', () => {
  const ashby = normalizeAshbyJobs({ jobs: [{ id: 'job-2', title: 'TPM', jobUrl: 'https://jobs.ashbyhq.com/cursor/job-2', applyUrl: 'https://jobs.ashbyhq.com/cursor/job-2/application', location: 'SF', descriptionPlain: '<aside>Note</aside>Build infrastructure.' }] });
  assert.equal(ashby[0].description, 'Note Build infrastructure.');

  const lever = normalizeLeverJobs([{ id: 'x', text: 'Analyst', hostedUrl: 'https://jobs.lever.co/acme/x', applyUrl: 'https://jobs.lever.co/acme/x/apply', descriptionPlain: '<p>Analyze &amp; report.</p>', categories: {} }]);
  assert.equal(lever[0].description, 'Analyze & report.');
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
