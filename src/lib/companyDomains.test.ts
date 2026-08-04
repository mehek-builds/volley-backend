import { test, describe } from 'node:test';
import assert from 'node:assert';
import { COMPANY_DOMAINS, companyDomainFor } from './companyDomains';

describe('companyDomainFor', () => {
  test('finds an employer however the board punctuates its name', () => {
    assert.strictEqual(companyDomainFor('Airbnb'), 'airbnb.com');
    assert.strictEqual(companyDomainFor('airbnb'), 'airbnb.com');
    assert.strictEqual(companyDomainFor('Airbnb, Inc.'), 'airbnb.com');
    assert.strictEqual(companyDomainFor('  AIRBNB  '), 'airbnb.com');
  });

  test('an unmapped employer is null, never a guess', () => {
    // Null is the honest answer and the row renders an initial. A guess here is the only way this
    // file can produce a wrong logo, which is worse than no logo.
    assert.strictEqual(companyDomainFor('Some Company We Have Never Polled'), null);
    assert.strictEqual(companyDomainFor(''), null);
    assert.strictEqual(companyDomainFor(null), null);
    assert.strictEqual(companyDomainFor(undefined), null);
  });

  test('the entries a name-similarity check got wrong are right here', () => {
    // Each of these was confidently mis-resolved by matching on the company word alone, which is
    // why that approach was rejected. They are the regression guard for reintroducing it.
    assert.strictEqual(companyDomainFor('Linear'), 'linear.app', 'not linear.io');
    assert.strictEqual(companyDomainFor('Chime'), 'chime.com', 'not chime.ai');
    assert.strictEqual(companyDomainFor('SoFi'), 'sofi.com', 'not sofi.io');
    assert.strictEqual(companyDomainFor('Gusto'), 'gusto.com', 'not gusto.ai');
    assert.strictEqual(companyDomainFor('Scale AI'), 'scale.com', 'not scaleai.co');
  });

  test('the entries the 2026-08-04 curation sweep caught are right here', () => {
    // Same failure class as the test above, found before it shipped rather than after. Every one of
    // these was about to be added as the obvious <name>.com until the employer's own ATS board said
    // otherwise, and every one of them would have rendered a DIFFERENT company's logo. Lucid is the
    // reason this test exists: lucid.com is Lucid Software, the maker of Lucidchart, while the
    // employer posting several hundred rows here files under the slug `lucidmotors`. Nothing else in
    // the repo would notice that swap, because both domains resolve and both serve a real favicon.
    for (const [company, right, wrong] of [
      ['Lucid', 'lucidmotors.com', 'lucid.com'],
      ['Mozilla', 'mozilla.org', 'mozilla.com'],
      ['Shield AI', 'shield.ai', 'shieldai.com'],
      ['Engineers Gate', 'eglp.com', 'engineersgate.com'],
      ['Epirus', 'epirusinc.com', 'epirus.com'],
      ['Squarepoint Capital', 'squarepoint-capital.com', 'squarepointcapital.com'],
      ['Ginkgo', 'ginkgo.bio', 'ginkgo.com'],
      ['Quadrature', 'quadrature.ai', 'quadraturecapital.com'],
      ['Skylight', 'myskylight.com', 'skylightframe.com'],
      ['Take-Two', 'take2games.com', 'taketwo.com'],
      ['Akuna', 'akunacapital.com', 'akuna.com'],
    ] as const) {
      assert.strictEqual(companyDomainFor(company), right, `${company} must map to ${right}`);
      assert.notStrictEqual(companyDomainFor(company), wrong, `${company} must never map to ${wrong}`);
    }
  });

  test('employers whose domain is not simply their name are correct', () => {
    assert.strictEqual(companyDomainFor('Datadog'), 'datadoghq.com');
    assert.strictEqual(companyDomainFor('Notion'), 'notion.so');
    assert.strictEqual(companyDomainFor('Match Group'), 'mtch.com');
    assert.strictEqual(companyDomainFor('IMC Trading'), 'imc.com');
    assert.strictEqual(companyDomainFor('Khan Academy'), 'khanacademy.org');
    assert.strictEqual(companyDomainFor('Twitch'), 'twitch.tv');
  });

  test('reviewed exceptions stay mapped when automated proof is blocked or non-obvious', () => {
    assert.strictEqual(companyDomainFor('Access Bank PLC'), 'accessbankplc.com');
    assert.strictEqual(companyDomainFor('Block'), 'block.xyz');
    assert.strictEqual(companyDomainFor('Oscar Health'), 'hioscar.com');
    assert.strictEqual(companyDomainFor('Rocket Lab'), 'rocketlabcorp.com');
    assert.strictEqual(companyDomainFor('Sigma'), 'sigmacomputing.com');
    assert.strictEqual(companyDomainFor('Toast'), 'toasttab.com');

    // Pure Storage looks deletable and is not. purestorage.com 301s to everpuredata.com, so anyone
    // reading the redirect alone concludes the entry points at another brand and drops it. What the
    // reader actually sees is the deciding fact: the favicon service returns the same orange hexagon
    // for both hosts, because the rebrand kept the mark. Pinned so that check has to be redone, not
    // re-litigated from the redirect.
    assert.strictEqual(companyDomainFor('Pure Storage'), 'purestorage.com');
  });
});

