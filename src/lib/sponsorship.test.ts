import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answerRequiresSponsorship,
  normalizeEmployerName,
  readPostingSponsorship,
  sponsorOnlyBoardRequired,
  sponsorshipVerdict,
} from './sponsorship';
import { H1B_EMPLOYERS, employerFilesH1b, h1bEmployer } from './sponsorEmployers';
import { JOB_SOURCES } from './jobSources';

test('normalizeEmployerName reconciles a brand with the legal entity that files the petition', () => {
  assert.equal(normalizeEmployerName('Airbnb'), normalizeEmployerName('AIRBNB INC'));
  assert.equal(normalizeEmployerName('MongoDB'), normalizeEmployerName('MongoDB, Inc.'));
  assert.equal(normalizeEmployerName('Qube Research & Technologies'), 'QUBE RESEARCH AND TECHNOLOGIES');
});

test('normalizeEmployerName strips ONE suffix, so a holdings entity stays distinct', () => {
  // "X HOLDINGS LLC" must not collapse to "X": they are different filers, and treating them as one
  // is how a company gets credited with petitions it never filed.
  assert.equal(normalizeEmployerName('Betterment Holdings LLC'), 'BETTERMENT HOLDINGS');
  assert.notEqual(normalizeEmployerName('Betterment Holdings LLC'), normalizeEmployerName('Betterment'));
});

test('a posting that refuses sponsorship is read as refusing, in the phrasings employers use', () => {
  const refusals = [
    'We are unable to sponsor or take over sponsorship of an employment visa at this time.',
    'Please note that we do not offer visa sponsorship for this position.',
    'This role is not eligible for visa sponsorship.',
    'Candidates must be authorized to work in the US without sponsorship now or in the future.',
    'No visa sponsorship is available for this opening.',
    'Sponsorship is not available for this role.',
    'We cannot provide immigration sponsorship for this position.',
  ];
  for (const text of refusals) {
    assert.equal(readPostingSponsorship(text), 'refuses', text);
  }
});

test('a posting that offers sponsorship is read as offering', () => {
  const offers = [
    'Visa sponsorship is available for this role.',
    'We sponsor visas for exceptional candidates.',
    'We are happy to sponsor the right person.',
    'H-1B sponsorship is offered for qualified applicants.',
  ];
  for (const text of offers) {
    assert.equal(readPostingSponsorship(text), 'offers', text);
  }
});

test('REFUSAL WINS when a posting says both, which is the common case', () => {
  // The single most dangerous input this function takes: a company-wide "we sponsor" paragraph
  // followed by a role-specific carve-out. Reading the positive first would surface exactly the
  // posting the negative sentence exists to keep away.
  const text =
    'Sponsorship is available for most roles at our company. '
    + 'For this particular position we are unable to sponsor visas.';
  assert.equal(readPostingSponsorship(text), 'refuses');
});

test('silence is unstated, never an offer', () => {
  assert.equal(readPostingSponsorship('Build great software with a great team.'), 'unstated');
  assert.equal(readPostingSponsorship(''), 'unstated');
  assert.equal(readPostingSponsorship(null), 'unstated');
  assert.equal(readPostingSponsorship(undefined), 'unstated');
  // The word alone means nothing without a verb attached to it.
  assert.equal(readPostingSponsorship('Questions about sponsorship? Ask your recruiter.'), 'unstated');
  // "Visa support" is not sponsorship. Employers write it about relocation help, tax advice and
  // paperwork for people who already have status, and reading it as an offer would put someone in
  // front of a role on the strength of a benefits line.
  assert.equal(readPostingSponsorship('We offer relocation and visa support for international hires.'), 'unstated');
});

test('a sentence using "sponsor" in another sense is skipped, not read as a refusal', () => {
  // Real text from Cloudflare's board, 2026-07-28. Before this was handled, this one sentence hid
  // all 275 of their openings from everyone who needs sponsorship.
  assert.equal(
    readPostingSponsorship(
      'You must be able to comply with US export laws without sponsorship for an export license.',
    ),
    'unstated',
  );
  assert.equal(
    readPostingSponsorship('Act as a key executive sponsor for high-growth accounts.'),
    'unstated',
  );
  assert.equal(
    readPostingSponsorship('Track state-sponsored actors. We are unable to sponsor work visas for this role.'),
    'refuses',
    'the real policy sentence still has to be read when another sentence uses the word differently',
  );
});

test('the verdict: a refusal outranks the employer filing thousands of petitions', () => {
  assert.deepEqual(
    sponsorshipVerdict({ posting: 'refuses', employerFilesH1b: true }),
    { surfaced: false, evidence: null },
  );
});

test('the verdict: the posting first, then the filings, then no', () => {
  assert.deepEqual(
    sponsorshipVerdict({ posting: 'offers', employerFilesH1b: false }),
    { surfaced: true, evidence: 'posting_offers' },
  );
  assert.deepEqual(
    sponsorshipVerdict({ posting: 'unstated', employerFilesH1b: true }),
    { surfaced: true, evidence: 'employer_h1b_filings' },
  );
  assert.deepEqual(
    sponsorshipVerdict({ posting: 'unstated', employerFilesH1b: false }),
    { surfaced: false, evidence: null },
  );
});

