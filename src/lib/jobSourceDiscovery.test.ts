import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATS_SCRAPERS_ATS_FAMILIES,
  ATS_SCRAPERS_COMPLETENESS_MAXIMUMS,
  ATS_SCRAPERS_SOURCE_CATALOG_URLS,
  ATS_SCRAPERS_SOURCE_DISCOVERY_CANDIDATE_METHOD,
  clearJobSourceDiscoveryCacheForTest,
  discoverJobSources,
  FREEHIRE_ATS_FAMILIES,
  FREEHIRE_COMPLETENESS_MAXIMUMS,
  FREEHIRE_SOURCE_CATALOG_URLS,
  FREEHIRE_SOURCE_DISCOVERY_CANDIDATE_METHOD,
  OPEN_JOBS_COMPLETENESS_MAXIMUMS,
  OPEN_JOBS_REQUIRED_FAMILIES,
  parseDiscoveredJobSources,
  parseAtsScrapersJobSources,
  parseFreehireJobSources,
  SOURCE_DISCOVERY_CANDIDATE_METHOD,
  sourceCareerUrl,
  type AtsScrapersAtsFamily,
  type FreehireAtsFamily,
  type OpenJobsRequiredFamily,
} from './jobSourceDiscovery';
import { POLLABLE_JOB_BOARDS } from './jobMonitor';

const oneOpenJobsMinimum = Object.fromEntries(
  OPEN_JOBS_REQUIRED_FAMILIES.map((family) => [family, 1]),
) as Record<OpenJobsRequiredFamily, number>;
const oneFreehireMinimum = Object.fromEntries(
  FREEHIRE_ATS_FAMILIES.map((family) => [family, 1]),
) as Record<FreehireAtsFamily, number>;
const oneOpenJobsMaximum = Object.fromEntries(
  OPEN_JOBS_REQUIRED_FAMILIES.map((family) => [family, 1]),
) as Record<OpenJobsRequiredFamily, number>;
const oneFreehireMaximum = Object.fromEntries(
  FREEHIRE_ATS_FAMILIES.map((family) => [family, 1]),
) as Record<FreehireAtsFamily, number>;
const oneAtsScrapersMinimum = Object.fromEntries(
  ATS_SCRAPERS_ATS_FAMILIES.map((family) => [family, 1]),
) as Record<AtsScrapersAtsFamily, number>;
const oneAtsScrapersMaximum = Object.fromEntries(
  ATS_SCRAPERS_ATS_FAMILIES.map((family) => [family, 1]),
) as Record<AtsScrapersAtsFamily, number>;

function completeOpenJobsPayload(overrides: Record<string, unknown> = {}) {
  return {
    ats: {
      ...Object.fromEntries(OPEN_JOBS_REQUIRED_FAMILIES.map((family) => [family, [`open-${family}`]])),
      ...overrides,
    },
  };
}

function freehireFixture(family: FreehireAtsFamily, token = `freehire-${family}`): string {
  return `# ${family} boards\n- company: Freehire ${family}\n  board: ${token}\n`;
}

function atsScrapersFixture(
  family: AtsScrapersAtsFamily,
  token = `ats-${family}`,
): string {
  return `name,slug,url\n"ATS, ${family}",${token},${sourceCareerUrl(family, token)}\n`;
}

function catalogFetcher(
  openJobsPayload: unknown,
  missingFreehire?: FreehireAtsFamily,
  calls?: string[],
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls?.push(url);
    if (url === 'https://catalog.test/slugs.json') {
      return new Response(JSON.stringify(openJobsPayload), { status: 200 });
    }
    const family = FREEHIRE_ATS_FAMILIES.find((candidate) => (
      FREEHIRE_SOURCE_CATALOG_URLS[candidate] === url
    ));
    if (family) {
      if (family === missingFreehire) return new Response('missing', { status: 404 });
      return new Response(freehireFixture(family, family === 'greenhouse' ? 'open-greenhouse' : undefined), {
        status: 200,
      });
    }
    const atsScrapersFamily = ATS_SCRAPERS_ATS_FAMILIES.find((candidate) => (
      ATS_SCRAPERS_SOURCE_CATALOG_URLS[candidate] === url
    ));
    if (atsScrapersFamily) return new Response(atsScrapersFixture(atsScrapersFamily), { status: 200 });
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
}

