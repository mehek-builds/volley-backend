import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildJobCertificationFingerprint,
  normalizeJobCertificationDescription,
  normalizeJobCertificationTitle,
  normalizeJobIdentityText,
} from './jobCertificationFingerprint';

const base = {
  employer_name: 'Acme, Inc.',
  title: 'Senior Platform Engineer',
  description: 'Build reliable systems. Partner with product and security.',
};

test('cross-source aliases share one versioned certification fingerprint', () => {
  const first = buildJobCertificationFingerprint(base);
  const alias = buildJobCertificationFingerprint({
    ...base,
    employer_name: 'ACME',
    title: 'Senior Platform Engineer ',
    description: 'Build reliable systems.\n\nPartner with product and security.',
  });
  assert.equal(first, alias);
  assert.match(first ?? '', /^v1:[0-9a-f]{64}:[0-9a-f]{64}$/);
});

test('source presentation fields are excluded while material content remains distinct', () => {
  const original = buildJobCertificationFingerprint(base);
  const alternatePresentation = {
    ...base,
    location: 'Paris, France',
    country: 'France',
    remote: true,
    apply_url: 'https://another.example/apply',
  };
  assert.equal(original, buildJobCertificationFingerprint(alternatePresentation));
  assert.notEqual(original, buildJobCertificationFingerprint({ ...base, title: 'Senior C++ Engineer' }));
  assert.notEqual(original, buildJobCertificationFingerprint({
    ...base,
    description: 'Lead a different product engineering team and operating model.',
  }));
});

test('title separator punctuation cannot inflate one role while C++ and C# remain distinct', () => {
  const aliases = [
    'Senior Engineer - Platform',
    'Senior Engineer: Platform',
    'Senior Engineer | Platform',
    'Senior Engineer Platform',
  ];
  const fingerprints = aliases.map((title) => buildJobCertificationFingerprint({ ...base, title }));
  assert.equal(new Set(fingerprints).size, 1);
  assert.equal(normalizeJobCertificationTitle('Senior Engineer | Platform'), 'senior engineer platform');
  assert.notEqual(
    buildJobCertificationFingerprint({ ...base, title: 'Senior C++ Engineer' }),
    buildJobCertificationFingerprint({ ...base, title: 'Senior C Engineer' }),
  );
  assert.notEqual(
    buildJobCertificationFingerprint({ ...base, title: 'Senior C# Engineer' }),
    buildJobCertificationFingerprint({ ...base, title: 'Senior C Engineer' }),
  );
});

test('ATS markup, bullet punctuation, and labeled boilerplate cannot inflate aliases', () => {
  const providerA = buildJobCertificationFingerprint({
    ...base,
    description: [
      '<p>Build reliable systems.</p>',
      '<ul><li>Partner with product &amp; security</li></ul>',
      'Equal Opportunity Employer statement.',
      'Candidate privacy notice: https://tracking.example/candidate?id=123',
      'Powered by Greenhouse.',
    ].join('\n'),
  });
  const providerB = buildJobCertificationFingerprint({
    ...base,
    description: 'Build reliable systems - Partner with product & security.',
  });
  assert.equal(providerA, providerB);
  assert.equal(
    normalizeJobCertificationDescription('Use C++ for systems work.'),
    'use c++ for systems work',
  );
  assert.notEqual(providerA, buildJobCertificationFingerprint({
    ...base,
    description: 'Build reliable systems. Lead product and security as the engineering manager.',
  }));
});

test('Unicode employer identities remain nonempty and distinct', () => {
  assert.equal(normalizeJobIdentityText('Ελληνική Τράπεζα'), 'ελληνική τράπεζα');
  assert.notEqual(
    buildJobCertificationFingerprint({ ...base, employer_name: 'Ελληνική Τράπεζα' }),
    buildJobCertificationFingerprint({ ...base, employer_name: 'Τράπεζα Κύπρου' }),
  );
});

test('missing verified identity cannot mint a certification fingerprint', () => {
  assert.equal(buildJobCertificationFingerprint({ ...base, employer_name: ' ' }), null);
});
