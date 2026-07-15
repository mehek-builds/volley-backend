// Alumni school matching for /resolve. Given the student's own school (from their profile) and
// the school(s) listed on a sourced contact (Apollo education), decide whether the contact is an
// alum of the same institution. Matching is fuzzy on purpose: providers spell the same school
// many ways ("USC", "University of Southern California", "USC Marshall School of Business"), so
// exact string equality would miss almost every real alum. We normalize both sides (lowercase,
// strip punctuation, drop filler tokens like "university"/"of"/"the") and match on a known
// abbreviation/alias hit OR strong token overlap. Never a substring free-for-all - "Stanford"
// must not match "Harvard", and an empty user school must never match anything.

const DROP_TOKENS = new Set([
  'university', 'universidad', 'college', 'the', 'of', 'at', 'and', 'school', 'schools',
]);

// Structural words that never distinguish one institution from another ("University of X" == "X").
// Deliberately does NOT include the institution-TYPE words below - "University" vs "College" is
// exactly what tells Boston University apart from Boston College.
const STRUCTURAL_FILLER = new Set([
  'the', 'of', 'at', 'and', 'school', 'schools', 'in', 'st', 'saint',
]);

// Institution-type words. Pulled out of the distinctive-name tokens but tracked separately: two
// schools with the SAME name token but DIFFERENT types ("Boston University" vs "Boston College")
// are different institutions, and so are same-type/same-token names in opposite word order
// ("University of Miami" vs "Miami University").
const TYPE_WORDS = new Set([
  'university', 'universidad', 'college', 'institute', 'polytechnic', 'academy',
]);

// Each group lists every spelling that should resolve to the same institution. The first entry is
// just the human-readable label; membership is what matters. Extend as real data surfaces.
const ALIAS_GROUPS: string[][] = [
  ['university of southern california', 'usc', 'southern cal'],
  ['university of california berkeley', 'uc berkeley', 'berkeley', 'cal berkeley'],
  ['university of california los angeles', 'ucla'],
  ['university of california san diego', 'ucsd'],
  ['university of california irvine', 'uc irvine', 'uci'],
  ['university of california davis', 'uc davis'],
  ['university of california santa barbara', 'ucsb'],
  ['massachusetts institute of technology', 'mit'],
  ['new york university', 'nyu'],
  ['california institute of technology', 'caltech'],
  ['georgia institute of technology', 'georgia tech', 'gatech'],
  ['carnegie mellon university', 'carnegie mellon', 'cmu'],
  ['university of pennsylvania', 'upenn', 'penn'],
  ['university of illinois urbana champaign', 'university of illinois at urbana champaign', 'uiuc'],
  ['university of michigan', 'umich'],
  ['university of texas austin', 'university of texas at austin', 'ut austin'],
  ['rensselaer polytechnic institute', 'rpi'],
];

// Distinctive abbreviations that are safe to match even as a single token inside a longer string
// (e.g. "USC Marshall School of Business" -> USC). Ambiguous shorthands ("penn", "cal") are left
// out of this set and only match as a full normalized string, to avoid Penn State vs UPenn slips.
const TOKEN_LEVEL_ABBREVS = new Set([
  'usc', 'ucla', 'ucsd', 'uci', 'ucsb', 'mit', 'nyu', 'caltech', 'gatech', 'cmu', 'uiuc',
  'umich', 'rpi',
]);

