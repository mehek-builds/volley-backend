import { z } from 'zod';

export const ISO_COUNTRY_CODES = (`AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`).split(' ');
const ISO_COUNTRY_CODE_SET = new Set(ISO_COUNTRY_CODES);

export function isIsoCountryCode(value: string | null | undefined): value is string {
  return Boolean(value && ISO_COUNTRY_CODE_SET.has(value.trim().toUpperCase()));
}

/**
 * One applicant declaration for one country.
 *
 * The country is the scope. No caller may detach the booleans from it or treat one row as a
 * worldwide answer. `authorization_type` and `authorization_expiry` are optional because many
 * applicants can truthfully answer the yes/no questions without either detail.
 */
export const countryWorkEligibilitySchema = z.object({
  country_code: z.string().trim().toUpperCase().refine(isIsoCountryCode, 'Use an ISO 3166-1 alpha-2 country code'),
  authorized_now: z.boolean(),
  needs_sponsorship_now: z.boolean(),
  needs_sponsorship_future: z.boolean(),
  authorization_type: z.string().trim().min(1).max(120).nullable().optional(),
  authorization_expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export const countryWorkEligibilityListSchema = z.array(countryWorkEligibilitySchema).max(64).superRefine((rows, ctx) => {
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (seen.has(row.country_code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'country_code'],
        message: 'Only one work eligibility record is allowed per country',
      });
    }
    seen.add(row.country_code);
  });
});

export type CountryWorkEligibility = z.infer<typeof countryWorkEligibilitySchema>;

export function normalizeCountryWorkEligibility(value: unknown): CountryWorkEligibility[] | undefined {
  const parsed = countryWorkEligibilityListSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return parsed.data.map((row) => {
    const normalized: CountryWorkEligibility = {
      country_code: row.country_code,
      authorized_now: row.authorized_now,
      needs_sponsorship_now: row.needs_sponsorship_now,
      needs_sponsorship_future: row.needs_sponsorship_future,
    };
    if (row.authorization_type?.trim()) normalized.authorization_type = row.authorization_type.trim();
    if (row.authorization_expiry) normalized.authorization_expiry = row.authorization_expiry;
    return normalized;
  });
}

export function eligibilityForCountry(
  rows: readonly CountryWorkEligibility[] | null | undefined,
  countryCode: string | null | undefined,
): CountryWorkEligibility | undefined {
  const code = countryCode?.trim().toUpperCase();
  if (!isIsoCountryCode(code)) return undefined;
  return rows?.find((row) => row.country_code === code);
}

/** Existing scalar columns remain a US compatibility view, never a second editable authority. */
export function legacyUsProjection(rows: readonly CountryWorkEligibility[] | null | undefined): {
  work_authorized: boolean | null;
  needs_sponsorship: boolean | null;
} {
  const us = eligibilityForCountry(rows, 'US');
  return us
    ? {
      work_authorized: us.authorized_now,
      needs_sponsorship: us.needs_sponsorship_now || us.needs_sponsorship_future,
    }
    : { work_authorized: null, needs_sponsorship: null };
}

/**
 * Read old US values only when their meaning is complete.
 *
 * The old `needs_sponsorship` bit combined present and future need. A true value therefore cannot
 * be split without the original onboarding answer. Unknown stays unknown instead of being turned
 * into two newly invented declarations.
 */
export function conservativeLegacyUsRecord(input: {
  work_authorized?: boolean | null;
  needs_sponsorship?: boolean | null;
  sponsorship_answer?: unknown;
}): CountryWorkEligibility | undefined {
  if (input.work_authorized === true && input.needs_sponsorship === false) {
    return {
      country_code: 'US',
      authorized_now: true,
      needs_sponsorship_now: false,
      needs_sponsorship_future: false,
    };
  }
  if (
    input.sponsorship_answer === 'needs_future'
    && input.work_authorized !== false
    && input.needs_sponsorship !== false
  ) {
    return {
      country_code: 'US',
      authorized_now: true,
      needs_sponsorship_now: false,
      needs_sponsorship_future: true,
    };
  }
  if (
    input.sponsorship_answer === 'no'
    && input.work_authorized !== false
    && input.needs_sponsorship !== true
  ) {
    return {
      country_code: 'US',
      authorized_now: true,
      needs_sponsorship_now: false,
      needs_sponsorship_future: false,
    };
  }
  return undefined;
}

