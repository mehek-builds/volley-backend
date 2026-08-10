import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { postingCountryForLegalScope, postingCountryFromJobContext } from './jobLocation';
import { resolveKnownAnswer, type ApplicationProfileLike } from './questionDiscovery';

/* THE PRODUCTION BLOCKER THIS FILE EXISTS FOR.
 *
 * Packet 59fb48ae-382c-4157-9b3d-d4c12883cc62 (Deepgram, Ashby) sat in needs_attention with two
 * required questions blank and two consented columns that answer them. Read from production,
 * read-only, on 2026-08-09. The labels are the employer's own, lowercased the way the pipeline
 * stores them; the location is what Ashby published and what the packet's job_context carries.
 */
const DEEPGRAM_AUTHORIZATION = 'are you legally authorized to work in the country where this role is located?';
const DEEPGRAM_SPONSORSHIP = 'will you now or in the future require visa sponsorship to work in the country where this role is located?';
const DEEPGRAM_LOCATION = 'USA | Remote';

/* The owner account's stored work-eligibility pair, and the only two columns any of this reads.
 * A student on CPT/OPT: allowed to work now, will need sponsorship to keep working. Consented on
 * 2026-08-09 (application_attestations_consented_at). */
const CPT_STUDENT: ApplicationProfileLike = {
  work_authorized: true,
  needs_sponsorship: true,
  work_eligibility_by_country: [{
    country_code: 'US', authorized_now: true, needs_sponsorship_now: false, needs_sponsorship_future: true,
  }],
};

test('a US posting answers both of the questions that pointed at it', () => {
  const country = postingCountryFromJobContext({ company: 'Deepgram', location: DEEPGRAM_LOCATION });
  assert.equal(country, 'us');
  assert.deepEqual(
    resolveKnownAnswer(DEEPGRAM_AUTHORIZATION, 'text', CPT_STUDENT, undefined, country),
    { value: 'Yes' },
    'she is authorized in the United States and the posting is in the United States',
  );
  assert.deepEqual(
    resolveKnownAnswer(DEEPGRAM_SPONSORSHIP, 'text', CPT_STUDENT, undefined, country),
    { value: 'Yes' },
    'she needs sponsorship, which is what needs_sponsorship records',
  );
});

test('the same pair on the other three job-location wordings in the account', () => {
  /* Scale AI, DV Trading and Together AI ask the same thing in three other sentences, and all three
   * postings are American. Written against the labels and locations as production holds them. */
  for (const [label, location] of [
    ['are you legally authorized to work in the country where the job is located?', 'San Francisco, CA; New York, NY'],
    ['are you legally authorized to work in the country where this role is based?', 'Chicago'],
    ['will you now or in the future require employer sponsorship for work authorization in this country? if you will be working under a student visa for this role, please select "yes."', 'Chicago'],
    ['will you now or in the future require company sponsorship to retain or extend your work authorization in the country where the job is located?', 'San Francisco'],
  ] as const) {
    const country = postingCountryFromJobContext({ location });
    assert.equal(country, 'us', location);
    const resolved = resolveKnownAnswer(label, 'text', CPT_STUDENT, undefined, country);
    assert.deepEqual(resolved, { value: 'Yes' }, label.slice(0, 70));
  }
});

test('a non-US posting answers neither, however plainly the stored pair reads', () => {
  for (const location of ['London', 'Amsterdam, Netherlands', 'Bengaluru', 'Dublin', 'Toronto, Canada']) {
    const country = postingCountryFromJobContext({ location });
    assert.equal(country, 'non_us', location);
    for (const label of [DEEPGRAM_AUTHORIZATION, DEEPGRAM_SPONSORSHIP]) {
      const resolved = resolveKnownAnswer(label, 'text', CPT_STUDENT, undefined, country);
      assert.ok(resolved && 'skipReason' in resolved, `${location}: ${label.slice(0, 60)}`);
    }
  }
});

