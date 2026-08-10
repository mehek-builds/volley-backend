export type BrowserApplicationFamily =
  | 'zoho_recruit'
  | 'bullhorn'
  | 'sap_successfactors'
  | 'oracle_taleo'
  | 'adp_recruiting'
  | 'jazzhr'
  | 'icims';

export type BrowserApplicationCapability = {
  family: BrowserApplicationFamily;
  fill: boolean;
  uploadResume: boolean;
  createAccount: boolean;
  programmaticSubmit: boolean;
  trustedDirectClick: boolean;
  pollPublicListings: boolean;
  reason: string;
};

const DENIED: Omit<BrowserApplicationCapability, 'family' | 'reason'> = {
  fill: false,
  uploadResume: false,
  createAccount: false,
  programmaticSubmit: false,
  trustedDirectClick: true,
  pollPublicListings: false,
};

const CAPABILITIES: Readonly<Record<BrowserApplicationFamily, BrowserApplicationCapability>> = {
  zoho_recruit: {
    ...DENIED,
    family: 'zoho_recruit',
    fill: true,
    uploadResume: true,
    reason: 'Tenant-configurable consent, privacy, retention, questions about race and gender, and CAPTCHA controls require applicant review.',
  },
  bullhorn: {
    ...DENIED,
    family: 'bullhorn',
    fill: true,
    uploadResume: true,
    reason: 'Bullhorn OSCP is self-hosted and customizable, so the final control and receipt are not portable proofs.',
  },
  sap_successfactors: {
    ...DENIED,
    family: 'sap_successfactors',
    reason: 'The public job route transitions to a tenant account wall before the application form.',
  },
  oracle_taleo: {
    ...DENIED,
    family: 'oracle_taleo',
    reason: 'Both researched Taleo tenants place a legal acceptance screen before any application controls.',
  },
  adp_recruiting: {
    ...DENIED,
    family: 'adp_recruiting',
    reason: 'Both researched ADP Recruiting tenants require authentication before the application form.',
  },
  jazzhr: {
    ...DENIED,
    family: 'jazzhr',
    fill: true,
    uploadResume: true,
    reason: 'Both researched JazzHR forms include reCAPTCHA and tenant-specific questions that require applicant review.',
  },
  /* The one family where creating an account is allowed, and the only capability that changed.
   *
   * iCIMS shows no application form at all until an account exists on the employer's tenant, so
   * "Litos leaves the account to you" meant Litos could do nothing here. It can now register the
   * account: the Litos application alias becomes the account address, so verification, confirmation
   * and interview mail arrive where every other employer message already arrives, and the password
   * is generated per tenant and stored encrypted for the applicant to read whenever she wants.
   *
   * Everything else stays denied, and deliberately so. `fill` is false because there is still no
   * captured application form behind the wall. `programmaticSubmit` is false because registering an
   * account is not pressing submit: the submit boundary is exactly where it was. The registration
   * plan itself is behind a flag that is off by default and stops on the hCaptcha that the captured
   * login page carries. */
  icims: {
    ...DENIED,
    family: 'icims',
    createAccount: true,
    reason: 'Litos creates the applicant account this portal requires, registered to the Litos application alias with a per-tenant password stored encrypted. The application form, its legal choices, and the send button remain the applicant\'s.',
  },
};

/** Unknown families and unknown tenants are denied. Nothing becomes submit-capable by omission. */
export function browserApplicationCapability(family: string): BrowserApplicationCapability {
  return CAPABILITIES[family as BrowserApplicationFamily] ?? {
    ...DENIED,
    family: family as BrowserApplicationFamily,
    reason: 'This browser application family has not been proven safe.',
  };
}

export const RESEARCHED_BROWSER_TENANTS = {
  zoho_recruit: ['genovice.zohorecruit.com', 'solution25.zohorecruit.eu'],
  bullhorn: ['www.serverlogic.com', 'www.staffingsolutionsenterprises.com'],
  sap_successfactors: ['career2.successfactors.eu', 'career8.successfactors.com'],
  oracle_taleo: ['fa007.taleo.net', 'aa270.taleo.net'],
  adp_recruiting: ['myjobs.adp.com'],
  jazzhr: ['utilidata.applytojob.com', 'foundationai.applytojob.com'],
  // Empty on purpose. The account wall and its hCaptcha were captured on 2026-07-29, but no iCIMS
  // tenant has been carried through a real registration, and listing a host here would claim
  // otherwise. Tenant identity for iCIMS is read from the URL by icimsTenantFromUrl, which needs no
  // allowlist; this stays empty until a live capture earns an entry.
  icims: [],
} as const satisfies Readonly<Record<BrowserApplicationFamily, readonly string[]>>;

export function isResearchedBrowserTenant(family: BrowserApplicationFamily, hostname: string): boolean {
  return (RESEARCHED_BROWSER_TENANTS[family] as readonly string[]).includes(hostname.toLowerCase());
}