export function countryEligibilityForRead(input: {
  stored: unknown;
  work_authorized?: boolean | null;
  needs_sponsorship?: boolean | null;
  sponsorship_answer?: unknown;
}): CountryWorkEligibility[] | undefined {
  const stored = normalizeCountryWorkEligibility(input.stored);
  if (stored !== undefined) return stored;
  const legacy = conservativeLegacyUsRecord(input);
  return legacy ? [legacy] : undefined;
}

/* Country names used by real ATS questions and structured locations. The value is always the
 * ISO-3166 alpha-2 code persisted in the profile. Ambiguous words such as Georgia are omitted. */
const COUNTRY_ALIASES = new Map<string, string>([
  ['united states', 'US'], ['united states of america', 'US'], ['usa', 'US'], ['u.s.', 'US'],
  ['united kingdom', 'GB'], ['great britain', 'GB'], ['britain', 'GB'], ['england', 'GB'], ['uk', 'GB'],
  ['united arab emirates', 'AE'], ['uae', 'AE'], ['dubai', 'AE'], ['abu dhabi', 'AE'],
  ['india', 'IN'], ['canada', 'CA'], ['singapore', 'SG'], ['australia', 'AU'], ['new zealand', 'NZ'],
  ['germany', 'DE'], ['france', 'FR'], ['ireland', 'IE'], ['netherlands', 'NL'], ['belgium', 'BE'],
  ['switzerland', 'CH'], ['austria', 'AT'], ['spain', 'ES'], ['portugal', 'PT'], ['italy', 'IT'],
  ['sweden', 'SE'], ['norway', 'NO'], ['denmark', 'DK'], ['finland', 'FI'], ['poland', 'PL'],
  ['czech republic', 'CZ'], ['czechia', 'CZ'], ['romania', 'RO'], ['hungary', 'HU'], ['greece', 'GR'],
  ['turkey', 'TR'], ['türkiye', 'TR'], ['israel', 'IL'], ['japan', 'JP'], ['china', 'CN'],
  ['hong kong', 'HK'], ['taiwan', 'TW'], ['south korea', 'KR'], ['korea', 'KR'], ['mexico', 'MX'],
  ['brazil', 'BR'], ['argentina', 'AR'], ['chile', 'CL'], ['colombia', 'CO'], ['peru', 'PE'],
  ['south africa', 'ZA'], ['nigeria', 'NG'], ['kenya', 'KE'], ['egypt', 'EG'],
  ['saudi arabia', 'SA'], ['qatar', 'QA'], ['vietnam', 'VN'], ['viet nam', 'VN'],
  ['indonesia', 'ID'], ['malaysia', 'MY'], ['philippines', 'PH'], ['thailand', 'TH'],
]);

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COUNTRY_ALIAS_PATTERN = new RegExp(
  `\\b(${[...COUNTRY_ALIASES.keys()].sort((a, b) => b.length - a.length).map(escaped).join('|')})\\b`,
  'gi',
);

/** Exactly one named country, or undefined for none, ambiguity, and multi-country questions. */
export function namedCountryCodes(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const match of text.matchAll(COUNTRY_ALIAS_PATTERN)) {
    const code = COUNTRY_ALIASES.get(match[0].toLowerCase());
    if (code) found.add(code);
  }
  return [...found];
}

export function namedCountryCode(text: string | null | undefined): string | undefined {
  const found = namedCountryCodes(text);
  return found.length === 1 ? found[0] : undefined;
}
