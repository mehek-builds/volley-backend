import { isIsoCountryCode } from './workEligibility';

/**
 * IS THIS JOB IN THE UNITED STATES?
 *
 * An H-1B is a US work visa. An employer's H-1B record is therefore evidence about the roles it
 * hires for IN THE UNITED STATES, and says nothing whatever about a job in Bengaluru, Tokyo or
 * London - those need a work permit from a different government, on rules this product knows
 * nothing about.
 *
 * Measured on the live board (2026-07-29): 3,336 of the 9,552 postings that the sponsor-only filter
 * surfaced were outside the US. Every one of them was shown to somebody who needs sponsorship as a
 * job at a company "we can confirm sponsors visas", on the strength of a petition filed in another
 * country for another role. That is the overclaim this file exists to stop.
 *
 * THREE ANSWERS, NOT TWO, and the third is load-bearing:
 *
 *   'us'       the location names a US state, city or the country
 *   'non_us'   the location names somewhere else
 *   'unknown'  "Remote", "Anywhere", an empty string - genuinely undecidable
 *
 * A bare "Remote" at a company whose whole filing history is American is not evidence of a foreign
 * role, so 'unknown' is surfaced rather than hidden. 'non_us' is not: London is London.
 */

export type JobCountry = 'us' | 'non_us' | 'unknown';
type JobCountrySignalDetails = { strongUs: boolean; weakUs: boolean; nonUs: boolean };

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY',
  'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY', 'DC', 'PR',
]);

/* GEORGIA IS NOT IN HERE, and that is the point. It is a US state and a country, and the live
   board carries "Belgrade, Belgrade, Serbia; Berlin, Berlin, Germany; Georgia" - which is the
   country, listed beside two other European ones, and which the state name turned into a US role.
   The US sense is still caught by everything around it: "Atlanta, Georgia" has ATLANTA, "Savannah,
   GA" has the code, "Georgia, United States" has the country. */
const US_STATE_NAMES = [
  'ALABAMA', 'ALASKA', 'ARIZONA', 'ARKANSAS', 'CALIFORNIA', 'COLORADO', 'CONNECTICUT', 'DELAWARE',
  'FLORIDA', 'HAWAII', 'IDAHO', 'ILLINOIS', 'INDIANA', 'IOWA', 'KANSAS', 'KENTUCKY',
  'LOUISIANA', 'MAINE', 'MARYLAND', 'MASSACHUSETTS', 'MICHIGAN', 'MINNESOTA', 'MISSISSIPPI',
  'MISSOURI', 'MONTANA', 'NEBRASKA', 'NEVADA', 'NEW HAMPSHIRE', 'NEW JERSEY', 'NEW MEXICO',
  'NEW YORK', 'NORTH CAROLINA', 'NORTH DAKOTA', 'OHIO', 'OKLAHOMA', 'OREGON', 'PENNSYLVANIA',
  'RHODE ISLAND', 'SOUTH CAROLINA', 'SOUTH DAKOTA', 'TENNESSEE', 'TEXAS', 'UTAH', 'VERMONT',
  'VIRGINIA', 'WASHINGTON', 'WEST VIRGINIA', 'WISCONSIN', 'WYOMING', 'DISTRICT OF COLUMBIA',
  'PUERTO RICO',
];

/* US cities that appear on this board without a state beside them. Kept short on purpose: a long
   list of ambiguous city names ("Cambridge", "Birmingham", "Portland") would start claiming British
   towns as American, and 'unknown' is a perfectly good answer. */
const US_CITIES = [
  'SAN FRANCISCO', 'NEW YORK CITY', 'NYC', 'LOS ANGELES', 'SILICON VALLEY', 'BAY AREA',
  'MOUNTAIN VIEW', 'PALO ALTO', 'MENLO PARK', 'SUNNYVALE', 'SANTA CLARA', 'SAN JOSE', 'SAN MATEO',
  'REDWOOD CITY', 'CUPERTINO', 'BROOKLYN', 'MANHATTAN', 'SEATTLE', 'BELLEVUE', 'REDMOND',
  'CHICAGO', 'AUSTIN', 'DENVER', 'BOULDER', 'ATLANTA', 'MIAMI', 'DALLAS', 'HOUSTON', 'PHOENIX',
  'SAN DIEGO', 'SALT LAKE CITY', 'MINNEAPOLIS', 'DETROIT', 'NASHVILLE', 'CHARLOTTE', 'RALEIGH',
  'DURHAM', 'PITTSBURGH', 'PHILADELPHIA', 'BALTIMORE', 'ARLINGTON', 'CULVER CITY', 'SANTA MONICA',
  'HAWTHORNE', 'EL SEGUNDO', 'IRVINE', 'NEWPORT BEACH', 'CORONA DEL MAR', 'STARBASE', 'MCLEAN',
  'RESTON', 'CAMBRIDGE, MA', 'BOSTON', 'GREENWICH, CT', 'JERSEY CITY', 'NEWARK, NJ',
  /* How individual boards write San Francisco. */
  'SF OFFICE', 'SF',
];

