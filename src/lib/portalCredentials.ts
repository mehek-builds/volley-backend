import { randomInt } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { portal_credentials } from '../db/schema';
import { decryptField, encryptField } from './fieldCrypto';

/* THE ACCOUNT LITOS HOLDS ON AN EMPLOYER'S ATS TENANT.
 *
 * Eight ATS families put an account wall in front of the application form, so on those portals
 * there is no form to fill until an account exists. This module owns the account's two secrets: the
 * address it is registered under (the Litos application alias, so employer mail keeps arriving
 * where every other employer message already arrives) and a password Litos generated.
 *
 * Three rules hold everywhere in this file, and the tests pin all three:
 *
 * 1. THE PASSWORD IS NEVER STORED IN PLAINTEXT. It goes through encryptField, the same AES-256-GCM
 *    envelope the encrypted country work-eligibility declaration uses. No second cipher, no second
 *    key derivation, no second thing to get wrong.
 * 2. EVERY READ IS OWNER-SCOPED. Every query below filters on user_id, and the credential id alone
 *    is never enough to read a row. A credential id is not a capability.
 * 3. THE PLAINTEXT LEAVES THIS MODULE ONLY BY A DELIBERATE CALL. Nothing here logs a password,
 *    puts one in an error message, or returns one from the listing path. The two functions that
 *    return plaintext say so in their names and are called from exactly two places: the owner's own
 *    reveal route, and the registration plan builder.
 */

/** One credential as the owner's dashboard sees it. No password field exists on this shape. */
export type PortalCredentialSummary = {
  id: string;
  portal_family: string;
  tenant: string;
  username: string;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
  last_revealed_at: Date | null;
  reveal_count: number;
};

/* PASSWORD SHAPE, as the union of what enterprise ATS password policies demand.
 *
 * Length 16 is a deliberate compromise rather than "as long as possible". The MINIMUMS in this
 * space cluster at 8 to 12, but several of these platforms also enforce a MAXIMUM (commonly 16 to
 * 20), and a password rejected for being too long fails at the one moment nobody is watching. 16
 * clears every minimum and sits at or under every maximum this feature is likely to meet.
 *
 * The character set drops two families of trouble:
 *   - characters that break form handling or get mangled in transit: quotes, angle brackets,
 *     backslash, backtick, ampersand, semicolon, comma, colon, slash, braces, brackets, pipe,
 *     tilde, caret, parentheses and whitespace are all absent;
 *   - characters a human misreads when copying the revealed value by hand: O, 0, I, l and 1.
 *
 * 68 possible characters at length 16 is about 97 bits of entropy from a CSPRNG. Deriving the
 * password from a secret instead would make every account on every tenant recoverable from one
 * stolen value, which is the opposite of what a per-tenant account is for.
 */
export const PORTAL_PASSWORD_LENGTH = 16;
export const PORTAL_PASSWORD_MIN_LENGTH = 12;
export const PORTAL_PASSWORD_MAX_LENGTH = 20;

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT = '23456789';
const SYMBOL = '!#$%*+-=?@_';
const ALPHABET = `${UPPER}${LOWER}${DIGIT}${SYMBOL}`;

function pick(source: string): string {
  return source[randomInt(source.length)];
}

/** Fisher-Yates, drawing every swap index from the CSPRNG rather than a convenience RNG. */
function shuffle(characters: string[]): string[] {
  for (let i = characters.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [characters[i], characters[j]] = [characters[j], characters[i]];
  }
  return characters;
}

/**
 * Why a candidate password fails, as a list rather than a boolean, so a test failure names the rule
 * that broke instead of only saying "false". `username` is optional and, when given, enforces the
 * common policy that the password must not contain the account name.
 */
export function portalPasswordPolicyViolations(value: string, username?: string): string[] {
  const violations: string[] = [];
  if (value.length < PORTAL_PASSWORD_MIN_LENGTH) violations.push('too_short');
  if (value.length > PORTAL_PASSWORD_MAX_LENGTH) violations.push('too_long');
  if (!/[A-Z]/.test(value)) violations.push('no_uppercase');
  if (!/[a-z]/.test(value)) violations.push('no_lowercase');
  if (!/[0-9]/.test(value)) violations.push('no_digit');
  if (![...value].some((character) => SYMBOL.includes(character))) violations.push('no_symbol');
  if ([...value].some((character) => !ALPHABET.includes(character))) violations.push('disallowed_character');
  if (/(.)\1\1/.test(value)) violations.push('three_in_a_row');
  const localPart = username?.split('@')[0]?.trim().toLowerCase();
  if (localPart && localPart.length >= 3 && value.toLowerCase().includes(localPart)) {
    violations.push('contains_username');
  }
  return violations;
}

