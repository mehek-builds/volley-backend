/* WHAT A POSTING PAYS, AND HOW OFTEN.
 *
 * Handshake can print "$35/hr" beside one job and "$50-63K/yr" beside the next because its
 * employers pick both numbers and the period from a form. The three boards Litos polls do not
 * agree on that, so this module is where their three shapes become one:
 *
 *   Lever   salaryRange { min, max, currency, interval: 'per-year-salary' }   period stated
 *   Ashby   compensationTiers[].components[] { minValue, maxValue, currencyCode, interval: '1 YEAR' }
 *                                                                             period stated
 *   Greenhouse  pay_input_ranges[] { min_cents, max_cents, currency_type, title }
 *                                                                             PERIOD NOT STATED
 *
 * Greenhouse is 84% of the board, so the missing period is the whole problem. See
 * inferGreenhouseInterval.
 *
 * NEITHER FETCH ASKS FOR THIS TODAY. Greenhouse needs `&pay_transparency=true` and Ashby needs
 * `?includeCompensation=true`; without those the fields are simply absent from the response, which
 * is why the board has never shown pay. Lever has been returning salaryRange all along and the
 * normalizer dropped it. See sourceEndpoint in jobMonitor.ts.
 */

export type PayInterval = 'year' | 'month' | 'hour';

export type NormalizedPay = {
  /** Major units (dollars, euros, yen), never cents. Greenhouse is the only source in cents. */
  min: number;
  max: number;
  /** ISO 4217, upper case. 19 distinct codes appear across the live board. */
  currency: string;
  interval: PayInterval;
};

type Range = { min: number; max: number; currency: string; interval: PayInterval };

/* Approximate units per USD, used ONLY to decide whether a number is an hourly rate or an annual
 * salary. It is a magnitude classifier, not a converter: nothing here is ever shown to anyone, and
 * the gap it has to resolve is ~300x wide (see inferGreenhouseInterval), so a rate that has drifted
 * by 2x still lands on the same side. That is the entire reason this is a hardcoded table rather
 * than an FX dependency the daily poll could fail on.
 *
 * Every code below was observed on the live board on 2026-07-29. An unlisted currency falls back to
 * 1, which treats it as dollar-scaled — safe for the majors and, for an unlisted minor currency,
 * pushes it toward the ambiguous band and out of the product rather than into a wrong label.
 */
const UNITS_PER_USD: Record<string, number> = {
  USD: 1, EUR: 0.92, GBP: 0.79, CAD: 1.37, AUD: 1.5, SGD: 1.34, CHF: 0.88,
  JPY: 150, CNY: 7.2, INR: 85, TWD: 32, HUF: 350, CLP: 950,
  SEK: 10.5, NOK: 10.5, DKK: 6.9, PLN: 4, RON: 4.6, BRL: 5.5, MXN: 18,
};

function usdEquivalent(value: number, currency: string): number {
  return value / (UNITS_PER_USD[currency.toUpperCase()] ?? 1);
}

/* The band where magnitude cannot tell an hourly rate from an annual salary.
 *
 * MEASURED, NOT GUESSED, across all 253 boards (7,472 Greenhouse ranges on 2026-07-29): 283 ranges
 * top out under $500/USD-equivalent and 7,174 top out above $10,000. Fifteen sit between, and every
 * one of them is genuinely ambiguous rather than merely unusual — six are Airbnb and Robinhood
 * MONTHLY ranges (labelled as such), and the rest are employer data errors, like Remote's
 * "annual salary range" of JPY 86,000-97,000, which would be $573 a year.
 *
 * So the band is dropped rather than guessed. Fifteen postings out of 22,124 lose a pay line they
 * were never going to render correctly, which is the same trade the rest of this board makes: say
 * only what is known. The lower floor is a junk gate — a handful of ranges max out at $1.00, which
 * is not an hourly wage anywhere.
 */
const IMPLAUSIBLE_BELOW_USD = 2;
const HOURLY_CEILING_USD = 500;
const ANNUAL_FLOOR_USD = 10_000;

/* Read only INSIDE the ambiguous band, and only for the one period magnitude can never recover.
 *
 * Greenhouse's range label is free text the employer types, and it is not reliable enough to lead
 * with: across the live board, 13 ranges labelled "hourly" carry annual-sized numbers and 17
 * labelled "annual" carry hourly-sized ones. Magnitude beats the label everywhere the two disagree.
 *
 * But magnitude alone has no way to see a monthly figure — a monthly salary is simply a smallish
 * annual one — so a label that says "Mexico Monthly Pay Range" is the only evidence that exists.
 * Consulted after the magnitude tests have already declined to rule, so a wrong label can only ever
 * recover a posting that was about to be dropped; it can never overturn a decided one.
 */