test('open-jobs discovery normalizes tokens, deduplicates casing, and omits unexecutable rows', () => {
  const sources = parseDiscoveredJobSources({ ats: {
    greenhouse: ['Acme', 'acme', '../bad', 'two words'],
    lever: ['LEVER-co'],
    breezy: ['valid-label', 'not.a.label'],
    smartrecruiters: ['blocked'],
    paylocity: ['blocked'],
  } });
  assert.deepEqual(sources.map((source) => `${source.ats_name}/${source.board_token}`), [
    'greenhouse/acme',
    'lever/lever-co',
    'breezy/valid-label',
  ]);
  assert.ok(sources.every((source) => (POLLABLE_JOB_BOARDS as readonly string[]).includes(source.ats_name)));
  assert.ok(sources.every((source) => source.logo_verification_status === 'unverified'));
  assert.ok(sources.every((source) => source.logo_verification_method === SOURCE_DISCOVERY_CANDIDATE_METHOD));
  assert.throws(() => parseDiscoveredJobSources({ ats: { greenhouse: ['../bad'] } }), /no pollable boards/);
});

test('discovery builds strict first-party career URLs for every current family', () => {
  const ats = Object.fromEntries(POLLABLE_JOB_BOARDS.map((family) => [family, ['sample']]));
  const sources = parseDiscoveredJobSources({ ats });
  const urls = Object.fromEntries(sources.map((source) => [source.ats_name, source.career_url]));
  assert.equal(urls.greenhouse, 'https://boards.greenhouse.io/sample');
  assert.equal(urls.lever, 'https://jobs.lever.co/sample');
  assert.equal(urls.ashby, 'https://jobs.ashbyhq.com/sample');
  assert.equal(urls.workable, 'https://apply.workable.com/sample');
  assert.equal(urls.rippling, 'https://ats.rippling.com/sample/jobs');
  assert.equal(urls.breezy, 'https://sample.breezy.hr');
  assert.equal(urls.recruitee, 'https://sample.recruitee.com');
  assert.equal(urls.crelate, 'https://jobs.crelate.com/portal/sample');
});

test('Freehire parser accepts only its bounded schema and omits ambiguous or unsupported regional boards', () => {
  const sources = parseFreehireJobSources('ashby', `
# source catalog
- company: Acme
  board: ACME
- company: "Encoded Company"
  board: Encoded%20Board
- company: encoded company
  board: Encoded Board
- company: First claimant
  board: conflict
- company: Second claimant
  board: CONFLICT
- company: EU only
  board: eu-only
  region: eu
`);
  assert.deepEqual(sources.map((source) => source.board_token), ['acme']);
  assert.equal(sources[0]?.career_url, 'https://jobs.ashbyhq.com/acme');
  assert.ok(sources.every((source) => (
    source.logo_verification_method === FREEHIRE_SOURCE_DISCOVERY_CANDIDATE_METHOD
  )));
  assert.throws(
    () => parseFreehireJobSources('lever', '- company: Acme\n  board: acme\n  unknown: value\n'),
    /Unsupported Freehire YAML at line 3/,
  );
  assert.throws(
    () => parseFreehireJobSources('lever', '- company: Acme\n'),
    /has no board/,
  );
});

test('ats-scrapers parser accepts strict CSV and exact first-party tenant URLs only', () => {
  const sources = parseAtsScrapersJobSources('rippling', [
    'name,slug,url',
    '"Acme, Inc.",Acme,https://ats.rippling.com/acme/jobs',
    'First claimant,conflict,https://ats.rippling.com/conflict/jobs',
    'Second claimant,CONFLICT,https://ats.rippling.com/conflict/jobs',
    'Wrong tenant,expected,https://ats.rippling.com/other/jobs',
    'Lookalike,lookalike,https://ats.rippling.com.evil.example/lookalike/jobs',
    'Query,query,https://ats.rippling.com/query/jobs?source=bad',
    '',
  ].join('\n'));

  assert.deepEqual(sources.map((source) => source.board_token), ['acme']);
  assert.equal(sources[0]?.company_name, 'Acme, Inc.');
  assert.equal(sources[0]?.career_url, 'https://ats.rippling.com/acme/jobs');
  assert.equal(
    sources[0]?.logo_verification_method,
    ATS_SCRAPERS_SOURCE_DISCOVERY_CANDIDATE_METHOD,
  );
  assert.throws(
    () => parseAtsScrapersJobSources('lever', 'company,slug,url\nAcme,acme,https://jobs.lever.co/acme\n'),
    /unsupported header/,
  );
  assert.throws(
    () => parseAtsScrapersJobSources('lever', 'name,slug,url\n"Acme,acme,https://jobs.lever.co/acme\n'),
    /unterminated quoted field/,
  );
});

