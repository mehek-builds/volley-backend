import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasUsPresence, hostLabels, identifyingTokens, identityCheck, portalNameAgrees, verdictFor, wordSet,
} from './sponsorIdentity';

/**
 * THE VERIFIER HAS TO CATCH THE ERRORS IT EXISTS TO CATCH.
 *
 * Its first version compared squashed strings and would have PASSED three of the six wrong matches
 * that were live in production: "Kansas" and "SaaS" both contain SAS, "LatchBio" contains LATCH,
 * "crispy" contains CRISP. It printed "185 verified, 0 suspect" and the number meant nothing.
 *
 * Every trap below is real text from the board that produced the wrong match. If somebody loosens
 * the matching to make a stubborn employer pass, these fail first.
 */

function board(
  text: string,
  options: { displayName?: string | null; url?: string; location?: string } = {},
) {
  const location = options.location ?? 'San Francisco, CA';
  return {
    displayName: options.displayName ?? null,
    count: 3,
    locations: [location],
    samples: [{
      title: 'Software Engineer',
      // A US location by default: these fixtures are about NAMES, and a non-US board is its own
      // signal (see the Amsterdam test).
      location,
      url: options.url ?? 'https://job-boards.greenhouse.io/x/jobs/1',
      text,
    }],
  };
}

const noFilings = { legal_names: [] as string[] };

/** A filing entity whose name IS the brand, so nothing was asserted by an alias. */
function plain(name: string) {
  return { legal_names: [name], normalized: 'SAME', matched_key: 'SAME' };
}

test('a brand that is only a SUBSTRING of another company is not a match', () => {
  // The Lever token `latch` is LatchBio, not Latch Systems. Real text from that board.
  const latchbio = board(
    'At LatchBio, we are building the ubiquitous cloud platform to store, visualize and analyze '
    + 'data from biological experiments. We are 22 engineers and salespeople in San Francisco. '
    + 'The convergence of laboratory automation and high-throughput biology is our whole thesis, '
    + 'and we are looking for people who want to build the tooling that makes it usable. You will '
    + 'work directly with scientists running experiments at scale, own the pipeline end to end, '
    + 'and ship to production every week. Experience with distributed systems is welcome but not '
    + 'required; curiosity about biology is.',
  );
  const check = identityCheck('Latch', plain('LATCH SYSTEMS INC'), latchbio);
  assert.equal(check.brandInText, false, '"LatchBio" must not confirm "Latch"');
  assert.equal(check.legalHit, null, 'LATCH from LATCH SYSTEMS must not match "LatchBio" either');
  assert.equal(check.domainMatch, false);
  // A real board, real postings, and nothing naming us: that is the shape of every wrong match.
  assert.equal(verdictFor(latchbio, check, null), 'SUSPECT');
});

test('a brand hiding inside an ordinary word is not a match', () => {
  // The Greenhouse token `sas` is Superior Alarm Systems. "Kansas" and "SaaS" both contain "sas".
  const check = identityCheck('sas', plain('SAS INSTITUTE INC'), board(
    'Superior Alarm Systems is hiring a Lead Security Technician in Kansas to support our SaaS '
    + 'monitoring product across commercial sites.',
    { displayName: 'Superior Alarm Systems' },
  ));
  assert.equal(check.brandInText, false, '"Kansas" and "SaaS" must not confirm "sas"');
  assert.equal(check.legalHit, null, 'INSTITUTE and SYSTEMS are not identifying');
});

test('an inflected form is not a match', () => {
  // The Ashby token `crisp` is the Dutch grocer. A US "Crisp, Inc." exists and normalises the same.
  const check = identityCheck('crisp', plain('Crisp, Inc.'), board(
    'Bezorger (met scooterrijbewijs) in Amsterdam. Wij bezorgen crispy verse boodschappen binnen '
    + '15 minuten in Amsterdam, Breda en Utrecht.',
  ));
  assert.equal(check.brandInText, false, '"crispy" must not confirm "crisp"');
});

test('a place name in the filing entity never confirms anything', () => {
  // `bcg` is Bohen Consulting Group. THE BOSTON CONSULTING GROUP shares BOSTON with any posting
  // that has a Boston office, and CONSULTING and GROUP with half the corpus.
  const check = identityCheck('BCG', plain('THE BOSTON CONSULTING GROUP INC'), board(
    'Bohen Consulting Group is looking for a Project Manager. This role sits in our Boston and '
    + 'Bronx offices and supports our consulting practice.',
    { displayName: 'Bohen Consulting Group' },
  ));
  assert.equal(check.legalHit, null, 'BOSTON, CONSULTING and GROUP are all non-identifying');
  assert.equal(check.brandInText, false);
});

