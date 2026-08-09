export type BrowserApplicationFamily = 'zoho_recruit' | 'bullhorn' | 'sap_successfactors';

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
} as const satisfies Readonly<Record<BrowserApplicationFamily, readonly string[]>>;

export function isResearchedBrowserTenant(family: BrowserApplicationFamily, hostname: string): boolean {
  return (RESEARCHED_BROWSER_TENANTS[family] as readonly string[]).includes(hostname.toLowerCase());
}
