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

  // 1. Unambiguous US: the country, a full state name, or a city that is only ever American.
  const strongUs = text.includes(' UNITED STATES ')
    || / (USA|U S A|U S|AMERICAS|AMER) /.test(text)
    || / US /.test(text)
    || US_STATE_NAMES.some((name) => text.includes(` ${name} `))
    || US_CITIES.some((city) => text.includes(` ${city.replace(/[^A-Z0-9]+/g, ' ')} `));
  const namedNonUs = NON_US.some((name) => text.includes(` ${name.replace(/[^A-Z0-9]+/g, ' ')} `));

  /* 3. "City, ST" and nothing else. The comma is what makes it a state rather than a country code
        or an English word: "Austin, TX" qualifies, "IN - Bengaluru" does not. */
  const upper = location.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
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
  if (parts.some((part) => US_COUNTRY_TOKENS.has(part) || / (USA|UNITED STATES) /.test(` ${part} `))) {
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