test('SOCIAL FINANCE does not confirm a posting that mentions social media', () => {
  // The legal entity behind SoFi. Both of its words are ordinary English.
  const check = identityCheck('SoFi', plain('SOCIAL FINANCE INC'), board(
    'Manage our social media presence and finance partnerships for a fast-growing brand.',
  ));
  assert.equal(check.legalHit, null);
  assert.equal(check.brandInText, false);
});

test('the real thing still passes: the company names itself in its own prose', () => {
  const check = identityCheck('Airtable', plain('FORMAGRID INC D/B/A AIRTABLE'), board(
    'Airtable is the no-code app platform that empowers people closest to the work to accelerate '
    + 'their most critical business processes.',
  ));
  assert.equal(check.brandInText, true);
});

test('...and so does the filing entity appearing instead of the brand', () => {
  const check = identityCheck('Carta', plain('ESHARES INC D/B/A CARTA'), board(
    'We are trusted by more than 40,000 companies. Our operating entity, eShares Inc, is the '
    + 'registered transfer agent.',
  ));
  assert.equal(check.legalHit, 'ESHARES');
});

test('a possessive still names the company', () => {
  const check = identityCheck('Ramp', plain('RAMP BUSINESS CORPORATION'), board(
    "Ramp's finance automation platform saves customers time and money.",
  ));
  assert.equal(check.brandInText, true);
});

test('a two-word brand is found spelled either way', () => {
  assert.equal(identityCheck('Scale AI', noFilings, board('Scale AI is the data engine for AI.')).brandInText, true);
  assert.equal(identityCheck('Scale AI', noFilings, board('Working at ScaleAI means shipping fast.')).brandInText, true);
});

test('the ATS host is never the company domain', () => {
  const check = identityCheck('Notion', noFilings, board('We are hiring.', {
    url: 'https://job-boards.greenhouse.io/notion/jobs/123',
  }));
  assert.equal(check.domainMatch, false, "greenhouse.io/notion is the board's URL, not Notion's domain");
});

test('the company own domain does count', () => {
  const check = identityCheck('Fivetran', noFilings, board('We are hiring.', {
    url: 'https://www.fivetran.com/careers/job?gh_jid=1',
  }));
  assert.equal(check.domainMatch, true);
});

test('a board with nothing to read is not a pass', () => {
  // The distinction that matters: "we could not tell" and "we checked and it is fine" are
  // different answers, and only one of them means an employer is safe to surface.
  assert.equal(verdictFor({ displayName: null, count: 0, samples: [], locations: [] }, null, null), 'empty-board');
  assert.equal(verdictFor(null, null, 'HTTP 404'), 'error');
  const thinBoard = board('Apply here.');
  const thin = identityCheck('Someone', plain('SOMEONE INC'), thinBoard);
  assert.equal(verdictFor(thinBoard, thin, null), 'weak');
});

test('a board with no US presence is never confirmed on the brand word alone', () => {
  /* THE `crisp` SHAPE, and the one the earlier checks could not see. Both companies really are
     called Crisp, so the brand matches honestly; only the geography separates them. An H-1B is a
     US work visa, so a board that hires nobody in the US cannot be the filer. */
  const amsterdam = board(
    'Bezorger (met scooterrijbewijs). Wij bezorgen verse boodschappen binnen 15 minuten in '
    + 'Amsterdam, Breda, Zwanenburg, Delft en Utrecht. Crisp is de snelst groeiende online '
    + 'supermarkt van Nederland en wij zoeken collega\'s voor ons warehouse team in Amsterdam.',
    { location: 'Amsterdam' },
  );
  const check = identityCheck('crisp', plain('Crisp, Inc.'), amsterdam);
  assert.equal(check.brandInText, true, 'the Dutch grocer really is called Crisp');
  assert.equal(check.usPresence, false);
  assert.equal(verdictFor(amsterdam, check, null), 'REVIEW', 'a US filing against a non-US board needs a human');
});

