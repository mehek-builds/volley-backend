import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

/* phone and the address columns are in ENCRYPTED_FIELDS, so encryptField needs a key. Set before
   the module graph loads, the same way the other crypto-touching suites do it. */
process.env.ENCRYPTION_KEY ??= 'contact-seed-test-encryption-key';

import { contactSeedFrom } from './profile';
import { resumeEmailForUpload } from '../lib/resumeEmail';
import { decryptField } from '../lib/fieldCrypto';

/* THE CONTACT BLOCK THE RESUME ALREADY PRINTS, into the row the resume header reads.
 *
 * engine/resumeRender.ts has always had a header for location, email, phone and three links, and
 * the only thing that ever filled it was the Settings form. A student who had just uploaded a
 * resume with their email and city under their name got a generated resume with neither. That
 * file's own comment measures the result: not one of 158 stored packets carried a location.
 */

describe('what the parse may fill in', () => {
  test('every contact field the resume printed reaches the row', () => {
    const seed = contactSeedFrom(
      {
        phone: '(512) 555-0142',
        location: 'Austin, TX',
        linkedin_url: 'linkedin.com/in/dfuentes',
        github_url: 'github.com/dfuentes',
        portfolio_url: 'diegobuilds.dev',
      },
      undefined,
    );
    assert.equal(decryptField(seed.address_city), 'Austin');
    assert.equal(decryptField(seed.address_state), 'TX');
    assert.equal(decryptField(seed.phone), '(512) 555-0142');
    // The three links are plaintext on purpose: published things, not identity facts.
    assert.equal(seed.linkedin_url, 'linkedin.com/in/dfuentes');
    assert.equal(seed.github_url, 'github.com/dfuentes');
    assert.equal(seed.portfolio_url, 'diegobuilds.dev');
  });

  test('a location that is not a clean "City, State" goes in whole as the city', () => {
    /* The header prints address_city first. "Austin" is right; "Austin, TX 78701" split across the
       wrong columns is wrong on every form that reads them. */
    const seed = contactSeedFrom({ location: 'London, United Kingdom, EC2A' }, undefined);
    assert.equal(decryptField(seed.address_city), 'London, United Kingdom, EC2A');
    assert.equal(seed.address_state, undefined);
  });

  test('nothing on the resume writes nothing', () => {
    assert.deepEqual(contactSeedFrom({}, undefined), {});
    assert.deepEqual(contactSeedFrom({ phone: '   ', location: '' }, undefined), {});
  });
});

describe('seed never overwrites', () => {
  test('a value the student typed in Settings survives their next upload', () => {
    /* Their correction, and the same rule academicSeedFrom and resume_email already keep. */
    const seed = contactSeedFrom(
      { phone: '(512) 555-0142', location: 'Austin, TX', linkedin_url: 'linkedin.com/in/parsed' },
      { phone: 'held', address_city: 'held', linkedin_url: 'linkedin.com/in/curated' },
    );
    assert.equal(seed.phone, undefined, 'a held phone was overwritten by the parse');
    assert.equal(seed.address_city, undefined, 'a held city was overwritten by the parse');
    assert.equal(seed.linkedin_url, undefined, 'a held link was overwritten by the parse');
    // The one field they had NOT filled is still seeded.
    assert.equal(decryptField(seed.address_state), 'TX');
  });
});

describe('the address printed on the resume is the last rung for resume_email', () => {
  test('a guest, who has neither a typed value nor a login email, gets the one on their resume', () => {
    /* The dead end this closes: a guest reached the build with no email anywhere and was told to
       add one in Account, which had none either. Their resume prints one under their name. */
    assert.equal(
      resumeEmailForUpload(undefined, undefined, 'priya.raghavan@example.edu'),
      'priya.raghavan@example.edu',
    );
  });

  test('the verified login email still outranks it', () => {
    /* A resume can carry a stale university address; the login email is one Litos can route through
       and the student proved they hold. */
    assert.equal(
      resumeEmailForUpload(undefined, 'signed.up@example.edu', 'old.address@example.edu'),
      'signed.up@example.edu',
    );
  });

  test('and their own typed value outranks both', () => {
    assert.equal(
      resumeEmailForUpload({ resume_email: 'typed@example.edu' }, 'signed.up@example.edu', 'onresume@example.edu'),
      'typed@example.edu',
    );
  });

  test('an unusable address on the resume is ignored rather than printed', () => {
    assert.equal(resumeEmailForUpload(undefined, undefined, 'not an address'), undefined);
  });
});