const MONTHLY_LABEL = /\bmonthly\b|\bper month\b|\/\s*month\b/i;

/**
 * Greenhouse states no pay period, so derive one from the size of the number.
 *
 * Returns null when the range is not confidently one thing, and the caller drops the pay line
 * entirely rather than showing a figure with the wrong period on it. A salary rendered as an
 * hourly rate is worse than no salary: it is a specific, credible, wrong number.
 */
export function inferGreenhouseInterval(
  max: number,
  currency: string,
  label?: string,
): PayInterval | null {
  const usd = usdEquivalent(max, currency);
  if (!Number.isFinite(usd) || usd < IMPLAUSIBLE_BELOW_USD) return null;
  if (usd < HOURLY_CEILING_USD) return 'hour';
  if (usd > ANNUAL_FLOOR_USD) return 'year';
  return label && MONTHLY_LABEL.test(label) ? 'month' : null;
}

const CURRENCY_CODE = /^[A-Za-z]{3}$/;

function toRange(
  min: unknown,
  max: unknown,
  currency: unknown,
  interval: PayInterval | null,
): Range | null {
  if (!interval) return null;
  if (typeof currency !== 'string' || !CURRENCY_CODE.test(currency.trim())) return null;
  const lo = typeof min === 'number' ? min : Number(min);
  const hi = typeof max === 'number' ? max : Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (lo <= 0 || hi <= 0) return null;
  /* An inverted range is employer error, not a signal to be clever about. Order it and move on;
     the alternative is dropping pay over a typo the reader would never have noticed. */
  return {
    min: Math.min(lo, hi),
    max: Math.max(lo, hi),
    currency: currency.trim().toUpperCase(),
    interval,
  };
}

/**
 * One posting, one pay line.
 *
 * 1,121 Greenhouse postings publish more than one range — "Zone 1 / Zone 2 / Zone 3" for cost-of-
 * living bands, or a separate figure per country — and 186 of those mix currencies. Ashby does the
 * same thing through compensationTiers and says so out loud ("Multiple Ranges"). A tile has room
 * for one line, so the ranges have to collapse.
 *
 * The rule: group by (currency, interval), keep the group with the most ranges in it, and span it —
 * lowest min to highest max. Most-ranges rather than highest-paying, because the majority group is
 * the one describing the role's main hiring market; picking the top figure would advertise the San
 * Francisco band on a job posted in three cities. Ties break on the group with the larger span, so
 * the collapse is deterministic and does not depend on the board's array order.
 */
