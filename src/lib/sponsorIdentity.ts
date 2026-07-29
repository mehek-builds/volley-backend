/**
 * IS THIS JOB BOARD REALLY THE COMPANY WE MATCHED TO A FEDERAL FILING?
 *
 * The pure half of scripts/verify-sponsor-matches.mjs, which fetches real postings and asks this
 * about each one. It lives here rather than in the script so it is typechecked and covered by the
 * ordinary test run: it is the last gate before Litos tells someone a company sponsors visas, and
 * the first version of it was wrong in a way that would have confirmed the very errors it exists
 * to catch.
 *
 * WHAT IT COMPARES. A board token is not a company and a display name is not evidence. The posting
 * is: it says who wrote it, in prose, with the company's own domain in its links. So three
 * independent questions are asked of that text, and any one of them is enough:
 *
 *   brandInText  our name for the company appears as a WORD
 *   legalHit     a distinctive word from the matched filing entity appears as a WORD
 *   domainMatch  a link's HOSTNAME carries the brand as a label, off the ATS's own host
 *
 * EXACT WORDS, NEVER SUBSTRINGS, and that is the whole value of the check. Comparing squashed
 * strings passed three of the six wrong matches that were live in production: "Kansas" and "SaaS"
 * both contain SAS, "LatchBio" contains LATCH, "crispy" contains CRISP. See sponsorIdentity.test.ts,
 * where each of those is a test.
 *
 * WHAT A PASS PROVES: the board we poll belongs to the company we named. NOT that the company filed
 * the petition - that is the alias list's job in scripts/build-h1b-sponsors.mjs.
 */

/** Words that identify nobody: half the filings in the country contain "TECHNOLOGIES". */
const NOISE = new Set([
  'INC', 'LLC', 'LTD', 'LIMITED', 'CORP', 'CORPORATION', 'THE', 'AND', 'COMPANY', 'LP', 'LLP',
  'GROUP', 'GROUPE', 'HOLDINGS', 'USA', 'AMERICA', 'AMERICAS', 'NORTH', 'GLOBAL', 'INTERNATIONAL',
  'TECHNOLOGIES', 'TECHNOLOGY', 'TECH', 'SYSTEMS', 'SOLUTIONS', 'SERVICES', 'SERVICE', 'SVCS',
  'LABS', 'SOFTWARE', 'DATA', 'DIGITAL', 'CAPITAL', 'PARTNERS', 'MANAGEMENT', 'CONSULTING',
  'FINANCIAL', 'FINANCE', 'HEALTH', 'MEDICAL', 'RESEARCH', 'SCIENCE', 'SCIENCES',
  'PLATFORM', 'NETWORKS', 'NETWORK', 'SECURITY', 'GENERAL', 'PRIVATE', 'PBC', 'GMBH', 'PLC',
  'DBA', 'FKA', 'OPERATIONS', 'INVESTMENTS', 'ASSET', 'TRUST', 'BUSINESS',
]);

/**
 * Place names and everyday words that appear in postings for reasons unrelated to the employer.
 *
 * Without this, "BOSTON" from THE BOSTON CONSULTING GROUP confirms any posting with a Boston
 * office - a company identity built out of a location - and "SOCIAL" from SOCIAL FINANCE confirms
 * any posting mentioning social media.
 */
const NOT_IDENTIFYING = new Set([
  'BOSTON', 'AUSTIN', 'CHICAGO', 'SEATTLE', 'DENVER', 'ATLANTA', 'DALLAS', 'HOUSTON', 'PHOENIX',
  'MIAMI', 'LONDON', 'DUBLIN', 'BERLIN', 'PARIS', 'MUNICH', 'TOKYO', 'SYDNEY', 'TORONTO',
  'VANCOUVER', 'MONTREAL', 'BANGALORE', 'MUMBAI', 'SINGAPORE', 'AMSTERDAM', 'YORK', 'JERSEY',
  'FRANCISCO', 'ANGELES', 'DIEGO', 'JOSE', 'CAROLINA', 'VIRGINIA', 'TEXAS', 'FLORIDA', 'GEORGIA',
  'WASHINGTON', 'OREGON', 'COLORADO', 'ARIZONA', 'MICHIGAN', 'ILLINOIS', 'MASSACHUSETTS',
  'SOCIAL', 'FIRST', 'MILE', 'MODERN', 'LIFE', 'STONE', 'RIVER', 'SUMMIT', 'PACIFIC', 'ATLANTIC',
  'UNITED', 'STATES', 'AMERICAN', 'NATIONAL', 'FEDERAL', 'STATE', 'CITY', 'COUNTY', 'UNIVERSITY',
  'CENTER', 'CENTRE', 'INSTITUTE', 'ACADEMY', 'SCHOOL', 'COLLEGE', 'HOSPITAL', 'CLINIC',
]);

