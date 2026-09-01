import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evidenceDefect, icoContainsPng, servableImageType } from './logoEvidenceProbe';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

/** A minimal one-entry .ico whose payload is `data`. */
function ico(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(6 + 16 + data.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);
  view.setUint32(6 + 8, data.length, true);
  view.setUint32(6 + 12, 6 + 16, true);
  out.set(data, 6 + 16);
  return out;
}

describe('icoContainsPng', () => {
  test('finds an embedded PNG', () => {
    assert.equal(icoContainsPng(ico(PNG)), true);
  });

  test('a DIB payload is not a PNG', () => {
    /* The class the website route cannot render: half of real-world .ico files.
       Gensyn's favicon.ico was the live case on 2026-09-01. */
    assert.equal(icoContainsPng(ico(new Uint8Array([0x28, 0, 0, 0, 1, 1]))), false);
  });

  test('garbage and truncation are false, never a throw', () => {
    assert.equal(icoContainsPng(new Uint8Array(0)), false);
    assert.equal(icoContainsPng(new Uint8Array([0, 0, 1, 0, 9, 0])), false);
    assert.equal(icoContainsPng(PNG), false);
  });
});

describe('servableImageType', () => {
  test('trusts a plain image content type', () => {
    assert.equal(servableImageType('image/png', PNG), 'image/png');
    assert.equal(servableImageType('image/svg+xml; charset=utf-8', new Uint8Array([1])), 'image/svg+xml');
  });

  test('sniffs real image bytes served under a lying header', () => {
    /* Lever's S3 serves PNGs as application/octet-stream. */
    assert.equal(servableImageType('application/octet-stream', PNG), 'image/png');
    assert.equal(servableImageType(null, JPEG), 'image/jpeg');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    assert.equal(servableImageType('text/plain', svg), 'image/svg+xml');
  });

  test('an ico counts either way, preferring its embedded PNG', () => {
    /* role-quick-website#477 made the route serve a DIB-only container as image/x-icon, which
       browsers draw; before that it dropped them and this check refused them to match. */
    assert.equal(servableImageType('image/x-icon', ico(PNG)), 'image/png');
    assert.equal(servableImageType('image/x-icon', ico(new Uint8Array([0x28, 0]))), 'image/x-icon');
    /* Ico magic under a generic header still gets the ico rule. */
    assert.equal(
      servableImageType('application/octet-stream', ico(new Uint8Array([0x28, 0]))),
      'image/x-icon',
    );
  });

  test('an HTML error page with an image URL is not a logo', () => {
    const html = new TextEncoder().encode('<!doctype html><html><body>403</body></html>');
    assert.equal(servableImageType('text/html', html), null);
    assert.equal(servableImageType('image/x-icon', html), null);
  });
});

describe('evidenceDefect', () => {
  const good = {
    company_name: 'Zapier',
    career_url: 'https://jobs.ashbyhq.com/zapier',
    company_logo_url: 'https://app.ashbyhq.com/api/images/org-theme-logo/x.png',
    logo_verification_status: 'verified',
    rows: 3,
  };

  test('a verified source with an https URL is probeable', () => {
    assert.equal(evidenceDefect(good), null);
  });

  test('an unverified surfaced source is named as a gate breach', () => {
    assert.match(evidenceDefect({ ...good, logo_verification_status: 'pending' }) ?? '', /pending/);
    assert.match(evidenceDefect({ ...good, logo_verification_status: undefined }) ?? '', /null/);
  });

  test('missing or non-https evidence is a defect, not a fetch attempt', () => {
    assert.equal(evidenceDefect({ ...good, company_logo_url: null }), 'no evidence URL');
    assert.equal(evidenceDefect({ ...good, company_logo_url: '  ' }), 'no evidence URL');
    assert.equal(evidenceDefect({ ...good, company_logo_url: 'http://a.com/x.png' }), 'evidence URL is not https');
    assert.equal(evidenceDefect({ ...good, company_logo_url: 'not a url' }), 'evidence URL is unparseable');
  });
});
