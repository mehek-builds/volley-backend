import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  jobExtractBodySchema,
  clipJdText,
  jobDescriptionSourceUrl,
  MAX_JD_TEXT_CHARS,
} from './jobExtract';

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

describe('jobDescriptionSourceUrl', () => {
  test('reads an exact Workable application URL from its job overview instead of the candidate form', () => {
    assert.equal(
      jobDescriptionSourceUrl('https://apply.workable.com/remote-recruitment/j/D4CA268A39/apply/'),
      'https://apply.workable.com/remote-recruitment/j/D4CA268A39/',
    );
  });

  test('drops application-form tracking state when moving to the Workable overview', () => {
    assert.equal(
      jobDescriptionSourceUrl(
        'https://apply.workable.com/remote-recruitment/j/D4CA268A39/apply?utm_source=board#application',
      ),
      'https://apply.workable.com/remote-recruitment/j/D4CA268A39/',
    );
  });

  test('reads an exact bare Workable account-feed application URL from its job overview', () => {
    assert.equal(
      jobDescriptionSourceUrl('https://apply.workable.com/j/57B10F8875/apply'),
      'https://apply.workable.com/j/57B10F8875/',
    );
  });

  test('drops query and fragment state from an exact bare Workable application URL', () => {
    assert.equal(
      jobDescriptionSourceUrl('https://apply.workable.com/j/57B10F8875/apply/?source=feed#application'),
      'https://apply.workable.com/j/57B10F8875/',
    );
  });

  test('does not rewrite non-form Workable paths or other origins', () => {
    for (const url of [
      'https://apply.workable.com/remote-recruitment/j/D4CA268A39/',
      'https://apply.workable.com/remote-recruitment/j/D4CA268A39/apply/extra',
      'https://apply.workable.com/j/57B10F8875/?source=feed#overview',
      'https://apply.workable.com/j/57B10F8875/apply/extra?source=feed#application',
      'https://apply.workable.com/remote-recruitment/jobs/view/D4CA268A39',
      'https://apply.workable.com:444/remote-recruitment/j/D4CA268A39/apply',
      'https://www.workable.com/remote-recruitment/j/D4CA268A39/apply',
      'https://example.com/remote-recruitment/j/D4CA268A39/apply',
    ]) {
      assert.equal(jobDescriptionSourceUrl(url), url);
    }
  });
});