/* Countries and cities that are unmistakably NOT the US. The list only needs to cover what actually
   appears on the board, and anything it misses lands in 'unknown', which is surfaced - so a gap
   here is a missed narrowing, never a false claim about a foreign job. */
const NON_US = [
  'UNITED KINGDOM', 'ENGLAND', 'SCOTLAND', 'WALES', 'IRELAND', 'GERMANY', 'FRANCE', 'SPAIN',
  'PORTUGAL', 'ITALY', 'NETHERLANDS', 'BELGIUM', 'SWITZERLAND', 'AUSTRIA', 'SWEDEN', 'NORWAY',
  'DENMARK', 'FINLAND', 'POLAND', 'CZECH', 'ROMANIA', 'HUNGARY', 'GREECE', 'TURKEY', 'ISRAEL',
  'INDIA', 'SINGAPORE', 'JAPAN', 'CHINA', 'HONG KONG', 'TAIWAN', 'KOREA', 'AUSTRALIA',
  'NEW ZEALAND', 'CANADA', 'MEXICO', 'BRAZIL', 'ARGENTINA', 'CHILE', 'COLOMBIA', 'PERU',
  'SOUTH AFRICA', 'NIGERIA', 'KENYA', 'EGYPT', 'UAE', 'UNITED ARAB EMIRATES', 'SAUDI',
  'LONDON', 'DUBLIN', 'BERLIN', 'MUNICH', 'HAMBURG', 'PARIS', 'MADRID', 'BARCELONA', 'LISBON',
  'AMSTERDAM', 'ROTTERDAM', 'BRUSSELS', 'ZURICH', 'GENEVA', 'VIENNA', 'STOCKHOLM', 'OSLO',
  'COPENHAGEN', 'HELSINKI', 'WARSAW', 'PRAGUE', 'BUCHAREST', 'BUDAPEST', 'ATHENS', 'ISTANBUL',
  'TEL AVIV', 'BENGALURU', 'BANGALORE', 'MUMBAI', 'DELHI', 'GURGAON', 'GURUGRAM', 'HYDERABAD',
  'CHENNAI', 'PUNE', 'NOIDA', 'TOKYO', 'OSAKA', 'SEOUL', 'SHANGHAI', 'BEIJING', 'SHENZHEN',
  'SYDNEY', 'MELBOURNE', 'AUCKLAND', 'TORONTO', 'VANCOUVER', 'MONTREAL', 'OTTAWA', 'MEXICO CITY',
  'SAO PAULO', 'BUENOS AIRES', 'BOGOTA', 'DUBAI', 'ABU DHABI', 'RIYADH', 'CAIRO', 'LAGOS',
  'NAIROBI', 'MANILA', 'JAKARTA', 'BANGKOK', 'KUALA LUMPUR', 'HO CHI MINH', 'HANOI', 'EMEA',
  'APAC', 'LATAM',
  /* Added after classifying every distinct location on the live board: these all landed in
     'unknown', which surfaces them, and each is unambiguously abroad. */
  'UK', 'SERBIA', 'BELGRADE', 'ESTONIA', 'LATVIA', 'LITHUANIA', 'ICELAND', 'REYKJAVIK',
  'COSTA RICA', 'QATAR', 'DOHA', 'FRANKFURT', 'MILAN', 'MILANO', 'LUXEMBOURG', 'SAO PAULO',
  'SAUDI ARABIA', 'KING ABDULLAH', 'GIFT CITY', 'BRISTOL UK', 'CAMBRIDGE UK', 'EDINBURGH',
  'MANCHESTER UK', 'GLASGOW', 'BELFAST', 'CORK', 'MALTA', 'CYPRUS', 'BULGARIA', 'CROATIA',
  'SLOVAKIA', 'SLOVENIA', 'UKRAINE', 'ARMENIA', 'GEORGIA COUNTRY', 'MOROCCO', 'TUNISIA', 'GHANA',
  'URUGUAY', 'PANAMA', 'GUATEMALA', 'ECUADOR', 'BOLIVIA', 'PARAGUAY', 'VENEZUELA',
  /* Georgia the country. It is NOT in US_STATE_NAMES for the mirror-image reason - the live board
     carries "Belgrade, Serbia; Berlin, Germany; Georgia", which is the country. The US sense is
     still caught by everything around it: "Atlanta, Georgia" has the city, "Savannah, GA" the
     code, "Georgia, United States" the country. */
  'GEORGIA',
];

/* Exact country codes for the unambiguous workplace cities already accepted by the frozen
   location classifier above. This table is deliberately used only on structured ATS country and
   location fields. It must never be applied to a job description, where a city can describe a
   customer, headquarters, or travel rather than the workplace for this role. Ambiguous bare city
   names such as Melbourne and Cambridge stay out. */
