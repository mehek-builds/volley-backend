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

/**
 * The profile-sourced contact fields a stored packet may safely pick up from the CURRENT profile
 * without becoming a different application. full_name and email are deliberately absent - see the
 * doc comment on refreshResumeContactFromProfile for why each stays packet-specific.
 */
const MUTABLE_CONTACT_FIELDS = ['phone', 'location', 'linkedin_url', 'github_url', 'portfolio_url'] as const;

/**
 * Refresh mutable contact facts when an applicant explicitly saves an existing packet again, or
 * explicitly asks Litos to bring an already-built packet's header back in line with her current
 * profile (POST /applications/:id/resume/contact-refresh).
 *
 * The generated resume remains frozen until one of those two things happens. Once it does,
 * preserving an older profile phone, residence or link would create a newly rendered PDF that
 * disagrees with the current employer-form packet: the managed form fills phone and location LIVE
 * from this same profile row at submit time (see applicationContextForQuestionResolution), and a
 * stale LinkedIn or portfolio link is simply a stale way to reach her.
 *
 * full_name and email remain packet-specific, and neither is in MUTABLE_CONTACT_FIELDS.
 * full_name is never sourced from the profile at all - resumeContactOfRecord takes it only from
 * `requested`, because a resume header prints the name she chose to apply under, not a column that
 * can change for reasons unrelated to any one application. email carries a separate identity: it is
 * the resume_email that pins the packet's applicant-email routing (see planPacketApplicantEmail)
 * and the packet audit's resumeContactEmailSha256, so a caller whose account email changed must be
 * refused upstream (resumePacketEmailIsCurrent) rather than have this helper silently rewrite it.
 */
export function refreshResumeContactFromProfile(
  stored: ContactHeader,
  profile: Record<string, unknown> | undefined,
): ContactHeader {
  const phone = text(profile?.['phone']);
  const location = resumeHeaderLocation(profile);
  const linkedin_url = text(profile?.['linkedin_url']);
  const github_url = text(profile?.['github_url']);
  const portfolio_url = text(profile?.['portfolio_url']);
  return {
    ...stored,
    ...(phone ? { phone } : {}),
    ...(location ? { location } : {}),
    ...(linkedin_url ? { linkedin_url } : {}),
    ...(github_url ? { github_url } : {}),
    ...(portfolio_url ? { portfolio_url } : {}),
  };
}

export type ResumeContactStaleness = {
  stored: ContactHeader;
  current: ContactHeader;
};

/**
 * Whether refreshResumeContactFromProfile would actually change anything on this packet, and the
 * exact before/after pair when it would.
 *
 * THE ONE COMPARISON BOTH SIDES OF THE FEATURE SHARE. GET /applications/:id/submission calls this
 * to decide whether to show the applicant a "your resume header is out of date" signal at all, and
 * POST /applications/:id/resume/contact-refresh calls it to decide whether there is anything worth
 * spending a PDF render and a new object key on. A second, differently-worded comparison in either
 * place is how a button and the route behind it drift apart - one says stale while the other says
 * there is nothing to refresh, or the reverse.
 *
 * null on a packet with no drift, which MUST be the common case: full_name and email are excluded
 * from MUTABLE_CONTACT_FIELDS on purpose (see refreshResumeContactFromProfile), so an applicant who
 * has only ever changed her name or her personal resume email sees no stale signal and the refresh
 * route touches nothing, exactly as it should - those are refused-or-ignored here, not silently
 * folded into "stale".
 */
export function resumeContactStaleness(
  stored: ContactHeader,
  profile: Record<string, unknown> | undefined,
): ResumeContactStaleness | null {
  const current = refreshResumeContactFromProfile(stored, profile);
  const drifted = MUTABLE_CONTACT_FIELDS.some((field) => (current[field] ?? '') !== (stored[field] ?? ''));
  return drifted ? { stored, current } : null;
}
