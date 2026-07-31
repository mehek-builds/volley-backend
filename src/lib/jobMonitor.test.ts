import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasUsableDescription,
  isIngestablePosting,
  isSelfDeclaredTestPosting,
  MIN_DESCRIPTION_CHARS,
  normalizeAshbyJobs,
  normalizeGreenhouseJobs,
  normalizeLeverJobs,
  normalizeWorkableJobs,
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

test('normalizes Workable postings from the public account feed', () => {
  const jobs = normalizeWorkableJobs({
    name: 'Suade',
    jobs: [{
      title: 'Business Development Representative',
      shortcode: '57B10F8875',
      employment_type: 'Full-time',
      telecommuting: false,
      department: 'Sales',
      url: 'https://apply.workable.com/j/57B10F8875',
      application_url: 'https://apply.workable.com/j/57B10F8875/apply',
      published_on: '2026-07-24',
      created_at: '2026-07-23',
      country: 'United Kingdom',
      city: 'London',
      state: 'England',
      locations: [{ country: 'United Kingdom', countryCode: 'GB', city: 'London', region: 'England' }],
      description: '<p>Build relationships &amp; create opportunities.</p><p>Work with the sales team.</p>',
    }],
  });

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].external_id, '57B10F8875');
  assert.equal(jobs[0].posting_url, 'https://apply.workable.com/j/57B10F8875');
  assert.equal(jobs[0].apply_url, 'https://apply.workable.com/j/57B10F8875/apply');
  assert.equal(jobs[0].location, 'London, England, United Kingdom');
  assert.equal(jobs[0].portal_country, 'United Kingdom');
  assert.equal(jobs[0].portal_company_name, 'Suade');
  assert.equal(jobs[0].department, 'Sales');
  assert.equal(jobs[0].employment_type, 'Full-time');
  assert.equal(jobs[0].description, 'Build relationships & create opportunities.\n\nWork with the sales team.');
  assert.equal(jobs[0].posted_at?.toISOString(), '2026-07-24T00:00:00.000Z');
});

test('Workable preserves multiple countries and its explicit remote flag', () => {
  const jobs = normalizeWorkableJobs({
    name: 'Acme',
    jobs: [{
      title: 'Remote Product Manager',
      shortcode: 'ABC123',
      telecommuting: true,
      function: 'Product',
      shortlink: 'https://apply.workable.com/j/ABC123',
      locations: [
        { country: 'United States', city: 'New York', region: 'New York' },
        { country: 'Canada', city: 'Toronto', region: 'Ontario' },
      ],
      description: '<p>Own product strategy and delivery across a global team.</p>',
    }],
  });

  assert.equal(jobs[0].remote, true);
  assert.equal(jobs[0].department, 'Product');
  assert.equal(jobs[0].location, 'New York, New York, United States | Toronto, Ontario, Canada');
  assert.equal(jobs[0].portal_country, 'United States | Canada');
  assert.equal(jobs[0].apply_url, 'https://apply.workable.com/j/ABC123');
});

test('strips markup that leaks into the providers\' descriptionPlain fields', () => {
  const ashby = normalizeAshbyJobs({ jobs: [{ id: 'job-2', title: 'TPM', jobUrl: 'https://jobs.ashbyhq.com/cursor/job-2', applyUrl: 'https://jobs.ashbyhq.com/cursor/job-2/application', location: 'SF', descriptionPlain: '<aside>Note</aside>Build infrastructure.' }] });
  assert.equal(ashby[0].description, 'Note Build infrastructure.');

  const lever = normalizeLeverJobs([{ id: 'x', text: 'Analyst', hostedUrl: 'https://jobs.lever.co/acme/x', applyUrl: 'https://jobs.lever.co/acme/x/apply', descriptionPlain: '<p>Analyze &amp; report.</p>', categories: {} }]);
  assert.equal(lever[0].description, 'Analyze & report.');
});

/* The description-quality rule. Every posting quoted below is one that was live on the board when
   this was written, fetched from the raw ATS API, so these are regression cases and not fixtures. */

const posting = (description: string, title = 'Software Engineer') => ({ description, title });

test('rejects the placeholder descriptions employers actually ship', () => {
  assert.equal(hasUsableDescription(posting('PLACEHOLDER', 'MASTER TEMPLATE')), false);
  assert.equal(hasUsableDescription(posting('afdsfasdfasdf', 'prospecting test')), false);
  assert.equal(hasUsableDescription(posting('(#LI-DNI)', 'Transferência BTG - PAN')), false);
  assert.equal(hasUsableDescription(posting('', 'Analyst')), false);
});

