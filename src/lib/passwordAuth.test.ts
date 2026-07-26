import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  normalizePassword,
  passwordHashNeedsUpgrade,
  passwordPolicyError,
  passwordUpdateError,
  verifyPassword,
} from './passwordAuth';

test('password policy follows the long passphrase model', () => {
  assert.equal(passwordPolicyError('short', 'person@example.com'), 'password_too_short');
  assert.equal(passwordPolicyError('password123456789', 'person@example.com'), 'password_too_common');
  assert.equal(passwordPolicyError('a private phrase with spaces', 'person@example.com'), null);
  assert.equal(passwordPolicyError('x'.repeat(129), 'person@example.com'), 'password_too_long');
});

test('password normalization uses canonical Unicode before hashing', () => {
  assert.equal(normalizePassword('Cafe\u0301 private phrase'), 'Caf\u00e9 private phrase');
});

test('Argon2id hashes are salted, verifiable, and at the current cost', async () => {
  const password = 'a private phrase with spaces';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.match(first, /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
  assert.equal(await verifyPassword(first, password), true);
  assert.equal(await verifyPassword(first, 'the wrong private phrase'), false);
  assert.equal(passwordHashNeedsUpgrade(first), false);
});

test('unknown accounts take the dummy verification path and still fail', async () => {
  assert.equal(await verifyPassword(null, 'a private phrase with spaces'), false);
});

test('password changes verify the current password before checking equality', async () => {
  const attempts: string[] = [];
  const verifier = async (_hash: string | null | undefined, password: string) => {
    attempts.push(password);
    return password === 'current private phrase';
  };

  assert.equal(await passwordUpdateError({
    existingHash: 'hash',
    currentPassword: 'wrong private phrase',
    newPassword: 'current private phrase',
    recoverySession: false,
  }, verifier), 'current_password_incorrect');
  assert.deepEqual(attempts, ['wrong private phrase']);
});

test('password update authorization covers create, change, and recovery paths', async () => {
  const verifier = async (_hash: string | null | undefined, password: string) =>
    password === 'current private phrase';

  assert.equal(await passwordUpdateError({
    existingHash: null,
    newPassword: 'new private phrase',
    recoverySession: false,
  }, verifier), 'recent_verification_required');
  assert.equal(await passwordUpdateError({
    existingHash: null,
    newPassword: 'new private phrase',
    recoverySession: true,
  }, verifier), null);
  assert.equal(await passwordUpdateError({
    existingHash: 'hash',
    currentPassword: 'current private phrase',
    newPassword: 'current private phrase',
    recoverySession: false,
  }, verifier), 'password_unchanged');
  assert.equal(await passwordUpdateError({
    existingHash: 'hash',
    newPassword: 'current private phrase',
    recoverySession: true,
  }, verifier), 'password_unchanged');
});