test('a posting whose country cannot be determined answers nothing', () => {
  /* Four separate ways of not knowing, and every one of them has to behave like London rather than
   * like San Francisco. The last is the one that would be easy to get wrong: two countries in one
   * field is a posting that has not said which country the question means. */
  for (const jobContext of [
    { location: 'Remote' },
    { location: '' },
    { company: 'Somebody' },
    undefined,
    { location: 'Anywhere' },
    { location: 'New York / Dublin' },
    { locations: ['San Francisco, CA', 'London'] },
  ]) {
    const country = postingCountryFromJobContext(jobContext);
    assert.notEqual(country, 'us', JSON.stringify(jobContext));
    for (const label of [DEEPGRAM_AUTHORIZATION, DEEPGRAM_SPONSORSHIP]) {
      const resolved = resolveKnownAnswer(label, 'text', CPT_STUDENT, undefined, country);
      assert.ok(resolved && 'skipReason' in resolved, `${JSON.stringify(jobContext)}: ${label.slice(0, 60)}`);
    }
  }
});

test('a caller that supplies no posting at all behaves exactly as it did before', () => {
  // The parameter is optional, so forgetting to thread it must cost a handoff and never an answer.
  for (const label of [DEEPGRAM_AUTHORIZATION, DEEPGRAM_SPONSORSHIP]) {
    const resolved = resolveKnownAnswer(label, 'text', CPT_STUDENT, undefined);
    assert.ok(resolved && 'skipReason' in resolved, label.slice(0, 60));
  }
});

test('a US posting answers nothing when the fact itself is missing', () => {
  const country = postingCountryFromJobContext({ location: DEEPGRAM_LOCATION });
  const noAuthorizationStored: ApplicationProfileLike = { needs_sponsorship: true };
  const noSponsorshipStored: ApplicationProfileLike = { work_authorized: true };
  const nothingStored: ApplicationProfileLike = {};

  const authorizationWithoutColumn = resolveKnownAnswer(
    DEEPGRAM_AUTHORIZATION, 'text', noAuthorizationStored, undefined, country,
  );
  assert.ok(authorizationWithoutColumn && 'skipReason' in authorizationWithoutColumn);

  /* The sponsorship half with only work_authorized on file. The disclosure arm cannot fire, because
   * needs_sponsorship is what it discloses and there is nothing there to disclose. */
  const sponsorshipWithoutColumn = resolveKnownAnswer(
    DEEPGRAM_SPONSORSHIP, 'text', noSponsorshipStored, undefined, country,
  );
  assert.ok(sponsorshipWithoutColumn && 'skipReason' in sponsorshipWithoutColumn);

  for (const label of [DEEPGRAM_AUTHORIZATION, DEEPGRAM_SPONSORSHIP]) {
    const resolved = resolveKnownAnswer(label, 'text', nothingStored, undefined, country);
    assert.ok(resolved && 'skipReason' in resolved, label.slice(0, 60));
  }
});

test('a structured US posting selects the matching country record', () => {
  const country = postingCountryFromJobContext({ location: DEEPGRAM_LOCATION });
  const resolved = resolveKnownAnswer('are you legally authorized to work?', 'text', CPT_STUDENT, undefined, country);
  assert.deepEqual(resolved, { value: 'Yes' });
});

test('a US posting does not override a label that names a different country', () => {
  // The employer said Canada. A posting header does not get to contradict the question's own words.
  const country = postingCountryFromJobContext({ location: DEEPGRAM_LOCATION });
  for (const label of [
    'are you legally authorized to work in canada?',
    'will you now or in the future require sponsorship to work in the united kingdom?',
  ]) {
    const resolved = resolveKnownAnswer(label, 'text', CPT_STUDENT, undefined, country);
    assert.ok(resolved && 'skipReason' in resolved, label);
  }
});