test('complete remote catalogs produce a trusted result, merge provisional names, and cache the result', async () => {
  clearJobSourceDiscoveryCacheForTest();
  const calls: string[] = [];
  const fetcher = catalogFetcher(completeOpenJobsPayload(), undefined, calls);
  const options = {
    openJobsMinimums: oneOpenJobsMinimum,
    freehireMinimums: oneFreehireMinimum,
    atsScrapersMinimums: oneAtsScrapersMinimum,
  };
  const first = await discoverJobSources(fetcher, 'https://catalog.test/slugs.json', 1_000, options);
  const second = await discoverJobSources(fetcher, 'https://catalog.test/slugs.json', 2_000, options);

  assert.equal(calls.length, 14);
  assert.equal(first, second);
  assert.equal(first.trustedComplete, true);
  assert.equal(first.provenance.openJobs.complete, true);
  assert.equal(first.provenance.freehire.complete, true);
  assert.equal(first.provenance.atsScrapers.complete, true);
  assert.equal(first.provenance.atsScrapers.files.rippling.sourceCount, 1);
  assert.equal(first.provenance.freehire.files.recruitee.fetched, true);
  const greenhouse = first.sources.find((source) => (
    source.ats_name === 'greenhouse' && source.board_token === 'open-greenhouse'
  ));
  assert.equal(greenhouse?.company_name, 'Freehire greenhouse');
  assert.equal(greenhouse?.logo_verification_method, FREEHIRE_SOURCE_DISCOVERY_CANDIDATE_METHOD);
  assert.ok(first.sources.every((source) => source.board_token === source.board_token.toLowerCase()));
  assert.equal(first.candidateSources.length, first.sources.length);
});

test('syntactically valid partial catalogs expose candidates but cannot activate additions', async () => {
  clearJobSourceDiscoveryCacheForTest();
  const result = await discoverJobSources(
    catalogFetcher({ ats: { greenhouse: ['acme'] } }),
    'https://catalog.test/slugs.json',
    1_000,
    { openJobsMinimums: oneOpenJobsMinimum, freehireMinimums: oneFreehireMinimum },
  );
  assert.equal(result.provenance.openJobs.fetched, true);
  assert.equal(result.provenance.openJobs.complete, false);
  assert.equal(result.provenance.freehire.complete, true);
  assert.equal(result.trustedComplete, false);
  assert.ok(result.candidateSources.length > 0, 'partial candidates remain visible for diagnostics');
  assert.equal(result.sources.length, 0, 'partial candidates must not reach the source upsert path');
});

test('every Freehire file is required before discovery is trusted complete', async () => {
  clearJobSourceDiscoveryCacheForTest();
  const result = await discoverJobSources(
    catalogFetcher(completeOpenJobsPayload(), 'recruitee'),
    'https://catalog.test/slugs.json',
    1_000,
    { openJobsMinimums: oneOpenJobsMinimum, freehireMinimums: oneFreehireMinimum },
  );
  assert.equal(result.provenance.openJobs.complete, true);
  assert.equal(result.provenance.freehire.complete, false);
  assert.equal(result.provenance.freehire.files.recruitee.fetched, false);
  assert.match(result.provenance.freehire.files.recruitee.error ?? '', /HTTP 404/);
  assert.equal(result.trustedComplete, false);
  assert.equal(result.sources.length, 0);
  assert.ok(result.candidateSources.length > 0);
});

test('a publisher spike above a per-family ceiling fails trust and activates nothing', async () => {
  clearJobSourceDiscoveryCacheForTest();
  const result = await discoverJobSources(
    catalogFetcher(completeOpenJobsPayload({ greenhouse: ['first', 'second'] })),
    'https://catalog.test/slugs.json',
    1_000,
    {
      openJobsMinimums: oneOpenJobsMinimum,
      openJobsMaximums: oneOpenJobsMaximum,
      freehireMinimums: oneFreehireMinimum,
    },
  );

  assert.equal(result.provenance.openJobs.fetched, true);
  assert.equal(result.provenance.openJobs.complete, false);
  assert.match(result.provenance.openJobs.error ?? '', /greenhouse:2 outside 1-1/);
  assert.equal(result.trustedComplete, false);
  assert.equal(result.sources.length, 0);
  assert.ok(result.candidateSources.some((source) => source.board_token === 'second'));
});

test('an oversized Rippling family cannot bypass catalog trust bounds', async () => {
  clearJobSourceDiscoveryCacheForTest();
  const result = await discoverJobSources(
    catalogFetcher(completeOpenJobsPayload({ rippling: ['rippling-first', 'rippling-second'] })),
    'https://catalog.test/slugs.json',
    1_000,
    {
      openJobsMinimums: oneOpenJobsMinimum,
      openJobsMaximums: oneOpenJobsMaximum,
      freehireMinimums: oneFreehireMinimum,
    },
  );

  assert.equal(result.provenance.openJobs.complete, false);
  assert.match(result.provenance.openJobs.error ?? '', /rippling:2 outside 1-1/);
  assert.equal(result.trustedComplete, false);
  assert.equal(result.sources.length, 0);
});

