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

  test('employers whose domain is not simply their name are correct', () => {
    assert.strictEqual(companyDomainFor('Datadog'), 'datadoghq.com');
    assert.strictEqual(companyDomainFor('Notion'), 'notion.so');
    assert.strictEqual(companyDomainFor('Match Group'), 'mtch.com');
    assert.strictEqual(companyDomainFor('IMC Trading'), 'imc.com');
    assert.strictEqual(companyDomainFor('Khan Academy'), 'khanacademy.org');
    assert.strictEqual(companyDomainFor('Twitch'), 'twitch.tv');
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
