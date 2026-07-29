/* Turning employers' location strings into cities a person would type.
 *
 * The board's `location` column is whatever the employer typed into their ATS,
 * and they are not consistent. The same place arrives as "New York, NY", "New
 * York, New York" and "New York, NY, United States"; as "San Francisco, CA" and
 * "San Francisco, California". Counting the raw column therefore spends three
 * of the fifty suggestion slots on one city and still offers none of them as
 * the obvious spelling.
 *
 * Kept out of SQL and in a plain function on purpose: this is a judgement about
 * how people write addresses, it needs to be readable, and it needs tests.
 */

/* Only the states that actually show up spelled out on this board, plus the
   ones likely to. A partial map is correct here — an unknown region is passed
   through untouched rather than mangled. */
const STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};

/* Values that are a working arrangement or a whole country, not a city. A field
   labelled City must not offer "United States" or "Hybrid". */
const NOT_A_CITY =
  /^(remote|hybrid|on-?site|in-?office|united states|usa|u\.s\.a?\.?|us|uk|worldwide|global|anywhere|various|multiple|location|n\/?a|tbd|flexible|field|home|other)$/i;

/* Trailing country names that add nothing once the city and region are there. */
const TRAILING_COUNTRY = /^(united states|usa|u\.s\.a?\.?|us|america)$/i;

/** One employer location string may name several places. */
export function splitLocations(raw: string): string[] {
  return raw
    .split(/[;|•]|(?:\s+\/\s+)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A single place, normalised to "City, REGION" — or null if it is not a city.
 *
 * "San Francisco, California" and "San Francisco, CA, United States" both come
 * back as "San Francisco, CA", so they count as one suggestion instead of three.
 */
export function normalizeCity(raw: string): string | null {
  let value = raw.trim().replace(/\s+/g, " ");
  /* "Remote - US", "Remote (San Francisco)": the useful part is the place. */
  value = value.replace(/^remote\s*[-–—:]\s*/i, "").replace(/^remote\s*\((.*)\)$/i, "$1").trim();
  if (!value || NOT_A_CITY.test(value)) return null;

  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;

  const city = parts[0];
  if (!city || city.length < 2 || NOT_A_CITY.test(city)) return null;
  /* A bare number or postcode is not a city. */
  if (!/[a-z]/i.test(city)) return null;

  /* Drop a trailing country, then take whatever region is left. */
  const rest = parts.slice(1).filter((p) => !TRAILING_COUNTRY.test(p));
  const region = rest[0];
  if (!region) return city;

  const mapped = STATES[region.toLowerCase()];
  if (mapped) return `${city}, ${mapped}`;
  /* Already an abbreviation, or a non-US region like "Ontario" or "England". */
  return `${city}, ${region}`;
}

/**
 * Rank raw location strings into the cities worth suggesting.
 *
 * Counts are summed across spellings, so a city split three ways in the data
 * ranks on its true total rather than losing to one that was spelled
 * consistently.
 */
export function rankCities(rows: { location: string | null; n: number }[], limit: number): string[] {
  const totals = new Map<string, { label: string; n: number }>();
  for (const { location, n } of rows) {
    if (!location) continue;
    for (const part of splitLocations(location)) {
      const city = normalizeCity(part);
      if (!city) continue;
      const key = city.toLowerCase();
      const seen = totals.get(key);
      if (seen) seen.n += n;
      else totals.set(key, { label: city, n });
    }
  }
  return [...totals.values()]
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map((c) => c.label);
}
