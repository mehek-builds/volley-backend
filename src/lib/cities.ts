/* Turning employers' location strings into cities a person would type.
 *
 * The `location` column is free text an employer typed into their ATS, and the
 * same place arrives a dozen ways. Measured across the live board, one city
 * routinely occupies three to six of the fifty suggestion slots:
 *
 *   San Francisco, CA (781) · San Francisco (110) · San Francisco, CA USA (9)
 *   London (111) · London, United Kingdom (81) · London, UK (67) · London, England (39)
 *   Toronto, Canada (38) · Toronto, Ontario (26) · Toronto, ON (24) · Toronto (16)
 *   Bengaluru, India (130) · Bengaluru (46) · Bengaluru, Karnataka (23) · Bangalore, India (36)
 *
 * Eleven distinct patterns, every one of them real:
 *   1. bare city vs city + region          "Austin" / "Austin, TX"
 *   2. the region spelled many ways        "United Kingdom" / "UK" / "England"
 *   3. a country tacked onto a state       "San Mateo, CA United States"
 *   4. the region repeating the city       "Singapore, Singapore", "Dublin, Dublin"
 *   5. a comma separating two CITIES       "San Francisco, Seattle"
 *   6. parentheticals                      "New York, NY (HQ)", "London, UK (Hybrid)"
 *   7. an arrangement used as a region     "Washington, Remote"
 *   8. an arrangement used as a prefix     "Hybrid - San Francisco"
 *   9. renamed cities                      "Bangalore" / "Bengaluru"
 *  10. accents dropped                     "Sao Paulo" / "São Paulo"
 *  11. genuinely different cities          "Vancouver, WA" vs "Vancouver, BC"
 *
 * Eleven is why this is a tested module rather than a regex inside a query, and
 * pattern 11 is why it is careful: Vancouver WA and Vancouver BC are different
 * places and must never be merged, which rules out "just take the first word".
 */

const REGION_CANON: Record<string, string> = {};
/* Which country each region belongs to. Two jobs: a bare country is not a city
   ("Canada" and "India" both reached the suggestions), and two variants of one
   city can only be merged when they agree about the country — which is what
   keeps Vancouver WA apart from Vancouver BC while joining Toronto ON to
   Toronto Canada. */
const REGION_COUNTRY: Record<string, string> = {};
const COUNTRIES = new Set<string>();
const addRegion = (canonical: string, ...spellings: string[]) => {
  REGION_CANON[canonical.toLowerCase()] = canonical;
  for (const s of spellings) REGION_CANON[s.toLowerCase()] = canonical;
};
/** A region inside a country: its own name, plus the country it implies. */
const addSubRegion = (country: string, canonical: string, ...spellings: string[]) => {
  addRegion(canonical, ...spellings);
  REGION_COUNTRY[canonical] = country;
};
/** A country in its own right. */
const addCountry = (canonical: string, ...spellings: string[]) => {
  addRegion(canonical, ...spellings);
  REGION_COUNTRY[canonical] = canonical;
  COUNTRIES.add(canonical.toLowerCase());
  for (const s of spellings) COUNTRIES.add(s.toLowerCase());
};

/** Exported for jdMatch's address-shape guard, which needs the code and the name to recognise
 *  "New York City, NY" and "the State of Washington" as addresses rather than as requirements. */