export type PostingSample = {
  title?: string | null;
  location?: string | null;
  url?: string | null;
  text?: string | null;
};

export type BoardIdentity = {
  /** Only Greenhouse publishes one. Null on Lever and Ashby. */
  displayName: string | null;
  count: number;
  /** A few postings, read in full. Prose is expensive to ship, so this is a sample. */
  samples: PostingSample[];
  /**
   * EVERY posting's location, not just the sampled ones.
   *
   * Locations are one short string each, so the whole board is affordable - and it has to be the
   * whole board, because sampling three postings out of four hundred flagged Cloudflare, Twilio and
   * a dozen other plainly American companies as having no US presence. A company's US-ness is a
   * property of its hiring, not of whichever three roles the API returned first.
   */
  locations: string[];
};

export type IdentityEvidence = {
  brandInText: boolean;
  /** The filing-entity word that matched, kept so the report can quote it. */
  legalHit: string | null;
  domainMatch: boolean;
  /** How much prose there was to judge. Too little is "weak", not "suspect". */
  textLength: number;
  /**
   * Does this board hire in the United States at all?
   *
   * The one check that separates a same-named company from ours, and the gap that let `crisp`
   * through: the Ashby board is the Amsterdam grocer, every posting is in the Netherlands and in
   * Dutch, and a US "Crisp, Inc." filed the petition we credited it with. The brand word matched
   * because both companies really are called Crisp.
   *
   * An H-1B is a US work visa. A board with no US presence cannot be the filer, so no US presence
   * plus a US filing is a contradiction worth a human's attention - and it is only ever a FLAG,
   * because a company can be genuinely US-based and post one remote European role.
   */
  usPresence: boolean;
  /**
   * A city or state this employer FILED FROM that also appears on the board.
   *
   * The strongest corroboration available offline, and the one that settles an asserted match:
   * SPACE EXPLORATION TECHNOLOGIES filed from Hawthorne, California, and the SpaceX board posts
   * jobs in Hawthorne, California. Two companies sharing a name do not usually share a street.
   */
  geoOverlap: string | null;
  /**
   * The filing itself names the brand: "MATONEE INC D/B/A APTOS LABS", "ESHARES INC D/B/A CARTA".
   *
   * The strongest corroboration there is, and it needs no web request: a d/b/a in a federal filing
   * is the employer stating, on a government form, which trading name it operates under. When the
   * filing says the brand, the alias linking them is not an assertion at all - it is a quotation.
   */
  dbaNamesBrand: boolean;
  /**
   * Whether the confirmation rests on a name we ASSERTED rather than one that matched literally.
   *
   * For an alias ("Airtable" -> FORMAGRID INC), the brand appearing in the posting proves nothing
   * about the alias: of course Airtable's board says Airtable. Only the legal entity's own words or
   * the company's domain corroborate the claim, so an alias-backed employer whose sole evidence is
   * the brand is reported as needing a human.
   */
  matchKind: 'plain' | 'asserted';
};

/** Distinctive words from a legal entity name. */
export function identifyingTokens(value: string): string[] {
  return [...new Set(
    value
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .split(' ')
      .filter((word) => word.length >= 4 && !NOISE.has(word) && !NOT_IDENTIFYING.has(word)),
  )];
}

/** Letters and digits only, for the one-word spelling of a two-word brand ("ScaleAI"). */
function squash(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function unescapeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, ' ');
}

