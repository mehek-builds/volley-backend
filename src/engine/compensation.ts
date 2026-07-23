// Answering a "compensation expectation" field.
//
// This is a STANDARD, not a per-application judgement call. Mehek set it on 2026-07-23 and was
// explicit that it belongs in the codebase: a compensation field is always answerable, and the
// student is never asked for a number.
//
//   1. The posting states a range  -> answer its MEDIAN, in the posting's own unit and currency.
//   2. The posting states no range -> answer a RESEARCHED median for that role in that region.
//
// Rule 1 is deterministic and lives here. Rule 2 needs market data this process does not have, so
// it is a caller-supplied input (`researchedMedian`) rather than something the model invents: a
// fabricated figure is exactly the failure the grounding rules elsewhere exist to prevent, and a
// hallucinated salary anchors the student for real money.
//
// Retired by this rule, recorded so older notes do not reintroduce them: answering "Negotiable,
// open to your standard intern rate", defaulting numeric-only fields to EUR 18,000/yr, and asking
// the student when no range was stated. A required salary field with no stated range was the
// single biggest blocker in the 2026-07-17 QA run.

export type CompensationUnit = 'hour' | 'month' | 'year';

export interface StatedCompensation {
  min: number;
  max: number;
  median: number;
  currency: string;
  unit: CompensationUnit;
}

const CURRENCY_BY_SYMBOL: Record<string, string> = {
  $: 'USD',
  '£': 'GBP',
  '€': 'EUR',
};

// "$7K", "£57,800", "10K", "300,000", "55"
const AMOUNT = String.raw`(?:[$£€]\s*)?(\d[\d,]*(?:\.\d+)?)\s*([kK])?`;
// en dash, em dash, hyphen, "to"
const SEPARATOR = String.raw`\s*(?:-|–|—|to)\s*`;

function toNumber(digits: string, thousands: string | undefined): number {
  const base = Number(digits.replace(/,/g, ''));
  return thousands ? base * 1000 : base;
}

function detectCurrency(text: string): string {
  // An explicit code wins over a symbol: "$40 - $55 USD" and "CA$69.6K" both matter, and "$" alone
  // is ambiguous across USD/CAD/AUD.
  const code = text.match(/\b(USD|CAD|AUD|EUR|GBP|SGD|INR|AED)\b/);
  if (code) return code[1];
  if (/\bCA\s*\$/i.test(text)) return 'CAD';
  if (/\bA\s*\$/i.test(text)) return 'AUD';
  const symbol = text.match(/[$£€]/);
  if (symbol) return CURRENCY_BY_SYMBOL[symbol[0]] ?? 'USD';
  return 'USD';
}

function detectUnit(text: string): CompensationUnit | null {
  if (/\bper\s+hour\b|\bhourly\b|\/\s*hr\b|\ban\s+hour\b/i.test(text)) return 'hour';
  if (/\bper\s+month\b|\bmonthly\b|\/\s*mo\b|\ba\s+month\b/i.test(text)) return 'month';
  if (/\bper\s+year\b|\bannual(?:ized|ly)?\b|\byearly\b|\/\s*yr\b|\bbase\s+salary\b/i.test(text)) return 'year';
  return null;
}

/**
 * The compensation range a posting states, if it states one.
 *
 * Scans line by line so the unit attaches to the line that carries the numbers: a posting can
 * mention "per year" in an unrelated benefits sentence, and a JD frequently states an hourly rate
 * and an annual equivalent in different places. Returns the FIRST line that yields both an amount
 * and a unit, which is the headline compensation on every real posting seen so far.
 */
export function parseStatedCompensation(jdText: string): StatedCompensation | null {
  const rangeRe = new RegExp(`${AMOUNT}${SEPARATOR}${AMOUNT}`);
  const singleRe = new RegExp(AMOUNT);

  for (const rawLine of jdText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // A line has to look like money, or "3 to 5 years of experience" parses as a salary band.
    if (!/[$£€]|\b(?:USD|CAD|AUD|EUR|GBP|SGD|INR|AED)\b/.test(line)) continue;

    const unit = detectUnit(line);
    if (!unit) continue;

    const range = line.match(rangeRe);
    if (range) {
      const min = toNumber(range[1], range[2]);
      const max = toNumber(range[3], range[4]);
      if (min > 0 && max >= min) {
        return { min, max, median: (min + max) / 2, currency: detectCurrency(line), unit };
      }
    }

    const single = line.match(singleRe);
    if (single) {
      const value = toNumber(single[1], single[2]);
      // A lone figure is the offer, so it is its own median. Guard against picking up a stray "1"
      // from surrounding prose.
      if (value >= 100) {
        return { min: value, max: value, median: value, currency: detectCurrency(line), unit };
      }
    }
  }
  return null;
}

const UNIT_LABEL: Record<CompensationUnit, string> = {
  hour: 'per hour',
  month: 'per month',
  year: 'per year',
};

/** Annualize a rate so an "annualized total compensation" field can be answered from any unit. */
export function annualize(amount: number, unit: CompensationUnit): number {
  if (unit === 'year') return amount;
  if (unit === 'month') return amount * 12;
  return amount * 40 * 52; // hourly, full-time equivalent
}

export function formatCompensation(amount: number, currency: string, unit: CompensationUnit): string {
  const rounded = Math.round(amount);
  return `${currency} ${rounded.toLocaleString('en-US')} ${UNIT_LABEL[unit]}`;
}

export interface CompensationAnswerInput {
  jdText: string;
  /**
   * Median for this role in this region, from research. Required only when the posting states no
   * range. Supplying it is the caller's job precisely because this process cannot research, and a
   * guessed number would be a fabrication with financial consequences for the student.
   */
  researchedMedian?: { amount: number; currency: string; unit: CompensationUnit };
  /** True when the field asks for an annualized figure, common on finance and trading postings. */
  wantsAnnualized?: boolean;
  /** True when the input rejects anything but digits. */
  numericOnly?: boolean;
}

export interface CompensationAnswer {
  /** What to type into the field. */
  value: string;
  /** Where the number came from, for the review surface and for audit. */
  basis: 'posting_range' | 'researched_median';
  amount: number;
  currency: string;
  unit: CompensationUnit;
}

/**
 * The answer for a compensation field, or null when the posting states no range AND no researched
 * median was supplied. Null means "go and research it", never "ask the student" and never "guess".
 */
export function answerCompensation(input: CompensationAnswerInput): CompensationAnswer | null {
  const stated = parseStatedCompensation(input.jdText);
  const source = stated
    ? { amount: stated.median, currency: stated.currency, unit: stated.unit, basis: 'posting_range' as const }
    : input.researchedMedian
      ? { ...input.researchedMedian, basis: 'researched_median' as const }
      : null;
  if (!source) return null;

  const unit: CompensationUnit = input.wantsAnnualized ? 'year' : source.unit;
  const amount = input.wantsAnnualized ? annualize(source.amount, source.unit) : source.amount;

  return {
    value: input.numericOnly ? String(Math.round(amount)) : formatCompensation(amount, source.currency, unit),
    basis: source.basis,
    amount,
    currency: source.currency,
    unit,
  };
}