export function collapseRanges(ranges: (Range | null)[]): NormalizedPay | null {
  const groups = new Map<string, Range[]>();
  for (const range of ranges) {
    if (!range) continue;
    const key = `${range.currency}:${range.interval}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(range);
    else groups.set(key, [range]);
  }
  if (groups.size === 0) return null;

  let best: Range[] | null = null;
  let bestSpan = -1;
  for (const bucket of groups.values()) {
    const span = Math.max(...bucket.map((r) => r.max)) - Math.min(...bucket.map((r) => r.min));
    if (!best || bucket.length > best.length || (bucket.length === best.length && span > bestSpan)) {
      best = bucket;
      bestSpan = span;
    }
  }
  if (!best) return null;
  return {
    min: Math.min(...best.map((r) => r.min)),
    max: Math.max(...best.map((r) => r.max)),
    currency: best[0].currency,
    interval: best[0].interval,
  };
}

/** Greenhouse `pay_input_ranges`, present only when the fetch asks for `pay_transparency=true`. */
export function readGreenhousePay(job: Record<string, unknown>): NormalizedPay | null {
  const ranges = job.pay_input_ranges;
  if (!Array.isArray(ranges)) return null;
  return collapseRanges(ranges.map((raw) => {
    const range = raw as Record<string, unknown>;
    const currency = typeof range.currency_type === 'string' ? range.currency_type : '';
    /* Cents on this board and this board only. Divide before inferring the period, because the
       period test is a statement about the size of a real salary. */
    const min = Number(range.min_cents) / 100;
    const max = Number(range.max_cents) / 100;
    if (!Number.isFinite(max)) return null;
    const label = typeof range.title === 'string' ? range.title : undefined;
    return toRange(min, max, currency, inferGreenhouseInterval(max, currency, label));
  }));
}

/* Lever states the period as a slug. Only the three the product can render are mapped: 'one-time'
   is a bonus rather than a rate, and per-week and per-day have no honest short form on a tile, so
   they return null and the posting shows no pay rather than a figure whose period is a guess. */
const LEVER_INTERVALS: Record<string, PayInterval> = {
  'per-year-salary': 'year',
  'per-month-salary': 'month',
  'per-hour-wage': 'hour',
};

/** Lever `salaryRange`, already present in the current fetch and previously discarded. */
export function readLeverPay(job: Record<string, unknown>): NormalizedPay | null {
  const range = job.salaryRange as Record<string, unknown> | undefined;
  if (!range || typeof range !== 'object') return null;
  const interval = typeof range.interval === 'string' ? LEVER_INTERVALS[range.interval] ?? null : null;
  return collapseRanges([toRange(range.min, range.max, range.currency, interval)]);
}

/* Ashby spells the period as a quantity and a unit. Anything other than these three (it also emits
   'NONE' on equity components, which are filtered out before this by compensationType) is not a
   rate this product can print. */
const ASHBY_INTERVALS: Record<string, PayInterval> = {
  '1 YEAR': 'year',
  '1 MONTH': 'month',
  '1 HOUR': 'hour',
};

/** Ashby `compensation`, present only when the fetch asks for `includeCompensation=true`. */
export function readAshbyPay(job: Record<string, unknown>): NormalizedPay | null {
  const compensation = job.compensation as Record<string, unknown> | undefined;
  if (!compensation || typeof compensation !== 'object') return null;
  const tiers = Array.isArray(compensation.compensationTiers) ? compensation.compensationTiers : [];
  const components = tiers.flatMap((tier) => {
    const list = (tier as Record<string, unknown>)?.components;
    return Array.isArray(list) ? list : [];
  });
  return collapseRanges(components.map((raw) => {
    const component = raw as Record<string, unknown>;
    /* Salary only. A tier also carries EquityPercentage and bonus components, which have no
       currency and no period and would otherwise collapse into the pay line as zeroes. */
    if (component.compensationType !== 'Salary') return null;
    const interval = typeof component.interval === 'string'
      ? ASHBY_INTERVALS[component.interval] ?? null
      : null;
    return toRange(component.minValue, component.maxValue, component.currencyCode, interval);
  }));
}

/* WHAT KIND OF JOB IT IS.
 *
 * Lever and Ashby state this on every posting. Greenhouse — 18,685 of the board's 22,124 postings —
 * has no such field at all, so for those the title is the only evidence there is.
 *
 * DERIVE ONLY THE POSITIVE CASES. A title says "Data Science Intern" or it does not; what it never
 * says is "this is a full-time role", because nobody writes that. Defaulting the other ~18,000
 * postings to "Full-time" would be asserting, on every tile, a fact no source stated — the same
 * mistake as jobbie.bot stamping "Just now" on every row, which this board already refuses to make.
 * So an unstated type shows no chip, and 158 internships, 150 contract roles and 34 part-time roles
 * on Greenhouse get labelled correctly instead of being drowned in 18,000 fabricated ones.
 */
const TITLE_TYPES: [RegExp, string][] = [
  /* Internship first: "Contract Intern" is an internship, and a co-op is one in everything but
     name. \b on both sides so "Internal Audit" and "Internationalization Engineer" — both live on
     the board — are not read as internships. */
  [/\b(intern|interns|internship|internships)\b|\bco-?op\b/i, 'Internship'],
  /* THE SAME WORD IN THE LANGUAGE THE POSTING WAS WRITTEN IN.
   *
   * The board is not English-only and the title rule was. Measured 2026-08-04 across 39,868 live
   * titles: TWENTY internships were being missed for no reason but language - 16 btgpactual
   * "Estágio em Data Analytics", 3 HelloFresh/Lucid "Stagiair(e)", and crisp's "Werkstudent
   * Finance". Every one is unambiguous in its own language, and none carries an English intern
   * word anywhere in the title, so nothing else was ever going to catch them.
   *
   * BARE "stage" IS DELIBERATELY ABSENT, and it is the whole reason this list is hand-picked
   * rather than a translation table. It means internship in French and Dutch and something else
   * entirely in an English job title: 22 live titles contain it, and they are "Account Executive,
   * Early Stage", "Senior Stage Fluids Engineer I" and "Account Manager, Growth Stage". Catching
   * the two real ones ("Category Management stage") is not worth relabelling twenty full-time
   * sales and engineering jobs as internships. Every token below is distinctive enough to have no
   * English homograph, which is the bar for adding another. */
  [
    new RegExp(
      '\\bestágios?\\b|\\bestagiári[oa]s?\\b'
      + '|\\bstagiaires?\\b|\\bstagiair\\b'
      + '|\\bpraktikums?\\b|\\bpraktikant(?:in)?\\b|\\bwerkstudent(?:in)?\\b'
      + '|\\bbecari[oa]s?\\b|\\bpasantías?\\b|\\bprácticas\\b'
      + '|\\btirocini[oa]\\b',
      'i',
    ),
    'Internship',
  ],
  /* APPRENTICESHIP IS ITS OWN CATEGORY, not a kind of internship (2026-08-04, Mehek's call).
     It used to share the rule above, and the two are genuinely different jobs. An internship is
     a student's fixed-length placement, usually a summer. A trade apprenticeship is a paid,
     multi-year, full-time route into a skilled trade, open to people who are not students at all:
     the live examples are Crusoe's Apprentice Electrician, SpaceX's Apprentice Weld Support
     Technician, Rocket Lab's Apprentice Aerospace Technician and Figure's Apprentice Robot Service
     Technician. Filing those under Internship told a career-changer they were student roles and
     told a student they were summer ones, and both were wrong.
     Below Internship on purpose: "Apprentice Intern" would be an internship, and the intern rule
     should win that. */
  [/\bapprentice(ship)?s?\b/i, 'Apprenticeship'],
  [/\bpart[-\s]?time\b/i, 'Part-time'],
  [/\bcontract(or)?\b|\btemporary\b|\bfixed[-\s]?term\b|\bseasonal\b/i, 'Contract'],
];

/**
 * The employment type a title states outright, or undefined.
 *
 * undefined is the common answer and the correct one: it means the posting did not say, and the
 * tile shows nothing. Never returns 'Full-time' — see the note above for why that would be a
 * fabrication rather than a default.
 *
 * HALF OF THE RULE. Exported for its own unit tests, but normalizers must call
 * resolveEmploymentType instead: this function alone knows nothing about the employer's field, and a
 * caller that used it directly on Lever or Ashby would throw that field away.
 */
export function employmentTypeFromTitle(title: string): string | undefined {
  for (const [pattern, type] of TITLE_TYPES) {
    if (pattern.test(title)) return type;
  }
  return undefined;
}

/* The vocabulary the two boards that DO state a type actually emit, measured live: Ashby sends
   FullTime / PartTime / Contract / Intern / Temporary, and Lever sends Full-time / Permanent /
   Internship / Fixed Term / Short Term / Apprenticeship / Contractor and several spellings of
   each. Normalized so one product word covers both boards and the titles above, because a filter
   over "Internship" and "Intern" as two different values is a filter that silently misses half.

   'Permanent' (190 Lever postings) folds into Full-time: it is the same thing said in British and
   European job-ad register, and it is Lever's commitment field, so it is the employer speaking. */
const TYPE_SYNONYMS: [RegExp, string][] = [
  /* "Full Time Employee" is Workable's wording and was passing straight through, so 55 live
     postings carried a chip reading "Full Time Employee" and were invisible to the Full-time
     filter - the employer had answered and the board was not listening.
     ANCHORED, NOT A PREFIX. `^full[-\s]?time` on its own would also swallow "Full Time
     Contractor", which is a contract and has to keep falling through to the Contract rule below. */
  /* "Permanent, Full-time" is Ninja Van's wording, found the day international sources landed and
     6 postings wide. Employers keep inventing new spellings of the same fact, which is why the
     verify:classification gate reports pass-through values rather than hiding them.
     STILL ANCHORED. "Full Time Contractor" has to keep falling through to Contract below. */
  [/^full[-\s]?time$|^full[-\s]?time employee$|^permanent,?\s*full[-\s]?time$|^permanent$|^fulltime$/i, 'Full-time'],
  [/^part[-\s]?time$|^parttime$/i, 'Part-time'],
  [/^intern(ship)?$|^co-?op$|^scholarship$/i, 'Internship'],
  /* Split out of Internship 2026-08-04. Lever emits this for Match Group's four "Apprenticeship -
     Junior ..." postings, which are the genuine early-career kind rather than trade routes, but
     they are still apprenticeships and belong in the same bucket as the trade ones. The category
     is "apprenticeship", not "how junior the apprentice is". */
  [/^apprentice(ship)?$/i, 'Apprenticeship'],
  [/contract|temporary|^temp$|fixed[-\s]?term|short[-\s]?term|agency/i, 'Contract'],
];

/* THE SECOND PASS, for a value that states a type AND something else in the same string.
 *
 * The rules above are anchored, so they only fire when the employer's field says the type and
 * nothing but the type. That is most of Ashby and Lever and none of the rest of the catalogue.
 * Measured against live prod 2026-09-01: 875 distinct values on 41,933 active postings fell past
 * them and were passed through verbatim, which is how a tile came to read `fulltime_permanent`.
 *
 * WHAT WAS ACTUALLY IN THERE, and why one more anchored rule per spelling was never going to work:
 *   - Recruitee posts a CODE, not a word: fulltime_permanent (11,164), fulltime_fixed_term (3,550),
 *     parttime_fixed_term (1,886), parttime_permanent (1,683), parttime_minijob (206).
 *   - Most boards post the type with a payroll or site qualifier welded on: "Salaried, full-time"
 *     (3,961), "Hourly, full-time" (1,312), "Full Time Hybrid" (922), "Clinical Part Time" (1,005).
 *   - Non-English boards post it in their own language: CDI, Temps plein, Vollzeit, Deeltijds,
 *     Tiempo Completo, Tempo integral, CLT, Efetivo, On-roll, En planilla, 正社員, 정규직.
 * That is an open set of decorations around a closed set of types, so this pass reads the SIGNAL
 * out of the noise instead of trying to enumerate the noise.
 *
 * PRECEDENCE IS THE WHOLE DESIGN:
 *   Volunteer, then Internship, then Apprenticeship, then the hours rules, then Contract.
 *
 * WHEN A VALUE STATES BOTH HOURS AND TENURE, THE HOURS WIN. `fulltime_fixed_term` states two facts
 * and only one of them fits a category, so the question is which one to keep. It is the hours, for
 * a reason that is about the reader rather than the taxonomy: BOTH filters this board runs are
 * hours filters. targetingConditions matches `employment_type ~* 'full.?time'` and matchingRoleType
 * sets isNonFullTime from the same word, and ROLE_TYPES is internship / co-op / new-grad /
 * full-time with no contract entry at all. So a posting typed Contract is not moved to a different
 * filter, it leaves targeting entirely. Reading the tenure half instead of the hours half dropped
 * 3,676 live postings out of every user's full-time matches with nothing able to recover them,
 * 3,550 of those the German and Austrian `fulltime_fixed_term`, where a befristet contract is
 * ordinary full-time employment rather than gig work.
 *
 * A value that states ONLY tenure still lands on Contract: Freelance, Per Diem, PRN, Casual,
 * Seasonal, Interim, Locum, 1099. Nothing there says how many hours, so there is no hours fact to
 * prefer. That is also why Lever's bare "Fixed Term" is untouched - it is caught by the anchored
 * rule above, which is the right answer precisely because it carries no hours.
 *
 * Part-time sits above Full-time so that "Permanent Part-Time" is not read as
 * permanent-therefore-full-time.
 *
 * STILL FALLS THROUGH TO PASS-THROUGH. A value with no signal at all is returned unchanged, exactly
 * as before, so the audit property the verify:classification gate depends on is unchanged: nothing
 * an employer said is discarded here. 4,391 postings still carry an unrecognised value, and reading
 * that list is the point - it is almost entirely departments ("Sales", "Engineering"), seniority
 * ("Mid Level"), work arrangement ("Remote", "Hybrid", "Homeoffice") and literal "Other", none of
 * which are employment types and none of which this pass should be taught to guess at.
 */

/* Stripped BEFORE the separators are, because these are job titles carrying an instruction to the
   reader, and the bare word "salary" inside them otherwise reads as a full-time signal. Live:
   "Coach & Cocurricular (See Salary Details for information)" and two more, 55 postings. */
const SALARY_DETAIL_NOISE = /see salary details[^)]*/gi;

/* Underscores, slashes, pipes, dashes and brackets all separate a type from its decoration on some
   board, so they are flattened to spaces and the signals below can rely on word boundaries. This
   is what turns Recruitee's `fulltime_fixed_term` into something `fixed ?term` can see. */
function flattenTypeValue(raw: string): string {
  return raw
    .replace(SALARY_DETAIL_NOISE, ' ')
    .replace(/[_/|,\-\u2013\u2014:()[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COMPOUND_TYPES: [RegExp, string][] = [
  [/volunteer|voluntari/i, 'Volunteer'],
  /* "Student" and "Working Student" are the German-board spelling of a working-student placement,
     and stage/stagiair/praktikum/becario/tirocinio are the same fact in five other languages. */
  [/\bintern(ship)?s?\b|\bco ?op\b|praktik|werkstudent|working student|\bstudent\b|stagiair|stagiaire|\bstage\b|becari|pasant|tirocini|est[a\u00e1]gi|scholarship/i, 'Internship'],
  [/apprentice|ausbildung|lehrling|alternan/i, 'Apprenticeship'],
  /* Stated as BOTH ("Full-time or Part-time", 964 postings across its spellings). One flat category
     has to be chosen and Full-time is the one the employer is certainly offering, so the posting
     stays reachable from the Full-time filter rather than vanishing from both. */
  [/(full ?time|\bft\b|\bpt\b|part ?time)[^a-z]{0,4}(or|and|&)?[^a-z]{0,4}(part ?time|\bpt\b|\bft\b|full ?time)/i, 'Full-time'],
  [/part ?time|teilzeit|deeltijd|temps partiel|tiempo parcial|meia jornada|minijob|\bpt\b/i, 'Part-time'],
  /* The tail here is the world's payroll vocabulary for "permanent staff job": CDI (France), CLT and
     Efetivo (Brazil), On-roll (India), En planilla (LatAm), W2 (US), 正社員 (Japan), 정규직 (Korea). */
  [/full ?time|vollzeit|voltijd|temps plein|tiempo completo|jornada completa|tempo integral|tempo pieno|\u6b63\u793e\u54e1|\uc815\uaddc\uc9c1|permanent|\bcdi\b|\bfte?\b|\bclt\b|efetivo|on ?roll|en planilla|\bw2\b|direct hire|salaried|salary|indefinido|dur[e\u00e9]e ind[e\u00e9]termin[e\u00e9]e/i, 'Full-time'],
  /* LAST, so it only answers for a value that never said how many hours.
     NOT "probation" and NOT a bare "contingent": a probationary period and a grant-contingent
     posting are both normally permanent jobs, and reading them as contracts mistyped 30 live
     postings ("PH: Professional Class - Probation", "Contingent on Award"). */
  [/contract|freelance|\btemp\b|temporary|temporaire|tempor[a\u00e1]ri|seasonal|interim|per ?diem|\bprn\b|casual|\b1099\b|fixed ?term|locum|consultant|on ?call|\bagency\b|contingent worker|maternity cover|\bcdd\b|variable hour/i, 'Contract'],
];

/**
 * One product word for a type that arrived in any of a dozen spellings.
 *
 * An unrecognized value is PASSED THROUGH rather than dropped: it came from the employer's own
 * field, so it is a fact about the posting even when this list has not seen it before, and a board
 * that quietly discards employer statements it does not recognize is how a field goes stale
 * without anyone noticing.
 *
 * THE OTHER HALF OF THE RULE. Exported for its own unit tests, but normalizers must call
 * resolveEmploymentType instead: this function trusts the field unconditionally, which is exactly
 * the behaviour that put "ML Research Intern" on the board as Full-time.
 */
export function normalizeEmploymentType(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  for (const [pattern, type] of TYPE_SYNONYMS) {
    if (pattern.test(raw)) return type;
  }
  const flattened = flattenTypeValue(raw);
  for (const [pattern, type] of COMPOUND_TYPES) {
    if (pattern.test(flattened)) return type;
  }
  return raw;
}

/**
 * The one employment type a posting gets, from the two things that can state it.
 *
 * The employer's own structured field normally WINS - it is the employer speaking about their own
 * role, and the title is only an inference. There is exactly one exception, and it is Mehek's call
 * (2026-07-29): A TITLE THAT SAYS INTERNSHIP BEATS THE FIELD.
 *
 * Why that one and nothing else. Employers use the field for two different questions and the board
 * cannot tell which they meant: "is this permanent?" and "is this 40 hours?". Modal's live posting
 * "ML Research Intern" is tagged FullTime, meaning full-time HOURS, and rendering that as a
 * Full-time job on a tile tells a job seeker the opposite of the one fact the title states plainly.
 * The title is unambiguous in a way the field is not - nobody writes "Intern" in a job title for a
 * permanent role - so where they disagree about an internship, the title is the better evidence.
 *
 * NARROW ON PURPOSE. Part-time and Contract in a title do NOT override the field, because there the
 * field is the more reliable of the two: "Contract" in a title is frequently the work rather than
 * the arrangement ("Contract Manager", "Contracts Counsel" - both live), and a title saying
 * part-time while the employer says full-time is a genuine ambiguity with no obvious winner. The
 * asymmetry is the point: this fixes a case where the field is known to answer a different
 * question, not every case where the two sources differ.
 *
 * Also the single entry point for all three boards, which is why Greenhouse routes through it too
 * even though it has no field to pass: one function means the precedence rule cannot end up
 * spelled differently in three normalizers.
 */
/* WHEN THE TITLE SAYS NOTHING AND THE EMPLOYER STATES NOTHING, THE DESCRIPTION IS THE ONLY EVIDENCE.
 *
 * Jane Street posts "Software Engineer" thirteen times. Some are full-time roles, some are the
 * summer internship, and the ONLY thing that tells them apart is the body copy - the internships
 * open "As an intern, you are paired with full-time employees who act as mentors", the full-time
 * reqs open "We're looking for Software Engineers who want to help us design and build...". Same
 * board, same title, same employer, no employment-type field, opposite answers. Measured
 * 2026-08-04: 38 live Jane Street postings are internships that the title rule reads as untyped.
 *
 * SECOND PERSON IS THE DISCRIMINATOR, and it is what makes this safe. A job that IS an internship
 * addresses the person who will be the intern ("as an intern, you...", "during your internship").
 * A job ABOUT the internship programme - a campus recruiter, an early-talent coordinator - talks
 * about interns in the third person ("our interns", "our internship program"). Matching only the
 * applicant-addressed phrasings separates them, and the RECRUITING_TITLES guard below is the
 * belt-and-braces: those roles are full-time and describing them as internships would put a
 * salaried recruiting job in front of a student filtering for one.
 *
 * Hand-verified on every one of the 38 hits, because there was no labelled data to check it
 * against: employers who state a type essentially always ALSO say "intern" in the title, so the
 * title-silent internship is a Greenhouse phenomenon with no ground truth to score against. All 38
 * are unambiguously internships and there were zero false positives.
 */
const INTERNSHIP_DESCRIPTION = new RegExp(
  [
    /* SECOND PERSON IS REQUIRED AFTER "as an intern", and this is the single most load-bearing
       character in the file. The first version matched the bare phrase and put THIRTEEN full-time
       jobs on the board as internships, because the phrase reads identically in a qualifications
       list: Rocket Lab's Security Officer says "Previous or current employment with Rocket Lab as
       an intern, employee or contractor". Requiring ", you" keeps Jane Street's "As an intern, you
       are paired with mentors" and drops every one of those. */
    '\\bas an intern,?\\s+you\\b',
    '\\bas our intern,?\\s+you\\b',
    '\\bduring (?:the|your) internship\\b',
    '\\bin this internship,?\\s+you\\b',
    '\\byour internship,?\\s+you\\b',
    /* "over the COURSE of your internship" and "the BULK of your internship", never "DURATION of".
       N26 publishes one benefits block on every posting it lists, and it ends "...vacation days
       depending on your location of work and duration of your internship" - which put a Social
       Media Customer Service TEAM LEAD in the internship filter. */
    '\\b(?:course|bulk|remainder) of your internship\\b',
    '\\bthe internship (?:is|will|runs|lasts|begins|starts)\\b',
    /* THE PROGRAMME NAMED AS THE THING ON OFFER. This is what catches the finance convention the
       title rule can never see: AQR posts "2027 Research Summer Analyst" and the body says "The
       Internship Program Our 10-week summer program puts real work of the firm in your hands".
       Eight live postings, and the word "intern" appears nowhere in any of their titles. Mozilla's
       "Necko Student Worker" is the same shape ("As part of our internship program, you'll..."). */
    '\\b(?:our|the)\\s+(?:\\d{1,2}[-\\s]?week\\s+)?(?:summer\\s+)?internship\\s+(?:program(?:me)?|experience)\\b',
    '\\b\\d{1,2}[-\\s]?week\\s+internship\\b',
  ].join('|'),
  'i',
);

/**
 * A POSTING THAT POINTS AT THE INTERNSHIP IS NOT THE INTERNSHIP.
 *
 * Astranis runs paired postings for the same role: a post-grad "Flight Software Associate (Fall
 * 2026)" and a "Flight Software Intern (Fall 2026)". The Associate one sends students away - "If
 * you have not already graduated from a four-year university, please apply to our internship
 * program" - and names the internship in exactly the words a real one would. TWELVE live postings,
 * every one a redirect, and every one was on the board as an internship.
 *
 * So a phrase only counts when it is NOT the object of "apply to" or "please see". Checked per
 * match rather than per posting: a description may point at the internship in one sentence and
 * describe its own in another, and only the second should decide.
 */
const INTERNSHIP_POINTER = /\b(?:apply|applying)\s+(?:to|for)\b[^.]{0,60}$|\bplease\s+(?:see|visit|check)\b[^.]{0,60}$/i;

/** Roles that RUN an internship programme rather than being one. All full-time. */
const RECRUITING_TITLES =
  /\brecruit(er|ing|ment)\b|\btalent acquisition\b|\bprograms?\s+(coordinator|manager|lead)\b|\b(coordinator|manager|lead|head)\s*(of|,)?\s*[a-z ]*\bprograms?\b|\bevents? coordinator\b|\bearly (talent|careers?)\b|\bemerging talent\b|\bstudent programs?\b|\bintern(ship)?s?\s+(operations|programs?|programmes?)\b|\bemployer brand\b|\bcampus\b|\buniversity\b/i;

/**
 * The internship a posting describes but never names, or undefined.
 *
 * PASS THE CLEANED TEXT, NOT THE RAW PAYLOAD. Greenhouse returns entity-escaped markup, so the
 * phrases above have to be matched against decoded text or a tag inside the phrase silently drops
 * the posting: "As an intern, you..." matches, "As an <strong>intern</strong>, you..." does not, and
 * neither does an &nbsp; between the words. Every normalizer therefore cleans once and passes the
 * result here, which also stops the same string being decoded twice per posting on every poll.
 *
 * Exported for its own tests; callers want resolveEmploymentType, which knows where in the
 * precedence order this belongs (last, and only when nothing else spoke).
 */
export function employmentTypeFromDescription(
  title: string,
  description?: string,
): string | undefined {
  if (!description || RECRUITING_TITLES.test(title)) return undefined;
  /* Every match is checked, not just the first: an Astranis Associate posting points at the
     internship early and describes its own role later, and a posting that both points AND offers
     should be read as offering. One non-pointer match is enough. */
  for (const match of description.matchAll(new RegExp(INTERNSHIP_DESCRIPTION.source, 'gi'))) {
    const before = description.slice(Math.max(0, match.index - 80), match.index);
    if (!INTERNSHIP_POINTER.test(before)) return 'Internship';
  }
  return undefined;
}

/* "SUMMER ANALYST" AND "SUMMER ASSOCIATE" ARE THE FINANCE AND LAW WORDS FOR INTERN.
 *
 * Not a season plus a job title - a term of art naming the summer intern class, which is why banks
 * and firms use it in place of the word intern entirely. Added because the description rule caught
 * eight of AQR's nine and missed the ninth: "2027 Research and Portfolio Management Engineering
 * Summer Analyst" is the one posting where AQR left the programme paragraph out, so there was no
 * body evidence to find.
 *
 * DELIBERATELY THE WEAKEST SIGNAL IN THE CHAIN, and it does NOT live in TITLE_TYPES. Putting it
 * there gave it the field-override that "Intern" has, and the evidence does not support that: the
 * intern override rests on "nobody writes Intern in a job title for a permanent role", which is a
 * claim about the whole language, while this rests on nine postings from ONE employer. In
 * TITLE_TYPES it read "Seasonal Summer Associate" tagged Contract as an internship, and a
 * "Summer Associate, Retail" tagged Part-time too. Below the employer's field, an employer who
 * states anything at all is believed and only a silent one reaches this.
 *
 * Two vetoes for the cases a bare season cannot separate: a programme-owner title ("Summer Analyst
 * Program Manager") and an explicitly seasonal one, which is a different job with a similar name.
 *
 * NARROW EVIDENCE BASE, stated plainly so it can be revisited: all nine live examples are AQR.
 * Zero counterexamples across 39,868 titles, but one employer is one employer.
 */
const SUMMER_INTERN_TITLE = /\bsummer\s+(analyst|associate)s?\b/i;

function summerInternTitle(title: string): string | undefined {
  if (!SUMMER_INTERN_TITLE.test(title)) return undefined;
  if (RECRUITING_TITLES.test(title) || /\bseasonal\b/i.test(title)) return undefined;
  return 'Internship';
}

export function resolveEmploymentType(
  title: string,
  boardValue?: string,
  description?: string,
): string | undefined {
  /* A TITLE NAMING A TRAINING ROUTE BEATS THE EMPLOYER'S FIELD - now for two categories, not one.
   *
   * The original exception was Internship, because employers use their one field for two different
   * questions ("is this permanent?" and "is this 40 hours?") and Modal's "ML Research Intern" is
   * tagged FullTime meaning the hours. Apprenticeship has exactly the same problem and it is worse,
   * because a trade apprenticeship genuinely IS full-time and multi-year, so the employer answering
   * "FullTime" is not even loosely wrong - it is answering a different question. Crusoe's
   * "Apprentice Electrician" is tagged FullTime; so, in the same shape, are SpaceX's Apprentice Weld
   * Support Technician, Rocket Lab's Apprentice Aerospace Technician and Figure's Apprentice Robot
   * Service Technician. Rendering those as plain Full-time hides the one fact that makes them worth
   * finding, which is that they train someone with no experience in the trade.
   *
   * Both are narrow and for the same reason: the title states a specific fact the field is not
   * contradicting. Part-time and Contract in a title still do NOT override, because there the title
   * is frequently the WORK rather than the arrangement ("Contract Manager", "Contracts Counsel"). */
  const fromTitle = employmentTypeFromTitle(title);
  if (fromTitle === 'Internship' || fromTitle === 'Apprenticeship') return fromTitle;

  const stated = normalizeEmploymentType(boardValue);
  if (stated) return stated;
  /* Description LAST, and only when both the title and the employer said nothing. Deliberately the
     weakest evidence in the chain: it is inference from prose, so it never overrules an employer
     stating their own answer, and it only ever fills a silence. */
  return fromTitle ?? employmentTypeFromDescription(title, description) ?? summerInternTitle(title);
}
