import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decryptField, encryptField, looksEncrypted } from './fieldCrypto';
import {
  PORTAL_PASSWORD_LENGTH,
  PORTAL_PASSWORD_MAX_LENGTH,
  PORTAL_PASSWORD_MIN_LENGTH,
  generatePortalPassword,
  icimsTenantFromUrl,
  passwordMeetsPortalPolicy,
  portalPasswordPolicyViolations,
  portalTenantFromUrl,
} from './portalCredentials';

process.env.ENCRYPTION_KEY ??= 'portal-credentials-test-key';

test('a generated password satisfies every enterprise policy rule, every time', () => {
  // One sample proves nothing about a random generator. 500 samples is enough that a class the
  // generator only sometimes includes would show up here rather than on an employer's form.
  for (let i = 0; i < 500; i++) {
    const password = generatePortalPassword('app-abc123@apply.trylitos.com');
    assert.equal(password.length, PORTAL_PASSWORD_LENGTH);
    assert.deepEqual(portalPasswordPolicyViolations(password, 'app-abc123@apply.trylitos.com'), []);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[a-z]/);
    assert.match(password, /[0-9]/);
    assert.match(password, /[!#$%*+\-=?@_]/);
  }
});

test('the password length sits inside the union of ATS minimums and maximums', () => {
  // Long enough for every minimum seen in this space, short enough for the platforms that cap it.
  assert.ok(PORTAL_PASSWORD_LENGTH >= PORTAL_PASSWORD_MIN_LENGTH);
  assert.ok(PORTAL_PASSWORD_LENGTH <= PORTAL_PASSWORD_MAX_LENGTH);
  assert.ok(PORTAL_PASSWORD_MIN_LENGTH >= 12);
});

test('the character set excludes what breaks forms and what a human misreads', () => {
  const joined = Array.from({ length: 300 }, () => generatePortalPassword()).join('');
  // Quotes, brackets, slashes, ampersands and whitespace are the characters that get mangled by
  // form handling, escaping, or a copy out of a shell.
  assert.equal(/["'`<>&\\/;:,()[\]{}|~^\s]/.test(joined), false, 'no form-hostile character may appear');
  // O/0 and I/l/1 are the pairs a person confuses when typing a revealed password by hand.
  assert.equal(/[O0Il1]/.test(joined), false, 'no visually ambiguous character may appear');
});

test('every password is unique, so one tenant never inherits another tenant account', () => {
  const seen = new Set(Array.from({ length: 1000 }, () => generatePortalPassword()));
  assert.equal(seen.size, 1000);
});

test('the policy checker names the rule that failed', () => {
  assert.deepEqual(portalPasswordPolicyViolations('Shrt2!ab'), ['too_short']);
  assert.deepEqual(portalPasswordPolicyViolations('everycasehere-ab'), ['no_uppercase', 'no_digit']);
  assert.deepEqual(portalPasswordPolicyViolations('NoDigitsHereAbc!'), ['no_digit']);
  assert.deepEqual(portalPasswordPolicyViolations('NoSymbsHere23456'), ['no_symbol']);
  assert.deepEqual(portalPasswordPolicyViolations('Has Space 234 A!'), ['disallowed_character']);
  assert.deepEqual(portalPasswordPolicyViolations('Quote"Mark234!Ab'), ['disallowed_character']);
  assert.deepEqual(portalPasswordPolicyViolations('Kaaa34!bcdefghij'), ['three_in_a_row']);
  assert.deepEqual(
    portalPasswordPolicyViolations('Xapp-abc789Yz34!', 'app-abc789@apply.trylitos.com'),
    ['contains_username'],
  );
  assert.equal(passwordMeetsPortalPolicy('Kp7#mQx2$Rv9Ztb4'), true);
});

test('a real iCIMS posting URL yields its tenant', () => {
  // Six real iCIMS URL shapes. The tenant is the host label, because that label IS the employer's
  // whole portal: every job that employer posts is reachable from one account on it.
  assert.equal(
    icimsTenantFromUrl('https://careers-acme.icims.com/jobs/12345/software-engineer/job'),
    'careers-acme',
  );
  assert.equal(
    icimsTenantFromUrl('https://jobs-express.icims.com/jobs/8891/data-analyst/job?mobile=false&width=1200&height=500&bga=true&needsRedirect=false'),
    'jobs-express',
  );
  assert.equal(
    icimsTenantFromUrl('https://externalhourly-omnihotels.icims.com/jobs/117054/front-desk-agent/job'),
    'externalhourly-omnihotels',
  );
  // The login route on the same tenant, which is where the account wall lives.
  assert.equal(
    icimsTenantFromUrl('https://careers-acme.icims.com/jobs/12345/software-engineer/login'),
    'careers-acme',
  );
  // Case in the host and the slug, plus a trailing slash and a percent-encoded slug.
  assert.equal(
    icimsTenantFromUrl('HTTPS://Careers-ACME.iCIMS.com/jobs/12345/Software%20Engineer/job/'),
    'careers-acme',
  );
  // The bare account route with no posting attached.
  assert.equal(icimsTenantFromUrl('https://careers-acme.icims.com/jobs/login'), 'careers-acme');
  // The tenant root, which is still unambiguous about which employer this is.
  assert.equal(icimsTenantFromUrl('https://careers-acme.icims.com/'), 'careers-acme');
});

test('an unclear URL yields null, because a wrong tenant reuses the wrong account', () => {
  // The vendor's own hosts are not an employer's portal.
  assert.equal(icimsTenantFromUrl('https://www.icims.com/products/recruiting-software'), null);
  assert.equal(icimsTenantFromUrl('https://login.icims.com/jobs/12345/engineer/login'), null);
  // A lookalike domain that merely contains icims.com.
  assert.equal(icimsTenantFromUrl('https://careers-acme.icims.com.attacker.example/jobs/1/x/job'), null);
  // The apex, which names no tenant at all.
  assert.equal(icimsTenantFromUrl('https://icims.com/jobs/12345/engineer/job'), null);
  // A deeper host than any captured tenant shape.
  assert.equal(icimsTenantFromUrl('https://a.careers-acme.icims.com/jobs/1/x/job'), null);
  // A page on a tenant host that is not a jobs route.
  assert.equal(icimsTenantFromUrl('https://careers-acme.icims.com/marketing/landing'), null);
  // Another ATS entirely, and a string that is not a URL.
  assert.equal(icimsTenantFromUrl('https://job-boards.greenhouse.io/acme/jobs/4567'), null);
  assert.equal(icimsTenantFromUrl('careers-acme.icims.com/jobs/1/x/job'), null);
  assert.equal(icimsTenantFromUrl(''), null);
});

test('only iCIMS has a tenant extractor, and every other family holds', () => {
  const url = 'https://careers-acme.icims.com/jobs/12345/software-engineer/job';
  assert.equal(portalTenantFromUrl('icims', url), 'careers-acme');
  for (const family of ['jobvite', 'oraclecloud', 'ultipro', 'sap_successfactors', 'oracle_taleo', 'adp_recruiting', 'avature']) {
    assert.equal(portalTenantFromUrl(family, url), null, `${family} must not claim a tenant`);
  }
});

test('a stored password round trips through the shared field encryption', () => {
  const password = generatePortalPassword();
  const stored = encryptField(password);
  assert.equal(looksEncrypted(stored), true);
  assert.equal(stored.includes(password), false, 'the stored envelope must not contain the plaintext');
  assert.equal(decryptField(stored), password);
  // Same plaintext, different envelope: the random IV must not be reused.
  assert.notEqual(encryptField(password), encryptField(password));
});

test('the credential module invents no crypto and writes no plaintext', () => {
  const source = readFileSync('src/lib/portalCredentials.ts', 'utf8');
  assert.match(source, /from '\.\/fieldCrypto'/, 'encryption must come from the shared helper');
  assert.match(source, /password_encrypted: encryptField\(password\)/);
  assert.equal(/createCipheriv|createHash\(|scrypt|pbkdf2|createHmac/.test(source), false,
    'no hand-rolled cipher or second key derivation may appear here');
  assert.equal(/Math\.random/.test(source), false, 'password material must come from the CSPRNG');
  assert.match(source, /randomInt/);
});

test('no password value is ever logged, serialized, or put in an error', () => {
  for (const file of [
    'src/lib/portalCredentials.ts',
    'src/lib/icimsAccountRegistration.ts',
    'src/routes/portalCredentials.ts',
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.equal(/console\.(log|info|warn|error|debug)/.test(source), false, `${file} must not log`);
    assert.equal(/log\.(info|warn|error|debug)\(/.test(source), false, `${file} must not use the request logger`);
    assert.equal(/JSON\.stringify\([^)]*password/i.test(source), false, `${file} must not serialize a password`);
    assert.equal(/(Error|error)\([^)]*\$\{[^}]*password[^}]*\}/.test(source), false,
      `${file} must not put a password in an error message`);
  }
});

test('the listing path never selects the password column', () => {
  const source = readFileSync('src/lib/portalCredentials.ts', 'utf8');
  const summary = source.slice(source.indexOf('function summaryColumns'), source.indexOf('ensurePortalCredential'));
  assert.equal(summary.includes('password_encrypted'), false, 'the summary shape must have no password column');
  // Exactly three functions touch the encrypted column: the one that writes it, and the two that
  // decrypt it for its owner. Both of those say whose value it is in their own names.
  const touching = source
    .split(/\n(?=export )/)
    .filter((block) => block.includes('password_encrypted'))
    .map((block) => /^export (?:async )?function (\w+)/.exec(block)?.[1])
    .filter((name): name is string => Boolean(name));
  assert.deepEqual(touching.sort(), [
    'ensurePortalCredential',
    'portalCredentialSecretForOwner',
    'revealPortalCredentialForOwner',
  ]);
});

test('every read and every write is owner-scoped', () => {
  const source = readFileSync('src/lib/portalCredentials.ts', 'utf8');
  const statements = source.split(/\n(?=export )/).filter((block) => /db\s*\.(select|update|insert)/.test(block));
  assert.ok(statements.length >= 5, 'the scan must actually find the database calls');
  for (const block of statements) {
    assert.match(block, /portal_credentials\.user_id/,
      `a database call outside an owner filter would make a credential id a capability:\n${block.slice(0, 200)}`);
  }
});
