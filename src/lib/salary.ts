// Ported verbatim from student-outreach-extension/src/lib/adapters/salary.ts (R-031 + R-011),
// so the server-side question-discovery path (R-055) applies the exact same salary rule as the
// extension rather than a second, drifting copy. This file is pure (no DOM, no fetch) in both
// places, which is what makes a direct copy safe: the ONLY change from the source is the
// `ApplicationProfile` import, replaced with the minimal local shape this backend needs.
//
// Do not hand-edit the logic here without also updating the extension copy (and vice versa) -
// two copies of the salary rule drifting apart is exactly how a currency-unsafe fill ships again.
//
// KNOWN DRIFT, 2026-09-02: REPEATED_CURRENCY_SRC below (a currency written again before the second
// number of a range) exists only in this copy so far. The extension's salary.ts must take the same
// change in the same release; until it does, a posting stating "$130,000 - $150,000" fills on the
// managed path and matches nothing on the extension path.
//
// `collectCurrencies` is exported here and not in the extension copy. That is an export keyword and
// nothing else: no line of logic differs, and the extension copy stays byte-comparable on every
// statement. questionDiscovery.ts reads it to answer a question detectCurrency cannot, which is how
// MANY currencies a label names - one, none, or two - because "expected salary (gbp or eur)" and
// "expected salary in kronor" both come back null from detectCurrency and mean opposite things.

export interface StoredSalaryProfile {
  desired_salary?: string;
  desired_salary_currency?: string;
}

const CURRENCY_CODES = [
  'usd', 'eur', 'gbp', 'aed', 'cad', 'aud', 'inr', 'sgd', 'chf', 'jpy', 'cny', 'hkd', 'nzd',
  'sek', 'nok', 'dkk', 'pln', 'czk', 'huf', 'brl', 'mxn', 'zar', 'krw', 'ils', 'sar', 'qar',
  'kwd', 'bhd', 'omr', 'myr', 'thb', 'idr', 'vnd', 'egp', 'ngn', 'kes', 'pkr', 'bdt', 'lkr',
];
const CODE_SRC = `\\b(${CURRENCY_CODES.join('|')})\\b`;
const SYMBOL_SRC = 'us\\$|ca\\$|au\\$|nz\\$|hk\\$|c\\$|a\\$|s\\$|[€£₹₩₺₪$]';
const CURRENCY_WORDS: Array<[RegExp, string]> = [
  [/\beuros?\b/i, 'EUR'],
  [/\bdirhams?\b/i, 'AED'],
  [/\bpounds?\s+sterling\b/i, 'GBP'],
  [/\bswiss\s+francs?\b/i, 'CHF'],
];

function mapCurrencyToken(token: string): string | null {
  const t = token.trim().toLowerCase();
  switch (t) {
    case 'us$': return 'USD';
    case 'ca$': case 'c$': return 'CAD';
    case 'au$': case 'a$': return 'AUD';
    case 'nz$': return 'NZD';
    case 'hk$': return 'HKD';
    case 's$': return 'SGD';
    case '€': return 'EUR';
    case '£': return 'GBP';
    case '₹': return 'INR';
    case '₩': return 'KRW';
    case '₺': return 'TRY';
    case '₪': return 'ILS';
    case '$': return null;
    default:
      return CURRENCY_CODES.includes(t) ? t.toUpperCase() : null;
  }
}

export function collectCurrencies(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(new RegExp(CODE_SRC, 'gi'))) {
    const c = mapCurrencyToken(m[1]);
    if (c) out.add(c);
  }
  for (const m of text.matchAll(new RegExp(SYMBOL_SRC, 'gi'))) {
    const c = mapCurrencyToken(m[0]);
    if (c) out.add(c);
  }
  for (const [re, code] of CURRENCY_WORDS) if (re.test(text)) out.add(code);
  return out;
}

export function detectCurrency(text: string): string | null {
  const set = collectCurrencies(text);
  return set.size === 1 ? [...set].at(0)! : null;
}

export function normalizeStoredCurrency(currency: string | undefined): string | null {
  const c = currency?.trim();
  if (!c) return null;
  return mapCurrencyToken(c);
}

export interface StatedRange {
  min: number;
  max: number;
  median: number;
  currency: string | null;
  fillText: string;
  fillNumeric: string;
}

interface NumToken {
  value: number;
  grouping: 'comma' | 'dot' | 'none';
}

function parseNumToken(raw: string): NumToken | null {
  const t = raw.trim();
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) return { value: Number(t.replace(/,/g, '')), grouping: 'comma' };
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(t)) {
    return { value: Number(t.replace(/\./g, '').replace(',', '.')), grouping: 'dot' };
  }
  if (/^\d+(?:\.\d+)?$/.test(t)) return { value: Number(t), grouping: 'none' };
  if (/^\d+,\d{1,2}$/.test(t)) return { value: Number(t.replace(',', '.')), grouping: 'none' };
  return null;
}

