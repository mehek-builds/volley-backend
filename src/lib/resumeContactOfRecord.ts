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
 * Phone and links still use the caller as a preference and fill holes from the decrypted profile.
 * Application resume routes pass the separately stored explicit resume_email as both requested and
 * account email, so neither login identity nor a portal alias can become the PDF email.
 */
export interface ResumeContactSources {
  /** What the caller asked for. Every field optional; blanks are holes to fill, not instructions. */
  requested: {
    full_name: string;
    email?: string;
    phone?: string;
    location?: string;
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

/**
 * The header's location line, assembled from the address she gave rather than inferred.
 *
 * "City, State" when both are on file, and the city alone when the state is not - a bare state is
 * not a location a reader can use, so it is never printed on its own. The country is used ONLY
 * when there is no state, which is what makes this work for a non-US address ("Dubai, United Arab
 * Emirates") without printing a redundant "Los Angeles, CA, United States" for a US one.
 *
 * NOT DERIVED FROM SCHOOL LOCATION, which is the near-miss worth naming. parsed_json carries
 * school_location and it reads "Los Angeles, CA" for this account, so using it would have produced
 * the right string here and the wrong rule everywhere: where someone studies is not where they
 * live, and a resume header stating a residence the applicant never claimed is exactly the class
 * of invented fact the profile columns exist to prevent. address_city and address_state are her
 * own answer to "where do you live", so they are the only source read here.
 */
export function resumeHeaderLocation(profile: Record<string, unknown> | undefined): string | undefined {
  const city = text(profile?.['address_city']);
  if (!city) return undefined;
  const region = text(profile?.['address_state']) ?? text(profile?.['address_country']);
  return region ? `${city}, ${region}` : city;
}

export function resumeContactOfRecord(sources: ResumeContactSources): ContactHeader {
  const { requested, accountEmail, profile } = sources;
  const fromProfile = (field: string) => text(profile?.[field]);
  return {
    full_name: requested.full_name,
    email: text(requested.email) ?? text(accountEmail),
    phone: text(requested.phone) ?? fromProfile('phone'),
    location: text(requested.location) ?? resumeHeaderLocation(profile),
    linkedin_url: text(requested.linkedin_url) ?? fromProfile('linkedin_url'),
    github_url: text(requested.github_url) ?? fromProfile('github_url'),
    portfolio_url: text(requested.portfolio_url) ?? fromProfile('portfolio_url'),
  };
}