test('the onboarding declaration is one-way: the setting can only ever add the filter', () => {
  // Mehek's rule, 2026-07-28. Declared at onboarding means filtered forever, whatever the toggle
  // says afterwards.
  assert.equal(sponsorOnlyBoardRequired({ declaredAtOnboarding: true, settingEnabled: false }), true);
  assert.equal(sponsorOnlyBoardRequired({ declaredAtOnboarding: true, settingEnabled: null }), true);
  // Not declared: the toggle is the whole answer, in both directions.
  assert.equal(sponsorOnlyBoardRequired({ declaredAtOnboarding: false, settingEnabled: true }), true);
  assert.equal(sponsorOnlyBoardRequired({ declaredAtOnboarding: false, settingEnabled: false }), false);
  // Nothing known at all (an account created before this shipped) leaves the board whole.
  assert.equal(sponsorOnlyBoardRequired({ declaredAtOnboarding: null, settingEnabled: undefined }), false);
});

test('three of the four onboarding answers filter the board', () => {
  assert.equal(answerRequiresSponsorship('needs_now'), true);
  assert.equal(answerRequiresSponsorship('needs_future'), true);
  assert.equal(answerRequiresSponsorship('not_authorized'), true);
  assert.equal(answerRequiresSponsorship('no'), false);
});

test('EVERY company on the board has been checked against the H-1B data', () => {
  // The guard against the quiet failure: adding a job source without re-running
  // scripts/build-h1b-sponsors.mjs would leave an employer nobody has checked, and an unchecked
  // employer is silently treated as not sponsoring - a company disappears from the board of the
  // people who most need it, with nothing anywhere saying why.
  const unchecked = JOB_SOURCES.filter((source) => h1bEmployer(source.company_name) === null);
  assert.deepEqual(
    unchecked.map((source) => source.company_name),
    [],
    'Run: node scripts/build-h1b-sponsors.mjs',
  );
});

test('the generated file agrees with this module about how names normalise', () => {
  // The ingest script is plain .mjs and carries its own copy of normalizeEmployerName, because it
  // cannot import the TypeScript. This is what keeps the copy honest: every `normalized` value in
  // the generated data was produced by the script, and is recomputed here by the real function.
  for (const employer of H1B_EMPLOYERS) {
    assert.equal(employer.normalized, normalizeEmployerName(employer.company), employer.company);
  }
});

test('a confirmed employer carries the filings that confirmed it, from the source it names', () => {
  // Not a snapshot of who sponsors - that changes when the data is refreshed. It asserts the SHAPE
  // of a confirmation: nothing is marked as sponsoring without the numbers its own evidence tier
  // claims, and the legal entity name that was matched.
  for (const employer of H1B_EMPLOYERS) {
    if (!employer.sponsors) continue;
    assert.ok(employer.legal_names.length > 0, `${employer.company} has no filing entity`);
    assert.equal(employerFilesH1b(employer.company), true);
    if (employer.evidence === 'uscis_h1b' || employer.evidence === 'both') {
      assert.ok(employer.approvals > 0, `${employer.company} claims USCIS evidence with no approvals`);
      assert.ok(employer.fiscal_years.length > 0, `${employer.company} has no fiscal year`);
    }
    if (employer.evidence === 'dol_lca' || employer.evidence === 'both') {
      assert.ok(employer.lca_certifications > 0, `${employer.company} claims DOL evidence with no certifications`);
    }
    if (employer.evidence === 'uscis_h1b') {
      // The tier is exact, not "at least": an employer with both records must say `both`, or the
      // product understates what it knows and the settings screen cites the weaker source.
      assert.equal(employer.lca_certifications, 0, `${employer.company} has LCAs but claims USCIS only`);
    }
    if (employer.evidence === 'dol_lca') {
      assert.equal(employer.approvals, 0, `${employer.company} has approvals but claims DOL only`);
    }
  }
});

test('a board token that is not the company it looks like is never confirmed', () => {
  /* Six board tokens resolve to a DIFFERENT company than their display name: `sas` is Superior
     Alarm Systems, `bcg` is Bohen Consulting Group, `tcs` is Thornbury Community Services (UK care
     work), `disney` is a two-posting test board, `latch` is LatchBio, `crisp` is a Dutch grocer
     whose postings are all in Amsterdam. Every one was CONFIRMED by an earlier version of this
     data, against the famous company's filings - TCS alone was credited with 24,287 approvals.
     This is the regression test for the worst thing this feature can do: tell somebody who needs
     sponsorship that a company sponsors when it does not. */
  for (const company of ['sas', 'BCG', 'TCS', 'Disney', 'Latch', 'crisp']) {
    const employer = h1bEmployer(company);
    assert.ok(employer, `${company} is not in the data at all`);
    assert.equal(employer.sponsors, false, `${company} is confirmed and must not be`);
    assert.equal(employer.evidence, null);
    assert.deepEqual(employer.legal_names, [], `${company} kept a legal name it must not claim`);
    assert.ok(employer.rejected, `${company} has no recorded reason, so it will be "fixed" back`);
  }
});

test('an employer with no filings is not confirmed, and is still listed', () => {
  const unconfirmed = H1B_EMPLOYERS.filter((employer) => !employer.sponsors);
  for (const employer of unconfirmed) {
    assert.equal(employer.approvals, 0);
    assert.equal(employer.lca_certifications, 0);
    assert.equal(employer.evidence, null);
    assert.equal(employerFilesH1b(employer.company), false);
  }
  // A company we have never heard of is treated exactly like one we checked and found nothing for.
  assert.equal(h1bEmployer('Some Company That Is Not On The Board'), null);
  assert.equal(employerFilesH1b('Some Company That Is Not On The Board'), false);
});