/** The text as WORDS. "LatchBio" is one word and is not "Latch"; "SaaS" is not "SAS". */
export function wordSet(text: string): Set<string> {
  return new Set(
    unescapeEntities(text)
      .toUpperCase()
      // Possessives first, so "Airtable's engineers" yields AIRTABLE and not AIRTABLES.
      .replace(/['’]S\b/g, '')
      .replace(/[^A-Z0-9]+/g, ' ')
      .split(' ')
      .filter(Boolean),
  );
}

/* US locations, as postings write them. Deliberately generous: the question is "does this employer
   hire in the US at all", and a false yes merely declines to raise a flag. */
const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY',
  'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY', 'DC',
]);
/* Punctuation is stripped before this runs, so "Remote - US" and "Remote, US" both arrive as
   "REMOTE US". */
const US_WORDS = /\b(UNITED STATES|USA|US|REMOTE US|NEW YORK|SAN FRANCISCO|LOS ANGELES|SEATTLE|BOSTON|CHICAGO|AUSTIN|DENVER|ATLANTA|MIAMI|DALLAS|HOUSTON|SAN DIEGO|SAN JOSE|PALO ALTO|MOUNTAIN VIEW|SUNNYVALE|BELLEVUE|BROOKLYN|PHILADELPHIA|PHOENIX|PORTLAND|SALT LAKE|MINNEAPOLIS|DETROIT|NASHVILLE|CHARLOTTE|RALEIGH|PITTSBURGH|BALTIMORE|ARLINGTON|CAMBRIDGE MA)\b/;

/** Does any sampled posting look like it is in the United States? */
export function hasUsPresence(locations: (string | null | undefined)[]): boolean {
  for (const raw of locations) {
    if (!raw) continue;
    const upper = raw.toUpperCase();
    if (US_WORDS.test(upper.replace(/[^A-Z0-9]+/g, ' '))) return true;
    // "Austin, TX" / "Remote, California, United States, AMER"
    for (const part of upper.split(/[,;|/]/)) {
      if (US_STATES.has(part.trim())) return true;
    }
  }
  return false;
}

/** Hostname labels only: `airtable` from `careers.airtable.com`, never a substring of a path. */
export function hostLabels(urls: (string | null | undefined)[]): Set<string> {
  const labels = new Set<string>();
  for (const raw of urls) {
    if (!raw) continue;
    let host: string;
    try {
      host = new URL(raw).hostname;
    } catch {
      continue;
    }
    // The ATS's own host is not the company's: every Greenhouse posting lives on greenhouse.io.
    if (/(greenhouse|lever|ashbyhq)\.(io|co)$/.test(host)) continue;
    for (const label of host.split('.')) labels.add(label.toUpperCase());
  }
  return labels;
}

/** A filing city or state that also appears in the board's own locations. */
export function geoCorroboration(
  filingCities: string[],
  filingStates: string[],
  locations: string[],
): string | null {
  const haystack = locations.map((location) => ` ${location.toUpperCase().replace(/[^A-Z0-9]+/g, ' ')} `).join('|');
  /* Cities first: they are far more specific than a state, and "CA" appearing somewhere on a board
     of four hundred roles says almost nothing. A state only counts when the city list is empty. */
  for (const city of filingCities) {
    const needle = ` ${city.toUpperCase().replace(/[^A-Z0-9]+/g, ' ')} `;
    if (needle.trim().length >= 4 && haystack.includes(needle)) return city;
  }
  if (filingCities.length === 0) {
    for (const state of filingStates) {
      if (state.length === 2 && haystack.includes(` ${state.toUpperCase()} `)) return state;
    }
  }
  return null;
}