test('...and a US board with the same evidence passes', () => {
  const us = board(
    'Crisp is hiring a warehouse lead in Austin to support our same-day grocery operation across '
    + 'Texas. You will own the shift schedule, the pick line and the quality bar for every order.',
    { location: 'Austin, TX' },
  );
  const check = identityCheck('crisp', plain('Crisp, Inc.'), us);
  assert.equal(check.usPresence, true);
  assert.equal(verdictFor(us, check, null), 'verified');
});

test('an ALIAS is not corroborated by the brand appearing in the posting', () => {
  /* Of course Airtable's board says "Airtable". The claim under test is that Airtable IS
     FORMAGRID INC, and only Formagrid's own name or airtable.com speaks to that. */
  const asserted = { legal_names: ['FORMAGRID INC'], normalized: 'AIRTABLE', matched_key: 'FORMAGRID' };
  const brandOnly = board(
    'Airtable is the no-code app platform that empowers people closest to the work to accelerate '
    + 'their most critical business processes. We are hiring across product and engineering, and '
    + 'you will work with teams shipping to hundreds of thousands of customers every week.',
  );
  const check = identityCheck('Airtable', asserted, brandOnly);
  assert.equal(check.brandInText, true);
  assert.equal(check.matchKind, 'asserted');
  assert.equal(verdictFor(brandOnly, check, null), 'REVIEW');

  // The company's own domain on the apply link IS corroboration.
  const withDomain = board(
    'Airtable is the no-code app platform that empowers people closest to the work to accelerate '
    + 'their most critical business processes. We are hiring across product and engineering.',
    { url: 'https://careers.airtable.com/jobs/123' },
  );
  const corroborated = identityCheck('Airtable', asserted, withDomain);
  assert.equal(verdictFor(withDomain, corroborated, null), 'verified');
});

test('a filing city that appears on the board settles an asserted match', () => {
  /* SPACE EXPLORATION TECHNOLOGIES filed from Hawthorne, California; the SpaceX board posts jobs
     in Hawthorne, California. Two companies sharing a name do not usually share a street, and this
     is the only corroboration available for an alias without going to the open web. */
  const spacex = {
    displayName: 'SpaceX',
    count: 400,
    locations: ['Hawthorne, CA', 'Starbase, TX', 'Redmond, WA'],
    samples: [{ title: 'Accountant', location: 'Hawthorne, CA', url: null, text: 'Join the team building rockets.' }],
  };
  const employer = {
    legal_names: ['SPACE EXPLORATION TECHNOLOGIES CORP'],
    normalized: 'SPACEX',
    matched_key: 'SPACE EXPLORATION TECHNOLOGIES',
    filing_cities: ['HAWTHORNE'],
    filing_states: ['CA'],
  };
  const check = identityCheck('SpaceX', employer, spacex);
  assert.equal(check.matchKind, 'asserted');
  assert.equal(check.geoOverlap, 'HAWTHORNE');
  assert.equal(verdictFor(spacex, check, null), 'verified');
});

test('a filing city somewhere else does NOT settle it', () => {
  const board2 = {
    displayName: null,
    count: 24,
    locations: ['Amsterdam', 'Breda', 'Utrecht'],
    samples: [{ title: 'Warehouse Medewerker', location: 'Amsterdam', url: null, text: 'Crisp bezorgt verse boodschappen in Amsterdam en Utrecht, en wij zoeken collega voor het warehouse team met ervaring in logistiek en planning.' }],
  };
  const employer = {
    legal_names: ['Crisp, Inc.'],
    normalized: 'CRISP',
    matched_key: 'CRISP',
    filing_cities: ['CHICAGO'],
    filing_states: ['IL'],
  };
  const check = identityCheck('crisp', employer, board2);
  assert.equal(check.geoOverlap, null);
  assert.equal(verdictFor(board2, check, null), 'REVIEW');
});

test('the whole board decides US presence, not the three sampled postings', () => {
  /* Sampling three of four hundred flagged Cloudflare and Twilio as having no US presence. A
     company's US-ness is a property of its hiring, not of whichever roles the API returned first. */
  const board3 = {
    displayName: 'Cloudflare',
    count: 275,
    locations: ['London, United Kingdom', 'Lisbon, Portugal', 'Austin, TX'],
    samples: [{ title: 'Engineer', location: 'London, United Kingdom', url: null, text: 'Cloudflare is building a better Internet for everyone, and we are hiring across our global team.' }],
  };
  const check = identityCheck('Cloudflare', { legal_names: ['CLOUDFLARE INC'], normalized: 'CLOUDFLARE', matched_key: 'CLOUDFLARE' }, board3);
  assert.equal(check.usPresence, true, 'the board hires in Austin even though the sample is London');
});

