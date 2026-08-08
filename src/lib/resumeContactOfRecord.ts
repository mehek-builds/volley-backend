import type { ContactHeader } from '../engine/resumeRender';

/**
 * THE CONTACT BLOCK IS SERVER BUSINESS, not something a client gets to be the only source of.
 *
 * POST /resume/generate used to render `body.contact` verbatim (routes/resume.ts, and every field
 * below full_name is `.nullable().optional()` in resumeRequestSchema.ts). So the document an
 * employer keeps was exactly as complete as whatever the caller happened to be holding in memory,
 * and both callers degrade quietly on their own profile reads:
 *
 *   - the dashboard: `bootstrap.application_profile ?? {}` and `.catch(() => ({}))` in
 *     features/dashboard/application/load-dashboard.ts
 *   - the extension: `profileRes.ok ? await profileRes.json() : EMPTY_PROFILE` in
 *     src/entrypoints/background.ts
 *
 * Measured on production 2026-08-09: 28 of one account's 85 packets carried neither email nor
 * phone, while the same account's users.email and application_profile.phone were populated and
 * sitting on this very request. The server had the answer and printed the client's blank.
 *
 * So the request is now a PREFERENCE, not the record. Anything the caller sends wins (it may be a
 * deliberate per-application choice), and every field it leaves empty is filled from the account.
 * Nothing is invented: `accountEmail` is the verified login off the JWT and `profile` is the
 * decrypted application_profile row. When both sources are empty the field stays empty and the
 * caller refuses, which is the whole point of returning a plain object rather than a rendered PDF.
 */
export interface ResumeContactSources {
  /** What the caller asked for. Every field optional; blanks are holes to fill, not instructions. */
  requested: {
    full_name: string;
    email?: string;
    phone?: string;
    linkedin_url?: string;
    github_url?: string;
    portfolio_url?: string;
  };
  /** users.email, resolved from the verified session in middleware/auth.ts. */
  accountEmail?: string;
  /**
   * The DECRYPTED application_profile row, or `{}` when there is none and when it would not
   * decrypt. phone is in ENCRYPTED_FIELDS, so passing the raw row here would print ciphertext on a
   * resume, which is the exact failure R-021 exists to prevent.
   */
  profile?: Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function resumeContactOfRecord(sources: ResumeContactSources): ContactHeader {
  const { requested, accountEmail, profile } = sources;
  const fromProfile = (field: string) => text(profile?.[field]);
  return {
    full_name: requested.full_name,
    email: text(requested.email) ?? text(accountEmail),
    phone: text(requested.phone) ?? fromProfile('phone'),
    linkedin_url: text(requested.linkedin_url) ?? fromProfile('linkedin_url'),
    github_url: text(requested.github_url) ?? fromProfile('github_url'),
    portfolio_url: text(requested.portfolio_url) ?? fromProfile('portfolio_url'),
  };
}