const STRUCTURED_CITY_COUNTRY_CODES = new Map<string, string>([
  ['LONDON', 'GB'], ['BRISTOL UK', 'GB'], ['CAMBRIDGE UK', 'GB'], ['EDINBURGH', 'GB'],
  ['MANCHESTER UK', 'GB'], ['GLASGOW', 'GB'], ['BELFAST', 'GB'],
  ['DUBLIN', 'IE'], ['CORK', 'IE'],
  ['BERLIN', 'DE'], ['MUNICH', 'DE'], ['HAMBURG', 'DE'], ['FRANKFURT', 'DE'],
  ['PARIS', 'FR'], ['MADRID', 'ES'], ['BARCELONA', 'ES'], ['LISBON', 'PT'],
  ['AMSTERDAM', 'NL'], ['ROTTERDAM', 'NL'], ['BRUSSELS', 'BE'], ['ZURICH', 'CH'],
  ['GENEVA', 'CH'], ['VIENNA', 'AT'], ['STOCKHOLM', 'SE'], ['OSLO', 'NO'],
  ['COPENHAGEN', 'DK'], ['HELSINKI', 'FI'], ['WARSAW', 'PL'], ['PRAGUE', 'CZ'],
  ['BUCHAREST', 'RO'], ['BUDAPEST', 'HU'], ['ATHENS', 'GR'], ['ISTANBUL', 'TR'],
  ['TEL AVIV', 'IL'],
  ['BENGALURU', 'IN'], ['BANGALORE', 'IN'], ['MUMBAI', 'IN'], ['NEW DELHI', 'IN'], ['DELHI', 'IN'],
  ['GURGAON', 'IN'], ['GURUGRAM', 'IN'], ['HYDERABAD', 'IN'], ['CHENNAI', 'IN'],
  ['PUNE', 'IN'], ['NOIDA', 'IN'], ['GIFT CITY', 'IN'],
  ['TOKYO', 'JP'], ['OSAKA', 'JP'], ['SEOUL', 'KR'],
  ['SHANGHAI', 'CN'], ['BEIJING', 'CN'], ['SHENZHEN', 'CN'],
  ['SYDNEY', 'AU'], ['AUCKLAND', 'NZ'],
  ['TORONTO', 'CA'], ['VANCOUVER', 'CA'], ['MONTREAL', 'CA'], ['OTTAWA', 'CA'],
  ['MEXICO CITY', 'MX'], ['SAO PAULO', 'BR'], ['BUENOS AIRES', 'AR'], ['BOGOTA', 'CO'],
  ['DUBAI', 'AE'], ['ABU DHABI', 'AE'], ['RIYADH', 'SA'], ['KING ABDULLAH', 'SA'],
  ['CAIRO', 'EG'], ['LAGOS', 'NG'], ['NAIROBI', 'KE'], ['MANILA', 'PH'],
  ['JAKARTA', 'ID'], ['BANGKOK', 'TH'], ['KUALA LUMPUR', 'MY'],
  ['HO CHI MINH CITY', 'VN'], ['HO CHI MINH', 'VN'], ['HANOI', 'VN'], ['BELGRADE', 'RS'], ['REYKJAVIK', 'IS'],
  ['DOHA', 'QA'], ['MILAN', 'IT'], ['MILANO', 'IT'], ['LUXEMBOURG', 'LU'],
]);

// Ambiguous bare city names that are authoritative only when followed by an exact jurisdiction.
// They intentionally have no default country: Melbourne alone remains unknown, Melbourne, FL does not.
const STRUCTURED_CITY_ALIASES_WITHOUT_DEFAULT = new Set(['MELBOURNE', 'BLOOMINGTON']);

const CANADIAN_PROVINCE_CODES = new Set([
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
]);

const CANADIAN_PROVINCE_NAMES = [
  'ALBERTA', 'BRITISH COLUMBIA', 'MANITOBA', 'NEW BRUNSWICK', 'NEWFOUNDLAND AND LABRADOR',
  'NOVA SCOTIA', 'NORTHWEST TERRITORIES', 'NUNAVUT', 'ONTARIO', 'PRINCE EDWARD ISLAND',
  'QUEBEC', 'SASKATCHEWAN', 'YUKON',
];

/* A city alias is only authoritative when it owns the whole structured place value. These are the
   jurisdiction suffixes a board may append to that city. State and province aliases are generated
   from the same authoritative lists used by the location classifier; country aliases are closed
   to the jurisdictions represented by the city registry. */
