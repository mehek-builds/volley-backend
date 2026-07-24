import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { jobExtractBodySchema, clipJdText, MAX_JD_TEXT_CHARS } from './jobExtract';

// POST /jobs/extract lets "New application" go from a pasted URL to a reviewable JD without a
// side-channel copy-paste step (2026-07-24 product decision). No live network/DB in the test env
// per this repo's convention, so these pin the two pure pieces: the request schema and the
// text-bounding helper the route applies to whatever the managed browser returns.

describe('jobExtractBodySchema', () => {
  test('accepts a valid https URL', () => {
    const r = jobExtractBodySchema.safeParse({ job_url: 'https://jobs.ashbyhq.com/ctgt/abc123' });
    assert.equal(r.success, true);
  });

  test('rejects a non-URL string', () => {
    const r = jobExtractBodySchema.safeParse({ job_url: 'not a url' });
    assert.equal(r.success, false);
  });

  test('rejects a missing job_url', () => {
    const r = jobExtractBodySchema.safeParse({});
    assert.equal(r.success, false);
  });

  test('rejects an over-length URL', () => {
    const long = 'https://example.com/' + 'a'.repeat(2000);
    const r = jobExtractBodySchema.safeParse({ job_url: long });
    assert.equal(r.success, false);
  });

  // http:// passes the schema's z.url() check; the route rejects it separately with an explicit
  // protocol check (new URL(...).protocol !== 'https:') so the managed browser is never pointed at
  // a plaintext origin. That check lives in the handler, not the schema, so it is not re-asserted
  // here.
});

describe('clipJdText', () => {
  test('trims surrounding whitespace', () => {
    assert.equal(clipJdText('  Software Engineer Intern  \n'), 'Software Engineer Intern');
  });

  test('passes short text through unchanged', () => {
    assert.equal(clipJdText('Short JD'), 'Short JD');
  });

  test('caps at MAX_JD_TEXT_CHARS so an oversized page cannot blow past resume/generate\'s jd_text cap', () => {
    const huge = 'x'.repeat(MAX_JD_TEXT_CHARS + 5000);
    const clipped = clipJdText(huge);
    assert.equal(clipped.length, MAX_JD_TEXT_CHARS);
  });

  test('undefined/null/empty all become an empty string, not a thrown error', () => {
    assert.equal(clipJdText(undefined), '');
    assert.equal(clipJdText(null), '');
    assert.equal(clipJdText(''), '');
  });
});