test('a d/b/a in the filing is the employer naming the brand itself', () => {
  /* "MATONEE INC D/B/A APTOS LABS" is Matonee telling the US government it trades as Aptos Labs.
     Nothing corroborates an alias better, and it needs no web request. */
  const asserted = {
    legal_names: ['MATONEE INC D/B/A APTOS LABS'],
    normalized: 'APTOSLABS',
    matched_key: 'MATONEE',
  };
  const anyBoard = board(
    'Aptos Labs is a premier Web3 studio building on the Aptos blockchain. We are hiring across '
    + 'engineering, product and community as the ecosystem grows through the next release cycle.',
  );
  const check = identityCheck('aptoslabs', asserted, anyBoard);
  assert.equal(check.dbaNamesBrand, true);
  assert.equal(verdictFor(anyBoard, check, null), 'verified');
});

test('a d/b/a for a DIFFERENT brand corroborates nothing', () => {
  // "MERCY CLINICS INC D/B/A MERCYONE MEDICAL GROUP" must not confirm One Medical.
  const wrong = {
    legal_names: ['MERCY CLINICS INC D/B/A MERCYONE MEDICAL GROUP CENTRAL IOWA'],
    normalized: 'ONEMEDICAL',
    matched_key: 'MERCY CLINICS',
  };
  const check = identityCheck('onemedical', wrong, board(
    'One Medical is a membership-based primary care practice. We are hiring providers across our '
    + 'offices and our virtual care team, and you will work alongside a multidisciplinary group.',
  ));
  assert.equal(check.dbaNamesBrand, false);
});

test('the helpers behave', () => {
  assert.deepEqual([...wordSet("Airtable's team")], ['AIRTABLE', 'TEAM']);
  assert.deepEqual(identifyingTokens('THE BOSTON CONSULTING GROUP INC'), []);
  assert.deepEqual(identifyingTokens('FORMAGRID INC D/B/A AIRTABLE'), ['FORMAGRID', 'AIRTABLE']);
  assert.deepEqual([...hostLabels(['https://careers.airtable.com/x'])], ['CAREERS', 'AIRTABLE', 'COM']);
  assert.equal(hasUsPresence(['Amsterdam', 'Breda']), false);
  assert.equal(hasUsPresence(['Remote, California, United States, AMER']), true);
  assert.equal(hasUsPresence(['Austin, TX']), true);
  assert.equal(hasUsPresence(['London', 'Remote - US']), true);
});

test('the portal name catches every board that was not the company we labelled it', () => {
  /* All six real cases, with the name Greenhouse was publishing the whole time. This check makes
     the discovery automatic instead of a hand audit weeks later. */
  assert.equal(portalNameAgrees('sas', 'Superior Alarm Systems'), false);
  assert.equal(portalNameAgrees('BCG', 'Bohen Consulting Group'), false);
  assert.equal(portalNameAgrees('TCS', 'Thornbury Community Services'), false);
  assert.equal(portalNameAgrees('Disney', "Sgt. Pepper's Lonely Hearts Club Band"), false);
});

test('...and tolerates the ways a real name legitimately differs', () => {
  assert.equal(portalNameAgrees('TripAdvisor', 'Tripadvisor'), true);
  assert.equal(portalNameAgrees('yugabyte', 'YugabyteDB'), true);
  assert.equal(portalNameAgrees('Qube Research & Technologies', 'Qube Research and Technologies'), true);
  assert.equal(portalNameAgrees('Scale AI', 'Scale'), true);
  assert.equal(portalNameAgrees('Point72', 'Point72 Asset Management'), true);
});

test('no published name is NO OPINION, never a pass', () => {
  // Lever and Ashby publish no company name at all. Silence must not read as agreement.
  assert.equal(portalNameAgrees('Notion', null), null);
  assert.equal(portalNameAgrees('Notion', ''), null);
});

test('a disagreement a human checked and cleared is not reported', () => {
  /* Pure Storage's board displays the stale name "Everpure". The names really do disagree, and
     unlinking it would cost a job seeker every Pure Storage posting - 353 approved petitions'
     worth. The clearance is explicit and carries its evidence. */
  assert.equal(portalNameAgrees('Pure Storage', 'Everpure'), true);
  // ...and clearing one board clears only that board.
  assert.equal(portalNameAgrees('sas', 'Superior Alarm Systems'), false);
});