const STRUCTURED_JURISDICTION_SUFFIX_CODES = new Map<string, string>([
  ...[...US_STATE_CODES].map((code) => [code, 'US'] as const),
  ...US_STATE_NAMES.map((name) => [name, 'US'] as const),
  ['GEORGIA', 'US'],
  ['US', 'US'], ['USA', 'US'], ['U S', 'US'], ['U S A', 'US'],
  ['UNITED STATES', 'US'], ['UNITED STATES OF AMERICA', 'US'],
  ...[...CANADIAN_PROVINCE_CODES].map((code) => [code, 'CA'] as const),
  ...CANADIAN_PROVINCE_NAMES.map((name) => [name, 'CA'] as const),
  ['CANADA', 'CA'],
  ['UK', 'GB'], ['U K', 'GB'], ['UNITED KINGDOM', 'GB'], ['GREAT BRITAIN', 'GB'], ['BRITAIN', 'GB'],
  ['ENGLAND', 'GB'], ['SCOTLAND', 'GB'], ['WALES', 'GB'],
  ['IRELAND', 'IE'], ['GERMANY', 'DE'], ['FRANCE', 'FR'], ['SPAIN', 'ES'], ['PORTUGAL', 'PT'],
  ['NETHERLANDS', 'NL'], ['BELGIUM', 'BE'], ['SWITZERLAND', 'CH'], ['AUSTRIA', 'AT'],
  ['SWEDEN', 'SE'], ['NORWAY', 'NO'], ['DENMARK', 'DK'], ['FINLAND', 'FI'], ['POLAND', 'PL'],
  ['CZECH REPUBLIC', 'CZ'], ['CZECHIA', 'CZ'], ['ROMANIA', 'RO'], ['HUNGARY', 'HU'],
  ['GREECE', 'GR'], ['TURKEY', 'TR'], ['TURKIYE', 'TR'], ['ISRAEL', 'IL'],
  ['INDIA', 'IN'], ['JAPAN', 'JP'], ['SOUTH KOREA', 'KR'], ['KOREA', 'KR'], ['CHINA', 'CN'],
  ['AUSTRALIA', 'AU'], ['NEW ZEALAND', 'NZ'], ['MEXICO', 'MX'], ['BRAZIL', 'BR'],
  ['ARGENTINA', 'AR'], ['COLOMBIA', 'CO'], ['UNITED ARAB EMIRATES', 'AE'], ['UAE', 'AE'],
  ['SAUDI ARABIA', 'SA'], ['EGYPT', 'EG'], ['NIGERIA', 'NG'], ['KENYA', 'KE'],
  ['PHILIPPINES', 'PH'], ['INDONESIA', 'ID'], ['THAILAND', 'TH'], ['MALAYSIA', 'MY'],
  ['VIETNAM', 'VN'], ['VIET NAM', 'VN'], ['SERBIA', 'RS'], ['ICELAND', 'IS'], ['QATAR', 'QA'],
  ['ITALY', 'IT'], ['LUXEMBOURG', 'LU'],
]);

const STRUCTURED_JURISDICTION_SUFFIXES_LONGEST_FIRST = [...STRUCTURED_JURISDICTION_SUFFIX_CODES.keys()]
  .sort((left, right) => right.length - left.length);

const US_STATE_JURISDICTION_ALIASES = new Set([
  ...US_STATE_CODES,
  ...US_STATE_NAMES,
  'GEORGIA',
]);

const CANADIAN_PROVINCE_JURISDICTION_ALIASES = new Set([
  ...CANADIAN_PROVINCE_CODES,
  ...CANADIAN_PROVINCE_NAMES,
]);

const STRUCTURED_COUNTRY_ALIAS_CODES = new Map(
  [...STRUCTURED_JURISDICTION_SUFFIX_CODES].filter(([alias]) => (
    !US_STATE_JURISDICTION_ALIASES.has(alias)
    && !CANADIAN_PROVINCE_JURISDICTION_ALIASES.has(alias)
  )),
);

function structuredJurisdictionSuffixCodes(suffix: string): Set<string> | undefined {
  const codes = new Set<string>();
  let remaining = suffix;
  while (remaining) {
    const alias = STRUCTURED_JURISDICTION_SUFFIXES_LONGEST_FIRST.find(
      (candidate) => remaining === candidate || remaining.startsWith(`${candidate} `),
    );
    if (!alias) return undefined;
    codes.add(STRUCTURED_JURISDICTION_SUFFIX_CODES.get(alias)!);
    remaining = remaining.slice(alias.length).trim();
  }
  return codes;
}

