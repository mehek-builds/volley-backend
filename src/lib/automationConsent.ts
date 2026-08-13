export const AUTOMATIC_SUBMISSION_CONSENT_VERSION = '2026-07-25';

/**
 * Bumped from the version the 25 pre-existing accounts hold.
 *
 * Those rows were written by codex/litos-captcha-consent, a branch that applied its migration to
 * production and then never merged, so those people agreed to a flow that was never built. The
 * behaviour that actually ships is not the behaviour they saw, and re-using their version string
 * would silently treat a stale agreement as consent to something else.
 *
 * Read `captchaResumeGranted` rather than the boolean alone: a row whose version does not match
 * this constant has not consented to what is here now.
 */
export const AUTOMATIC_CAPTCHA_CONSENT_VERSION = '2026-08-04';

/**
 * The words the applicant is shown when she grants standing permission to accept employer consent
 * acknowledgements. First version, so no account can hold a stale one yet.
 *
 * BUMP THIS whenever the boundary changes, and specifically whenever a question class moves from
 * held to accepted. The version is the record of WHAT she agreed Litos could tick; widening the
 * class under an unchanged string would silently reuse an old agreement for a new act, which is the
 * exact defect AUTOMATIC_CAPTCHA_CONSENT_VERSION exists to document.
 */
export const AUTOMATIC_CONSENT_ACCEPTANCE_VERSION = '2026-08-12';

/**
 * The words shown for the SECOND consent permission, codes of conduct.
 *
 * Its own constant rather than a shared one, because the two permissions are independently
 * revocable and independently re-consentable. Sharing a version string would mean rewording the
 * privacy permission silently invalidated a conduct grant she never touched.
 */
export const AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION = '2026-08-12';

export type AutomationPermissions = {
  automatic_submission_enabled: boolean;
  automatic_verification_enabled: boolean;
  automatic_captcha_enabled?: boolean;
  automatic_consent_acceptance_enabled?: boolean;
  automatic_conduct_acceptance_enabled?: boolean;
};

/**
 * Whether Litos may pick an application back up after the APPLICANT clears a challenge.
 *
 * It never means Litos solves anything. The applicant passes the check in their own browser, in
 * their own session, and this only decides whether the fill resumes on its own afterwards or waits
 * to be told. Submission permission does not imply it and never has: finishing the remaining fields
 * and sending an application to an employer are different acts with different stakes.
 *
 * Version-checked, not just boolean-checked. See AUTOMATIC_CAPTCHA_CONSENT_VERSION.
 */
export function captchaResumeGranted(row: {
  automatic_captcha_enabled?: boolean | null;
  automatic_captcha_consent_version?: string | null;
} | null | undefined): boolean {
  return row?.automatic_captcha_enabled === true
    && row.automatic_captcha_consent_version === AUTOMATIC_CAPTCHA_CONSENT_VERSION;
}

/**
 * Whether Litos may ACCEPT an employer's privacy statement, applicant terms or code of conduct in
 * the applicant's name, instead of handing every one of them back to her.
 *
 * Version-checked for the same reason CAPTCHA resume is: this permission is defined by the words
 * she was shown, and a row carrying a different version agreed to different words.
 *
 * It never widens what may be accepted. The class is decided structurally by
 * isConsentAcknowledgementQuestion (lib/questionDiscovery.ts), whose held-declaration veto runs
 * first and is not reachable from here: work authorization, age, degree, criminal history, health,
 * veteran status, EEO, background and reference authorizations and truth attestations stay held
 * whatever this returns. This only decides whether the consent CLASS is accepted or held.
 */
export function consentAcceptanceGranted(row: {
  automatic_consent_acceptance_enabled?: boolean | null;
  automatic_consent_acceptance_consent_version?: string | null;
} | null | undefined): boolean {
  return row?.automatic_consent_acceptance_enabled === true
    && row.automatic_consent_acceptance_consent_version === AUTOMATIC_CONSENT_ACCEPTANCE_VERSION;
}

/**
 * Whether Litos may accept an employer's CODE OF CONDUCT in the applicant's name.
 *
 * Deliberately not derivable from consentAcceptanceGranted. See the column comment in db/schema.ts:
 * a behavioural policy binding a live interview is not the routine privacy notice, and this repo
 * has already ticked one of them with nothing stored behind it once.
 */
export function conductAcceptanceGranted(row: {
  automatic_conduct_acceptance_enabled?: boolean | null;
  automatic_conduct_acceptance_consent_version?: string | null;
} | null | undefined): boolean {
  return row?.automatic_conduct_acceptance_enabled === true
    && row.automatic_conduct_acceptance_consent_version === AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION;
}

/** The stored shape every permission verdict is derived from. */
export type AutomationConsentRow = {
  automatic_submission_enabled: boolean | null;
  automatic_submission_consented_at: Date | null;
  automatic_submission_consent_version: string | null;
  automatic_verification_enabled: boolean | null;
  automatic_verification_consented_at?: Date | null;
  automatic_captcha_enabled?: boolean | null;
  automatic_captcha_consented_at?: Date | null;
  automatic_captcha_consent_version?: string | null;
  automatic_consent_acceptance_enabled?: boolean | null;
  automatic_consent_acceptance_consented_at?: Date | null;
  automatic_consent_acceptance_consent_version?: string | null;
  automatic_conduct_acceptance_enabled?: boolean | null;
  automatic_conduct_acceptance_consented_at?: Date | null;
  automatic_conduct_acceptance_consent_version?: string | null;
};

