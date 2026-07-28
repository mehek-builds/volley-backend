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
  /* The second strip matches a tag-name allowlist, so prose survives as long as
   * the first token is not itself a tag name. Comparison operators are the
   * common real case and are safe because a space or digit follows the "<". */
  const jobs = normalizeGreenhouseJobs({ jobs: [{
    id: 11,
    title: 'Analyst',
    absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/11',
    content: '&lt;p&gt;Latency &amp;lt; 100ms, &amp;gt; 5 years. Ship &amp;lt;Karnataka, Delhi&amp;gt; too.&lt;/p&gt;',
  }] });
  assert.equal(jobs[0].description, 'Latency < 100ms, > 5 years. Ship <Karnataka, Delhi> too.');
});

test('the tag allowlist is a known trade: prose starting with a tag name is lost', () => {
  /* Documented, accepted, and unobserved across 22,084 postings. "<b and c>" is
   * genuinely indistinguishable from a bold tag carrying attributes, and the
   * allowlist resolves the ambiguity toward markup. Asserted so that if someone
   * later changes the resolution, they do it on purpose. */
  const jobs = normalizeGreenhouseJobs({ jobs: [{
    id: 12,
    title: 'Analyst',
    absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/12',
    content: '&lt;p&gt;Use it if a&amp;lt;b and c&amp;gt;d.&lt;/p&gt;',
  }] });
  assert.equal(jobs[0].description, 'Use it if a d.');
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

test('keeps prose in brackets but strips markup that is double-escaped', () => {
  /* Both arrive as `&amp;lt;...&amp;gt;` and are only told apart by whether the
   * first token is an HTML tag name. Twilio really ships the first one. */
  const jobs = normalizeGreenhouseJobs({ jobs: [{
    id: 21,
    title: 'Applications Engineer 2',
    absolute_url: 'https://job-boards.greenhouse.io/twilio/jobs/21',
    content: '&lt;p&gt;Based in India &amp;lt;Karnataka, Tamil Nadu, Telangana State&amp;gt;.&lt;/p&gt;&lt;p&gt;&amp;lt;div class="x"&amp;gt;Perks&amp;lt;/div&amp;gt;&lt;/p&gt;',
  }] });
  assert.match(jobs[0].description, /Based in India <Karnataka, Tamil Nadu, Telangana State>\./);
  assert.doesNotMatch(jobs[0].description, /<\/?div/);
  assert.match(jobs[0].description, /Perks/);
});

test('decodes entities however many layers of escaping they arrive under', () => {
  /* Greenhouse escapes the document, so a posting whose source text already
   * spelled the entity out arrives triple-escaped. Seven live postings do this
   * and two decodes left a visible "&amp;" in the description. */
  const jobs = normalizeGreenhouseJobs({ jobs: [{
    id: 24,
    title: 'Analyst',
    absolute_url: 'https://job-boards.greenhouse.io/gemini/jobs/24',
    content: '&lt;p&gt;Partner with FP&amp;amp;amp;A, Tax &amp;amp; Legal, payors&amp;amp;#39; teams.&lt;/p&gt;',
  }] });
  assert.equal(jobs[0].description, "Partner with FP&A, Tax & Legal, payors' teams.");
  assert.doesNotMatch(jobs[0].description, /&(amp|lt|gt|quot|#\d+);/i);
});

test('normalizes the two spellings of a non-breaking space to the same text', () => {
  const named = normalizeGreenhouseJobs({ jobs: [{
    id: 22, title: 'T', absolute_url: 'https://x/22',
    content: '&lt;p&gt;Who we are&nbsp;now&lt;/p&gt;',
  }] })[0].description;
  const numeric = normalizeGreenhouseJobs({ jobs: [{
    id: 23, title: 'T', absolute_url: 'https://x/23',
    content: '&lt;p&gt;Who we are&#160;now&lt;/p&gt;',
  }] })[0].description;
  assert.equal(named, numeric);
  assert.equal(named, 'Who we are now');
});

test('leaves a genuinely plain descriptionPlain untouched', () => {
  /* Lever and Ashby indent bullets in this field. Running the HTML cleaner over
   * it flattened that for no gain, so it now runs only when markup is present. */
  const plain = 'What you will do:\n  - Ship features\n  - Talk to users\n\nWhat we offer:\n  - Equity';
  const lever = normalizeLeverJobs([{
    id: 'p1', text: 'Engineer', hostedUrl: 'https://jobs.lever.co/acme/p1',
    applyUrl: 'https://jobs.lever.co/acme/p1/apply', descriptionPlain: plain, categories: {},
  }]);
  assert.equal(lever[0].description, plain);

  const ashby = normalizeAshbyJobs({ jobs: [{
    id: 'a1', title: 'Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/a1',
    applyUrl: 'https://jobs.ashbyhq.com/acme/a1/apply', descriptionPlain: plain,
  }] });
  assert.equal(ashby[0].description, plain);
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
