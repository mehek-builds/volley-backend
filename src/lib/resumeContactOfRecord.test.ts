/* The resume header's location line.
 *
 * MEASURED 2026-08-11: `spec->'_contact'` carried neither `location` nor `city` on ANY of the 158
 * stored packets, so every resume Litos has generated went to an employer with no location in the
 * header, while "Current location" was separately a required-and-empty blocker on 9 of them. The
 * fact was on file the whole time: address_city and address_state are populated on this account.
 *
 * These tests pin both halves - that the value is assembled from the address she gave, and that it
 * actually reaches the rendered contact line rather than stopping at the interface.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { resumeContactOfRecord, resumeHeaderLocation } from './resumeContactOfRecord';
import { contactLine } from '../engine/resumeRender';

const LOS_ANGELES = { address_city: 'Los Angeles', address_state: 'CA' };

describe('resumeHeaderLocation', () => {
  test('city and state become one line', () => {
    assert.equal(resumeHeaderLocation(LOS_ANGELES), 'Los Angeles, CA');
  });

  /* The non-US shape. Country is used ONLY when there is no state, which is what keeps a US
   * address from printing "Los Angeles, CA, United States". */
  test('country stands in for a missing state', () => {
    assert.equal(
      resumeHeaderLocation({ address_city: 'Dubai', address_country: 'United Arab Emirates' }),
      'Dubai, United Arab Emirates',
    );
  });

  test('state wins over country when both are on file', () => {
    assert.equal(
      resumeHeaderLocation({ ...LOS_ANGELES, address_country: 'United States' }),
      'Los Angeles, CA',
    );
  });

  test('a city alone is a usable location', () => {
    assert.equal(resumeHeaderLocation({ address_city: 'Dubai' }), 'Dubai');
  });

  /* A bare state is not a location a reader can act on, and printing one would put "CA" alone in
   * the header. Nothing on file means nothing printed, which is the recoverable failure. */
  test('a state with no city prints nothing rather than a fragment', () => {
    assert.equal(resumeHeaderLocation({ address_state: 'CA' }), undefined);
    assert.equal(resumeHeaderLocation({}), undefined);
    assert.equal(resumeHeaderLocation(undefined), undefined);
  });

  test('whitespace-only values are not a location', () => {
    assert.equal(resumeHeaderLocation({ address_city: '   ', address_state: 'CA' }), undefined);
  });

  /* THE NEAR-MISS WORTH PINNING. parsed_json.school_location reads "Los Angeles, CA" for this
   * account, so reading it here would have produced the right string and the wrong rule: where
   * someone studies is not where they live. Only her own address answers this. */
  test('school_location is never used as the header location', () => {
    assert.equal(resumeHeaderLocation({ school_location: 'Los Angeles, CA' }), undefined);
  });
});

describe('resumeContactOfRecord', () => {
  test('the stored address fills a header the caller left blank', () => {
    const contact = resumeContactOfRecord({
      requested: { full_name: 'Test Applicant' },
      profile: LOS_ANGELES,
    });
    assert.equal(contact.location, 'Los Angeles, CA');
  });

  test('an explicit request wins, because it may be a deliberate per-application choice', () => {
    const contact = resumeContactOfRecord({
      requested: { full_name: 'Test Applicant', location: 'New York, NY' },
      profile: LOS_ANGELES,
    });
    assert.equal(contact.location, 'New York, NY');
  });

  test('no address anywhere leaves the field empty rather than inventing one', () => {
    const contact = resumeContactOfRecord({ requested: { full_name: 'Test Applicant' }, profile: {} });
    assert.equal(contact.location, undefined);
  });
});

describe('the location reaches the rendered resume', () => {
  /* THE JOINT THAT MATTERS. A field that is resolved and never printed is the same defect as one
   * that is collected and never read: the fact is on file and the employer still cannot see it.
   * contactLine is what renderResumePdf draws, so this is the printed header, not a proxy for it. */
  test('the header prints the location', () => {
    const line = contactLine({
      full_name: 'Test Applicant',
      email: 'test@example.com',
      location: 'Los Angeles, CA',
    });
    assert.match(line, /Los Angeles, CA/);
  });

  test('the location leads the contact line, ahead of the email', () => {
    const line = contactLine({
      full_name: 'Test Applicant',
      email: 'test@example.com',
      phone: '+971 567417451',
      location: 'Los Angeles, CA',
    });
    assert.ok(
      line.indexOf('Los Angeles, CA') < line.indexOf('test@example.com'),
      `location must come first in the contact line, got: ${line}`,
    );
  });

  test('the whole header assembles from a stored profile with nothing requested', () => {
    const line = contactLine(resumeContactOfRecord({
      requested: { full_name: 'Test Applicant' },
      accountEmail: 'test@example.com',
      profile: { ...LOS_ANGELES, phone: '+971 567417451' },
    }));
    assert.match(line, /Los Angeles, CA/);
    assert.match(line, /test@example\.com/);
  });

  test('a header with no location still renders the rest of the contact line', () => {
    const line = contactLine({ full_name: 'Test Applicant', email: 'test@example.com' });
    assert.match(line, /test@example\.com/);
    assert.doesNotMatch(line, /^\s*\|/);
  });
});
