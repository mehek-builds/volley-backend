import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { mintPortalSecret, secretMatches } from './portalAccountVault';

test('a minted secret always carries every character class a portal asks for', () => {
  /* Not a style assertion. These portals enforce upper/lower/digit/symbol at registration, and a
     generator that satisfies it BY CHANCE fails a real form roughly one time in forty - which would
     surface as a mysterious registration failure on one employer and not the next. 200 samples is
     enough that a generator relying on luck cannot pass this. */
  for (let i = 0; i < 200; i += 1) {
    const secret = mintPortalSecret();
    assert.equal(secret.length, 24, 'length is fixed');
    assert.match(secret, /[A-Z]/, `no uppercase in ${secret}`);
    assert.match(secret, /[a-z]/, `no lowercase in ${secret}`);
    assert.match(secret, /[0-9]/, `no digit in ${secret}`);
    assert.match(secret, /[!@#$%^&*\-_=+]/, `no symbol in ${secret}`);
    // Characters that break naive form handling on the far side are excluded by construction.
    assert.doesNotMatch(secret, /['"\\<>`]/, `unsafe character in ${secret}`);
  }
});

test('the required characters are not pinned to the front', () => {
  /* The four guaranteed classes are generated first and then shuffled. If the shuffle were dropped -
     or written as sort(() => Math.random() - 0.5), which is biased - the first four positions would
     be a fixed class pattern, and those are the characters an attacker would not have to guess.
     Measured across samples: position 0 must not always be uppercase. */
  const firstCharClasses = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const first = mintPortalSecret()[0]!;
    firstCharClasses.add(
      /[A-Z]/.test(first) ? 'upper'
        : /[a-z]/.test(first) ? 'lower'
          : /[0-9]/.test(first) ? 'digit' : 'symbol',
    );
  }
  assert.ok(firstCharClasses.size > 1, `position 0 is always one class: ${[...firstCharClasses]}`);
});

test('minted secrets do not repeat', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i += 1) seen.add(mintPortalSecret());
  assert.equal(seen.size, 500, 'a collision in 500 draws means the entropy source is wrong');
});

test('secretMatches is length-safe and correct', () => {
  const a = mintPortalSecret();
  assert.equal(secretMatches(a, a), true);
  assert.equal(secretMatches(a, `${a}x`), false, 'a length mismatch must not throw');
  assert.equal(secretMatches(a, mintPortalSecret()), false);
  assert.equal(secretMatches('', ''), true);
});

test('no route can return a stored portal secret', () => {
  /* THE ONE PROPERTY THIS FEATURE LIVES OR DIES ON, asserted against the source rather than a mock.
   *
   * This repo distrusts source-text tests and says so, for good reason. It is used here because the
   * claim is about the ABSENCE of a call across a whole directory, and absence is exactly what a
   * behavioural test of any single route cannot establish. It is the junior partner to the type:
   * PortalAccountDescription has no secret field, so the ordinary read path cannot express one.
   *
   * If a route ever legitimately needs this, the fix is not to delete this test. It is to explain in
   * review why a credential should cross an HTTP boundary, which is a conversation worth forcing. */
  const dir = 'src/routes/';
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.includes('.test.'));
  assert.ok(files.length > 5, `expected the routes directory, found ${files.length} files`);
  const callers = files.filter((name) => readFileSync(`${dir}${name}`, 'utf8').includes('readSecretForManagedRun'));
  assert.deepEqual(callers, [], `a route reaches the plaintext credential read: ${callers.join(', ')}`);
});

test('the vault exposes exactly one plaintext read, and its name says so', () => {
  const source = readFileSync('src/lib/portalAccountVault.ts', 'utf8');
  const decryptCalls = source.match(/\bdecryptField\(/g) ?? [];
  assert.equal(decryptCalls.length, 1, 'more than one decrypt path means the single-read claim is false');
  assert.match(source, /export async function readSecretForManagedRun/);
  /* The description type is what routes return, and it must not grow a field that HOLDS a secret.
     `has_secret: boolean` is fine and is deliberately allowed - it reports presence, not value - so
     this matches field names that would carry the string itself rather than any mention of the word. */
  const described = source.slice(source.indexOf('export type PortalAccountDescription'));
  const body = described.slice(0, described.indexOf('};'));
  assert.doesNotMatch(
    body,
    /^\s*(secret|password|credential|secret_ciphertext)\s*[?]?:\s*string/m,
    'the described shape must carry no secret value',
  );
});