export function identityCheck(
  company: string,
  employer: {
    legal_names: string[];
    normalized?: string;
    matched_key?: string | null;
    filing_cities?: string[];
    filing_states?: string[];
  },
  identity: BoardIdentity,
): IdentityEvidence {
  const parts = [
    identity.displayName ?? '',
    ...identity.samples.map((sample) => `${sample.title ?? ''} ${sample.text ?? ''}`),
  ];
  const words = wordSet(parts.join(' \n '));

  /* The brand as the employer would write it, and as one word: "Scale AI" occurs both ways, and a
     company that writes only "ScaleAI" is still naming itself. */
  const brandWords = [...wordSet(company)];
  const brandJoined = squash(company);
  const brandInText = brandJoined.length >= 3
    && ((brandWords.length > 0 && brandWords.every((word) => words.has(word))) || words.has(brandJoined));

  /* A filing-entity word only corroborates if it is NOT the brand we already looked for. For a
     plain match the entity's name IS the brand, so "CRISP" from "Crisp, Inc." appearing in a Crisp
     posting proves exactly nothing - it is the same fact counted twice, and it is what made the
     Amsterdam grocer look confirmed. */
  const brandWordSet = new Set([...brandWords, brandJoined]);
  const legalHit = employer.legal_names
    .flatMap(identifyingTokens)
    .find((word) => words.has(word) && !brandWordSet.has(word)) ?? null;

  const labels = hostLabels(identity.samples.map((sample) => sample.url));
  const domainMatch = brandJoined.length >= 4
    && [...labels].some((label) => label.replace(/-/g, '') === brandJoined);

  /* A d/b/a in the filing that IS our brand. Read off the legal names we already store, so it
     costs nothing and cannot go stale. */
  const dbaNamesBrand = employer.legal_names.some((name) => {
    const match = name.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').match(/\bD ?B ?A (.+)$/);
    return match ? squash(match[1]) === brandJoined : false;
  });

  /* "plain" means the filing entity's own name normalises to the brand, so nothing was asserted.
     "asserted" means an alias or a d/b/a bridged two different names, and that bridge is a claim
     the board's own text has to corroborate. */
  const matchKind: 'plain' | 'asserted' = employer.matched_key && employer.normalized
    && employer.matched_key === employer.normalized ? 'plain' : 'asserted';

  return {
    brandInText,
    legalHit,
    domainMatch,
    textLength: parts.join(' ').length,
    usPresence: hasUsPresence(identity.locations.length > 0
      ? identity.locations
      : identity.samples.map((sample) => sample.location)),
    dbaNamesBrand,
    geoOverlap: geoCorroboration(
      employer.filing_cities ?? [],
      employer.filing_states ?? [],
      identity.locations.length > 0
        ? identity.locations
        : identity.samples.map((sample) => sample.location ?? ''),
    ),
    matchKind,
  };
}

/**
 * The verdict for one employer.
 *
 * `weak` and `empty-board` are NOT passes. They mean the board gave us nothing to judge, and an
 * unjudged employer is one somebody has to open by hand - which is why the audit exits non-zero
 * for them too.
 */
export type IdentityVerdict = 'verified' | 'REVIEW' | 'weak' | 'SUSPECT' | 'empty-board' | 'error';

export function verdictFor(
  identity: BoardIdentity | null,
  evidence: IdentityEvidence | null,
  error: string | null,
): IdentityVerdict {
  if (error) return 'error';
  if (!identity) return 'error';
  /* Order matters: an EMPTY board legitimately has no evidence to weigh, so the count is checked
     before the evidence. Testing `!evidence` first reported a board with no postings as a fetch
     error, which sends the reader chasing a network problem that does not exist. */
  if (identity.count === 0) return 'empty-board';
  if (!evidence) return 'error';

  /* Corroboration the brand word cannot give.
     An ASSERTED match (alias or d/b/a) is a claim that two different names are one company, and the
     brand appearing in the posting says nothing about it - Airtable's board obviously says
     "Airtable". Only the filing entity's own words or the company's domain speak to the claim.
     A US filing against a board with no US presence is the `crisp` shape: both companies really are
     called Crisp, and only the geography tells them apart. */
  const corroborated = evidence.dbaNamesBrand
    || Boolean(evidence.legalHit)
    || evidence.domainMatch
    || Boolean(evidence.geoOverlap);
  if (evidence.matchKind === 'asserted' && !corroborated) return 'REVIEW';
  if (!evidence.usPresence && !corroborated) return 'REVIEW';

  if (evidence.brandInText || corroborated) return 'verified';
  return evidence.textLength < 400 ? 'weak' : 'SUSPECT';
}