test('rejects a description that is only the job title echoed back', () => {
  /* 12 live Point72 postings. The damage is not cosmetic: jdMatch scores this text, so a title
     repeated back produces a confident and meaningless match, and resumePolicy/resumeRender pick
     bullets against it. */
  assert.equal(hasUsableDescription(posting('Software Engineer, Bpm', 'Software Engineer, Bpm')), false);
  assert.equal(hasUsableDescription(posting('Pnl Rec And Analysis Analyst', 'Pnl Rec And Analysis Analyst')), false);
  // Punctuation and case drift must not defeat it - the comparison folds to letters and digits.
  assert.equal(hasUsableDescription(posting('head of compliance hong kong', 'Head of Compliance, Hong Kong')), false);
});

test('rejects a title echo that drifts by a word, in either direction', () => {
  // Point72 adds a word...
  assert.equal(hasUsableDescription(posting(
    'Software Engineer, Investor and Fund Administration Technology',
    'Software Engineer, Investor and Fund Administration',
  )), false);
  // ...and Physical Intelligence drops one.
  assert.equal(hasUsableDescription(posting('Internships', 'Research Internships')), false);
});

test('the title-echo rule does not fire on a real posting that opens with its own title', () => {
  /* The false positive that a naive "description contains the title" rule would cause. Datadog,
     Databricks and Match Group all open their Japanese and Korean listings with the role name and
     then write 2,700-3,900 characters of real prose. The rule is bounded by what is LEFT OVER after
     the title, not by whether the title appears, so those survive. */
  const real = `Commercial Account Executive (AE)은 중소규모 시장에서 전략적으로 신규 고객을 유치하고 거래를 성사시켜 Datadog의 비즈니스 성장을 지원합니다. ${'영업 담당자는 잘 정의된 방법론을 따릅니다. '.repeat(40)}`;
  assert.equal(hasUsableDescription(posting(real, 'Commercial Account Executive')), true);
});

test('keeps a description written entirely in a non-Latin script', () => {
  /* The false positive that would have hit hardest, and it is not hypothetical: Riot Games ships
     Chinese-only descriptions, Match Group Korean, Databricks Japanese. The fold that makes the
     title comparison punctuation-proof keeps only a-z and 0-9, so text like this folds to the EMPTY
     string. Judging length or emptiness on the folded form would have deleted these in bulk, so
     both are judged on the raw text and the echo check is skipped when either side folds away. */
  const riot = '关于我们，我们以玩家体验为核心，专注于创新与高性能的技术开发。你将与多元化团队协作，面向全球玩家开发和优化新一代游戏服务。'.repeat(4);
  assert.equal(riot.replace(/[^a-z0-9]+/gi, ''), '', 'this description folds away entirely');
  assert.ok(riot.length > MIN_DESCRIPTION_CHARS);
  assert.equal(hasUsableDescription(posting(riot, 'Software Engineer, Services (Contract)')), true);
  // ...including against a SHORT title, where an empty fold would otherwise look like an exact echo.
  assert.equal(hasUsableDescription(posting(riot, 'PM')), true);
});

test('keeps a real description that merely carries a #LI-DNI tag in a corner', () => {
  /* The measurement that decided the marker rule's shape. 6 live postings contain "#LI-DNI" and 5
     of them are full, real descriptions (Cursor, Recursion x2, IMC Trading, btgpactual). Matching
     the marker as a SUBSTRING would have deleted five good jobs to remove one bad one, so it is
     only rejected when it is the entire description. */
  const cursor = `Our mission is to automate coding. The first step in our journey is to build the best tool for professional programmers, using a combination of inventive research, design, and engineering. Our organization is very flat, and our team is small and talent dense. We particularly like people who are truth-seeking, passionate, and creative. #LI-DNI`;
  assert.ok(cursor.length > MIN_DESCRIPTION_CHARS);
  assert.equal(hasUsableDescription(posting(cursor, 'Software Engineer, Generalist')), true);
});

test('keeps the shortest descriptions that are genuinely real', () => {
  /* The floor is measured, not guessed. Across all 253 boards (22,119 postings) the junk cluster
     ends at 62 characters and the shortest real description is 353 - Latch's evergreen "I don't see
     the right role" - with nothing at all between 177 and 353. These two pin the margin, so a
     future change that raises the floor toward real data fails here instead of in production. */
  const latch = `About Us\n\nThe convergence of laboratory automation, high-throughput assays, and machine learning is moving the medium of biological discovery to silicon. At LatchBio, our mission is to foster this revolution by creating a first-in-class platform that enables biologists to leverage the explosion of data that increases by orders of magnitude every year.`;
  assert.equal(latch.length, 353);
  assert.equal(hasUsableDescription(posting(latch, 'I don’t see the right role')), true);
  assert.ok(MIN_DESCRIPTION_CHARS < 353, 'the floor must stay clear of the shortest real posting');
});

