import { randomInt, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { portal_accounts } from '../db/schema';
import { decryptField, encryptField, looksEncrypted } from './fieldCrypto';
import { isAccountWalledFamily } from './portalSubmission';
import type { SupportedPortal } from './portalSubmission';

/**
 * Credentials for the eight portal families that render no application form until an account exists.
 *
 * WHAT THIS IS FOR
 * ================
 * jobvite, icims, oraclecloud, ultipro, sap_successfactors, oracle_taleo, adp_recruiting and avature
 * all gate their application form behind a sign-in. ACCOUNT_WALLED_FAMILIES describes that stop and
 * `prepareManagedAttendedAccountGate` hands the page to a human. This module is the other half: a
 * place for Litos to hold the account it made, so the second application to the same tenant signs in
 * instead of stalling at the same wall.
 *
 * THE SECRET IS NEVER READABLE OUTSIDE ONE FUNCTION
 * =================================================
 * `readSecretForManagedRun` is the ONLY export that returns plaintext, and it exists so the managed
 * runner can type the password into the portal's own login form server-side. Nothing else in this
 * module can reach it:
 *
 *   - the secret is generated HERE, from crypto.randomBytes. No caller supplies one, so no caller
 *     ever holds one to pass in.
 *   - it is encrypted with encryptField (AES-256-GCM, the same primitive the application profile
 *     uses) before it touches the database.
 *   - `describePortalAccount` is the shape routes are meant to return, and it has no secret field at
 *     all. That is a type-level guarantee rather than a discipline: a route cannot leak what its
 *     return type cannot express.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * =========================================
 * It does not create accounts. Minting and storing a credential is bookkeeping; going to an
 * employer's site, accepting their terms of use and registering a person is a legal act performed in
 * her name, and the 2026-08-17 design note is explicit that the flow has to end in her action. So
 * `status` starts at 'pending' and only a confirmed sign-in moves it to 'active'. Nothing here
 * advances that on its own.
 *
 * It also never touches the eleven families that are NOT account-walled. `assertAccountWalled`
 * refuses them outright, because storing a credential for a portal that needs no account is a
 * credential with no purpose and one more thing to leak.
 */

export type PortalAccountStatus = 'pending' | 'active' | 'needs_human' | 'failed';

/** Everything a caller outside this module may see. Note the absence of the secret. */
export type PortalAccountDescription = {
  portal_family: string;
  tenant: string;
  login_email: string;
  status: PortalAccountStatus;
  has_secret: boolean;
  last_verified_at: string | null;
  created_at: string;
};

export class PortalAccountNotWalledError extends Error {
  constructor(portal: string) {
    super(`${portal} does not gate its application form behind an account, so Litos stores no credential for it`);
    this.name = 'PortalAccountNotWalledError';
  }
}

function assertAccountWalled(portal: SupportedPortal): void {
  if (!isAccountWalledFamily(portal)) throw new PortalAccountNotWalledError(portal);
}

/* Character classes kept separate so the generated secret can be PROVEN to satisfy the
 * "upper, lower, digit, symbol" rule most of these portals enforce, rather than satisfying it by
 * luck and failing a registration form one time in forty.
 *
 * The symbol set is deliberately narrow. Quotes, backslashes and angle brackets are the characters
 * that break naive form handling and shell-adjacent tooling on the far side, and a password that
 * cannot be typed into the portal is worse than a slightly smaller alphabet. */
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT = '23456789';
const SYMBOL = '!@#$%^&*-_=+';
const ALL = UPPER + LOWER + DIGIT + SYMBOL;

/** Length is well past any portal maximum worth worrying about and far past any brute-force concern. */
const SECRET_LENGTH = 24;

function pick(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)]!;
}

/**
 * A fresh portal password.
 *
 * Exported for its tests only. It is not exported to give a caller a way to obtain a secret: every
 * write path below generates its own, so there is no signature anywhere that accepts one.
 */