/**
 * Every automation permission exactly as GET /onboarding/state sends it.
 *
 * ONE FUNCTION RATHER THAN A LITERAL IN THE ROUTE, because the rule this encodes was broken for
 * eight days without anything going red. `automatic_captcha_consented_at` was written on every grant
 * from 2026-08-04 and returned by nothing, so a settings screen could show a granted permission with
 * no date and no way to find one. Writing and sending lived in different files, which is precisely
 * what made the omission invisible. Here the pairing is a property of a function a test can call.
 *
 * TWO SHAPES, and the difference is the whole design:
 *   *_enabled          the ALREADY-VERSION-CHECKED verdict. Never the raw column. A row whose stored
 *                      version has been superseded is not consent to what ships now, and a client
 *                      re-deriving that rule is a client that will get it wrong.
 *   *_consented_at     the RAW date, ungated. A superseded grant therefore arrives as a false
 *                      verdict WITH a real date, and that pairing is deliberate: the client prints
 *                      no date whenever the verdict is false, which is what stops a stale grant from
 *                      being displayed as a live one. Gating the date here would hide the one fact
 *                      that makes the pairing legible.
 *
 * The version fields are the CURRENT constants, not the row's. What a client may know is which
 * wording is live, never which wording a given row happens to carry, because the second invites
 * exactly the re-derivation the first line above forbids.
 */
export function automationConsentState(row: AutomationConsentRow) {
  return {
    automatic_submission_enabled: row.automatic_submission_enabled,
    automatic_submission_consented_at: row.automatic_submission_consented_at,
    automatic_submission_consent_version: row.automatic_submission_consent_version,
    automatic_verification_enabled: row.automatic_verification_enabled,
    /* Sent for the first time here. It was written by PUT /onboarding/automation and read by
       nothing, the same defect as the captcha column and found while fixing that one. Two permissions
       with the same bug, and only one of them repaired, is how the class survives. */
    automatic_verification_consented_at: row.automatic_verification_consented_at ?? null,
    automatic_captcha_enabled: captchaResumeGranted(row),
    automatic_captcha_consented_at: row.automatic_captcha_consented_at ?? null,
    automatic_consent_acceptance_enabled: consentAcceptanceGranted(row),
    automatic_consent_acceptance_consented_at: row.automatic_consent_acceptance_consented_at ?? null,
    automatic_consent_acceptance_consent_version: AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
    automatic_conduct_acceptance_enabled: conductAcceptanceGranted(row),
    automatic_conduct_acceptance_consented_at: row.automatic_conduct_acceptance_consented_at ?? null,
    automatic_conduct_acceptance_consent_version: AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION,
  };
}

export function automationConsentValues(settings: AutomationPermissions, now: Date) {
  return {
    automatic_submission_enabled: settings.automatic_submission_enabled,
    automatic_submission_consented_at: settings.automatic_submission_enabled ? now : null,
    automatic_submission_consent_version: settings.automatic_submission_enabled
      ? AUTOMATIC_SUBMISSION_CONSENT_VERSION
      : null,
    automatic_verification_enabled: settings.automatic_verification_enabled,
    automatic_verification_consented_at: settings.automatic_verification_enabled ? now : null,
    /* OMITTED when undefined, not defaulted to false. This object is spread into a column update, so
     * naming the column always would make every writer that does not mention captcha resume revoke
     * it: POST /onboarding/complete does not send the field, so re-running /start after granting the
     * permission in settings would silently take it away with no user-visible act. Undefined means
     * "leave it alone"; an explicit false is a revocation and still clears the version with it. */
    ...(settings.automatic_captcha_enabled === undefined ? {} : {
      automatic_captcha_enabled: settings.automatic_captcha_enabled,
      automatic_captcha_consented_at: settings.automatic_captcha_enabled ? now : null,
      automatic_captcha_consent_version: settings.automatic_captcha_enabled
        ? AUTOMATIC_CAPTCHA_CONSENT_VERSION
        : null,
    }),
    // Omitted when undefined for the reason above it, and it matters more here than anywhere: this
    // is the permission whose whole point is that the applicant chose it on a date. A writer that
    // did not mention it must not restamp the date, and must not revoke it either.
    ...(settings.automatic_consent_acceptance_enabled === undefined ? {} : {
      automatic_consent_acceptance_enabled: settings.automatic_consent_acceptance_enabled,
      automatic_consent_acceptance_consented_at: settings.automatic_consent_acceptance_enabled ? now : null,
      automatic_consent_acceptance_consent_version: settings.automatic_consent_acceptance_enabled
        ? AUTOMATIC_CONSENT_ACCEPTANCE_VERSION
        : null,
    }),
    ...(settings.automatic_conduct_acceptance_enabled === undefined ? {} : {
      automatic_conduct_acceptance_enabled: settings.automatic_conduct_acceptance_enabled,
      automatic_conduct_acceptance_consented_at: settings.automatic_conduct_acceptance_enabled ? now : null,
      automatic_conduct_acceptance_consent_version: settings.automatic_conduct_acceptance_enabled
        ? AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION
        : null,
    }),
  };
}