function groupDigits(n: number, grouping: NumToken['grouping']): string {
  const int = Math.trunc(n);
  const frac = n - int;
  const sep = grouping === 'comma' ? ',' : grouping === 'dot' ? '.' : '';
  const grouped = sep ? String(int).replace(/\B(?=(\d{3})+(?!\d))/g, sep) : String(int);
  if (!frac) return grouped;
  const fracStr = String(Math.round(frac * 100) / 100).slice(2);
  return `${grouped}${grouping === 'dot' ? ',' : '.'}${fracStr}`;
}

const NUM_SRC = String.raw`\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?`;
const SEP_SRC = String.raw`(?:\s*[-‐-―~]\s*|\s+(?:to|and|bis)\s+)`;
// The currency written AGAIN before the second number: "$130,000 - $150,000", "USD 90k to USD 110k".
// Measured live on TixTrack (2026-09-02), whose description states "Base annual salary range of
// $130,000 - $150,000" and matched nothing, because the range shape expected the second number to
// follow the separator directly. Only a currency symbol or code may sit there, never a word, so
// "130,000 to the 150,000 band" still does not read as a range. Non-capturing on purpose: the four
// numbered groups below are read by position.
const REPEATED_CURRENCY_SRC = `(?:(?:${SYMBOL_SRC}|\\b(?:${CURRENCY_CODES.join('|')})\\b)\\s?)?`;
const RANGE_SRC = `(${NUM_SRC})\\s*(k)?${SEP_SRC}${REPEATED_CURRENCY_SRC}(${NUM_SRC})\\s*(k)?`;

function currencyPrefixAt(text: string, index: number): string {
  const window = text.slice(Math.max(0, index - 8), index);
  const sym = new RegExp(`(?:${SYMBOL_SRC})\\s?$`, 'i').exec(window);
  if (sym) return sym[0];
  const code = /(?:^|[^a-z])([a-z]{3})(\s?)$/i.exec(window);
  if (code && mapCurrencyToken(code[1])) return code[1] + code[2];
  return '';
}

function suffixAt(text: string, end: number): { unit: string; code: string } {
  const window = text.slice(end, end + 18);
  const unit =
    /^\s*(?:\/\s*(?:hr|hour|yr|year|mo|month|wk|week|annum)\b|\s?per\s+(?:hour|year|month|week|annum)\b)/i.exec(
      window,
    )?.[0] ?? '';
  const rest = window.slice(unit.length);
  const code = /^\s?([a-z]{3})\b/i.exec(rest);
  return { unit, code: code && mapCurrencyToken(code[1]) ? code[1] : '' };
}

export function findStatedRanges(text: string): StatedRange[] {
  const out: StatedRange[] = [];
  for (const m of text.matchAll(new RegExp(RANGE_SRC, 'gi'))) {
    const minTok = parseNumToken(m[1]);
    const maxTok = parseNumToken(m[3]);
    if (!minTok || !maxTok) continue;
    const kMin = !!m[2];
    const kMax = !!m[4];
    const min = minTok.value * (kMin || (kMax && !kMin && minTok.grouping === 'none' && minTok.value < 1000) ? 1000 : 1);
    const max = maxTok.value * (kMax || (kMin && !kMax && maxTok.grouping === 'none' && maxTok.value < 1000) ? 1000 : 1);
    if (!(min > 0) || max < min) continue;

    const idx = m.index ?? 0;
    const prefix = currencyPrefixAt(text, idx);
    const { unit, code: suffixCode } = suffixAt(text, idx + m[0].length);
    const k = kMin || kMax;
    const marker = prefix !== '' || suffixCode !== '' || k || unit !== '';
    if (!marker && min < 1000) continue;
    if (
      !marker &&
      Number.isInteger(min) &&
      Number.isInteger(max) &&
      min >= 1900 && min <= 2100 &&
      max >= 1900 && max <= 2100
    ) {
      continue;
    }

    const median = (min + max) / 2;
    const prefixTok = prefix.trim();
    const currency =
      (prefixTok ? mapCurrencyToken(prefixTok) : null) ?? (suffixCode ? mapCurrencyToken(suffixCode) : null);

    const grouping = maxTok.grouping !== 'none' ? maxTok.grouping : minTok.grouping;
    const medianStr = k ? `${String(median / 1000)}k` : groupDigits(median, grouping);
    const prefixOut = prefixTok
      ? /^[a-z]{3}$/i.test(prefixTok)
        ? prefixTok.toUpperCase() + (prefix.endsWith(' ') ? ' ' : '')
        : prefix
      : '';
    const suffixOut = !prefixOut && suffixCode ? ` ${suffixCode.toUpperCase()}` : '';
    const unitOut = unit && !/^[\s/]/.test(unit) ? ` ${unit}` : unit;
    out.push({
      min,
      max,
      median,
      currency,
      fillText: `${prefixOut}${medianStr}${unitOut}${suffixOut}`,
      fillNumeric: String(median),
    });
  }
  return out;
}