test('rejects prose that is real but far too short to evaluate a job from', () => {
  const twoSentences = 'We are hiring an engineer. You will write code.';
  assert.ok(twoSentences.length < MIN_DESCRIPTION_CHARS);
  assert.equal(hasUsableDescription(posting(twoSentences)), false);
});

test('the normalizers still return junk postings, because the poller needs the raw count', () => {
  /* Placement, asserted. Disney's board is 2 postings and BOTH are placeholders, so a filter inside
     the normalizers would make its fetch return zero, trip shouldKeepPostingsOnEmptyFetch, and pin
     those exact two rows on the board forever - the fix would be a no-op for the worst case it was
     written for. The normalizers stay honest about what the API said; pollSource applies the rule
     after that guard, next to the freshness filter. */
  const disney = normalizeGreenhouseJobs({ jobs: [
    { id: 7667872002, title: 'MASTER TEMPLATE', absolute_url: 'https://x/1', content: '&lt;p&gt;PLACEHOLDER&lt;/p&gt;' },
    { id: 4460067002, title: 'prospecting test', absolute_url: 'https://x/2', content: '&lt;p&gt;afdsfasdfasdf&lt;/p&gt;' },
  ] });
  assert.equal(disney.length, 2, 'the raw fetch count must survive normalization');
  assert.equal(disney.filter(hasUsableDescription).length, 0, 'and none of them may reach the table');
});

/* BCG's four self-declared fake postings, quoted from the live Greenhouse board. */
const BCG_DISCLAIMER = 'This is a fake job. Do not apply unless you are a Greenhouse employee. This is for testing purposes only.';

test('rejects a posting that declares itself a fake', () => {
  assert.equal(isSelfDeclaredTestPosting({ description: `${BCG_DISCLAIMER} Test Description\n\nIf you do apply, your application will be deleted.` }), true);
});

test('rejects a fake posting even when it carries a full, convincing job description', () => {
  /* The two BCG postings that a length rule can never catch: 1,641 and 1,742 characters of real
     role prose with the disclaimer bolted on the front. This is why the fake-posting rule exists
     separately from hasUsableDescription rather than as another length or title heuristic. */
  const convincing = `${BCG_DISCLAIMER} Associate Customer Success Manager\n\nAbout the Role\n\nYou'll own a portfolio of accounts and be the primary relationship owner for a set of customers post-sale. Your job is to make sure they are successful, engaged, and renewing. ${'You will run onboarding, drive adoption, and coordinate across multiple teams. '.repeat(20)}`;
  assert.ok(convincing.length > 1_600, 'the fixture must be long enough to clear every length rule');
  assert.equal(hasUsableDescription({ description: convincing, title: 'Voice AI Test - CSM' }), true,
    'the description itself is perfectly readable, which is exactly the problem');
  assert.equal(isIngestablePosting({ description: convincing, title: 'Voice AI Test - CSM' }), false,
    'and it must still never reach the table');
});

test('keeps the 325 real postings whose anti-scam boilerplate mentions fake jobs', () => {
  /* The measurement that shaped this rule. "fake job" appears in 329 descriptions across the 253
     boards and only 4 are fake; the other 325 are Samsara warning candidates about recruitment
     scams. A substring match would have deleted 325 real jobs to remove 4, so every pattern must be
     a statement ABOUT the posting, never a mention of fakery in passing. */
  const samsara = `We are looking for an Account Executive to join our team. ${'You will own the full sales cycle and partner closely with customers. '.repeat(10)}\n\nFraudulent Employment Offers\n\nSamsara is aware of scams involving fake job interviews and offers. Please know we do not charge fees to applicants and all communications come from an @samsara.com address.`;
  assert.match(samsara, /fake job/i, 'the fixture really does contain the phrase');
  assert.equal(isSelfDeclaredTestPosting({ description: samsara }), false);
  assert.equal(isIngestablePosting({ description: samsara, title: 'Account Executive, Commercial' }), true);
});

