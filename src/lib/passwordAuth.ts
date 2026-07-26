import { argon2id, hash, needsRehash, verify } from 'argon2';

export const MIN_PASSWORD_LENGTH = 15;
export const MAX_PASSWORD_LENGTH = 128;

const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

// Login attempts for unknown emails still verify a real Argon2id hash. This
// keeps account existence out of timing differences and API error messages.
const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=19456,p=1,t=2$fcMstuCsBxmioeRTQrj8rw$j60jIJTCZNYDeldhMZo3qXR4NrGCgjPyW0ZHb0IbBsY';

const COMMON_PASSWORDS = new Set([
  'passwordpassword',
  'password123456',
  'password123456789',
  'qwertyqwertyqwerty',
  'qwerty123456789',
  'letmeinletmein',
  'iloveyouiloveyou',
  'adminadminadmin',
  'welcome123456789',
  '123456789012345',
  '1234567890123456',
  '111111111111111',
  'aaaaaaaaaaaaaaa',
  'abc123abc123abc',
  'changemechangeme',
  'correcthorsebatterystaple',
]);

export type PasswordPolicyError = 'password_too_short' | 'password_too_long' | 'password_too_common';
export type PasswordUpdateError =
  | 'recent_verification_required'
  | 'current_password_incorrect'
  | 'password_unchanged';

export function normalizePassword(password: string): string {
  return password.normalize('NFC');
}

export function passwordPolicyError(password: string, email?: string | null): PasswordPolicyError | null {
  const normalized = normalizePassword(password);
  const length = Array.from(normalized).length;
  if (length < MIN_PASSWORD_LENGTH) return 'password_too_short';
  if (length > MAX_PASSWORD_LENGTH) return 'password_too_long';

  const candidate = normalized.toLocaleLowerCase('en-US');
  const normalizedEmail = email?.trim().toLocaleLowerCase('en-US') ?? '';
  const emailLocalPart = normalizedEmail.split('@')[0] ?? '';
  if (
    COMMON_PASSWORDS.has(candidate)
    || candidate === 'litoslitoslitos'
    || candidate === normalizedEmail
    || (emailLocalPart.length >= MIN_PASSWORD_LENGTH && candidate === emailLocalPart)
  ) {
    return 'password_too_common';
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  return hash(normalizePassword(password), ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string | null | undefined, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash || DUMMY_PASSWORD_HASH, normalizePassword(password));
  } catch {
    return false;
  }
}

export function passwordHashNeedsUpgrade(passwordHash: string): boolean {
  return needsRehash(passwordHash, ARGON2_OPTIONS);
}

export async function passwordUpdateError(
  input: {
    existingHash: string | null;
    newPassword: string;
    currentPassword?: string;
    recoverySession: boolean;
  },
  verifier: typeof verifyPassword = verifyPassword,
): Promise<PasswordUpdateError | null> {
  if (!input.existingHash) {
    return input.recoverySession ? null : 'recent_verification_required';
  }

  if (!input.recoverySession) {
    const currentPassword = normalizePassword(input.currentPassword ?? '');
    if (!await verifier(input.existingHash, currentPassword)) {
      return 'current_password_incorrect';
    }
    // Only compare the proposed value after the caller proved knowledge of the
    // current password. This avoids exposing a password-equality oracle.
    return currentPassword === normalizePassword(input.newPassword)
      ? 'password_unchanged'
      : null;
  }

  return await verifier(input.existingHash, input.newPassword)
    ? 'password_unchanged'
    : null;
}
