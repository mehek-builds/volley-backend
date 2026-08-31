import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATALOG_DOMAIN_CANDIDATE_METHOD,
  catalogBrandedJobSources,
  parseCatalogBrandedJobSources,
} from './jobSourceBrandCatalog';

test('generated brand catalog is large, unique, and remains explicitly unverified', () => {
  const sources = catalogBrandedJobSources();
  assert.ok(sources.length >= 10_000, `expected at least 10,000 branded boards, got ${sources.length}`);
  assert.equal(new Set(sources.map((source) => `${source.ats_name}/${source.board_token.toLowerCase()}`)).size, sources.length);
  assert.deepEqual(
    [...new Set(sources.map((source) => source.ats_name))].sort(),
    ['ashby', 'breezy', 'crelate', 'greenhouse', 'lever', 'recruitee', 'rippling', 'workable'],
  );
  assert.ok(sources.some((source) => source.ats_name === 'rippling'));
  assert.ok(sources.every((source) => !source.company_domain.startsWith('www.')));
  assert.ok(sources.every((source) => source.logo_verification_status === 'unverified'));
  assert.ok(sources.every((source) => source.logo_verification_method === CATALOG_DOMAIN_CANDIDATE_METHOD));
  assert.ok(sources.every((source) => source.logo_verified_at === null));
});

test('catalog parser fails closed on malformed or duplicate brand claims', () => {
  const valid = {
    ats_name: 'greenhouse',
    board_token: 'acme',
    company_name: 'Acme',
    company_domain: 'acme.example',
  };
  assert.throws(() => parseCatalogBrandedJobSources([{ ...valid, company_domain: 'https://acme.example' }]), /Invalid/);
  assert.throws(() => parseCatalogBrandedJobSources([{ ...valid, ats_name: 'workday' }]), /Invalid/);
  assert.throws(() => parseCatalogBrandedJobSources([{ ...valid, board_token: 'acme/other' }]), /Invalid/);
  assert.throws(() => parseCatalogBrandedJobSources([valid, valid]), /Duplicate/);
});

test('catalog parser stores the exact normalized executable token', () => {
  const [source] = parseCatalogBrandedJobSources([{
    ats_name: 'greenhouse',
    board_token: 'Acme%2DJobs',
    company_name: 'Acme',
    company_domain: 'acme.example',
  }]);
  assert.equal(source.board_token, 'acme-jobs');
});