function normalise(location: string): string {
  /* Accents folded first, or "São Paulo" becomes "S O PAULO" and matches nothing, and "Reykjavík"
     splits in the middle. Both were sitting in the surfaced pile because of it. */
  const folded = location.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return ` ${folded.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/**
 * Where a posting is, as far as a US work visa is concerned.
 *
 * THE ORDER OF THE THREE TESTS IS THE WHOLE ALGORITHM, and getting it wrong put foreign jobs on
 * the board of people who need US sponsorship. Every one of these is real text from the live board:
 *
 *   "IN - Bengaluru"                    IN is India in Stripe's format, and Indiana in ours
 *   "Oxford or  London-United Kingdom"  the word "or" is Oregon
 *   "Dublin OR London"                  again
 *   "Amsterdam, NH"                     NH is Noord-Holland, and New Hampshire
 *
 * A two-letter code is the weakest signal there is, so it is tested LAST and only in the "City, ST"
 * shape it actually appears in. A named country or city beats it every time.
 *
 * US STILL WINS A GENUINE TIE. "Remote - US or London" and "New York / Dublin" are roles an
 * American hire can take, and those say "US" and "New York" outright - strong signals, tested
 * first.
 */
export function jobCountry(location: string | null | undefined): JobCountry {
  const signals = jobCountrySignalDetails(location);
  if (signals.strongUs) return 'us';
  if (signals.nonUs) return 'non_us';
  if (signals.weakUs) return 'us';
  return 'unknown';
}

function jobCountrySignalDetails(location: string | null | undefined): JobCountrySignalDetails {
  if (!location || !location.trim()) return { strongUs: false, weakUs: false, nonUs: false };
  const text = normalise(location);
  const upper = location.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

  // 1. Unambiguous US: the country, a full state name, or a city that is only ever American.
  const strongUs = text.includes(' UNITED STATES ')
    || / (USA|U S A|U S|AMERICAS|AMER) /.test(text)
    || / US /.test(text)
    || US_STATE_NAMES.some((name) => text.includes(` ${name} `))
    || US_CITIES.some((city) => text.includes(` ${city.replace(/[^A-Z0-9]+/g, ' ')} `))
    // Melbourne alone is Australian in the board corpus. The explicit Florida pair is not.
    || /\bMELBOURNE\s*,\s*FL\b/.test(upper);
  const namedNonUs = NON_US.some((name) => text.includes(` ${name.replace(/[^A-Z0-9]+/g, ' ')} `));

  /* 3. "City, ST" and nothing else. The comma is what makes it a state rather than a country code
        or an English word: "Austin, TX" qualifies, "IN - Bengaluru" does not. */
  const afterComma = upper.match(/,\s*([A-Z]{2})\b/g) ?? [];
  const stateCodeUs = afterComma.some((match) => US_STATE_CODES.has(match.replace(/[^A-Z]/g, '')));

  /* A code at the very END, which is how "Remote - FL" and "Remote - TX" are written.
     IT HAS TO BE ITS OWN TOKEN. Without the separator this matched the last two letters of any
     word: "GEORGIA" ends in IA and became Iowa, and so would "Austria", "Slovakia" and "Somalia"
     the moment one of them was missing from the foreign list. */
  const trailing = upper.trim().match(/(?:^|[\s,\-/;])([A-Z]{2})$/);
  const trailingCodeUs = !!trailing && US_STATE_CODES.has(trailing[1]);
  return { strongUs, weakUs: stateCodeUs || trailingCodeUs, nonUs: namedNonUs };
}

/**
 * May an employer's H-1B record be used to surface THIS posting?
 *
 * Only for roles in the US, or roles whose location says nothing. A posting that states its own
 * sponsorship does not come through here at all: an employer writing "visa sponsorship available"
 * on a Berlin role is talking about Germany, and it is their statement to make.
 */
export function employerEvidenceApplies(location: string | null | undefined): boolean {
  return jobCountry(location) !== 'non_us';
}

/* ISO-3166 alpha-2 and the country names the boards actually publish. Lever sends "GB", Ashby and
   Workable send "United States", and Greenhouse sends office names and locations, so this has to
   read every shape. */
const US_COUNTRY_TOKENS = new Set(['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA', 'PR', 'PUERTO RICO']);

/**
 * The country as the PORTAL published it, which beats anything read out of a location string.
 *
 * Greenhouse office groups are a list ("US | Bay Area", "India Locations"), so any US token in the
 * list makes it US: a posting filed under both is one an American hire can take. A named foreign
 * group with no US token is foreign. Anything unrecognised returns null, and the caller falls back
 * to the string classifier rather than guessing.
 */
export function countryFromPortal(portalCountry: string | null | undefined): JobCountry | null {
  if (!portalCountry || !portalCountry.trim()) return null;
  const parts = portalCountry.split('|').map((part) => normalise(part).trim());
  const exactCodes = parts.flatMap((part) => {
    const code = exactPortalCountryCodePart(part);
    return code ? [code] : [];
  });
  if (exactCodes.includes('US')
    || parts.some((part) => US_COUNTRY_TOKENS.has(part) || / (USA|UNITED STATES) /.test(` ${part} `))) {
    return 'us';
  }
  /* An office group NAMED after a foreign country ("India Locations", "EMEA"), or a two-letter code
     that is not ours. Two letters is safe here in a way it never was in a location string: this is
     a country field, so "IN" means India and cannot mean Indiana. */
  const foreign = parts.some((part) => {
    if (/^[A-Z]{2}$/.test(part)) return true;
    return NON_US.some((name) => ` ${part} `.includes(` ${name.replace(/[^A-Z0-9]+/g, ' ')} `));
  });
  if (foreign) return 'non_us';
  return null;
}

const PORTAL_OFFICE_GROUP_SUFFIX = /\s+(?:LOCATIONS?|OFFICES?)$/;

/** Exact country evidence from an ATS country field, including its closed office-group labels. */
function exactPortalCountryCodePart(part: string): string | undefined {
  const normalized = normalise(part).trim();
  const country = normalized.replace(PORTAL_OFFICE_GROUP_SUFFIX, '').trim();
  if (!country) return undefined;
  return exactStructuredCountryCode(country, true);
}

/**
 * Where a posting is: the portal's answer if it gave one, ours if it did not.
 *
 * THE ORDER IS THE POINT. Every location bug this feature had came from reading a string the
 * employer never meant as a country - "IN - Bengaluru", "Amsterdam, NH", "Georgia". All three
 * boards publish the country as structured data, and the parser exists only for the postings where
 * they do not.
 */
export function resolveJobCountry(
  portalCountry: string | null | undefined,
  location: string | null | undefined,
): JobCountry {
  return countryFromPortal(portalCountry) ?? jobCountry(location);
}

/* Where one location FIELD stops being one place.
 *
 * Boards put more than one place in a single string, and they do it with these characters:
 * "USA | Remote", "San Francisco, CA; New York, NY", "New York / Dublin", "Dublin OR London".
 * Deliberately NOT the comma, which is the inside of "Austin, TX", and NOT the hyphen, which is the
 * inside of "Remote - US" and "London-United Kingdom".
 */
const LOCATION_SEGMENT_SEPARATOR = /\s*[;|\/•\n]\s*|\s+\bor\b\s+|\s+\band\b\s+/i;

/**
 * WHICH COUNTRY DOES "THE COUNTRY WHERE THIS ROLE IS LOCATED" MEAN?
 *
 * A different question from `jobCountry`, and it has to be, because the two are used for opposite
 * things and one of them is a legal declaration.
 *
 * `jobCountry` answers "may an American hire take this job?", so it lets the US WIN A TIE on
 * purpose: "New York / Dublin" and "Remote - US or London" both return 'us' there, and that is
 * right for a board filter, because a role offered in New York is a role she could hold. It is
 * wrong here. An employer asking whether she may work "in the country where this role is located"
 * is asking about ONE country, and a posting that names two has not said which, so a stored
 * US-scoped fact does not answer it. Reusing `jobCountry` would have put "Yes, I am authorized"
 * on a Dublin application because the same field also said New York.
 *
 * So the string is split into the places it actually names and each one is classified on its own:
 *
 *   any segment abroad   -> 'non_us'  the posting may be there, and nothing on file covers it
 *   otherwise any US     -> 'us'      every place named is American; "Remote" beside "USA" is not
 *                                     a second country, it is the same one from a sofa
 *   otherwise            -> 'unknown' a bare "Remote", an empty field, somewhere unrecognised
 *
 * 'unknown' is the answer whenever the classifier is not sure, and every caller of this function
 * must treat 'unknown' exactly like 'non_us': say nothing. A gap in the lists below can therefore
 * only ever cost a handoff, never a false statement about where somebody may work.
 */
export function postingCountryForLegalScope(
  locations: readonly (string | null | undefined)[],
): JobCountry {
  const segments = locations
    .flatMap((value) => (typeof value === 'string' ? value.split(LOCATION_SEGMENT_SEPARATOR) : []))
    .map((segment) => (segment ?? '').trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return 'unknown';
  const evidence = segments.map((segment) => structuredCountryEvidence(segment, false));
  if (evidence.some((item) => item.invalid)) return 'unknown';
  const codes = new Set(evidence.flatMap((item) => [...item.codes]));
  const hasUs = evidence.some((item) => item.us);
  const hasNonUs = evidence.some((item) => item.nonUs);
  // One legal scope means one country. A mixed segment (for example, a London office supporting
  // US customers) and a multi-location posting (London / New York) both provide more than one
  // country signal, so neither may borrow either stored declaration.
  if (codes.size > 1 || (hasUs && hasNonUs)) return 'unknown';
  if (codes.size === 1) return codes.has('US') ? 'us' : 'non_us';
  if (hasUs) return 'us';
  if (hasNonUs) return 'non_us';
  return 'unknown';
}

/**
 * The same answer, read off the packet's own `job_context`.
 *
 * `job_context.location` and `job_context.locations` are what the PORTAL published for this
 * posting, copied onto the packet when it was created. That is the only location evidence this
 * path will accept: the job description's prose is not consulted here and must not be. Reading
 * "our San Francisco headquarters" out of a JD for a London role, and answering a work-eligibility
 * question from it, is the inference be1bccf removed, and it stays removed.
 */
export function postingCountryFromJobContext(jobContext: unknown): JobCountry {
  const context = (jobContext && typeof jobContext === 'object' ? jobContext : {}) as Record<string, unknown>;
  return legalCountryEvidenceFromJobContext(context).country;
}

type StructuredCountryEvidence = {
  codes: string[];
  us: boolean;
  nonUs: boolean;
  invalid?: boolean;
  hardInvalid?: boolean;
};

function exactStructuredCountryCode(value: string, acceptsBareIsoCode: boolean): string | undefined {
  const normalized = normalise(value).trim();
  if (isIsoCountryCode(value.trim())) {
    const code = value.trim().toUpperCase();
    if (acceptsBareIsoCode || code === 'US' || (!US_STATE_CODES.has(code) && !CANADIAN_PROVINCE_CODES.has(code))) {
      return code;
    }
  }
  return STRUCTURED_COUNTRY_ALIAS_CODES.get(normalized);
}

function exactRegisteredCityCode(normalized: string): string | undefined {
  return STRUCTURED_CITY_COUNTRY_CODES.get(normalized);
}

function exactUsCity(normalized: string): boolean {
  return normalized === 'NEW YORK' || US_CITIES.some((city) => normalise(city).trim() === normalized);
}

function registeredStructuredPlace(normalized: string): boolean {
  if (normalized === 'REMOTE') return true;
  if (exactRegisteredCityCode(normalized) || exactUsCity(normalized)) return true;
  return STRUCTURED_CITY_ALIASES_WITHOUT_DEFAULT.has(normalized);
}

function remoteCountryCode(normalized: string): string | undefined {
  if (normalized.startsWith('REMOTE ')) return exactStructuredCountryCode(normalized.slice(7), false);
  if (normalized.endsWith(' REMOTE')) return exactStructuredCountryCode(normalized.slice(0, -7), false);
  return undefined;
}

function evidenceFromCodes(codes: Set<string>): StructuredCountryEvidence {
  return {
    codes: [...codes],
    us: codes.has('US'),
    nonUs: [...codes].some((code) => code !== 'US'),
  };
}

function parseStructuredPlaceHead(normalized: string): {
  valid: boolean;
  explicitCodes: Set<string>;
  defaultCode?: string;
} {
  const exactCity = exactRegisteredCityCode(normalized);
  if (exactCity) return { valid: true, explicitCodes: new Set(), defaultCode: exactCity };
  if (exactUsCity(normalized)) return { valid: true, explicitCodes: new Set(), defaultCode: 'US' };
  if (normalized === 'REMOTE') return { valid: true, explicitCodes: new Set() };

  const words = normalized.split(' ');
  for (let splitAt = 1; splitAt < words.length; splitAt += 1) {
    const place = words.slice(0, splitAt).join(' ');
    const suffix = words.slice(splitAt).join(' ');
    if (!registeredStructuredPlace(place)) continue;
    const suffixCodes = structuredJurisdictionSuffixCodes(suffix);
    if (suffixCodes) return { valid: true, explicitCodes: suffixCodes };
  }
  return { valid: registeredStructuredPlace(normalized), explicitCodes: new Set() };
}

function structuredCountryEvidence(value: string, acceptsBareIsoCode: boolean): StructuredCountryEvidence {
  const trimmed = value.trim();
  if (!trimmed) return { codes: [], us: false, nonUs: false };

  const components = trimmed
    .split(/\s*[,•]\s*/)
    .map((part) => normalise(part).trim())
    .filter(Boolean);
  if (components.length === 0) return { codes: [], us: false, nonUs: false };

  // A country field is authoritative only when its complete value is one exact country alias or
  // ISO code. Office-group prose and arbitrary descriptive text do not become country evidence.
  if (acceptsBareIsoCode) {
    const code = components.length === 1 ? exactStructuredCountryCode(components[0], true) : undefined;
    return code ? evidenceFromCodes(new Set([code])) : { codes: [], us: false, nonUs: false };
  }

  const allCountries = components.map((component) => exactStructuredCountryCode(component, false));
  if (allCountries.every(Boolean)) return evidenceFromCodes(new Set(allCountries as string[]));

  if (components.length === 2) {
    const [first, second] = components;
    if (first === 'REMOTE') {
      const code = exactStructuredCountryCode(second, false);
      if (code) return evidenceFromCodes(new Set([code]));
    }
    if (second === 'REMOTE') {
      const code = exactStructuredCountryCode(first, false);
      if (code) return evidenceFromCodes(new Set([code]));
    }
  }

  // A state/province hierarchy may consist entirely of exact jurisdiction segments, but never a
  // single bare abbreviation. This covers TX, United States and ON, Canada without authorizing an
  // arbitrary unknown place name followed by either jurisdiction.
  if (components.length > 1) {
    const jurisdictionSets = components.map((component) => structuredJurisdictionSuffixCodes(component));
    if (jurisdictionSets.every(Boolean)) {
      const codes = new Set<string>();
      for (const jurisdiction of jurisdictionSets as Set<string>[]) {
        for (const code of jurisdiction) codes.add(code);
      }
      return evidenceFromCodes(codes);
    }
  }

  if (components.length > 1) {
    const [place, ...jurisdictions] = components;
    const parsedPlace = parseStructuredPlaceHead(place);
    if (!parsedPlace.valid) return {
      codes: [], us: false, nonUs: false, invalid: true, hardInvalid: true,
    };
    const codes = new Set(parsedPlace.explicitCodes);
    for (const jurisdiction of jurisdictions) {
      const suffixCodes = structuredJurisdictionSuffixCodes(jurisdiction);
      if (!suffixCodes) return {
        codes: [], us: false, nonUs: false, invalid: true, hardInvalid: true,
      };
      for (const code of suffixCodes) codes.add(code);
    }
    if (codes.size === 0 && parsedPlace.defaultCode) codes.add(parsedPlace.defaultCode);
    return evidenceFromCodes(codes);
  }

  const normalized = components[0];
  const exactCountry = exactStructuredCountryCode(normalized, false);
  if (exactCountry) return evidenceFromCodes(new Set([exactCountry]));
  const remoteCountry = remoteCountryCode(normalized);
  if (remoteCountry) return evidenceFromCodes(new Set([remoteCountry]));
  const exactCity = exactRegisteredCityCode(normalized);
  if (exactCity) return evidenceFromCodes(new Set([exactCity]));
  if (exactUsCity(normalized)) return evidenceFromCodes(new Set(['US']));

  const words = normalized.split(' ');
  for (let splitAt = 1; splitAt < words.length; splitAt += 1) {
    const place = words.slice(0, splitAt).join(' ');
    const suffix = words.slice(splitAt).join(' ');
    if (!registeredStructuredPlace(place)) continue;
    const suffixCodes = structuredJurisdictionSuffixCodes(suffix);
    if (suffixCodes) return evidenceFromCodes(suffixCodes);
  }
  return {
    codes: [],
    us: false,
    nonUs: false,
    invalid: normalized === 'REMOTE' ? undefined : true,
    hardInvalid: normalized !== 'REMOTE' && normalized.includes(' ') ? true : undefined,
  };
}

function structuredJobContextValues(context: Record<string, unknown>): Array<{
  value: string;
  source: 'portal' | 'country' | 'location';
}> {
  const values: Array<{ value: string; source: 'portal' | 'country' | 'location' }> = [];
  if (typeof context.portal_country === 'string') values.push({ value: context.portal_country, source: 'portal' });
  if (typeof context.country === 'string') values.push({ value: context.country, source: 'country' });
  if (typeof context.location === 'string') values.push({ value: context.location, source: 'location' });
  if (Array.isArray(context.locations)) {
    for (const value of context.locations) {
      if (typeof value === 'string') values.push({ value, source: 'location' });
    }
  }
  return values;
}

function portalCountryEvidence(value: string): StructuredCountryEvidence {
  const codes = new Set(value
    .split('|')
    .map((part) => exactPortalCountryCodePart(part))
    .filter((code): code is string => Boolean(code)));
  return evidenceFromCodes(codes);
}

function legalCountryEvidenceFromJobContext(context: Record<string, unknown>): {
  country: JobCountry;
  code: string | undefined;
} {
  const evidence = structuredJobContextValues(context).flatMap((entry) => {
    if (entry.source === 'portal') {
      return [{ ...portalCountryEvidence(entry.value), fromCountryField: true }];
    }
    return entry.value.split(LOCATION_SEGMENT_SEPARATOR).map((segment) => ({
      ...structuredCountryEvidence(segment, entry.source === 'country'),
      fromCountryField: entry.source === 'country',
    }));
  });
  const hasAuthoritativeCountryField = evidence.some(
    (item) => item.fromCountryField && item.codes.length > 0 && !item.invalid,
  );
  if (evidence.some((item) => item.hardInvalid)) return { country: 'unknown', code: undefined };
  if (!hasAuthoritativeCountryField && evidence.some((item) => item.invalid)) {
    return { country: 'unknown', code: undefined };
  }
  const codes = new Set(evidence.flatMap((item) => item.codes));
  const hasUs = evidence.some((item) => item.us);
  const hasNonUs = evidence.some((item) => item.nonUs);
  if (codes.size > 1 || (hasUs && hasNonUs)) return { country: 'unknown', code: undefined };
  const code = codes.size === 1 ? [...codes][0] : undefined;
  if (code) return { country: code === 'US' ? 'us' : 'non_us', code };
  if (hasUs) return { country: 'us', code: undefined };
  if (hasNonUs) return { country: 'non_us', code: undefined };
  return { country: 'unknown', code: undefined };
}

/**
 * The posting's one exact ISO country, or undefined when its structured fields are missing,
 * unknown, or name more than one country.
 *
 * This intentionally reads no job-description prose. It accepts the ATS country field and the
 * packet's structured location fields only. Unknown pieces such as "Remote" may sit beside one
 * exact country, but two different country codes always refuse.
 */
export function postingCountryCodeFromJobContext(jobContext: unknown): string | undefined {
  const context = (jobContext && typeof jobContext === 'object' ? jobContext : {}) as Record<string, unknown>;
  return legalCountryEvidenceFromJobContext(context).code;
}