export function passwordMeetsPortalPolicy(value: string, username?: string): boolean {
  return portalPasswordPolicyViolations(value, username).length === 0;
}

/**
 * A fresh password from the CSPRNG. One character is drawn from each required class first so the
 * result cannot miss a class by chance, then the rest are drawn from the whole alphabet, then the
 * whole thing is shuffled so the class order is not a fixed prefix an attacker could assume.
 *
 * The retry loop exists for the "three identical characters in a row" rule, which random draws can
 * produce. It is bounded: a generator that cannot satisfy its own policy is a bug that must fail
 * loudly, not spin.
 */
export function generatePortalPassword(username?: string): string {
  for (let attempt = 0; attempt < 32; attempt++) {
    const characters = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
    while (characters.length < PORTAL_PASSWORD_LENGTH) characters.push(pick(ALPHABET));
    const candidate = shuffle(characters).join('');
    if (passwordMeetsPortalPolicy(candidate, username)) return candidate;
  }
  throw new Error('Could not generate a portal password that satisfies the policy');
}

/* TENANT IDENTITY ON iCIMS.
 *
 * An iCIMS customer's whole portal lives on one host label: careers-acme.icims.com is one account
 * space, and every job that employer posts is reachable from the same account. That label is the
 * tenant, and it is the only part of the URL that is stable - the job id and slug change per
 * posting, and the path changes between the posting, the login page and the account pages.
 *
 * THE FAILURE THIS FUNCTION EXISTS TO PREVENT is a wrong tenant, not a missing one. A wrong tenant
 * makes Litos reuse the account it holds for one employer while talking to a different employer:
 * the login fails, or worse it succeeds against the wrong portal and the applicant's identity ends
 * up in the wrong company's system. So every uncertain shape returns null and the caller holds:
 *
 *   - anything that is not exactly one label under icims.com (the bare apex, a deeper host like
 *     a.b.icims.com, and lookalikes such as icims.com.example.net all fail);
 *   - the vendor's own hosts - www, login, api, community, support, secure, uploads, static, cdn -
 *     which are not employer portals;
 *   - any path that is not an iCIMS jobs route, so a marketing or product page on a tenant host is
 *     never mistaken for a posting;
 *   - anything that will not parse, or that is not http(s).
 */
const ICIMS_HOST_RE = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.icims\.com$/;

/** Vendor-owned labels. None of these is an employer's applicant portal. */
const ICIMS_RESERVED_LABELS: ReadonlySet<string> = new Set([
  'www', 'login', 'api', 'community', 'support', 'help', 'docs', 'status',
  'secure', 'uploads', 'static', 'cdn', 'mail', 'ftp', 'admin', 'app',
]);

/** Every iCIMS applicant route seen in the captures lives under /jobs. Root is allowed too. */
const ICIMS_PATH_RE = /^\/(?:jobs(?:\/.*)?)?$/i;

export function icimsTenantFromUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const match = ICIMS_HOST_RE.exec(url.hostname.toLowerCase());
  if (!match) return null;
  const label = match[1];
  if (ICIMS_RESERVED_LABELS.has(label)) return null;
  // A single-character or two-character label is not a shape any captured tenant uses, and a guess
  // here is the expensive kind of wrong.
  if (label.length < 3) return null;
  if (!ICIMS_PATH_RE.test(url.pathname)) return null;
  return label;
}

/**
 * The tenant for any supported family, so the caller does not have to know which families have an
 * extractor yet. Only iCIMS is implemented; every other family returns null and holds, which is the
 * same answer as "Litos cannot register here yet".
 */
export function portalTenantFromUrl(portalFamily: string, rawUrl: string): string | null {
  if (portalFamily !== 'icims') return null;
  return icimsTenantFromUrl(rawUrl);
}

function summaryColumns() {
  return {
    id: portal_credentials.id,
    portal_family: portal_credentials.portal_family,
    tenant: portal_credentials.tenant,
    username: portal_credentials.username,
    created_at: portal_credentials.created_at,
    updated_at: portal_credentials.updated_at,
    last_used_at: portal_credentials.last_used_at,
    last_revealed_at: portal_credentials.last_revealed_at,
    reveal_count: portal_credentials.reveal_count,
  };
}

/**
 * The credential for one (user, family, tenant), created on first use and returned untouched after
 * that.
 *
 * An existing row is NEVER re-passworded here. The password stored is the one the real employer
 * account was created with, and overwriting it would leave the applicant holding a value that opens
 * nothing while the account it belongs to still exists.
 */