function dedupeRanges(ranges: StatedRange[]): StatedRange[] {
  const seen = new Map<string, StatedRange>();
  for (const r of ranges) seen.set(`${r.min}:${r.max}:${r.currency ?? ''}`, r);
  return [...seen.values()];
}

export function statedRangeInLabel(label: string): StatedRange | null {
  const distinct = dedupeRanges(findStatedRanges(label));
  return distinct.length === 1 ? distinct[0] : null;
}

const SALARY_CONTEXT_SRC = 'salar|compensat|stipend|remunerat|\\bpay\\b|\\bwage\\b|hourly rate';

export function statedRangeInJd(jd: string): StatedRange | null {
  const ranges: StatedRange[] = [];
  for (const m of jd.matchAll(new RegExp(SALARY_CONTEXT_SRC, 'gi'))) {
    const idx = m.index ?? 0;
    ranges.push(...findStatedRanges(jd.slice(Math.max(0, idx - 40), idx + 160)));
  }
  const distinct = dedupeRanges(ranges);
  return distinct.length === 1 ? distinct[0] : null;
}

export function salaryAdjacentCurrencyInJd(jd: string): string | null {
  const found = new Set<string>();
  for (const m of jd.matchAll(new RegExp(SALARY_CONTEXT_SRC, 'gi'))) {
    const idx = m.index ?? 0;
    for (const c of collectCurrencies(jd.slice(Math.max(0, idx - 40), idx + 160))) found.add(c);
  }
  return found.size === 1 ? [...found].at(0)! : null;
}

export type SalaryFieldShape = 'numeric' | 'freetext';

export interface SalaryQuestionContext {
  label: string;
  field: SalaryFieldShape;
  jdText?: string;
}

export interface StoredSalary {
  value?: string;
  currency?: string;
}

export function storedSalaryOf(ap: StoredSalaryProfile): StoredSalary {
  return { value: ap.desired_salary, currency: ap.desired_salary_currency };
}

export type SalaryResolution =
  | { action: 'fill'; value: string; source: 'label-range' | 'posting-compensation' | 'jd-range' | 'stored-figure' | 'stored-prose' }
  | { action: 'flag'; reason: string };

export function salarySkipReason(label: string, detail: string): string {
  return `salary question left for you (${detail}): "${label.slice(0, 60)}"`;
}

export function isProseSalary(value: string): boolean {
  return !/^[\d\s.,]+k?$/i.test(value.trim());
}

function storedFigureFor(value: string, numeric: boolean): string {
  const trimmed = value.trim();
  if (!numeric) return trimmed;
  const compact = trimmed.replace(/\s+/g, '');
  const k = /k$/i.test(compact);
  const tok = parseNumToken(k ? compact.slice(0, -1) : compact);
  return tok ? String(tok.value * (k ? 1000 : 1)) : trimmed;
}

export function resolveSalary(ctx: SalaryQuestionContext, stored: StoredSalary): SalaryResolution {
  const numeric = ctx.field === 'numeric';

  const labelRange = statedRangeInLabel(ctx.label);
  if (labelRange) {
    return { action: 'fill', source: 'label-range', value: numeric ? labelRange.fillNumeric : labelRange.fillText };
  }

  if (ctx.jdText) {
    const jdRange = statedRangeInJd(ctx.jdText);
    if (jdRange) {
      return { action: 'fill', source: 'jd-range', value: numeric ? jdRange.fillNumeric : jdRange.fillText };
    }
  }

  const value = stored.value?.trim();
  if (!value) {
    return { action: 'flag', reason: salarySkipReason(ctx.label, 'no salary answer in your profile') };
  }

  if (isProseSalary(value)) {
    if (numeric) {
      return {
        action: 'flag',
        reason: salarySkipReason(ctx.label, 'this field takes a number and your stored answer is a sentence'),
      };
    }
    return { action: 'fill', source: 'stored-prose', value };
  }

  const postingCurrency = detectCurrency(ctx.label) ?? (ctx.jdText ? salaryAdjacentCurrencyInJd(ctx.jdText) : null);
  const storedCurrency = normalizeStoredCurrency(stored.currency);
  if (!postingCurrency) {
    return {
      action: 'flag',
      reason: salarySkipReason(ctx.label, "couldn't confirm the posting's currency for your stored figure"),
    };
  }
  if (!storedCurrency || storedCurrency !== postingCurrency) {
    return {
      action: 'flag',
      reason: salarySkipReason(
        ctx.label,
        `the posting pays in ${postingCurrency} and your stored figure is ${storedCurrency ?? 'in no stated currency'}, never converted`,
      ),
    };
  }
  return { action: 'fill', source: 'stored-figure', value: storedFigureFor(value, numeric) };
}