test('keeps real postings that tell some applicants not to apply here', () => {
  /* The same trap from the other direction: 75 live postings use "do not apply" for routing. */
  const stripe = `Note: if you are an intern, new grad, staff, front-end, or full-stack applicant, please do not apply using this link and visit our jobs page for those specific postings. ${'You will build and operate payment APIs at scale. '.repeat(12)}`;
  const sofi = `Internal Employees\n\nIf you are a current employee, do not apply here - please navigate to our Internal Job Board in Greenhouse to apply. ${'You will partner with risk and product teams. '.repeat(12)}`;
  for (const description of [stripe, sofi]) {
    assert.equal(isSelfDeclaredTestPosting({ description }), false);
  }
});

test('keeps a real posting that tells SOME readers to disregard it', () => {
  /* Pins a rule deliberately NOT added. "disregard this posting" reads like a self-declaration but
     is usually conditional in real prose, which is the same shape as the "do not apply" routing
     trap, and it catches nothing live. A pattern that is true for only some readers does not
     belong in the set, so this asserts the omission rather than leaving it to be re-added. */
  const conditional = `If you have already applied to this team, please disregard this posting. ${'You will design and ship data pipelines end to end. '.repeat(12)}`;
  assert.equal(isSelfDeclaredTestPosting({ description: conditional }), false);
  assert.equal(isIngestablePosting({ description: conditional, title: 'Data Engineer' }), true);
});

test('keeps real test-engineering roles, which are the bulk of what "test" matches', () => {
  /* 199 postings carry "Test" in the title and essentially all are real hardware and software test
     roles at SpaceX, Rocket Lab and graphcore. The rule reads the description only, and even there
     it needs a self-declaration, so none of these are touched. */
  const spacex = `Test Engineer, Avionics (Starship)\n\nSpaceX was founded under the belief that a future where humanity is out exploring the stars is fundamentally more exciting than one where we are not. ${'You will develop and execute test campaigns for flight avionics hardware. '.repeat(12)}`;
  assert.equal(isSelfDeclaredTestPosting({ description: spacex }), false);
  assert.equal(isIngestablePosting({ description: spacex, title: 'Test Engineer, Avionics (Starship)' }), true);
  // Prose that merely discusses testing must not trip it either.
  assert.equal(isSelfDeclaredTestPosting({ description: `${spacex} All hardware is built for testing purposes across the fleet.` }), false);
});

test('the ingest gate is the single place both rules are enforced', () => {
  /* Guards the seam rather than the rules: pollSource applies exactly this one predicate, so a rule
     added to either half takes effect for the daily cron without another call site being edited. */
  const placeholder = { description: 'PLACEHOLDER', title: 'MASTER TEMPLATE' };
  const fake = { description: `${BCG_DISCLAIMER} ${'Real sounding prose about the role. '.repeat(12)}`, title: 'PM' };
  const real = { description: `${'We are hiring an engineer to build and ship product. '.repeat(12)}`, title: 'Software Engineer' };
  assert.equal(isIngestablePosting(placeholder), false, 'no usable description');
  assert.equal(isIngestablePosting(fake), false, 'declares itself fake');
  assert.equal(isIngestablePosting(real), true);
});

test('builds first-party ATS endpoints from board tokens', () => {
  assert.match(sourceEndpoint({ ats_name: 'greenhouse', board_token: 'acme' }), /boards-api\.greenhouse\.io/);
  assert.match(sourceEndpoint({ ats_name: 'lever', board_token: 'acme' }), /api\.lever\.co/);
  assert.match(sourceEndpoint({ ats_name: 'ashby', board_token: 'acme' }), /api\.ashbyhq\.com/);
  assert.equal(
    sourceEndpoint({ ats_name: 'workable', board_token: 'acme' }),
    'https://www.workable.com/api/accounts/acme?details=true',
  );
});

test('rejects malformed successful payloads instead of interpreting them as an empty board', () => {
  assert.throws(() => normalizeGreenhouseJobs({ error: 'rate limited' }), /invalid jobs payload/);
  assert.throws(() => normalizeLeverJobs({ postings: [] }), /invalid jobs payload/);
  assert.throws(() => normalizeAshbyJobs({ results: [] }), /invalid jobs payload/);
  assert.throws(() => normalizeWorkableJobs({ results: [] }), /invalid jobs payload/);
});

test('accepts explicit empty job collections', () => {
  assert.deepEqual(normalizeGreenhouseJobs({ jobs: [] }), []);
  assert.deepEqual(normalizeLeverJobs([]), []);
  assert.deepEqual(normalizeAshbyJobs({ jobs: [] }), []);
  assert.deepEqual(normalizeWorkableJobs({ name: 'Acme', jobs: [] }), []);
});