test('a US posting does not unlock the guards that hold the whole family', () => {
  const country = postingCountryFromJobContext({ location: DEEPGRAM_LOCATION });

  /* The stored pair that describes nobody: not authorized AND needing no sponsorship. Held whatever
   * the posting says, because the two halves are answered by two branches that would contradict
   * each other on the same page. */
  const impossible: ApplicationProfileLike = { work_authorized: false, needs_sponsorship: false };
  for (const label of [DEEPGRAM_AUTHORIZATION, DEEPGRAM_SPONSORSHIP]) {
    const resolved = resolveKnownAnswer(label, 'text', impossible, undefined, country);
    assert.ok(resolved && 'skipReason' in resolved, label.slice(0, 60));
  }

  /* A compound label whose other half has no column, and a label phrased so that "yes" claims an
   * exemption rather than disclosing a need. Both refuse on a US posting exactly as they do
   * without one. */
  for (const label of [
    'are you currently located in the country where this role is located, or do you have work authorization there?',
    'are you authorized to work for all employers in the country where this role is located without sponsorship?',
  ]) {
    const resolved = resolveKnownAnswer(label, 'text', CPT_STUDENT, undefined, country);
    assert.ok(resolved && 'skipReason' in resolved, label.slice(0, 70));
  }
});

test('the country a work-eligibility question means is stricter than the board filter', () => {
  /* postingCountryForLegalScope is deliberately NOT jobCountry, and this is the difference that
   * matters. jobCountry lets the US win a tie on purpose - "New York / Dublin" is a role an
   * American hire can take, which is the right answer for a board filter. It is the wrong answer
   * for "may you work in the country where this role is located", because the posting has not said
   * which of the two it means. */
  assert.equal(postingCountryForLegalScope(['USA | Remote']), 'us');
  assert.equal(postingCountryForLegalScope(['San Francisco, CA; New York, NY']), 'us');
  assert.equal(postingCountryForLegalScope(['Remote - US']), 'us');
  assert.equal(postingCountryForLegalScope(['San Francisco, CA', 'Austin, TX']), 'us');

  assert.equal(postingCountryForLegalScope(['New York / Dublin']), 'non_us');
  assert.equal(postingCountryForLegalScope(['Remote - US or London']), 'non_us');
  assert.equal(postingCountryForLegalScope(['Oxford or London-United Kingdom']), 'non_us');
  assert.equal(postingCountryForLegalScope(['London']), 'non_us');

  assert.equal(postingCountryForLegalScope(['Remote']), 'unknown');
  assert.equal(postingCountryForLegalScope(['']), 'unknown');
  assert.equal(postingCountryForLegalScope([null, undefined]), 'unknown');
  assert.equal(postingCountryForLegalScope([]), 'unknown');
});

test('only the packet job_context is read, and prose is never consulted', () => {
  /* be1bccf deleted JD_US_SCOPE, which swept the job description's PROSE for "california" and
   * "new york" and therefore read a London role's San Francisco headquarters as an American job.
   * Nothing added here may bring that back, so the job description is passed in and must change
   * nothing: only job_context.location and job_context.locations decide the country. */
  const londonPosting = postingCountryFromJobContext({ location: 'London, United Kingdom' });
  const americanSoundingJd = 'Our San Francisco headquarters, our New York customers, and US benefits.';
  for (const label of [DEEPGRAM_AUTHORIZATION, DEEPGRAM_SPONSORSHIP]) {
    const resolved = resolveKnownAnswer(label, 'text', CPT_STUDENT, americanSoundingJd, londonPosting);
    assert.ok(resolved && 'skipReason' in resolved, label.slice(0, 60));
  }
  // And a JD alone, with no structured location anywhere, still resolves to nothing.
  assert.equal(postingCountryFromJobContext({ jd_text: americanSoundingJd }), 'unknown');
});