describe('the map itself', () => {
  test('every value is a bare domain, not a URL and not a job board', () => {
    // A URL here would be concatenated into the favicon request and silently fetch nothing; a board
    // host would paint one ATS logo across every row from that board, which is the exact failure
    // this whole mechanism exists to prevent.
    const boards = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'workable.com'];
    for (const [name, domain] of Object.entries(COMPANY_DOMAINS)) {
      assert.ok(!/^https?:/i.test(domain), `${name}: "${domain}" is a URL, not a domain`);
      assert.ok(!domain.includes('/'), `${name}: "${domain}" contains a path`);
      assert.ok(!domain.startsWith('www.'), `${name}: "${domain}" still carries www.`);
      assert.strictEqual(domain, domain.toLowerCase(), `${name}: "${domain}" is not lowercased`);
      assert.match(domain, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `${name}: "${domain}" is not a bare domain`);
      assert.ok(
        !boards.some((b) => domain === b || domain.endsWith(`.${b}`)),
        `${name}: "${domain}" is a job board, not an employer`,
      );
    }
  });

  test('no two employers share a domain', () => {
    // Two names pointing at one domain means one of them is wrong, and the wrong one shows another
    // company's logo.
    const seen = new Map<string, string>();
    for (const [name, domain] of Object.entries(COMPANY_DOMAINS)) {
      const prior = seen.get(domain);
      assert.strictEqual(prior, undefined, `${name} and ${prior} both claim ${domain}`);
      seen.set(domain, name);
    }
  });

  test('names are distinct once normalized, so no entry silently shadows another', () => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const seen = new Set<string>();
    for (const name of Object.keys(COMPANY_DOMAINS)) {
      const key = norm(name);
      assert.ok(!seen.has(key), `"${name}" collides with an earlier entry once normalized`);
      seen.add(key);
    }
  });
});

describe('the failure classes this map has actually hit', () => {
  test('a multi-word company is never resolved from its first word alone', () => {
    // Epic Games -> epic.com (Epic Systems), Rocket Lab -> rocket.com, Marshall Wace ->
    // marshall.com (amplifiers), Pure Storage -> pure.com. A generator once produced all four,
    // because every one of those sites contains its own first word. Absent is the right answer.
    for (const [company, wrong] of [
      ['Epic Games', 'epic.com'],
      ['Rocket Lab', 'rocket.com'],
      ['Marshall Wace', 'marshall.com'],
      ['Pure Storage', 'pure.com'],
    ] as const) {
      assert.notStrictEqual(companyDomainFor(company), wrong, `${company} must never map to ${wrong}`);
    }
  });

  test('a company whose common word belongs to someone else never resolves to that word', () => {
    // The point was never that these must be absent. It is that the obvious domain belongs to a
    // DIFFERENT company, so resolving by name paints that company's logo on this employer's rows:
    // fireworks.com is a fireworks retailer, oldmission.org is a church, pinecone.com is a for-sale
    // page, honor.com is the handset maker, opal.com is Open Advisors, column.com serves no title.
    // Absent is the safe default; a reviewed override is the only way out, and it must not land on
    // the word itself. Each override below was established from the employer's own ATS board.
    for (const [company, wrong] of [
      ['Old Mission', 'oldmission.org'],
      ['Pinecone', 'pinecone.com'],
      ['honor', 'honor.com'],
      ['opal', 'opal.com'],
      ['Fireworks', 'fireworks.com'],
    ] as const) {
      assert.notStrictEqual(companyDomainFor(company), wrong, `${company} must never map to ${wrong}`);
    }

    assert.strictEqual(companyDomainFor('Old Mission'), 'oldmissioncapital.com');
    assert.strictEqual(companyDomainFor('Pinecone'), 'pinecone.io');
    assert.strictEqual(companyDomainFor('honor'), 'honorcare.com');
    assert.strictEqual(companyDomainFor('opal'), 'opal.dev');
    assert.strictEqual(companyDomainFor('Column'), 'column.com', 'og:site_name=Column is the proof');
    assert.strictEqual(companyDomainFor('Fireworks'), 'fireworks.ai');

    // No override was ever established for these two, so they stay absent and render an initial.
    for (const company of ['Depot', 'Knock']) {
      assert.strictEqual(companyDomainFor(company), null, `${company} is not safely resolvable by name`);
    }
  });

  test('no entry is a country redirect of itself', () => {
    // Resolved from Dubai, bitgo.com answers as bitgo.ae and airbnb.com as airbnb.ae. The map must
    // hold the canonical domain, not an accident of where the resolver ran.
    for (const [name, domain] of Object.entries(COMPANY_DOMAINS)) {
      assert.ok(!/\.(ae|de|fr|in|jp|co\.uk)$/.test(domain), `${name}: "${domain}" looks geo-localized`);
    }
  });

  test('no entry is a known domain-parking host', () => {
    for (const [name, domain] of Object.entries(COMPANY_DOMAINS)) {
      for (const parked of ['aftermarket.com', 'hugedomains.com', 'sedo.com', 'dan.com', 'afternic.com']) {
        assert.notStrictEqual(domain, parked, `${name} points at a domain broker`);
      }
    }
  });
});
