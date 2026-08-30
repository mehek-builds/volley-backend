import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeExecutableAtsBoardToken } from './atsBoardToken';

test('path-segment ATS families accept bounded ASCII slugs and normalize percent encoding', () => {
  for (const atsName of ['greenhouse', 'lever', 'ashby', 'workable', 'rippling', 'crelate'] as const) {
    assert.equal(normalizeExecutableAtsBoardToken(atsName, '  Acme_Co.v2~west  '), 'acme_co.v2~west');
    assert.equal(normalizeExecutableAtsBoardToken(atsName, 'Acme%2DJobs'), 'acme-jobs');
    assert.equal(normalizeExecutableAtsBoardToken(atsName, `a${'b'.repeat(127)}z`), null);
    assert.equal(normalizeExecutableAtsBoardToken(atsName, 'two words'), null);
    assert.equal(normalizeExecutableAtsBoardToken(atsName, '../tenant'), null);
    assert.equal(normalizeExecutableAtsBoardToken(atsName, 'tenant/other'), null);
    assert.equal(normalizeExecutableAtsBoardToken(atsName, 'tenant?mode=json'), null);
    assert.equal(normalizeExecutableAtsBoardToken(atsName, 'tenant.'), null);
    assert.equal(normalizeExecutableAtsBoardToken(atsName, '%2Fetc%2Fpasswd'), null);
  }
});

test('path-segment ATS tokens are capped at 128 characters', () => {
  assert.equal(
    normalizeExecutableAtsBoardToken('greenhouse', `a${'b'.repeat(126)}z`),
    `a${'b'.repeat(126)}z`,
  );
  assert.equal(normalizeExecutableAtsBoardToken('greenhouse', `a${'b'.repeat(127)}z`), null);
});

test('hostname ATS families require one complete DNS label', () => {
  const longest = `a${'b'.repeat(61)}z`;
  for (const atsName of ['breezy', 'recruitee'] as const) {
    assert.equal(normalizeExecutableAtsBoardToken(atsName, 'Acme-Jobs'), 'acme-jobs');
    assert.equal(normalizeExecutableAtsBoardToken(atsName, longest), longest);
    assert.equal(normalizeExecutableAtsBoardToken(atsName, `${longest}z`), null);
    assert.equal(normalizeExecutableAtsBoardToken(atsName, '-tenant'), null);
    assert.equal(normalizeExecutableAtsBoardToken(atsName, 'tenant-'), null);
    assert.equal(normalizeExecutableAtsBoardToken(atsName, 'tenant.other'), null);
    assert.equal(normalizeExecutableAtsBoardToken(atsName, 'tenant_name'), null);
  }
});

test('non-string and malformed encoded tokens fail closed', () => {
  assert.equal(normalizeExecutableAtsBoardToken('lever', null), null);
  assert.equal(normalizeExecutableAtsBoardToken('lever', 42), null);
  assert.equal(normalizeExecutableAtsBoardToken('lever', ''), null);
  assert.equal(normalizeExecutableAtsBoardToken('lever', '%E0%A4%A'), null);
});
