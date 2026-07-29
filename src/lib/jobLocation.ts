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

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY',
  'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY', 'DC', 'PR',
]);

const US_STATE_NAMES = [
  'ALABAMA', 'ALASKA', 'ARIZONA', 'ARKANSAS', 'CALIFORNIA', 'COLORADO', 'CONNECTICUT', 'DELAWARE',
  'FLORIDA', 'GEORGIA', 'HAWAII', 'IDAHO', 'ILLINOIS', 'INDIANA', 'IOWA', 'KANSAS', 'KENTUCKY',
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
  /* "SF Office" is how one board writes San Francisco. */
  'SF OFFICE',
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
 * US WINS A TIE, and that is deliberate. "Remote - US or London" and "New York / Dublin" are roles
 * an American hire can take, so an H-1B record is relevant to them. Only a location with no US
 * signal at all is 'non_us'.
 */
export function jobCountry(location: string | null | undefined): JobCountry {
  if (!location || !location.trim()) return 'unknown';
  const text = normalise(location);

  const us = ` UNITED STATES `.split('|').some((needle) => text.includes(needle))
    || / (USA|US|U S|AMERICAS|AMER) /.test(text)
    || US_STATE_NAMES.some((name) => text.includes(` ${name} `))
    || [...US_STATE_CODES].some((code) => text.includes(` ${code} `))
    || US_CITIES.some((city) => text.includes(` ${city.replace(/[^A-Z0-9]+/g, ' ')} `));
  if (us) return 'us';

  if (NON_US.some((name) => text.includes(` ${name.replace(/[^A-Z0-9]+/g, ' ')} `))) return 'non_us';
  return 'unknown';
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