test('one anomalous ats-scrapers family is rejected without poisoning trusted families', async () => {
  clearJobSourceDiscoveryCacheForTest();
  const baseFetcher = catalogFetcher(completeOpenJobsPayload());
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === ATS_SCRAPERS_SOURCE_CATALOG_URLS.rippling) {
      return new Response([
        atsScrapersFixture('rippling', 'rippling-first').trimEnd(),
        'Rippling second,rippling-second,https://ats.rippling.com/rippling-second/jobs',
        '',
      ].join('\n'), { status: 200 });
    }
    return baseFetcher(input);
  }) as typeof fetch;
  const result = await discoverJobSources(fetcher, 'https://catalog.test/slugs.json', 1_000, {
    openJobsMinimums: oneOpenJobsMinimum,
    freehireMinimums: oneFreehireMinimum,
    atsScrapersMinimums: oneAtsScrapersMinimum,
    atsScrapersMaximums: oneAtsScrapersMaximum,
  });

  assert.equal(result.trustedComplete, false);
  assert.equal(result.provenance.atsScrapers.files.rippling.complete, false);
  assert.match(result.provenance.atsScrapers.files.rippling.error ?? '', /outside trusted range 1-1/);
  assert.ok(result.candidateSources.some((source) => source.board_token === 'rippling-second'));
  assert.ok(!result.sources.some((source) => source.board_token === 'rippling-second'));
  for (const family of ATS_SCRAPERS_ATS_FAMILIES.filter((value) => value !== 'rippling')) {
    assert.ok(result.sources.some((source) => source.board_token === `ats-${family}`));
  }
});

test('a Freehire family spike fails the whole snapshot instead of activating the other files', async () => {
  clearJobSourceDiscoveryCacheForTest();
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://catalog.test/slugs.json') {
      return new Response(JSON.stringify(completeOpenJobsPayload()), { status: 200 });
    }
    const family = FREEHIRE_ATS_FAMILIES.find((candidate) => (
      FREEHIRE_SOURCE_CATALOG_URLS[candidate] === url
    ));
    if (!family) return new Response('missing', { status: 404 });
    const yaml = family === 'lever'
      ? `${freehireFixture(family, 'lever-first')}- company: Lever second\n  board: lever-second\n`
      : freehireFixture(family);
    return new Response(yaml, { status: 200 });
  }) as typeof fetch;
  const result = await discoverJobSources(fetcher, 'https://catalog.test/slugs.json', 1_000, {
    openJobsMinimums: oneOpenJobsMinimum,
    freehireMinimums: oneFreehireMinimum,
    freehireMaximums: oneFreehireMaximum,
  });

  assert.equal(result.provenance.freehire.complete, false);
  assert.equal(result.provenance.freehire.files.lever.fetched, true);
  assert.equal(result.provenance.freehire.files.lever.complete, false);
  assert.match(result.provenance.freehire.files.lever.error ?? '', /outside trusted range 1-1/);
  assert.equal(result.trustedComplete, false);
  assert.equal(result.sources.length, 0);
  assert.ok(result.candidateSources.some((source) => source.board_token === 'lever-second'));
});

test('default trust ceilings remain above their corresponding completeness floors', () => {
  for (const family of OPEN_JOBS_REQUIRED_FAMILIES) {
    assert.ok(OPEN_JOBS_COMPLETENESS_MAXIMUMS[family] > oneOpenJobsMinimum[family]);
  }
  for (const family of FREEHIRE_ATS_FAMILIES) {
    assert.ok(FREEHIRE_COMPLETENESS_MAXIMUMS[family] > oneFreehireMinimum[family]);
  }
  for (const family of ATS_SCRAPERS_ATS_FAMILIES) {
    assert.ok(ATS_SCRAPERS_COMPLETENESS_MAXIMUMS[family] > oneAtsScrapersMinimum[family]);
  }
});

test('malformed and oversized remote catalogs fail closed without erasing successful sources', async () => {
  clearJobSourceDiscoveryCacheForTest();
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://catalog.test/slugs.json') {
      return new Response('{}', { status: 200 });
    }
    const family = FREEHIRE_ATS_FAMILIES.find((candidate) => FREEHIRE_SOURCE_CATALOG_URLS[candidate] === url);
    if (!family) return new Response('missing', { status: 404 });
    return new Response(freehireFixture(family), { status: 200 });
  }) as typeof fetch;
  const result = await discoverJobSources(
    fetcher,
    'https://catalog.test/slugs.json',
    1_000,
    { openJobsMinimums: oneOpenJobsMinimum, freehireMinimums: oneFreehireMinimum },
  );
  assert.equal(result.trustedComplete, false);
  assert.match(result.provenance.openJobs.error ?? '', /no ATS map/);
  assert.equal(result.sources.length, 0);
  assert.equal(result.candidateSources.length, FREEHIRE_ATS_FAMILIES.length);

  assert.throws(
    () => parseFreehireJobSources('greenhouse', 'x'.repeat(1024 * 1024 + 1)),
    /exceeds the byte limit/,
  );
});
