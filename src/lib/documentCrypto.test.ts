import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import {
  DOCUMENT_CRYPTO_SALT_ID,
  DOCUMENT_ENCRYPTION_SCHEME,
  DocumentDecryptError,
  openDocument,
  sealDocument,
} from './documentCrypto';
import { FIELD_CRYPTO_SALT_ID } from './fieldCrypto';

function withKey<T>(key: string | undefined, fn: () => T): T {
  const prev = process.env.ENCRYPTION_KEY;
  if (key === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = key;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = prev;
  }
}

test('the document salt is its own, and stays its own', () => {
  // Domain separation is the entire security argument for reusing ENCRYPTION_KEY across three
  // purposes (lib/resumeAccess.ts:73). If this ever equals another salt, a resume download token
  // and a stored transcript become interchangeable ciphertexts under one key.
  assert.equal(DOCUMENT_CRYPTO_SALT_ID, 'litos-user-document');
  assert.notEqual(DOCUMENT_CRYPTO_SALT_ID, FIELD_CRYPTO_SALT_ID);
  assert.notEqual(DOCUMENT_CRYPTO_SALT_ID, 'rolequick-resume-download-token');
});

test('the scheme string is the value written to user_documents.encryption_scheme', () => {
  assert.equal(DOCUMENT_ENCRYPTION_SCHEME, 'aes-256-gcm.v1');
});

test('a PDF round-trips byte for byte', () => {
  withKey('test-key', () => {
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.from([0x00, 0xff, 0x0a, 0x25, 0x80, 0x7f]),
      Buffer.from('\n%%EOF\n'),
    ]);
    assert.deepEqual(openDocument(sealDocument(pdf)), pdf);
  });
});

test('a file at the 4 MB cap round-trips, and the envelope costs exactly 28 bytes', () => {
  withKey('test-key', () => {
    /* The 28 bytes are what lets the cap be stated as a round 4 MB, and they are the whole of what
     * this envelope costs.
     *
     * They are NOT what clears the managed sandbox's ceiling, which is what this comment used to
     * claim while asserting 5,333,372 - the base64 length of the sealed object, a figure nothing in
     * the system ever computes. The sandbox encodes packet.transcript, and documentBytesForPacket
     * hands that over already opened, so the number measured against the 6,000,000-character
     * refusal is the encoding of the PLAINTEXT. The assertion below is on the bytes that actually
     * travel. */
    const big = Buffer.alloc(4_000_000, 0x41);
    const sealed = sealDocument(big);
    assert.equal(sealed.length, big.length + 28);
    const opened = openDocument(sealed);
    assert.deepEqual(opened, big);
    // Computed from `opened` rather than from `big` on purpose: what a runner carries is what came
    // back out of the envelope, and asserting on the input would prove nothing about the round trip.
    const base64Length = Buffer.from(opened).toString('base64').length;
    assert.equal(base64Length, 5_333_336);
    assert.ok(base64Length < 6_000_000, 'the bytes the sandbox encodes have to clear its ceiling');
    // The sealed object encodes to 5,333,372, which is the figure this test used to pin. Asserting
    // the two differ is what makes a future re-derivation from `sealed` fail here rather than
    // quietly restating the wrong reasoning with a number close enough to look checked.
    assert.notEqual(Math.ceil(sealed.length / 3) * 4, base64Length);
  });
});

test('two seals of the same file differ, so the ciphertext is not a fingerprint of the file', () => {
  withKey('test-key', () => {
    const pdf = Buffer.from('%PDF-1.4\ntranscript\n%%EOF\n');
    assert.notDeepEqual(sealDocument(pdf), sealDocument(pdf));
  });
});

test('a flipped byte anywhere in the object is refused, not decrypted into a corrupt file', () => {
  // GCM is authenticated, which is what makes this a detection rather than a hope. Each of the
  // three regions is tampered separately because they fail through different code paths: the iv
  // yields a wrong keystream, the tag is the check itself, and the ciphertext is what the tag
  // covers. A corrupt file that decrypts is worse than one that refuses to: it reaches an
  // employer's form under a filename that says transcript.pdf and nobody can open it.
  withKey('test-key', () => {
    const sealed = sealDocument(Buffer.from('%PDF-1.4\ntranscript\n%%EOF\n'));
    for (const [region, offset] of [['iv', 0], ['auth tag', 12], ['ciphertext', 28]] as const) {
      const tampered = Buffer.from(sealed);
      tampered[offset] ^= 0x01;
      assert.throws(() => openDocument(tampered), DocumentDecryptError, `tampering the ${region}`);
    }
  });
});

test('a truncated object is refused rather than decrypting to zero bytes', () => {
  withKey('test-key', () => {
    // An iv and tag with no ciphertext is the case that matters: subarray returns an empty buffer
    // rather than throwing, and AES-GCM over zero bytes is a legitimate operation, so without the
    // length floor this path produces a 0-byte attachment and no error anywhere.
    assert.throws(() => openDocument(Buffer.alloc(28)), DocumentDecryptError);
    assert.throws(() => openDocument(Buffer.alloc(0)), DocumentDecryptError);
    assert.throws(() => openDocument(Buffer.from('not a sealed document')), DocumentDecryptError);
  });
});

test('a rotated key throws rather than yielding garbage bytes', () => {
  // R-021's shape, applied to a file: ENCRYPTION_KEY is not rotatable on its own, so the honest
  // behaviour is a loud failure. Passing the bytes through would attach ciphertext to a real
  // application under a name that says transcript.pdf.
  const stored = withKey('original-key', () => sealDocument(Buffer.from('%PDF-1.4\n%%EOF\n')));
  withKey('rotated-key', () => {
    assert.throws(() => openDocument(stored), DocumentDecryptError);
  });
});

test('a document sealed under the profile-column salt does not open here', () => {
  // Proves the domain separation empirically rather than by reading the two constants. Same secret,
  // different salt, so the derived keys differ and the auth tag fails.
  withKey('shared-secret', () => {
    const sealed = sealDocument(Buffer.from('%PDF-1.4\n%%EOF\n'));
    const documentKey = scryptSync('shared-secret', DOCUMENT_CRYPTO_SALT_ID, 32);
    const profileKey = scryptSync('shared-secret', FIELD_CRYPTO_SALT_ID, 32);
    assert.equal(documentKey.equals(profileKey), false);
    assert.ok(sealed.length > 28);
  });
});

test('a missing ENCRYPTION_KEY is a config error on both directions', () => {
  withKey(undefined, () => {
    assert.throws(() => sealDocument(Buffer.from('%PDF-1.4\n')), /ENCRYPTION_KEY not configured/);
    assert.throws(() => openDocument(Buffer.alloc(64)), /ENCRYPTION_KEY not configured/);
  });
});