export const US_STATES: [string, string][] = [
  ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],
  ['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['FL','Florida'],['GA','Georgia'],
  ['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],
  ['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],['MD','Maryland'],
  ['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],['MO','Missouri'],
  ['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],
  ['NM','New Mexico'],['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],
  ['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],
  ['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],
  ['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming'],
  ['DC','District of Columbia'],
];
for (const [code, name] of US_STATES) addSubRegion('United States', code, name);
/* Washington DC is written with dots as often as without. */
addSubRegion('United States', 'DC', 'D.C.', 'D.C', 'Washington DC', 'Washington D.C.');

addSubRegion('Canada', 'ON', 'Ontario');
addSubRegion('Canada', 'BC', 'British Columbia');
addSubRegion('Canada', 'QC', 'Quebec', 'Québec');
addSubRegion('Canada', 'AB', 'Alberta');
addSubRegion('Canada', 'MB', 'Manitoba');
addSubRegion('Canada', 'NS', 'Nova Scotia');

/* Countries, canonicalised to the shortest form a person would type. The UK
   matters most: it arrives as four different strings on this board. */
addCountry('UK', 'United Kingdom', 'England', 'Great Britain', 'Scotland', 'Wales');
addCountry('Ireland', 'IE');
addCountry('Netherlands', 'The Netherlands', 'NL', 'Holland', 'North Holland', 'Noord-Holland');
addCountry('Germany', 'DE', 'Deutschland');
addCountry('France', 'FR');
addCountry('Spain', 'ES');
addCountry('Portugal', 'PT');
addCountry('Italy', 'IT');
addCountry('Poland', 'PL', 'Masovian Voivodeship');
addCountry('Canada');
addCountry('Australia', 'AU', 'New South Wales', 'NSW');
addCountry('India', 'Karnataka', 'Haryana', 'Maharashtra', 'Telangana', 'Tamil Nadu');
addCountry('Japan', 'JP');
addCountry('Singapore', 'SG');
addCountry('China', 'CN');
addCountry('Hong Kong', 'HK');
addCountry('Taiwan', 'TW');
addCountry('South Korea', 'Korea', 'KR');
addCountry('Brazil', 'BR');
addCountry('Mexico', 'MX');
addCountry('Israel');
addCountry('Sweden', 'SE');
addCountry('Denmark', 'DK');
addCountry('Norway');
addCountry('Finland', 'FI');
addCountry('Switzerland', 'CH');
addCountry('Austria', 'AT');
addCountry('Belgium', 'BE');
addCountry('Czechia', 'Czech Republic', 'CZ');
addCountry('Romania', 'RO');
addCountry('Lithuania', 'LT');
addCountry('Estonia', 'EE');
addCountry('Ukraine', 'UA');
addCountry('Serbia', 'RS');
addCountry('Turkey', 'Türkiye', 'TR');
addCountry('Greece', 'GR');
addCountry('UAE', 'United Arab Emirates');
addCountry('Argentina');
addCountry('Chile');
addCountry('Colombia');
addCountry('Indonesia');
addCountry('Philippines');
addCountry('Vietnam');
addCountry('Thailand');
addCountry('Malaysia');
addCountry('New Zealand');
addCountry('South Africa');
addCountry('Nigeria');
addCountry('Kenya');
addCountry('Egypt');

/* Dropped rather than kept: "San Mateo, CA United States" says nothing that
   "San Mateo, CA" does not, and a US state already identifies its country. */
const REDUNDANT_COUNTRY = /^(united states|usa|u\.?s\.?a?\.?|america)$/i;

/* Renamed, or spelled two ways on this board. Deliberately short and only for
   cases actually observed — a speculative alias list is a way to merge two
   places that are not the same. */
/* Countries that are also cities, so the bare-country rule does not delete
   them. Singapore alone accounts for 200 postings on this board. */
const CITY_STATES = new Set(['singapore', 'hongkong', 'macau', 'monaco', 'luxembourg', 'gibraltar']);

const CITY_ALIASES: Record<string, string> = {
  bangalore: 'Bengaluru',
  bombay: 'Mumbai',
  calcutta: 'Kolkata',
  madras: 'Chennai',
  gurgaon: 'Gurugram',
  'washington d.c.': 'Washington',
  'washington dc': 'Washington',
  'new york city': 'New York',
  nyc: 'New York',
  'sao paulo': 'São Paulo',
};

/* Not a place a field labelled City may offer: a working arrangement, a
   placeholder, or a whole country or continent standing on its own. */
const NOT_A_CITY =
  /^(remote|hybrid|on-?site|in-?office|flexible|field|home|anywhere|worldwide|global|various|multiple|location|n\/?a|tbd|other|united states|usa|us|uk|united kingdom|europe|emea|apac|latam|americas)$/i;

/* The same test cannot be used on the token AFTER the comma. "London, United
   Kingdom" is a perfectly good place, and rejecting the country there left the
   region uncanonicalised, so London kept three separate entries — which is the
   bug this module exists to fix. Only arrangements and placeholders are refused
   in the region position; a country there is exactly what we want. */
const NOT_A_REGION =
  /^(remote|hybrid|on-?site|in-?office|flexible|anywhere|various|multiple|n\/?a|tbd|other|blank)$/i;

/** Compare without accents or punctuation, so "Sao Paulo" meets "São Paulo". */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** One employer location may name several places. */
export function splitLocations(raw: string): string[] {
  return raw
    .replace(/\([^)]*\)/g, ' ')
    .replace(/^\s*(remote|hybrid|on-?site)\s*[-–—:]\s*/i, '')
    .split(/[;|•]|\s+\/\s+|\s+or\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type Place = { city: string; region?: string };

/**
 * Parse one candidate into a city and, where there is one, a region.
 *
 * `knownCities` is what makes "San Francisco, Seattle" two cities while "New
 * York, NY" stays one: a token after the comma that is not a known region, but
 * IS used as a city elsewhere on the board, is a second city. Without it, every
 * two-city string on the board turns Seattle into a province.
 */
export function parsePlace(raw: string, knownCities: Set<string> = new Set()): Place[] {
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return [];

  const head = parts[0];
  if (!head || head.length < 2 || !/[a-z]/i.test(head) || NOT_A_CITY.test(head)) return [];
  /* "Canada" and "India" both reached the suggestion list as cities. A country
     standing alone is a country — unless it is also a city, which is why
     Singapore and Hong Kong are named here rather than lost to the rule. */
  if (COUNTRIES.has(head.toLowerCase()) && !CITY_STATES.has(fold(head))) return [];
  /* "US Remote", "Remote within Canada", "BLANK": an arrangement dressed as a
     place, and the literal placeholder one ATS emits. */
  if (/\bremote\b/i.test(head) || /^blank$/i.test(head)) return [];
  const city = CITY_ALIASES[head.toLowerCase()] ?? head;

  const extra: Place[] = [];
  let region: string | undefined;

  for (const token of parts.slice(1)) {
    if (NOT_A_REGION.test(token) || REDUNDANT_COUNTRY.test(token)) continue;
    const trimmed = token.replace(/\s+(united states|usa|u\.s\.a?\.?)$/i, '').trim();
    if (!trimmed) continue;

    const canon = REGION_CANON[trimmed.toLowerCase()];
    /* Same carve-out as the head check above, applied here for the same reason: "Dubai, Hong Kong"
       is two cities, not Dubai in the region of Hong Kong. Without it, a city-state named anywhere
       but first in the list silently became the region of whatever came before it. */
    if (canon && !(CITY_STATES.has(fold(trimmed)) && knownCities.has(fold(trimmed)))) {
      if (!region && fold(canon) !== fold(city)) region = canon;
      continue;
    }
    if (knownCities.has(fold(CITY_ALIASES[trimmed.toLowerCase()] ?? trimmed))) {
      const alias = CITY_ALIASES[trimmed.toLowerCase()] ?? trimmed;
      if (!NOT_A_CITY.test(alias)) extra.push({ city: alias });
    } else if (canon) {
      if (!region && fold(canon) !== fold(city)) region = canon;
    } else if (!region && fold(trimmed) !== fold(city)) {
      region = trimmed;
    }
  }

  return [{ city, region }, ...extra];
}

export function label(place: Place): string {
  return place.region ? `${place.city}, ${place.region}` : place.city;
}

/**
 * Rank raw location strings into the cities worth suggesting.
 *
 * Three passes, each earning its place:
 *   1. learn which words this board uses as cities, so a comma between two
 *      cities is not read as a region;
 *   2. count every place, keyed on city AND region, so Vancouver WA and
 *      Vancouver BC stay apart;
 *   3. fold a bare city into its regioned form ONLY where there is exactly one
 *      such form. "London" becomes "London, UK" because that is the only London
 *      on the board. "Vancouver" stays bare, because merging it would mean
 *      choosing between Washington and British Columbia.
 */
export function rankCities(rows: { location: string | null; n: number }[], limit: number): string[] {
  const knownCities = new Set<string>();
  for (const { location } of rows) {
    if (!location) continue;
    for (const candidate of splitLocations(location)) {
      const head = candidate.split(',')[0].trim();
      if (head && !NOT_A_CITY.test(head) && /[a-z]/i.test(head)) {
        knownCities.add(fold(CITY_ALIASES[head.toLowerCase()] ?? head));
      }
    }
  }

  const totals = new Map<string, { city: string; region?: string; n: number }>();
  for (const { location, n } of rows) {
    if (!location) continue;
    for (const candidate of splitLocations(location)) {
      for (const place of parsePlace(candidate, knownCities)) {
        const key = `${fold(place.city)}|${place.region ? fold(place.region) : ''}`;
        const seen = totals.get(key);
        if (seen) seen.n += n;
        else totals.set(key, { ...place, n });
      }
    }
  }

  /* Merge variants of one city that AGREE ABOUT THE COUNTRY, keeping the more
     specific region. "Toronto, Canada" and "Toronto, ON" are one place written
     two ways; "Vancouver, WA" and "Vancouver, BC" are two places, and no rule
     here may join them. */
  const variantsOf = new Map<string, string[]>();
  for (const [key, entry] of totals) {
    if (!entry.region) continue;
    const city = fold(entry.city);
    variantsOf.set(city, [...(variantsOf.get(city) ?? []), key]);
  }
  for (const keys of variantsOf.values()) {
    const byCountry = new Map<string, string[]>();
    for (const key of keys) {
      const region = totals.get(key)!.region!;
      byCountry.set(REGION_COUNTRY[region] ?? region, [...(byCountry.get(REGION_COUNTRY[region] ?? region) ?? []), key]);
    }
    for (const group of byCountry.values()) {
      if (group.length < 2) continue;
      /* The most specific label wins: a province beats the country it sits in. */
      const winner = group.find((k) => !COUNTRIES.has(totals.get(k)!.region!.toLowerCase())) ?? group[0];
      for (const key of group) {
        if (key === winner) continue;
        totals.get(winner)!.n += totals.get(key)!.n;
        totals.delete(key);
      }
    }
  }

  /* Then the bare form. It folds when one regioned variant remains, or when one
     of them holds the clear majority — Amsterdam is Noord-Holland 42 times and
     New Hampshire 4, and spending two slots on that helps nobody. Below the
     threshold the bare form stays bare, because merging would be a guess. */
  const remaining = new Map<string, string[]>();
  for (const [key, entry] of totals) {
    if (!entry.region) continue;
    const city = fold(entry.city);
    remaining.set(city, [...(remaining.get(city) ?? []), key]);
  }
  for (const [key, entry] of [...totals]) {
    if (entry.region) continue;
    const keys = remaining.get(fold(entry.city));
    if (!keys?.length) continue;
    const sorted = keys.map((k) => ({ k, n: totals.get(k)!.n })).sort((a, b) => b.n - a.n);
    const total = sorted.reduce((sum, v) => sum + v.n, 0);
    if (sorted.length === 1 || sorted[0].n / total >= 0.7) {
      totals.get(sorted[0].k)!.n += entry.n;
      totals.delete(key);
    }
  }

  return [...totals.values()]
    .sort((a, b) => b.n - a.n || label(a).localeCompare(label(b)))
    .slice(0, limit)
    .map(label);
}

/** A single place as one string. Kept for callers that want just the label. */
export function normalizeCity(raw: string): string | null {
  const [place] = parsePlace(raw);
  return place ? label(place) : null;
}
