/**
 * THE OFFICES AN EMPLOYER NAMES IN A QUESTION, and which country each one is in.
 *
 * One table, two readers. answerReuse.ts asks "does this label name a place at all?" to decide
 * whether an answer she typed may travel to the next employer. questionDiscovery.ts asks "which
 * places does it name, and are they in the US?" to decide whether her stored standing preference
 * settles the question.
 *
 * It is a shared module rather than a copy in each file because the two readers must never disagree
 * about what counts as a named office: a label that answerReuse treats as placed and the resolver
 * treats as placeless would be remembered under one rule and answered under another. This repo has
 * paid for two copies of one regex more than once.
 */

export type OfficeMetro = {
  /** The canonical name, used only in messages and tests. */
  metro: string;
  /** Where the office is. 'US' is the only value the standing preference is scoped to. */
  country: 'US' | 'other';
  /** The spellings employers actually type for it. */
  pattern: RegExp;
};

export const OFFICE_METROS: readonly OfficeMetro[] = [
  { metro: 'San Francisco', country: 'US', pattern: /\bsan\s+franc?[si]sco\b|\bsan\s+fran\b|\bsf\s+(?:office|bay)\b|\bin\s+sf\b|\bsf\s+hq\b/i },
  { metro: 'New York', country: 'US', pattern: /\bnew\s+york(?:\s+city)?\b|\bnyc\b|\bmanhattan\b/i },
  { metro: 'Los Angeles', country: 'US', pattern: /\blos\s+angeles\b|\bla\s+office\b|\bculver\s+city\b|\bsanta\s+monica\b/i },
  { metro: 'Austin', country: 'US', pattern: /\baustin\b/i },
  { metro: 'Chicago', country: 'US', pattern: /\bchicago\b/i },
  { metro: 'Seattle', country: 'US', pattern: /\bseattle\b|\bbellevue\b/i },
  { metro: 'Boston', country: 'US', pattern: /\bboston\b|\bcambridge,\s*ma\b/i },
  { metro: 'Mountain View', country: 'US', pattern: /\bmountain\s+view\b/i },
  { metro: 'Palo Alto', country: 'US', pattern: /\bpalo\s+alto\b/i },
  { metro: 'San Mateo', country: 'US', pattern: /\bsan\s+mateo\b/i },
  { metro: 'Greenwich', country: 'US', pattern: /\bgreenwich\b/i },
  { metro: 'Houston', country: 'US', pattern: /\bhouston\b/i },
  { metro: 'Denver', country: 'US', pattern: /\bdenver\b/i },
  { metro: 'Atlanta', country: 'US', pattern: /\batlanta\b/i },
  { metro: 'Costa Mesa', country: 'US', pattern: /\bcosta\s+mesa\b|\birvine\b/i },
  { metro: 'Washington DC', country: 'US', pattern: /\bwashington,?\s*d\.?c\.?\b|\barlington,\s*va\b/i },
  { metro: 'London', country: 'other', pattern: /\blondon\b/i },
  { metro: 'Dubai', country: 'other', pattern: /\bdubai\b/i },
  { metro: 'Singapore', country: 'other', pattern: /\bsingapore\b/i },
  { metro: 'Amsterdam', country: 'other', pattern: /\bamsterdam\b/i },
  { metro: 'Sydney', country: 'other', pattern: /\bsydney\b/i },
  { metro: 'Toronto', country: 'other', pattern: /\btoronto\b/i },
  { metro: 'Hong Kong', country: 'other', pattern: /\bhong\s+kong\b/i },
  { metro: 'Bengaluru', country: 'other', pattern: /\bbengaluru\b|\bbangalore\b/i },
  { metro: 'Mumbai', country: 'other', pattern: /\bmumbai\b/i },
  { metro: 'Zug', country: 'other', pattern: /\bzug\b|\bzurich\b/i },
];

/** Every metro this text names, in table order. Empty when it names none. */
export function officeMetrosNamed(text: string): OfficeMetro[] {
  const value = text ?? '';
  return OFFICE_METROS.filter((entry) => entry.pattern.test(value));
}

/** Does this label name an office metro at all? */
export function labelNamesOfficeMetro(label: string): boolean {
  return officeMetrosNamed(label).length > 0;
}

/**
 * Does this text name only offices inside the United States?
 *
 * False when it names none, so a caller cannot read "no place mentioned" as "a US place". The
 * standing onsite preference is scoped to the US, so a label naming London has to be refused rather
 * than answered from it, and a label naming nowhere is a different refusal with a different reason.
 */
export function namesOnlyUsOffices(text: string): boolean {
  const named = officeMetrosNamed(text);
  return named.length > 0 && named.every((entry) => entry.country === 'US');
}

/**
 * Does this text place itself in the United States without naming one of the metros above?
 *
 * "Are you willing to work in-person in the US?" names no city and is still plainly US-scoped. Kept
 * separate from the metro table so a country phrase can never be mistaken for an office.
 */
const US_COUNTRY_PHRASE =
  /\bunited\s+states\b|\bu\.?\s?s\.?\s?a\b|\bin\s+the\s+us\b|\bus[-\s]based\b|\bstateside\b/i;

export function namesUnitedStates(text: string): boolean {
  return US_COUNTRY_PHRASE.test(text ?? '');
}