export function mintPortalSecret(): string {
  const required = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  const rest = Array.from({ length: SECRET_LENGTH - required.length }, () => pick(ALL));
  const chars = [...required, ...rest];
  /* Fisher-Yates with crypto randomness. A sort() with a random comparator is the usual shortcut
   * here and it is biased, which would leave the four required characters clustered at the front in
   * a predictable way - the one part of this string an attacker could otherwise guess. */
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

function describe(row: typeof portal_accounts.$inferSelect): PortalAccountDescription {
  return {
    portal_family: row.portal_family,
    tenant: row.tenant,
    login_email: row.login_email,
    status: row.status as PortalAccountStatus,
    has_secret: Boolean(row.secret_ciphertext),
    last_verified_at: row.last_verified_at ? row.last_verified_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Record the account Litos will use for this tenant, minting and encrypting its secret.
 *
 * Idempotent on (user, family, tenant): a second call returns the existing row rather than minting a
 * second password for an account that already has one. That matters because these portals lock an
 * address after a few failed sign-ins, and two credentials for one account is how that happens.
 */
export async function ensurePortalAccount(input: {
  userId: string;
  portal: SupportedPortal;
  tenant: string;
  loginEmail: string;
}): Promise<PortalAccountDescription> {
  assertAccountWalled(input.portal);
  const tenant = input.tenant.trim().toLowerCase();
  if (!tenant) throw new Error('A portal account needs the tenant it belongs to');
  if (!input.loginEmail.includes('@')) throw new Error('A portal account needs the Litos alias it signs in with');

  const [existing] = await db.select().from(portal_accounts).where(and(
    eq(portal_accounts.user_id, input.userId),
    eq(portal_accounts.portal_family, input.portal),
    eq(portal_accounts.tenant, tenant),
  )).limit(1);
  if (existing) return describe(existing);

  const [created] = await db.insert(portal_accounts).values({
    user_id: input.userId,
    portal_family: input.portal,
    tenant,
    login_email: input.loginEmail,
    secret_ciphertext: encryptField(mintPortalSecret()),
    status: 'pending',
  }).returning();
  return describe(created!);
}

/** What a route may show. Never includes the secret; see the type. */
export async function describePortalAccount(input: {
  userId: string;
  portal: SupportedPortal;
  tenant: string;
}): Promise<PortalAccountDescription | null> {
  const [row] = await db.select().from(portal_accounts).where(and(
    eq(portal_accounts.user_id, input.userId),
    eq(portal_accounts.portal_family, input.portal),
    eq(portal_accounts.tenant, input.tenant.trim().toLowerCase()),
  )).limit(1);
  return row ? describe(row) : null;
}

/**
 * THE ONLY PLAINTEXT READ. Server-side, for the managed runner's sign-in step.
 *
 * Callers must not log it, must not put it in an error, and must not return it over HTTP. There is
 * no route in this codebase that calls this, and adding one would be the defect this comment exists
 * to make obvious in review.
 *
 * Throws rather than returning null on a value that does not decrypt: a wrong key is a configuration
 * error, and typing base64 garbage into an employer's login form would lock the account. That is the
 * same reasoning `decryptField` documents for the profile fields.
 */
export async function readSecretForManagedRun(input: {
  userId: string;
  portal: SupportedPortal;
  tenant: string;
}): Promise<{ loginEmail: string; secret: string } | null> {
  assertAccountWalled(input.portal);
  const [row] = await db.select().from(portal_accounts).where(and(
    eq(portal_accounts.user_id, input.userId),
    eq(portal_accounts.portal_family, input.portal),
    eq(portal_accounts.tenant, input.tenant.trim().toLowerCase()),
  )).limit(1);
  if (!row?.secret_ciphertext) return null;
  if (!looksEncrypted(row.secret_ciphertext)) {
    throw new Error('A stored portal credential is not in the encrypted format and will not be used');
  }
  return { loginEmail: row.login_email, secret: decryptField(row.secret_ciphertext) };
}

/**
 * Move an account to 'active' once a sign-in has actually been observed.
 *
 * Separate from ensurePortalAccount on purpose. Creating the row is bookkeeping; asserting the
 * account EXISTS at the employer is a claim about the outside world, and this codebase's rule is
 * that such a claim comes from an observation rather than from the act that hoped to produce it.
 */
export async function markPortalAccountVerified(input: {
  userId: string;
  portal: SupportedPortal;
  tenant: string;
  verifiedAt: Date;
}): Promise<void> {
  await db.update(portal_accounts).set({
    status: 'active',
    last_verified_at: input.verifiedAt,
    updated_at: new Date(),
  }).where(and(
    eq(portal_accounts.user_id, input.userId),
    eq(portal_accounts.portal_family, input.portal),
    eq(portal_accounts.tenant, input.tenant.trim().toLowerCase()),
  ));
}

/**
 * Constant-time comparison, for the one place a caller needs to check a secret it already holds.
 *
 * Exists so that a future sign-in verifier does not reach for `===`. Length is compared first
 * because timingSafeEqual throws on a length mismatch, and that throw is itself a timing signal.
 */
export function secretMatches(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Unused today; kept adjacent so a future rotation writes through the same encryption path. */
export function rotatedSecretCiphertext(): string {
  return encryptField(mintPortalSecret());
}