test('the abbreviation guard is case-folded, because the pipeline lowercases every label', () => {
  /* MEASURED against production on 2026-08-09: 507 distinct stored question labels, 494 of them
   * entirely lowercase, and the case-SENSITIVE US_ABBREVIATION_SCOPE matches 0 of them. It cannot
   * match one that came through the extension, which lowercases every label it captures
   * (student-outreach-extension/src/lib/adapters/generic.ts). The case-folded arm matches 6, and
   * these two are Roblox's, which were a live stop until it landed. Pinned here so the arm is not
   * "simplified" back out on the grounds that the case-sensitive one already covers it. */
  assert.deepEqual(
    resolveKnownAnswer('are you legally authorized to work in the us?', 'text', CPT_STUDENT, undefined),
    { value: 'Yes' },
  );
  assert.deepEqual(
    resolveKnownAnswer('will you now or in the future require sponsorship for work authorization?', 'text', CPT_STUDENT, undefined),
    { skipReason: 'work-eligibility question left for you: "will you now or in the future require sponsorship for work a"' },
  );
  // The pronoun that the capital letters used to be the only defence against is still not a country.
  const pronoun = resolveKnownAnswer(
    'how did you hear about us?', 'text', { ...CPT_STUDENT, work_authorized: true }, undefined,
  );
  assert.ok(!(pronoun && 'value' in pronoun && /^(yes|no)$/i.test(pronoun.value)));
});

/* THE PROMISE ON THE WEBSITE AND THE CODE UNDER IT, PINNED TO EACH OTHER.
 *
 * components/start/SponsorshipStep.tsx in role-quick-website used to say "This answer is permanent.
 * We never fill it in for you." while this resolver had filled a work-authorization answer on
 * dozens of real applications. Both halves were defensible on their own and the pair was not: a
 * promise the product breaks is worse than either policy, because nothing predicts what will
 * happen next.
 *
 * The copy now states the rule instead of a blanket refusal, and these are its clauses, each one
 * asserted as behaviour. The sentences are duplicated here verbatim ON PURPOSE. The two repos
 * deploy separately and cannot import from each other, so the only thing that can stop them
 * drifting is a test in each that fails when the other side changes: this one fails if the
 * behaviour stops matching the words, and tests/sponsorship.test.mjs over there fails if the words
 * stop matching this comment.
 */
const SITE_COPY_AUTHORIZATION = 'Are you authorized to work? gets an answer only when the job is in the United States.';
const SITE_COPY_SPONSORSHIP = 'Do you need sponsorship? gets a yes whenever you do.';
const SITE_COPY_OTHERWISE = 'Anything else is left blank for you.';

test('the sponsorship screen describes what this resolver actually does', async () => {
  const usPosting = postingCountryFromJobContext({ location: DEEPGRAM_LOCATION });
  const londonPosting = postingCountryFromJobContext({ location: 'London, United Kingdom' });

  // "... gets an answer only when the job is in the United States."
  assert.deepEqual(
    resolveKnownAnswer(DEEPGRAM_AUTHORIZATION, 'text', CPT_STUDENT, undefined, usPosting),
    { value: 'Yes' },
    SITE_COPY_AUTHORIZATION,
  );
  const abroad = resolveKnownAnswer(DEEPGRAM_AUTHORIZATION, 'text', CPT_STUDENT, undefined, londonPosting);
  assert.ok(abroad && 'skipReason' in abroad, SITE_COPY_AUTHORIZATION);

  const unscopedSponsorship = resolveKnownAnswer(
    'will you require sponsorship for employment visa status?', 'text', CPT_STUDENT, undefined,
  );
  assert.ok(unscopedSponsorship && 'skipReason' in unscopedSponsorship, SITE_COPY_SPONSORSHIP);

  // "Anything else is left blank for you."
  for (const label of ['are you legally authorized to work in canada?']) {
    const resolved = resolveKnownAnswer(label, 'text', CPT_STUDENT, undefined, usPosting);
    assert.ok(resolved && 'skipReason' in resolved, SITE_COPY_OTHERWISE);
  }

  /* And the sentence this replaced is gone from the code's own account of itself. The old comment
   * in questionDiscovery.ts told the next reader that the posting's location was off limits, which
   * was true of the JD's prose and never true of the structured field. */
  const source = await readFile('src/lib/questionDiscovery.ts', 'utf8');
  assert.match(source, /postingCountryFromJobContext/, 'the structured-location rule must be named where it is used');
  assert.doesNotMatch(
    source,
    /posting's location is a JD inference/,
    'the stale justification must not outlive the rule it justified',
  );
});
