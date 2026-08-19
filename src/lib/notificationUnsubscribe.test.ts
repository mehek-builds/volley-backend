import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  mintUnsubscribeToken,
  readUnsubscribeToken,
  unsubscribeConfigured,
  unsubscribeUrl,
} from './notificationUnsubscribe';

const USER = '6d58c1f5-e885-41f7-a16a-dac37f98ab17';
const OTHER = '9610648e-7750-4931-9a74-8aef5ebf00c0';
const saved = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

function withSecret(secret: string) {
  process.env.LITOS_NOTIFICATION_UNSUBSCRIBE_SECRET = secret;
}

test('a minted token round trips to the account and the stream it was minted for', () => {
  withSecret('unsubscribe-test-secret-one');
  const token = mintUnsubscribeToken(USER, 'strong_match');
  assert.deepEqual(readUnsubscribeToken(token), { userId: USER, kind: 'strong_match' });

  /* THE KIND IS PART OF THE TOKEN, so the link stops the stream that actually mailed her. Somebody
     tired of match alerts has said nothing about wanting to miss an employer's reply. */
  const reply = mintUnsubscribeToken(USER, 'employer_reply');
  assert.deepEqual(readUnsubscribeToken(reply), { userId: USER, kind: 'employer_reply' });
  assert.notEqual(token, reply);
});

test('a token minted under a different secret does not verify', () => {
  withSecret('unsubscribe-test-secret-one');
  const token = mintUnsubscribeToken(USER, 'strong_match');
  withSecret('unsubscribe-test-secret-two');
  assert.equal(readUnsubscribeToken(token), null);
});

test('the signature covers the account and the kind, so neither can be swapped', () => {
  withSecret('unsubscribe-test-secret-one');
  const token = mintUnsubscribeToken(USER, 'strong_match');
  const [version, kind, encodedUser, signature] = token.split('.');
  assert.equal(kind, 'strong_match');

  // Swapping the kind onto a valid signature must not unsubscribe a different stream.
  assert.equal(readUnsubscribeToken([version, 'employer_reply', encodedUser, signature].join('.')), null);

  // Swapping the account must not unsubscribe somebody else.
  const otherUser = Buffer.from(OTHER).toString('base64url');
  assert.equal(readUnsubscribeToken([version, kind, otherUser, signature].join('.')), null);

  // And a tampered signature is refused.
  assert.equal(readUnsubscribeToken([version, kind, encodedUser, `${signature.slice(0, -1)}A`].join('.')), null);
});

test('malformed tokens are refused rather than parsed leniently', () => {
  withSecret('unsubscribe-test-secret-one');
  assert.equal(readUnsubscribeToken(''), null);
  assert.equal(readUnsubscribeToken('nonsense'), null);
  assert.equal(readUnsubscribeToken('v1.strong_match.abc'), null, 'three parts is not four');
  const token = mintUnsubscribeToken(USER, 'strong_match');
  assert.equal(readUnsubscribeToken(`v2${token.slice(2)}`), null, 'an unknown version is not read as v1');
});

test('a payload that does not re-encode to the signed bytes is refused', () => {
  /* base64url DECODES input the encoder would never PRODUCE, so a signature check alone is not
     enough: without the round-trip test a padded or otherwise re-spelled payload could verify
     against its own signature and then be used as a different string than the one signed. */
  withSecret('unsubscribe-test-secret-one');
  const token = mintUnsubscribeToken(USER, 'strong_match');
  const [version, kind, encodedUser] = token.split('.');
  const padded = `${encodedUser}=`;
  assert.notEqual(padded, encodedUser);
  assert.equal(Buffer.from(padded, 'base64url').toString(), USER, 'the decoder does accept it');
  // Re-signing the padded payload proves the guard is the round trip and not the signature.
  const forged = mintUnsubscribeToken(USER, 'strong_match');
  assert.equal(readUnsubscribeToken([version, kind, padded, forged.split('.')[3]].join('.')), null);
});

test('a token whose payload is not a user id is refused even when it verifies', () => {
  withSecret('unsubscribe-test-secret-one');
  // Minting is a private operation, so this is the shape an internal caller mistake would take:
  // a signed token carrying something that is not an account id must not reach an UPDATE.
  const token = mintUnsubscribeToken('not-a-uuid', 'strong_match');
  assert.equal(readUnsubscribeToken(token), null);
});

test('with no secret anywhere, nothing can be minted and nothing verifies', () => {
  delete process.env.LITOS_NOTIFICATION_UNSUBSCRIBE_SECRET;
  delete process.env.JWT_SIGNING_SECRET;
  assert.equal(unsubscribeConfigured(), false);
  assert.throws(() => mintUnsubscribeToken(USER, 'strong_match'));
  assert.equal(readUnsubscribeToken('v1.strong_match.abc.def'), null);
});

test('the JWT secret is the fallback, so the feature works on the deploy that ships it', () => {
  delete process.env.LITOS_NOTIFICATION_UNSUBSCRIBE_SECRET;
  process.env.JWT_SIGNING_SECRET = 'jwt-fallback-secret-for-unsubscribe';
  assert.equal(unsubscribeConfigured(), true);
  assert.deepEqual(readUnsubscribeToken(mintUnsubscribeToken(USER, 'strong_match')), {
    userId: USER,
    kind: 'strong_match',
  });
});

test('the dedicated secret wins over the JWT fallback', () => {
  process.env.JWT_SIGNING_SECRET = 'jwt-fallback-secret-for-unsubscribe';
  withSecret('unsubscribe-test-secret-one');
  const token = mintUnsubscribeToken(USER, 'strong_match');
  delete process.env.LITOS_NOTIFICATION_UNSUBSCRIBE_SECRET;
  assert.equal(readUnsubscribeToken(token), null, 'the two secrets sign different tokens');
});

test('the link is absolute or it is nothing', () => {
  withSecret('unsubscribe-test-secret-one');
  const token = mintUnsubscribeToken(USER, 'strong_match');

  /* A cron has no inbound request to read a host from, and a relative link in an email is not a
     link. Null is what the send path treats as fatal, which is the whole point: no way out means
     no send. */
  delete process.env.PUBLIC_API_BASE;
  assert.equal(unsubscribeUrl(token), null);

  process.env.PUBLIC_API_BASE = 'https://api.trylitos.com/';
  const url = unsubscribeUrl(token);
  assert.ok(url);
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://api.trylitos.com');
  assert.equal(parsed.pathname, '/notifications/unsubscribe');
  assert.equal(parsed.searchParams.get('token'), token);
});