export async function ensurePortalCredential(input: {
  userId: string;
  portalFamily: string;
  tenant: string;
  username: string;
}): Promise<PortalCredentialSummary> {
  const existing = await findPortalCredential(input.userId, input.portalFamily, input.tenant);
  if (existing) return existing;

  const password = generatePortalPassword(input.username);
  await db.insert(portal_credentials).values({
    user_id: input.userId,
    portal_family: input.portalFamily,
    tenant: input.tenant,
    username: input.username,
    password_encrypted: encryptField(password),
    updated_at: new Date(),
  }).onConflictDoNothing({
    target: [portal_credentials.user_id, portal_credentials.portal_family, portal_credentials.tenant],
  });

  const stored = await findPortalCredential(input.userId, input.portalFamily, input.tenant);
  if (!stored) throw new Error('Portal credential could not be stored');
  return stored;
}

export async function findPortalCredential(
  userId: string,
  portalFamily: string,
  tenant: string,
): Promise<PortalCredentialSummary | null> {
  const rows = await db
    .select(summaryColumns())
    .from(portal_credentials)
    .where(and(
      eq(portal_credentials.user_id, userId),
      eq(portal_credentials.portal_family, portalFamily),
      eq(portal_credentials.tenant, tenant),
    ))
    .limit(1);
  return rows[0] ?? null;
}

/** The owner's list. The password column is not selected, so it cannot reach a response by accident. */
export async function listPortalCredentials(userId: string): Promise<PortalCredentialSummary[]> {
  return db
    .select(summaryColumns())
    .from(portal_credentials)
    .where(eq(portal_credentials.user_id, userId))
    .orderBy(desc(portal_credentials.created_at))
    .limit(200);
}

/**
 * The owner's deliberate reveal. Returns null when the credential does not exist OR is not this
 * user's, which are the same answer on purpose: a caller must not be able to tell a stranger's
 * credential id apart from one that was never issued.
 *
 * The reveal is counted and timestamped before the value is returned, so the trace exists even if
 * the caller never reads the response.
 */
export async function revealPortalCredentialForOwner(
  userId: string,
  credentialId: string,
): Promise<{ id: string; portal_family: string; tenant: string; username: string; password: string } | null> {
  const rows = await db
    .select({
      id: portal_credentials.id,
      portal_family: portal_credentials.portal_family,
      tenant: portal_credentials.tenant,
      username: portal_credentials.username,
      password_encrypted: portal_credentials.password_encrypted,
    })
    .from(portal_credentials)
    .where(and(eq(portal_credentials.id, credentialId), eq(portal_credentials.user_id, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  await db.update(portal_credentials)
    .set({
      last_revealed_at: new Date(),
      reveal_count: sql`${portal_credentials.reveal_count} + 1`,
    })
    .where(and(eq(portal_credentials.id, credentialId), eq(portal_credentials.user_id, userId)));

  // decryptField throws FieldDecryptError when ENCRYPTION_KEY does not match the stored envelope.
  // That is a configuration fault and must surface as one; it is never caught and turned into a
  // pass-through of the stored bytes, which is how ciphertext once reached a real employer.
  return {
    id: row.id,
    portal_family: row.portal_family,
    tenant: row.tenant,
    username: row.username,
    password: decryptField(row.password_encrypted),
  };
}

/**
 * The plaintext the registration runner needs, owner-scoped by (user, family, tenant) rather than by
 * credential id, because the runner knows the portal it is looking at and not a row id.
 *
 * Callers must keep the returned value in memory: it must not be logged, persisted into a spec, or
 * attached to a review record.
 */
export async function portalCredentialSecretForOwner(
  userId: string,
  portalFamily: string,
  tenant: string,
): Promise<{ username: string; password: string } | null> {
  const rows = await db
    .select({
      username: portal_credentials.username,
      password_encrypted: portal_credentials.password_encrypted,
    })
    .from(portal_credentials)
    .where(and(
      eq(portal_credentials.user_id, userId),
      eq(portal_credentials.portal_family, portalFamily),
      eq(portal_credentials.tenant, tenant),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { username: row.username, password: decryptField(row.password_encrypted) };
}

/** Records that the credential was used against the portal. Owner-scoped like every other write. */
export async function markPortalCredentialUsed(userId: string, credentialId: string): Promise<void> {
  await db.update(portal_credentials)
    .set({ last_used_at: new Date(), updated_at: new Date() })
    .where(and(eq(portal_credentials.id, credentialId), eq(portal_credentials.user_id, userId)));
}