function normalizeString(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()'"[\]–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Collapse runs of single letters into one token so dotted/spaced initialisms normalize like
// their compact form: "m i t" -> "mit", "u s c" -> "usc". Multi-letter tokens ("uc", "berkeley")
// are left untouched.
function collapseInitialisms(norm: string): string {
  return norm.replace(/\b(?:[a-z] )+[a-z]\b/g, (run) => run.replace(/ /g, ''));
}

function tokenize(raw: string): string[] {
  // length >= 2 so stray single letters (from dotted initialisms) don't create spurious token
  // overlap; initialisms are handled via the alias path instead.
  return normalizeString(raw)
    .split(' ')
    .filter((t) => t.length >= 2 && !DROP_TOKENS.has(t));
}

// Reverse lookups, built once: normalized full-string variant -> group index, and (for the
// distinctive abbreviations only) single abbrev token -> group index.
const VARIANT_TO_GROUP = new Map<string, number>();
const ABBREV_TOKEN_TO_GROUP = new Map<string, number>();
ALIAS_GROUPS.forEach((group, i) => {
  for (const variant of group) {
    const norm = normalizeString(variant);
    VARIANT_TO_GROUP.set(norm, i);
    if (!norm.includes(' ') && TOKEN_LEVEL_ABBREVS.has(norm)) {
      ABBREV_TOKEN_TO_GROUP.set(norm, i);
    }
  }
});

// The alias-group id a school string belongs to, or null if it matches no known institution.
export function aliasGroupOf(school: string): number | null {
  const norm = normalizeString(school);
  if (!norm) return null;
  const collapsed = collapseInitialisms(norm);
  for (const form of new Set([norm, collapsed])) {
    if (VARIANT_TO_GROUP.has(form)) return VARIANT_TO_GROUP.get(form)!;
  }
  for (const tok of collapsed.split(' ')) {
    if (ABBREV_TOKEN_TO_GROUP.has(tok)) return ABBREV_TOKEN_TO_GROUP.get(tok)!;
  }
  return null;
}

interface ParsedSchool {
  nameTokens: string[]; // distinctive tokens (order preserved), type + structural filler removed
  type: string | null; // the institution-type word, if the name carries one
  typeBeforeName: boolean | null; // type word's position relative to the first name token
}

// Split a school string into its distinctive name tokens and (separately) its institution-type
// word. Keeping the type word out of the name set - but remembering it - lets the matcher tell
// "Boston University" from "Boston College" and "University of Miami" from "Miami University",
// which a plain token-overlap check cannot.
function parseSchool(raw: string): ParsedSchool {
  const toks = collapseInitialisms(normalizeString(raw))
    .split(' ')
    .filter((t) => t.length >= 2);
  const nameTokens: string[] = [];
  let type: string | null = null;
  let typeIdx = -1;
  let firstNameIdx = -1;
  toks.forEach((t, i) => {
    if (TYPE_WORDS.has(t)) {
      if (type === null) {
        type = t;
        typeIdx = i;
      }
      return;
    }
    if (STRUCTURAL_FILLER.has(t)) return;
    if (firstNameIdx === -1) firstNameIdx = i;
    nameTokens.push(t);
  });
  const typeBeforeName = type === null || firstNameIdx === -1 ? null : typeIdx < firstNameIdx;
  return { nameTokens, type, typeBeforeName };
}

// True only when two school strings name the SAME institution by their distinctive tokens. Both
// sides must be almost fully contained in each other (so an extra distinctive token like "State"
// or "Louis" breaks the match), the institution type must not conflict, and same-token/same-type
// names in opposite order don't match. This is the fuzzy fallback used only when the alias table
// doesn't already resolve both sides.
function sameInstitutionByTokens(aRaw: string, bRaw: string): boolean {
  const a = parseSchool(aRaw);
  const b = parseSchool(bRaw);
  const sa = new Set(a.nameTokens);
  const sb = new Set(b.nameTokens);
  if (sa.size === 0 || sb.size === 0) return false;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  if (inter === 0) return false;
  // Both-sided containment: neither side may carry an extra distinctive token the other lacks.
  // Kills "University of Michigan" vs "Michigan State University" (extra "state"), "University of
  // Washington" vs "Washington University in St. Louis" (extra "louis"), "York University" vs
  // "New York University" (extra "new").
  if (inter / sa.size < 0.8 || inter / sb.size < 0.8) return false;
  // Same name tokens but a different institution type -> different schools
  // ("Boston University" vs "Boston College", "Columbia University" vs "Columbia College").
  if (a.type && b.type && a.type !== b.type) return false;
  // Same name token, same type, but opposite word order -> different schools
  // ("University of Miami" [FL] vs "Miami University" [OH]).
  if (
    a.type &&
    b.type &&
    a.typeBeforeName !== null &&
    b.typeBeforeName !== null &&
    a.typeBeforeName !== b.typeBeforeName
  ) {
    return false;
  }
  return true;
}

// True when the student and the contact went to the same school. `candidateSchools` is every
// school string the provider returned for the contact (usually 0-2). Empty/whitespace user
// school -> always false.
export function isAlumniMatch(
  userSchool: string | null | undefined,
  candidateSchools: Array<string | null | undefined>,
): boolean {
  if (!userSchool || !userSchool.trim()) return false;
  const uGroup = aliasGroupOf(userSchool);
  const uTokens = tokenize(userSchool);
  if (uTokens.length === 0 && uGroup === null) return false;

  for (const cand of candidateSchools) {
    if (!cand || !cand.trim()) continue;
    const cGroup = aliasGroupOf(cand);
    if (uGroup !== null && cGroup !== null) {
      // Both sides resolve to a known institution: the alias table is authoritative. Same group =
      // match; different groups = definitively different schools - don't fall through to the fuzzy
      // token check, which could wrongly rejoin two distinct schools that share a token.
      if (uGroup === cGroup) return true;
      continue;
    }
    if (sameInstitutionByTokens(userSchool, cand)) return true;
  }
  return false;
}
