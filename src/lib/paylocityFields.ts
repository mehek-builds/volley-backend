type PaylocityFieldIdentity = {
  label: string;
  selector?: string | null;
  durableSelector?: string | null;
  inputType?: string;
  role?: string | null;
  required?: boolean;
};

type PaylocityApplicantFacts = {
  full_name?: string;
  contact_email?: string;
  phone?: string;
  preferred_first_name?: string;
  linkedin_url?: string;
  address_city?: string;
  address_state?: string;
  address_zip?: string;
  address_country?: string;
};

const CANONICAL_LABEL_BY_ID: Readonly<Record<string, string>> = {
  'info.firstName': 'First name',
  'info.lastName': 'Last name',
  'info.middleName': 'Middle name',
  'info.preferredName': 'Preferred first name',
  'info.email': 'Email',
  'info.cellPhone': 'Mobile number',
  'info.phone': 'Home phone number',
  'info.linkedIn': 'LinkedIn',
  'info.dateAvailableToStart': 'Available to start',
  'info.desiredSalaryType': 'Desired salary type',
  'info.minimumDesiredSalary': 'Salary range (minimum)',
  'info.maximumDesiredSalary': 'Salary range (maximum)',
  'public-site-address-address-1': 'Address line 1',
  'public-site-address-city': 'City',
  'public-site-address-county': 'County',
  'public-site-address-us-state': 'State',
  'public-site-address-zip': 'Zip code',
  'public-site-address-country': 'Country',
};

/* Paylocity renders these built-in controls with visible required copy that its generic discovery
 * output did not carry in the live Celerant capture. The stable provider ids identify those rows.
 * Treating a tenant's optional row as required only asks the applicant one extra question; treating
 * a required row as optional lets the wizard advance with an employer field blank. */
const REQUIRED_FIELD_IDS = new Set<string>([
  'info.dateAvailableToStart',
  'info.minimumDesiredSalary',
  'info.maximumDesiredSalary',
  'info.desiredSalaryType',
  'info.haveYouAppliedWithUsBefore',
  'info.haveYouWorkedWithUsBefore',
  'info.smsOptedIn',
  'public-site-address-address-1',
  'public-site-address-city',
  'public-site-address-county',
  'public-site-address-us-state',
  'public-site-address-zip',
  'public-site-address-country',
]);

const OPEN_TEXT_AUTOCOMPLETE_IDS = new Set<string>([
  'public-site-address-address-1',
]);

const isUnitedStates = (value: string | undefined): boolean =>
  /^(?:united states(?: of america)?|u\.?s\.?a?|us)$/i.test(value?.trim() ?? '');

export function paylocityFieldIdFromSelector(selector: string | null | undefined): string | undefined {
  const trimmed = selector?.trim() ?? '';
  if (!trimmed) return undefined;
  const attributeId = trimmed.match(
    /^(?:[a-z][a-z0-9-]*)?\[id=["']([A-Za-z][A-Za-z0-9_.:-]*)["']\]$/i,
  )?.[1];
  if (attributeId) return attributeId;
  if (!trimmed.startsWith('#')) return undefined;
  const id = trimmed.slice(1).replace(/\\([.:-])/g, '$1');
  return /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(id) ? id : undefined;
}

export function paylocityFieldId(
  field: Pick<PaylocityFieldIdentity, 'selector' | 'durableSelector'>,
): string | undefined {
  return paylocityFieldIdFromSelector(field.durableSelector)
    ?? paylocityFieldIdFromSelector(field.selector);
}

export function paylocityCanonicalFieldLabel(
  field: Pick<PaylocityFieldIdentity, 'selector' | 'durableSelector'>,
): string | undefined {
  const id = paylocityFieldId(field);
  return id ? CANONICAL_LABEL_BY_ID[id] : undefined;
}

export function paylocityFieldIsOpenTextAutocomplete(
  field: Pick<PaylocityFieldIdentity, 'selector' | 'durableSelector'>,
): boolean {
  const id = paylocityFieldId(field);
  return id ? OPEN_TEXT_AUTOCOMPLETE_IDS.has(id) : false;
}

export function normalizePaylocityDiscoveredField<T extends PaylocityFieldIdentity>(field: T): T {
  const id = paylocityFieldId(field);
  if (!id) return field;
  const label = CANONICAL_LABEL_BY_ID[id] ?? field.label;
  const required = field.required === true || REQUIRED_FIELD_IDS.has(id);
  const openTextAutocomplete = OPEN_TEXT_AUTOCOMPLETE_IDS.has(id)
    && /^(?:text|search)?$/i.test(field.inputType?.trim() ?? '');
  return {
    ...field,
    label,
    required,
    ...(openTextAutocomplete ? { role: null } : {}),
  };
}

/** Whether the exact built-in control is owned by Paylocity's fixed profile-fill plan. */
export function paylocityFieldIsFilledFromProfile(
  field: Pick<PaylocityFieldIdentity, 'selector' | 'durableSelector'>,
  facts: PaylocityApplicantFacts,
): boolean {
  const id = paylocityFieldId(field);
  if (!id) return false;
  if (id === 'info.firstName' || id === 'info.lastName' || id === 'info.email') return true;
  if (id === 'info.cellPhone') return Boolean(facts.phone?.trim());
  if (id === 'info.preferredName') return Boolean(facts.preferred_first_name?.trim());
  if (id === 'info.linkedIn') return Boolean(facts.linkedin_url?.trim());
  if (id === 'public-site-address-country') return Boolean(facts.address_country?.trim());
  if (id === 'public-site-address-city') return Boolean(facts.address_city?.trim());
  if (id === 'public-site-address-zip') return Boolean(facts.address_zip?.trim());
  if (id === 'public-site-address-us-state') {
    if (facts.address_country?.trim() && !isUnitedStates(facts.address_country)) return true;
    return isUnitedStates(facts.address_country) && Boolean(facts.address_state?.trim());
  }
  return false;
}

export function paylocityCountryIsUnitedStates(value: string | undefined): boolean {
  return isUnitedStates(value);
}
