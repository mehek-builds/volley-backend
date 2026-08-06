import type { Page } from 'playwright-core';
import type { ManagedBrowserAction, ManagedBrowserResult } from './browserbase';
import { describeRequiredBlocker, describeUnlabelledBlockers, humanFieldLabel } from './fieldLabel';
import { classifyField, isLegalConsentQuestion, normalizeReviewQuestionLabel } from './questionDiscovery';
import type { Locator } from 'playwright-core';

// Portal field ids legitimately contain CSS-syntax characters (Greenhouse uses UUIDs, others use
// dots and colons), so they are matched with the [id="..."] attribute form rather than #id. Inside
// a quoted attribute value only the quote and the backslash need escaping, which keeps this to one
// rule instead of a full CSS identifier escaper, and means a field id can never terminate the
// selector and match something unintended.
function quoteAttr(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

type PortalFamily =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'workable'
  | 'jazzhr'
  | 'paylocity'
  | 'rippling'
  | 'breezy'
  | 'bamboohr'
  | 'jobvite'
  | 'icims'
  | 'oraclecloud'
  | 'ultipro';
type ControlledPortal =
  | 'controlled_test'
  | 'controlled_lever'
  | 'controlled_ashby'
  | 'controlled_smartrecruiters'
  | 'controlled_workable'
  | 'controlled_jazzhr'
  | 'controlled_paylocity'
  | 'controlled_rippling'
  | 'controlled_breezy'
  | 'controlled_bamboohr';
export type SupportedPortal = PortalFamily | ControlledPortal;

function portalFamily(portal: SupportedPortal): PortalFamily {
  if (portal === 'controlled_test') return 'greenhouse';
  if (portal === 'controlled_lever') return 'lever';
  if (portal === 'controlled_ashby') return 'ashby';
  if (portal === 'controlled_smartrecruiters') return 'smartrecruiters';
  if (portal === 'controlled_workable') return 'workable';
  if (portal === 'controlled_jazzhr') return 'jazzhr';
  if (portal === 'controlled_paylocity') return 'paylocity';
  if (portal === 'controlled_rippling') return 'rippling';
  if (portal === 'controlled_breezy') return 'breezy';
  if (portal === 'controlled_bamboohr') return 'bamboohr';
  return portal;
}

// Portals whose first page is NOT the last page. A run against one of these fills what it can and
// stops; it must never click its way forward, because the control that looks like a submit button
// is a "Next Step"/"Continue" that leads to further pages this adapter has never seen. Letting one
// through would produce a "submitted" state for an application the employer never received, which
// is the single worst failure this module can have - worse than not supporting the portal at all.
// Confirmed live 2026-07-28: Paylocity's #btn-submit is labelled "Next Step".
//
// 'smartrecruiters' joined this set on 2026-07-28. It was always equally multi-step - the scope
// limit is documented at SMARTRECRUITERS_RESUME_SELECTOR - but it relied on the weaker guarantee
// that clickFinalSubmit() finds no submit control on step one, so the click was pushed and landed on
// nothing. That was tolerable while the only consumer was the submission runner.
//
// It stopped being tolerable when the jobs board began deriving "which jobs may we show" from
// portalCanAutoSubmit(). A predicate that answers true for a portal that cannot actually finish
// would surface postings the student can never complete through Litos, which is a worse failure than
// the honest "not supported yet" - she'd spend the effort before finding out. Making the predicate
// truthful is what lets anything else depend on it.
// Declared as TYPES first, not just Sets, so "can this portal finish on its own" is answerable at
// compile time and not only at runtime. That is what lets the jobs board's own union be checked
// against this one by the type checker instead of by a test that someone can forget to run.
type MultiStepFamily = 'paylocity' | 'smartrecruiters';
type CaptchaGatedFamily = 'jazzhr' | 'bamboohr';

const MULTI_STEP_FAMILIES: ReadonlySet<PortalFamily> = new Set<PortalFamily>(
  ['paylocity', 'smartrecruiters'] satisfies MultiStepFamily[],
);

// Portals that gate submission behind a CAPTCHA. Litos fills these and hands off to the human; it
// never attempts the challenge (standing rule, and the same correct stop the Ashby/CTGT run made).
// Confirmed live 2026-07-28: every JazzHR application form carries a g-recaptcha-response field.
// Confirmed live 2026-07-29 for BambooHR on a real PRC-Saltillo posting: g-recaptcha-response is
// present, window.grecaptcha is defined, the badge renders, and recaptcha/api.js?render=explicit is
// loaded. BambooHR's fields are otherwise clean and fully fillable, which is exactly why the ceiling
// has to be written down - the form LOOKS like a one-run submit and is not.
const CAPTCHA_GATED_FAMILIES: ReadonlySet<PortalFamily> = new Set<PortalFamily>(
  ['jazzhr', 'bamboohr'] satisfies CaptchaGatedFamily[],
);

// Portals where there is no application form to fill AT ALL until a human passes a gate that only
// they can pass: a data-consent choice, an account wall, or an emailed one-time code. This is a
// different and stronger limit than the two above, which describe forms Litos fills and then stops
// on. Here the first page carries no application fields whatsoever, so there is nothing to fill and
// no selector worth writing.
//
// All four were read live on 2026-07-29 (see litos-ats-dom-capture-2026-07-29.md in the vault):
//  - jobvite:     /apply renders a page headed "Data Consent" whose ONLY control is a select whose
//                 only real option is "Data Privacy Acknowledgement -- Global". Choosing it IS the
//                 act of acknowledging a privacy notice, which is the student's to make, not ours.
//                 Confirmed identical on two unrelated tenants, so it is the platform, not a
//                 customer's configuration.
//  - icims:       the apply route redirects to /login, which is an email field plus an
//                 h-captcha-response textarea. An account wall and a CAPTCHA, before any field.
//  - oraclecloud: the apply route lands on an "Authentication screen" that emails a one-time code,
//                 alongside a legal "I agree with the terms and conditions" checkbox. Litos cannot
//                 read the code and must not tick the checkbox.
//  - ultipro:     the board bootstraps through an AnonymousSessionCheck iframe and never rendered
//                 its job content to an automated browser at all, so the apply form was never
//                 reached. Nothing was captured, so per the standing rule nothing is guessed.
//
// Being in this set is NOT a claim the platform is unsupportable forever. It is a claim that today
// Litos can recognise the page and explain it, which is worth more to a job seeker than a fill that
// silently does nothing.
type AccountWalledFamily = 'jobvite' | 'icims' | 'oraclecloud' | 'ultipro';

const ACCOUNT_WALLED_FAMILIES: ReadonlySet<PortalFamily> = new Set<PortalFamily>(
  ['jobvite', 'icims', 'oraclecloud', 'ultipro'] satisfies AccountWalledFamily[],
);

export function isAccountWalledFamily(portal: SupportedPortal): boolean {
  return ACCOUNT_WALLED_FAMILIES.has(portalFamily(portal));
}

export function isCaptchaGatedFamily(portal: SupportedPortal): boolean {
  return CAPTCHA_GATED_FAMILIES.has(portalFamily(portal));
}

// Only for the paths that stop WITHOUT a live Page, where the provider cannot be observed. Both
// values are measured, not assumed: JazzHR carries g-recaptcha-response on every application form
// (confirmed 2026-07-28) and BambooHR does too, with window.grecaptcha defined and the badge
// rendering, on a real PRC-Saltillo posting (confirmed 2026-07-29). Anything else returns 'unknown'
// rather than a guess - a wrong provider label is worse than an absent one, because the whole point
// of recording it is to decide which families are worth building around.
export function captchaProviderForFamily(portal: SupportedPortal): CaptchaProvider {
  return isCaptchaGatedFamily(portal) ? 'recaptcha_v2' : 'unknown';
}

export function portalCanAutoSubmit(portal: SupportedPortal): boolean {
  const family = portalFamily(portal);
  return !MULTI_STEP_FAMILIES.has(family)
    && !CAPTCHA_GATED_FAMILIES.has(family)
    && !ACCOUNT_WALLED_FAMILIES.has(family);
}

// The portal families Litos can carry all the way to a confirmation on its own.
//
// Subtracted from PortalFamily rather than hand-listed, so a portal that later turns out to be
// multi-step or CAPTCHA-gated leaves this type the moment it is added to either set above. There is
// no second list to remember to update, which is the only version of this that stays true.
//
// This is what the jobs board is allowed to source from. Surfacing a posting Litos cannot finish is
// worse than not surfacing it at all: the student picks it, tailors a resume to it, and only then
// discovers the last step needs her anyway. Fewer jobs that all work beats more jobs that mostly do.
export type AutonomousPortalFamily = Exclude<
  PortalFamily,
  MultiStepFamily | CaptchaGatedFamily | AccountWalledFamily
>;

export const AUTONOMOUS_PORTAL_FAMILIES = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  // Added 2026-07-29 from live capture. Both are single-step, CAPTCHA-free forms with a real submit
  // button, which is the whole bar for this list. They were the only two of the seven platforms
  // looked at that session that cleared it - the other five each stop on a CAPTCHA, a consent
  // choice, or an account wall.
  'rippling',
  'breezy',
] as const satisfies readonly AutonomousPortalFamily[];

export function isAutonomousPortalFamily(value: string): value is AutonomousPortalFamily {
  return (AUTONOMOUS_PORTAL_FAMILIES as readonly string[]).includes(value);
}

// Why a run stopped short of submitting, in the student's words. Surfaced on the blocker card so
// "needs attention" reads as a known platform limit rather than an unexplained failure.
// The four account-walled platforms stop for four different reasons, and a job seeker who is told
// "this one needs you" deserves to know which one so she knows what she is about to face. One shared
// sentence would have been less code and less use.
const ACCOUNT_WALLED_REASONS: Record<AccountWalledFamily, string> = {
  jobvite:
    'This company asks you to agree to their privacy notice before the application form opens. That choice is yours to make, so Litos stops here. Open the page and pick your country, and the form appears.',
  icims:
    'This company asks you to make an account and prove you are human before the application form opens. Litos cannot do either of those for you, so this one needs your hands.',
  oraclecloud:
    'This company emails you a code and asks you to agree to their terms before the application form opens. Both of those need you, so Litos stops here.',
  ultipro:
    'Litos can find this job but cannot read this company’s application form yet. Everything you need is ready to paste in, so open the page and apply there.',
};

export function portalHandoffReason(portal: SupportedPortal): string | null {
  const family = portalFamily(portal);
  // Checked FIRST. An account-walled portal never reached a form, so telling the student "Litos
  // filled everything in" (which both sentences below do) would be a plain lie about work that
  // never happened, and she would go looking for filled fields that are not there.
  if (ACCOUNT_WALLED_FAMILIES.has(family)) {
    return ACCOUNT_WALLED_REASONS[family as AccountWalledFamily];
  }
  if (CAPTCHA_GATED_FAMILIES.has(family)) {
    return 'This company’s application page asks you to prove you are human. Litos filled everything in, so all that is left is that check and the send button.';
  }
  if (MULTI_STEP_FAMILIES.has(family)) {
    return 'Litos filled in this application and stopped on the last page. That page asks you to confirm the details are true, and it can ask about your background and your right to work, so those answers need to be yours.';
  }
  return null;
}

// What to say when an UNATTENDED run left this application alone.
//
// portalHandoffReason above cannot be reused here, and the reason is the one its own first comment
// gives: both of its sentences promise "Litos filled everything in". On the unattended path nothing
// was filled, because the run stopped before it opened a browser. Telling someone their application
// is filled and waiting on one click, when the form is still blank, sends them to a page that does
// not match what they were told and costs them the trust to believe the next message.
export function unattendedHandoffReason(portal: SupportedPortal): string | null {
  const family = portalFamily(portal);
  if (ACCOUNT_WALLED_FAMILIES.has(family)) {
    return ACCOUNT_WALLED_REASONS[family as AccountWalledFamily];
  }
  if (CAPTCHA_GATED_FAMILIES.has(family)) {
    return 'This company asks you to prove you are human before it will take an application, so Litos cannot send this one while you are away. Open it when you have a minute and Litos will fill it in for you.';
  }
  if (MULTI_STEP_FAMILIES.has(family)) {
    return 'This company asks its questions over several pages, and the last one needs answers only you can give. Litos cannot send this one while you are away. Open it when you have a minute and Litos will fill it in for you.';
  }
  return null;
}

export type SubmissionPacket = {
  fullName: string;
  email: string;
  phone?: string;
  city?: string;
  country?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
  school?: string;
  degree?: string;
  graduationDate?: string;
  graduationMonth?: string;
  graduationYear?: string;
  gpa?: string;
  major?: string;
  referralSourceDefault?: string;
  resume: Buffer;
  resumeName: string;
  coverLetter?: Buffer;
  coverLetterName?: string;
  eeoPrefs?: Record<string, string> | null;
  // The single most recent role from the parsed resume, for portals that ask for work history as
  // structured fields rather than accepting the resume file alone (Paylocity's step one). Only one
  // entry, deliberately: portals render additional rows behind an "Add" button, and creating rows
  // Litos may not be able to complete leaves the form messier than one clean entry the student
  // extends herself. Optional throughout - a profile with no parsed experience simply skips these.
  mostRecentRole?: {
    company: string;
    title: string;
    summary?: string;
    startDate?: string;
    endDate?: string;
  };
  questions: Array<{
    question: string;
    answer: string;
    portalSelector?: string;
    portalInputType?: string;
    atsApiField?: string;
  }>;
};

export type FillResult = {
  filledFields: string[];
  blockers: string[];
};

const KNOWN_DIAL_CODES = [
  '1',
  '7',
  '20',
  '27',
  '30',
  '31',
  '32',
  '33',
  '34',
  '36',
  '39',
  '40',
  '41',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '52',
  '54',
  '55',
  '61',
  '64',
  '65',
  '81',
  '82',
  '86',
  '90',
  '91',
  '92',
  '971',
] as const;

function nationalPhoneForCountryCodeField(phone: string | undefined): string | undefined {
  if (!phone) return phone;
  const trimmed = phone.trim();
  if (!trimmed.startsWith('+')) return phone;
  const digits = trimmed.replace(/\D/g, '');
  const dialCode = KNOWN_DIAL_CODES
    .filter((code) => digits.startsWith(code))
    .sort((a, b) => b.length - a.length)[0];
  if (!dialCode) return phone;
  const national = digits.slice(dialCode.length);
  return national || phone;
}

const DIAL_CODE_COUNTRY_LABELS: Record<string, string> = {
  '1': 'United States',
  '7': 'Russia',
  '20': 'Egypt',
  '27': 'South Africa',
  '30': 'Greece',
  '31': 'Netherlands',
  '32': 'Belgium',
  '33': 'France',
  '34': 'Spain',
  '36': 'Hungary',
  '39': 'Italy',
  '40': 'Romania',
  '41': 'Switzerland',
  '43': 'Austria',
  '44': 'United Kingdom',
  '45': 'Denmark',
  '46': 'Sweden',
  '47': 'Norway',
  '48': 'Poland',
  '49': 'Germany',
  '52': 'Mexico',
  '55': 'Brazil',
  '60': 'Malaysia',
  '61': 'Australia',
  '62': 'Indonesia',
  '63': 'Philippines',
  '65': 'Singapore',
  '81': 'Japan',
  '82': 'South Korea',
  '86': 'China',
  '90': 'Turkey',
  '91': 'India',
  '92': 'Pakistan',
  '971': 'United Arab Emirates',
};

function countryForPhoneField(phone: string | undefined, fallbackCountry: string | undefined): string | undefined {
  if (!phone) return fallbackCountry;
  const digits = phone.trim().startsWith('+') ? phone.replace(/\D/g, '') : '';
  if (!digits) return fallbackCountry;
  const dialCode = Object.keys(DIAL_CODE_COUNTRY_LABELS)
    .filter((code) => digits.startsWith(code))
    .sort((a, b) => b.length - a.length)[0];
  return dialCode ? DIAL_CODE_COUNTRY_LABELS[dialCode] : fallbackCountry;
}

function phoneForPortalField(portal: SupportedPortal, phone: string | undefined): string | undefined {
  const family = portalFamily(portal);
  if (family === 'rippling') {
    return nationalPhoneForCountryCodeField(phone);
  }
  return phone;
}

function greenhouseLocationSearch(packet: SubmissionPacket): string | undefined {
  if (!packet.city) return undefined;
  if (!packet.country) return packet.city;
  const city = packet.city.trim();
  const country = packet.country.trim();
  if (!city || !country || city.toLowerCase().includes(country.toLowerCase())) return city;
  return `${city}, ${country}`;
}

function receiptReference(body: string): string | undefined {
  return body.match(/(?:confirmation|reference)(?:\s*(?:id|number))?\s*[:#]\s*([A-Z0-9-]{5,})/i)?.[1]
    ?? body.match(/application\s*(?:id|number|#)\s*[:#]?\s*([A-Z0-9-]{5,})/i)?.[1];
}

// Bounded auto-wait for every managed action. Playwright defaults to 30s, so a single selector
// that never matches (e.g. a Greenhouse posting proxied through a branded domain whose form does
// not use the classic `job_application[...]` field names) used to burn the full 30s per action and
// take the run's whole time budget with it. Capping the wait degrades a missed selector to a fast
// blocker card instead of a hard timeout. Present fields still fill immediately; this only bites
// when the selector is genuinely wrong. Applied by default to every managedFill/managedUpload and
// to the reviewed-question fills, so no one action can ever spend 30s.
const MANAGED_FILL_TIMEOUT_MS = 10_000;

function managedFill(
  actions: ManagedBrowserAction[],
  selector: string,
  value: string | undefined,
  label: string,
  optional = true,
  timeout = MANAGED_FILL_TIMEOUT_MS,
) {
  if (!value) return;
  actions.push({ type: 'fill', selector, value, label, optional, timeout });
}

function managedFillByLabel(
  actions: ManagedBrowserAction[],
  text: string,
  value: string | undefined,
  label: string,
  optional = true,
  timeout = MANAGED_FILL_TIMEOUT_MS,
) {
  if (!value) return;
  actions.push({ type: 'fillByLabelText', text, value, label, optional, timeout });
}

function durablePortalSelector(selector: string | undefined): string | undefined {
  const trimmed = selector?.trim();
  if (!trimmed || trimmed.length > 500 || trimmed.startsWith('[data-litos-discovered-')) return undefined;
  return trimmed;
}

function managedComboboxFill(
  actions: ManagedBrowserAction[],
  selector: string,
  value: string | undefined,
  label: string,
  optional = true,
  timeout = MANAGED_FILL_TIMEOUT_MS,
) {
  if (!value) return;
  actions.push({ type: 'fill', selector, value, label, optional, timeout });
  actions.push({ type: 'press', selector, value: 'Enter', label: `${label}_select`, optional, timeout });
}

function managedGreenhouseReactSelectFill(
  actions: ManagedBrowserAction[],
  inputId: 'school--0' | 'degree--0' | 'discipline--0',
  value: string | undefined,
  label: string,
  optional = true,
  timeout = MANAGED_FILL_TIMEOUT_MS,
) {
  if (!value) return;
  const selector = `#${inputId}`;
  actions.push({
    type: 'click',
    selector,
    label: `${label}_open`,
    optional,
    timeout,
  });
  actions.push({ type: 'fill', selector, value, label, optional, timeout });
  actions.push({
    type: 'click',
    selector: `#react-select-${inputId}-option-0`,
    label: `${label}_option`,
    optional,
    timeout,
  });
}

function managedGreenhouseScopedReactSelectFill(
  actions: ManagedBrowserAction[],
  inputSelector: string,
  optionSelector: string | undefined,
  value: string | undefined,
  label: string,
  optional = true,
  timeout = MANAGED_FILL_TIMEOUT_MS,
) {
  if (!value) return;
  actions.push({ type: 'fill', selector: inputSelector, value, label, optional, timeout });
  if (optionSelector) {
    actions.push({
      type: 'click',
      selector: optionSelector,
      label: `${label}_option`,
      optional,
      timeout,
    });
  }
  actions.push({ type: 'press', selector: inputSelector, value: 'Enter', label: `${label}_select`, optional, timeout });
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function greenhouseSchoolAliases(school: string | undefined): string[] {
  const trimmed = school?.trim();
  if (!trimmed) return [];
  const uscAlias = /\bUniversity of Southern California\b/i.test(trimmed)
    ? 'University of Southern California'
    : undefined;
  if (uscAlias) return [uscAlias];
  return uniqueDefined([
    trimmed,
  ]);
}

function greenhouseDegreeAliases(degree: string | undefined): string[] {
  const trimmed = degree?.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  let level: string | undefined;
  if (/\bph\.?d\b|doctor of philosophy|doctorate/i.test(lower)) level = 'Doctor of Philosophy (Ph.D.)';
  else if (/\bmaster|m\.?s\.?|m\.?a\.?\b|mba|m\.?b\.?a\.?/i.test(lower)) level = 'Master\'s Degree';
  else if (/\bbachelor|b\.?s\.?|b\.?a\.?\b/i.test(lower)) level = 'Bachelor\'s Degree';
  else if (/\bassociate/i.test(lower)) level = 'Associate\'s Degree';
  else if (/\bhigh school/i.test(lower)) level = 'High School';
  const bachelorScience = level === 'Bachelor\'s Degree' && /\b(?:science|b\.?s\.?)\b/i.test(lower)
    ? 'Bachelor of Science'
    : undefined;
  return uniqueDefined([level, bachelorScience, trimmed]);
}

function greenhouseDisciplineAliases(packet: SubmissionPacket): string[] {
  const major = packet.major?.trim();
  const degree = packet.degree?.trim();
  const inferred = degree?.match(/computer science/i)?.[0] ?? degree?.match(/\bfinance\b/i)?.[0];
  return uniqueDefined([
    major,
    inferred,
    major && /\bcs\b/i.test(major) ? 'Computer Science' : undefined,
  ]);
}

function pushGreenhouseEducationComboboxActions(actions: ManagedBrowserAction[], packet: SubmissionPacket) {
  const schoolAliases = greenhouseSchoolAliases(packet.school);
  for (const [index, value] of schoolAliases.entries()) {
    managedGreenhouseReactSelectFill(actions, 'school--0', value, `education_school_combo:${index}`);
  }
  const degreeAliases = greenhouseDegreeAliases(packet.degree);
  for (const [index, value] of degreeAliases.entries()) {
    managedGreenhouseReactSelectFill(actions, 'degree--0', value, `education_degree_combo:${index}`);
  }
  for (const [index, value] of greenhouseDisciplineAliases(packet).entries()) {
    managedGreenhouseReactSelectFill(actions, 'discipline--0', value, `education_discipline_combo:${index}`);
  }
}

function pushGreenhouseGraduationDateComboboxActions(actions: ManagedBrowserAction[], packet: SubmissionPacket) {
  const values = uniqueDefined([
    packet.graduationDate,
    packet.graduationDate ? greenhouseGraduationBucket(packet.graduationDate) : undefined,
  ]).slice(0, 2);
  const labels = ['Graduation Date', 'Expected Graduation Date'];
  let index = 0;
  for (const label of labels) {
    for (const value of values) {
      for (const selector of greenhouseQuestionComboboxSelectors(label).slice(0, QUESTION_COMBOBOX_SELECTOR_LIMIT)) {
        managedGreenhouseScopedReactSelectFill(
          actions,
          selector,
          GREENHOUSE_VISIBLE_REACT_SELECT_OPTION_SELECTOR,
          value,
          `education_graduation_date_combo:${index}:${label}`,
        );
        index += 1;
      }
    }
  }
}

function managedSelect(
  actions: ManagedBrowserAction[],
  selector: string,
  value: string | undefined,
  label: string,
  optional = true,
  timeout = MANAGED_FILL_TIMEOUT_MS,
) {
  if (!value) return;
  actions.push({ type: 'select', selector, value, label, optional, timeout });
}

// The resume upload is always optional + bounded. On a real ATS form the file input is present and
// setInputFiles returns immediately; on a branded-redirect form that lacks the selector (Jump
// Trading) an unbounded, non-optional upload waited the full 30s on setInputFiles and failed the
// whole run one step after the name/email fills were already made optional. Optional means a missing
// file input degrades to a blocker card; the run never auto-submits, so "resume not attached" is a
// safe thing to hand back to the human rather than a hard error.
function managedUpload(
  actions: ManagedBrowserAction[],
  selector: string,
  label: 'resume' | 'cover_letter',
  file: Buffer | undefined,
  fileName: string | undefined,
) {
  if (!file || !fileName) return;
  actions.push({
    type: 'upload',
    selector,
    label,
    optional: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
    file: { name: fileName, mimeType: 'application/pdf', base64: file.toString('base64') },
  });
}

// Questions that are usually a checkbox, radio group or select on an ATS form, and so cannot be
// typed into. Matching on the QUESTION wording rather than the answer is the informative signal:
// "Yes" tells you nothing about the control, "Have you..." tells you a lot.
//
// Kept and exported because the direct Playwright path can still use it, but note it is NOT a
// sufficient guard on its own: it was written against "Please select all fields of study", and the
// very next run failed on "How did you hear about this job?", which reads like free text and is a
// checkbox group. Question wording cannot reliably predict a control type.
const CHOICE_QUESTION_RE =
  /^\s*(?:do|does|did|have|has|are|is|was|were|will|would|can|could|should|may|must)\s+you\b|select\s+(?:all|one|any|your)\b|please\s+select\b|which\s+of\s+the\s+following\b|\bwhat\s+year\b|\bhow\s+did\s+you\s+hear\b|\byes\s*\/\s*no\b/i;

export function isChoiceQuestion(question: string): boolean {
  return CHOICE_QUESTION_RE.test(question);
}

// Whether reviewed questions may be sent to a given provider's runner.
//
// Both providers now can. This was briefly false for 'managed' as a containment measure: that
// runner used to call fill() on every control, which throws on a checkbox or radio, and it did not
// honour the `optional` flag, so one unfillable question aborted the entire run and discarded the
// name, email, phone and resume already entered.
//
// Fixed at the source in stratus-browser-cloud (PR #6, merged and deployed 2026-07-23): every
// action is wrapped so an optional failure is stepped over, and fillByLabelText dispatches on the
// control it actually found (select -> selectOption, checkbox/radio -> check, otherwise fill), with
// option matching scoped to the question's own container. Guessing control types from question
// wording was tried here first and does not work: "How did you hear about this job?" reads like
// free text and is a checkbox group.
//
// Kept as a function rather than deleted because it is the switch to reach for if a provider
// regresses, and the history above is the reason it exists.
export function canFillReviewedQuestions(_provider: 'managed' | 'direct'): boolean {
  return true;
}

// Ashby's core identity inputs use stable `_systemfield_*` names, but LinkedIn/GitHub/portfolio are
// not among them and, when present, are custom fields whose `name` is an opaque UUID. Matching on a
// case-insensitive substring of name/aria-label/placeholder is what reliably finds them without a
// per-employer selector. Verify against a live Ashby form's rendered HTML if a real run still shows
// the URL fields empty; these were written from the naming pattern, not yet confirmed on the wire.
const ASHBY_LINKEDIN_SELECTOR =
  'input[name="_systemfield_linkedin" i], input[name*="linkedin" i], input[aria-label*="linkedin" i], input[placeholder*="linkedin" i], label:has-text("LinkedIn Profile") + div input';
const ASHBY_GITHUB_SELECTOR =
  'input[name="_systemfield_github" i], input[name*="github" i], input[aria-label*="github" i], input[placeholder*="github" i], label:has-text("GitHub") + div input';
const ASHBY_PORTFOLIO_SELECTOR =
  'input[name*="portfolio" i], input[aria-label*="portfolio" i], input[placeholder*="portfolio" i], label:has-text("Portfolio") + div input, label:has-text("Website") + div input';
// Phone controls vary more than the other identity fields. Ashby and branded Greenhouse forms
// often omit the legacy id/name while still exposing the semantic HTML type or autocomplete value.
// Keep the aria-label and placeholder alternatives exact. A broad `*=phone` match can target a
// prose screening question such as "mobile app experience", which previously caused a phone
// number to be entered into an unrelated text answer.
const SEMANTIC_PHONE_SELECTOR =
  'input[type="tel" i], input[autocomplete*="tel" i], input[aria-label="Phone" i], input[aria-label="Phone number" i], input[placeholder="Phone" i], input[placeholder="Phone number" i]';
const GREENHOUSE_FIRST_NAME_SELECTOR =
  '#first_name, input[name="job_application[first_name]"], input[autocomplete="given-name" i], input[aria-label="First Name" i], input[placeholder="First Name" i]';
const GREENHOUSE_LAST_NAME_SELECTOR =
  '#last_name, input[name="job_application[last_name]"], input[autocomplete="family-name" i], input[aria-label="Last Name" i], input[placeholder="Last Name" i]';
const GREENHOUSE_EMAIL_SELECTOR =
  '#email, input[name="job_application[email]"], input[type="email" i], input[autocomplete="email" i], input[aria-label="Email" i], input[placeholder="Email" i]';
const GREENHOUSE_PHONE_SELECTOR =
  `#phone, input[name="job_application[phone]"], ${SEMANTIC_PHONE_SELECTOR}`;
const GREENHOUSE_RESUME_SELECTOR =
  '#resume, input[type="file"][name="job_application[resume]"], input[type="file"][id*="resume" i], input[type="file"][name*="resume" i], input[type="file"][aria-label*="resume" i], label:has-text("Resume") input[type="file"]';
const ASHBY_PHONE_SELECTOR =
  `#phone, input[name="phone"], input[name="_systemfield_phone"], ${SEMANTIC_PHONE_SELECTOR}`;

// SmartRecruiters renders its "Easy Apply" form as web components (spl-input, spl-phone-field,
// spl-dropzone, ...) behind OPEN shadow roots (confirmed live, 2026-07-24, on a real Western
// Digital posting: jobs.smartrecruiters.com/oneclick-ui/company/...). Playwright's locator engine
// auto-pierces open shadow roots for plain CSS selectors, so a compound selector spanning the
// shadow boundary (e.g. the dropzone selector below) resolves without any special syntax - these
// are real ids/data-test attributes read off that live DOM, not guessed from a naming pattern.
//
// SCOPE LIMIT, on purpose: this only fills the first ("Personal information") step and stops.
// A real posting's "Next" button leads to further steps (custom questions, EEO, ...) that this
// pass does not discover or advance through - the same multi-step complexity this milestone
// explicitly carved Workday out for. clickFinalSubmit() will not find a submit control until a
// human clicks through the remaining steps, so a SmartRecruiters run always lands on
// needs_attention/blocked rather than a false "submitted" - the same safe-degradation behavior
// as every other blocker on this path, never a silent partial success.
const SMARTRECRUITERS_RESUME_SELECTOR = 'spl-dropzone[data-test="resume-upload"] input[type="file"]';
const SMARTRECRUITERS_PHONE_SELECTOR = '[aria-label="Phone number"]';
const SMARTRECRUITERS_FIRST_NAME_SELECTOR = 'spl-input#first-name-input input';
const SMARTRECRUITERS_LAST_NAME_SELECTOR = 'spl-input#last-name-input input';
const SMARTRECRUITERS_EMAIL_SELECTOR = 'spl-input#email-input input';
const SMARTRECRUITERS_CONFIRM_EMAIL_SELECTOR = 'spl-input#confirm-email-input input';
const SMARTRECRUITERS_LINKEDIN_SELECTOR = 'spl-input#linkedin-input input';
const SMARTRECRUITERS_WEBSITE_SELECTOR = 'spl-input#website-input input';
const CONTROLLED_SMARTRECRUITERS_FIRST_NAME_SELECTOR = '[id="first-name-input"]';
const CONTROLLED_SMARTRECRUITERS_LAST_NAME_SELECTOR = '[id="last-name-input"]';
const CONTROLLED_SMARTRECRUITERS_EMAIL_SELECTOR = '[id="email-input"]';
const CONTROLLED_SMARTRECRUITERS_CONFIRM_EMAIL_SELECTOR = '[id="confirm-email-input"]';
const CONTROLLED_SMARTRECRUITERS_LINKEDIN_SELECTOR = '[id="linkedin-input"]';
const CONTROLLED_SMARTRECRUITERS_WEBSITE_SELECTOR = '[id="website-input"]';
const ASHBY_RESUME_SELECTOR = 'input#_systemfield_resume[type="file"], input[type="file"][name="_systemfield_resume"], input[type="file"][name*="resume" i]';
const ASHBY_COVER_LETTER_SELECTOR = 'input#cover_letter[type="file"], input[type="file"][id*="cover" i], input[type="file"][name*="cover" i], input[type="file"][aria-label*="cover" i]';

function cssString(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function greenhouseQuestionSelectSelectors(label: string): string[] {
  const text = cssString(label);
  return [
    `.field:has(label:has-text("${text}")) select`,
    `div:has(> label:has-text("${text}")) select`,
    `fieldset:has(legend:has-text("${text}")) select`,
    `label:has-text("${text}") ~ select`,
    `label:has-text("${text}") + select`,
  ];
}

function greenhouseQuestionComboboxSelectors(label: string): string[] {
  const text = cssString(label);
  return [
    `.select__container:has(> label:has-text("${text}")) input[role="combobox"]`,
    `.field-wrapper:has(label:has-text("${text}")) input[role="combobox"]`,
    `div:has(> label:has-text("${text}")) input[role="combobox"]`,
  ];
}

const GREENHOUSE_VISIBLE_REACT_SELECT_OPTION_SELECTOR = '[id^="react-select-"][id$="-option-0"]:visible';

const GREENHOUSE_ALIAS_SELECT_SELECTOR_LIMIT = 1;
const QUESTION_SELECT_SELECTOR_LIMIT = 1;
const QUESTION_COMBOBOX_SELECTOR_LIMIT = 1;
const ASHBY_QUESTION_TEXT_SELECTOR_LIMIT = 9;
const MANAGED_ACTION_LIMIT = 120;
const CONFIRM_AFTER_FILL_FIELDS = new Set(['school', 'degree']);

function pushGreenhouseManagedPreflightActions(actions: ManagedBrowserAction[]) {
  const cookieClicks = [
    '#onetrust-accept-btn-handler',
    '.onetrust-close-btn-handler',
    'button:has-text("Allow All")',
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept Cookies")',
    'button:has-text("Confirm My Choices")',
  ];
  for (const [index, selector] of cookieClicks.entries()) {
    actions.push({
      type: 'click',
      selector,
      label: `greenhouse_cookie_preflight:${index}`,
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
  }
  actions.push({
    type: 'click',
    selector: [
      'a:has-text("Apply Now")',
      'button:has-text("Apply Now")',
      'a:has-text("Apply for this job")',
      'button:has-text("Apply for this job")',
      'a:has-text("Apply for this role")',
      'button:has-text("Apply for this role")',
      'a:has-text("Start application")',
      'button:has-text("Start application")',
    ].join(', '),
    label: 'greenhouse_open_application_form',
    optional: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
  });
  actions.push({
    type: 'waitForSelector',
    selector: `${GREENHOUSE_EMAIL_SELECTOR}, ${GREENHOUSE_RESUME_SELECTOR}`,
    label: 'greenhouse_application_form_ready',
    optional: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
  });
}

function questionSelectSelectors(label: string): string[] {
  const text = cssString(label);
  return [
    `label:has-text("${text}") ~ select`,
    `label:has-text("${text}") + select`,
    `fieldset:has(legend:has-text("${text}")) select`,
    `div:has(> label:has-text("${text}")) select`,
    `[role="group"]:has-text("${text}") select`,
  ];
}

function questionTextInputSelectors(label: string): string[] {
  const text = cssString(label);
  const xpathText = xpathLiteral(label);
  return [
    `label:has-text("${text}") ~ textarea`,
    `label:has-text("${text}") + textarea`,
    `label:has-text("${text}") ~ div textarea`,
    `label:has-text("${text}") + div textarea`,
    `div:has(> label:has-text("${text}")) textarea`,
    `div:has(> label:has-text("${text}")) input[type="text"]`,
    `fieldset:has(legend:has-text("${text}")) textarea`,
    `xpath=(//label[contains(normalize-space(.), ${xpathText})]/parent::*[not(self::form) and .//textarea]//textarea)[1]`,
    `xpath=(//label[contains(normalize-space(.), ${xpathText})]/parent::*/parent::*[not(self::form) and .//textarea]//textarea)[1]`,
    `xpath=(//label[contains(normalize-space(.), ${xpathText})]/parent::*/parent::*/parent::*[not(self::form) and .//textarea]//textarea)[1]`,
  ];
}

function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value.split("'").map((part) => `'${part}'`).join(`, "'", `)})`;
}

function ashbyQuestionTextVariants(label: string): string[] {
  const normalized = label.replace(/\s+/g, ' ').trim();
  const variants = [normalized];
  const prompt = normalized.match(/^(.{12,120}?[?!])(?:\s|$)/)?.[1]?.trim();
  const prefix = normalized.length > 120 ? normalized.slice(0, 120).replace(/\s+\S*$/, '').trim() : undefined;
  if (prompt || prefix) variants.push(prompt ?? prefix!);
  return [...new Set(variants.filter(Boolean))];
}

function ashbyQuestionTextInputSelectors(label: string): string[] {
  const selectorGroups = ashbyQuestionTextVariants(label).map(questionTextInputSelectors);
  const selectors: string[] = [];
  if (selectorGroups.length > 1) {
    const variantPriority: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0, 7],
      [1, 7],
      [1, 8],
      [1, 9],
      [1, 4],
    ];
    for (const [groupIndex, selectorIndex] of variantPriority) {
      const selector = selectorGroups[groupIndex]?.[selectorIndex];
      if (selector && !selectors.includes(selector)) selectors.push(selector);
      if (selectors.length >= ASHBY_QUESTION_TEXT_SELECTOR_LIMIT) break;
    }
    return selectors;
  }
  const priority = [0, 1, 7, 4, 8, 9, 2, 3, 5, 6];
  for (const index of priority) {
    if (selectors.length >= ASHBY_QUESTION_TEXT_SELECTOR_LIMIT) break;
    let pushed = false;
    for (const group of selectorGroups) {
      const selector = group[index];
      if (!selector || selectors.includes(selector)) continue;
      selectors.push(selector);
      pushed = true;
      if (selectors.length >= ASHBY_QUESTION_TEXT_SELECTOR_LIMIT) break;
    }
    if (!pushed) break;
  }
  return selectors;
}

function selectValuesForAnswer(answer: string): string[] {
  const trimmed = answer.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  if (lower === 'yes') return ['Yes', 'yes', '1', 'true'];
  if (lower === 'no') return ['No', 'no', '0', 'false'];
  const values = [trimmed];
  if (/^company website$/i.test(trimmed)) {
    values.push('Company Website', 'Company website', 'Careers page', 'Career site', 'Other');
  }
  if (/\b(?:have\s+not|haven't|never)\s+(?:worked|been employed)\b/.test(lower)) {
    values.push('No', 'No, I have not', 'I have not worked there before');
  }
  if (/\bnone\s+of\s+the\s+above\b/.test(lower)) {
    values.push('None of the above', 'None');
  }
  if (/^(?:n\/?a|not applicable)$/i.test(trimmed)) {
    values.push('N/A', 'Not applicable');
  }
  return [...new Set(values)];
}

function parsedGpa(value: string): number | null {
  const match = value.match(/\b([0-4](?:\.\d+)?)\b/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function greenhouseGpaBucket(value: string): string | undefined {
  const gpa = parsedGpa(value);
  if (gpa === null) return undefined;
  if (gpa >= 3.6) return '3.6 or above (out of 4.0)';
  if (gpa >= 3.4) return '3.4 - 3.5 (out of 4.0)';
  if (gpa >= 3.1) return '3.1 - 3.3 (out of 4.0)';
  if (gpa >= 2.8) return '2.8 - 3.0 (out of 4.0)';
  if (gpa >= 2.5) return '2.5 - 2.7 (out of 4.0)';
  return '2.4 or below';
}

function greenhouseGraduationBucket(value: string): string | undefined {
  const year = Number(value.match(/\b(20\d{2})\b/)?.[1]);
  if (!Number.isFinite(year)) return undefined;
  if (year < 2027) return 'Earlier than Fall 2027';
  if (year === 2027) {
    if (/\b(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|spring|summer)\b/i.test(value)) {
      return 'Earlier than Fall 2027';
    }
    return 'Fall 2027';
  }
  if (year === 2028 && /\b(?:jan|january|feb|february|mar|march|apr|april|may|spring)\b/i.test(value)) {
    return 'Spring 2028';
  }
  return 'Later than Summer 2028';
}

function abbreviatedUsLocation(value: string): string | undefined {
  const stateMap: Record<string, string> = { california: 'CA', washington: 'WA' };
  const match = value.match(/^\s*([^,]+),\s*([^,]+?)(?:,\s*(?:United States|USA|US|U\.S\.))?\s*$/i);
  if (!match) return undefined;
  const city = match[1]?.trim();
  const state = match[2]?.trim();
  if (!city || !state) return undefined;
  const abbreviation = /^[A-Z]{2}$/i.test(state) ? state.toUpperCase() : stateMap[state.toLowerCase()];
  return abbreviation ? `${city}, ${abbreviation}` : undefined;
}

function cityOnlyLocation(value: string): string | undefined {
  const match = value.match(/^\s*([^,]+),\s*[^,]+(?:,\s*(?:United States|USA|US|U\.S\.))?\s*$/i);
  return match?.[1]?.trim() || undefined;
}

function greenhouseComboboxValuesForQuestion(question: string, answer: string): string[] {
  const normalizedQuestion = question.toLowerCase();
  const normalizedAnswer = answer.trim().toLowerCase();
  const values = selectValuesForAnswer(answer);
  if (/\bwhat\s+is\s+your\s+gpa\b|\bgpa\b|academic\s+performance|grade\s+average|grade\s+point/.test(normalizedQuestion)) {
    values.unshift(greenhouseGpaBucket(answer) ?? '');
  }
  if (/\bgraduat(?:ion|e)\s+(?:date|semester|term|time\s*frame|timeframe|window)\b|\bwhat\s+is\s+your\s+graduation\s+date\b|\bexpected\s+graduat(?:ion|e)/.test(normalizedQuestion)) {
    values.unshift(greenhouseGraduationBucket(answer) ?? '');
  }
  if (/\bdegree\b/.test(normalizedQuestion) && /\bbachelor/i.test(answer)) {
    values.unshift('Bachelor\'s Degree');
  }
  if (/\b(?:discipline|field\s+of\s+study|major|course)\b/.test(normalizedQuestion) && /computer science/i.test(answer)) {
    values.unshift('Computer Science');
  }
  if (/\b(?:current\s+year|year\s+of\s+(?:your\s+)?stud(?:y|ies)|academic\s+year)\b/.test(normalizedQuestion)) {
    values.unshift(answer.replace(/\s+year$/i, ''), answer);
  }
  if (/\b(?:how\s+did\s+you\s+hear|referral\s+source|hear\s+about|source)\b/.test(normalizedQuestion)) {
    values.push('Company Website', 'Company website', 'Careers page', 'Career site', 'Other');
  }
  if (/\b(?:country|currently\s+residing|current\s+location|where\s+are\s+you\s+currently\s+(?:located|living|based))\b/.test(normalizedQuestion)) {
    values.unshift(answer, cityOnlyLocation(answer) ?? '');
  }
  if (/\b(?:single|top|preferred|preference|most interested)\b[^?]{0,120}\blocation\b|\blocation\b[^?]{0,120}\b(?:single|top|preferred|preference|most interested)\b/.test(normalizedQuestion)) {
    values.unshift(abbreviatedUsLocation(answer) ?? '', cityOnlyLocation(answer) ?? '');
  }
  if (/\bpreviously\s+worked\b|\bworked\s+for\s+databricks\b/.test(normalizedQuestion)
    && /\b(?:have\s+not|haven't|never)\s+(?:worked|been employed)\b/.test(answer.toLowerCase())) {
    values.unshift('No');
  }
  if (/legally\s+authorized\s+to\s+work|authori[sz](?:ed|ation)\s+to\s+work|work\s+authori[sz]/.test(normalizedQuestion)) {
    const negative = /^(?:no|false|0)\b/.test(normalizedAnswer) || /\bnot\s+authori[sz]ed\b/.test(normalizedAnswer);
    const affirmative = /^(?:yes|true|1)\b/.test(normalizedAnswer) || (!negative && /\bauthori[sz]ed\b/.test(normalizedAnswer));
    if (negative) {
      values.unshift('No');
    } else if (affirmative) {
      values.unshift('Yes');
      values.push(
        'Yes, I am authorized to work in the country where this job is located',
        'Yes, I am authorized to work in the country where the job is located',
        'Yes, I am authorized to work in the United States',
      );
    }
  }
  return uniqueDefined(values);
}

function isGreenhouseReactSelectQuestion(question: string): boolean {
  return /\b(?:single|top|preferred|preference|most interested)\b[^?]{0,120}\blocation\b|\bwhat\s+is\s+your\s+graduation\s+date\b|\bgraduat(?:ion|e)\s+(?:date|semester|term|time\s*frame|timeframe|window)\b|\bexpected\s+graduat(?:ion|e)\b|\bwhat\s+is\s+your\s+gpa\b|\bacademic\s+performance\b|\bdegree\b(?!\s+program)|\bdiscipline\b|\bfield\s+of\s+study\b|\bmajor\b|\bcourse\b|\bschool\b|\buniversity\b|\bcurrent\s+year\b|\byear\s+of\s+(?:your\s+)?stud(?:y|ies)\b|\bacademic\s+year\b|\bhow\s+did\s+you\s+hear\b|\breferral\s+source\b|\bhear\s+about\b|\bsource\b|\bsource\s+of\b|\bcountry\b|\bcurrent\s+location\b|\bwhere\s+are\s+you\s+currently\s+(?:located|living|based)\b|\bpreviously\s+worked\b|\bworked\s+for\s+databricks\b|legally\s+authorized\s+to\s+work|(?:require|need)\s+sponsorship|sponsorship\s+for\s+(?:employment\s+visa|work\s+authorization)|\bteam\s+opening\b|\bopening\b[^?]{0,80}\binterested\b|\bLGBTQIA?\+?\b|sexual\s+orientation|\bgender(?:\s+identity)?\b|\bveteran\b|\bmilitary\b|\brace\b|\bethnicit|\bcategory\b/i.test(question);
}

function isGreenhouseEducationComboboxQuestion(question: string): boolean {
  return /\b(?:school|degree|discipline)--\d+\b/i.test(question);
}

function pushGreenhouseQuestionComboboxActions(
  actions: ManagedBrowserAction[],
  selector: string,
  questionText: string,
  answer: string,
  labelPrefix: string,
) {
  if (!isGreenhouseReactSelectQuestion(questionText)) return;
  for (const [index, value] of greenhouseComboboxValuesForQuestion(questionText, answer).slice(0, 1).entries()) {
    managedGreenhouseScopedReactSelectFill(
      actions,
      selector,
      GREENHOUSE_VISIBLE_REACT_SELECT_OPTION_SELECTOR,
      value,
      `${labelPrefix}_combo:${index}:${questionText.slice(0, 80)}`,
    );
  }
}

function pushGreenhouseQuestionComboboxLabelActions(
  actions: ManagedBrowserAction[],
  questionText: string,
  answer: string,
  labelPrefix: string,
) {
  if (!isGreenhouseReactSelectQuestion(questionText)) return;
  let index = 0;
  const values = greenhouseComboboxValuesForQuestion(questionText, answer).slice(0, 1);
  for (const selector of greenhouseQuestionComboboxSelectors(questionText).slice(0, QUESTION_COMBOBOX_SELECTOR_LIMIT)) {
    for (const value of values) {
      managedGreenhouseScopedReactSelectFill(
        actions,
        selector,
        GREENHOUSE_VISIBLE_REACT_SELECT_OPTION_SELECTOR,
        value,
        `${labelPrefix}_combo_label:${index}:${questionText.slice(0, 80)}`,
      );
      index += 1;
    }
  }
}

function pushGreenhouseDemographicComboboxLabelActions(
  actions: ManagedBrowserAction[],
  label: string,
  value: string,
) {
  for (const [index, selector] of greenhouseQuestionComboboxSelectors(label).slice(0, QUESTION_COMBOBOX_SELECTOR_LIMIT).entries()) {
    managedGreenhouseScopedReactSelectFill(
      actions,
      selector,
      GREENHOUSE_VISIBLE_REACT_SELECT_OPTION_SELECTOR,
      value,
      `greenhouse_demographic_combo:${index}:${label.slice(0, 80)}`,
    );
  }
}

function pushGreenhouseReferralSourceAliases(actions: ManagedBrowserAction[], packet: SubmissionPacket) {
  const value = packet.referralSourceDefault?.trim();
  if (!value) return;
  const aliases = [
    'How did you hear about this job?',
    'How did you hear about this job',
    'How did you hear about us?',
    'How did you hear about us',
    'How did you hear about Faire?',
    'How did you hear about Faire',
    'Referral source',
  ];
  for (const alias of aliases) {
    pushGreenhouseQuestionComboboxLabelActions(actions, alias, value, 'greenhouse_referral');
  }
}

function greenhouseCheckboxOptionSelectors(questionText: string, answer: string): string[] {
  const normalizedQuestion = questionText.toLowerCase();
  const normalizedAnswer = answer.toLowerCase();
  if (
    /sanctions\s+and\s+export\s+controls|cuba,\s*iran,\s*north\s+korea/.test(normalizedQuestion)
    && /none\s+of\s+the\s+above/.test(normalizedAnswer)
  ) {
    return [
      'input[name="question_35110536002[]"][value="221056618002"]',
    ];
  }
  if (
    /prior\s+question\s+other\s+than\s+[“"]?none\s+of\s+the\s+above|if\s+you\s+selected\s+a\s+response\s+to\s+the\s+prior\s+question/.test(normalizedQuestion)
    && /not\s+applicable|none\s+of\s+the\s+above/.test(normalizedAnswer)
  ) {
    return [
      'input[name="question_35114221002[]"][value="221073825002"]',
    ];
  }
  return [];
}

function pushGreenhouseCheckboxOptionActions(
  actions: ManagedBrowserAction[],
  questionText: string,
  answer: string,
  labelPrefix: string,
) {
  for (const [index, selector] of greenhouseCheckboxOptionSelectors(questionText, answer).entries()) {
    actions.push({
      type: 'click',
      selector,
      label: `${labelPrefix}_checkbox:${index}:${questionText.slice(0, 80)}`,
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
  }
}

function questionFillShouldPressEnter(questionText: string): boolean {
  const key = classifyField(questionText);
  return key ? CONFIRM_AFTER_FILL_FIELDS.has(key) : false;
}

function pushScopedQuestionChoiceActions(
  actions: ManagedBrowserAction[],
  questionText: string,
  answer: string,
  labelPrefix: string,
  options: { includeSelectFallbacks?: boolean } = {},
) {
  actions.push({
    type: 'fillByLabelText',
    text: questionText,
    value: answer,
    label: `${labelPrefix}:${questionText.slice(0, 80)}`,
    optional: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
  });
  if (options.includeSelectFallbacks === false) return;
  let index = 0;
  const values = selectValuesForAnswer(answer);
  for (const selector of questionSelectSelectors(questionText)) {
    if (index >= QUESTION_SELECT_SELECTOR_LIMIT * values.length) break;
    for (const value of values) {
      managedSelect(actions, selector, value, `${labelPrefix}_select:${index}:${questionText.slice(0, 80)}`);
      index += 1;
    }
  }
}

function pushAshbyQuestionTextFallbackActions(
  actions: ManagedBrowserAction[],
  questionText: string,
  answer: string,
  labelPrefix: string,
) {
  for (const [index, selector] of ashbyQuestionTextInputSelectors(questionText).entries()) {
    managedFill(actions, selector, answer, `${labelPrefix}_text:${index}:${questionText.slice(0, 80)}`);
  }
}

function greenhouseKnownQuestionAliases(question: string, answer: string): string[] {
  const normalizedQuestion = question.toLowerCase();
  const normalizedAnswer = answer.trim().toLowerCase();
  if (!['yes', 'no'].includes(normalizedAnswer)) return [];
  if (
    /\b(?:eligible|authorized|authorised|legally\s+work|work\s+authorization|work\s+authorisation)\b/.test(normalizedQuestion)
    && (/\b(?:u\.?s\.?a?|united\s+states)\b/.test(normalizedQuestion) || /\bcountry\s+where\s+the\s+job\s+is\s+located\b/.test(normalizedQuestion))
    && !/\bwithout\s+sponsorship\b/.test(normalizedQuestion)
  ) {
    return [
      'Are you currently eligible to legally work in the United States?',
      'Are you currently eligible to legally work in the U.S.?',
      'Are you legally authorized to work in the United States?',
      'Are you authorized to work in the United States?',
      'Are you legally authorized to work in the country where the job is located?',
    ];
  }
  if (
    /\b(?:future|now)\b/.test(normalizedQuestion)
    && /\b(?:immigration|visa|sponsorship|sponsor)\b/.test(normalizedQuestion)
    && !/\bwithout\s+sponsorship\b/.test(normalizedQuestion)
  ) {
    return [
      'Will you now or in the future require immigration support or sponsorship?',
      'Will you now or in the future require immigration support or sponsorship from Postman?',
      'Will you now or in the future require sponsorship for employment visa status?',
      'Do you now or in the future require visa sponsorship?',
    ];
  }
  if (
    /\b(?:onsite|on[\s-]?site|in[\s-]?office|office|hybrid)\b/.test(normalizedQuestion)
    && /\b(?:three|four|five|3|4|5)\s+days?\b/.test(normalizedQuestion)
  ) {
    const requiredDay = normalizedQuestion.match(/\brequires?\s+(?:\w+\s+){0,4}(three|four|five|3|4|5)\s+days?\b/)?.[1];
    const firstDay = normalizedQuestion.match(/\b(three|four|five|3|4|5)\s+days?\b/)?.[1];
    const day = requiredDay ?? firstDay;
    const aliases: string[] = [];
    if (day === 'three' || day === '3') {
      aliases.push(
        'Are you able to work onsite three days a week?',
        'Are you able to work on-site three days a week?',
        'Are you able to work onsite in our San Francisco office 3 days a week?',
        'Are you able to work onsite in our San Francisco office three days a week?',
      );
    }
    if (day === 'four' || day === '4') {
      aliases.push(
        'Are you able to work onsite four days a week?',
        'Are you able to work on-site four days a week?',
        'Are you able to work onsite in our San Francisco office 4 days a week?',
        'Are you able to work onsite in our San Francisco office four days a week?',
      );
    }
    if (day === 'five' || day === '5') {
      aliases.push(
        'Are you able to work onsite five days a week?',
        'Are you able to work on-site five days a week?',
        'Are you able to work onsite in our San Francisco office 5 days a week?',
        'Are you able to work onsite in our San Francisco office five days a week?',
      );
    }
    return aliases;
  }
  return [];
}

function pushGreenhouseKnownQuestionAliases(actions: ManagedBrowserAction[], packet: SubmissionPacket) {
  const seen = new Set<string>();
  for (const item of packet.questions) {
    for (const alias of greenhouseKnownQuestionAliases(item.question, item.answer)) {
      const key = `${alias}\n${item.answer.trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      actions.push({
        type: 'fillByLabelText',
        text: alias,
        value: item.answer.trim(),
        label: `greenhouse_known_question:${alias.slice(0, 80)}`,
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      });
    }
  }
}

const GREENHOUSE_DEMOGRAPHIC_ALIASES: Array<{ key: string; aliases: string[] }> = [
  {
    key: 'gender',
    aliases: [
      'What gender identity do you most closely identify with?',
    ],
  },
  {
    key: 'transgender_status',
    aliases: [
      'Are you a person of transgender experience?',
    ],
  },
  {
    key: 'sexual_orientation',
    aliases: [
      'What sexual orientation do you most closely identify with?',
    ],
  },
  {
    key: 'disability_status',
    aliases: [
      'Do you live with a disability (as outlined by the ADA)?',
    ],
  },
  {
    key: 'veteran_status',
    aliases: [
      'Are you a veteran/have you served in the military?',
    ],
  },
  {
    key: 'race',
    aliases: [
      'Please select up to 2 ethnicities that you most closely identify with.',
    ],
  },
];

function packetHasGreenhouseReviewedDemographicAnswer(packet: SubmissionPacket, key: string): boolean {
  const patterns: Record<string, RegExp> = {
    gender: /\bgender(?:\s+identity)?\b/i,
    transgender_status: /transgender/i,
    sexual_orientation: /sexual\s+orientation/i,
    disability_status: /\bdisab/i,
    veteran_status: /\bveteran\b|\bmilitary\b/i,
    race: /\brace\b|\bethnicit|which\s+categor(?:y|ies)\b[^?]{0,120}(?:describe|identify)|hispanic|latino/i,
  };
  const pattern = patterns[key];
  if (!pattern) return false;
  return packet.questions.some((item) => item.answer.trim() && pattern.test(normalizeReviewQuestionLabel(item.question)));
}

function pushGreenhouseDemographicAliases(actions: ManagedBrowserAction[], packet: SubmissionPacket) {
  const prefs = packet.eeoPrefs;
  if (!prefs) return;
  for (const item of GREENHOUSE_DEMOGRAPHIC_ALIASES) {
    const value = prefs[item.key]?.trim();
    if (!value) continue;
    if (packetHasGreenhouseReviewedDemographicAnswer(packet, item.key)) continue;
    for (const alias of item.aliases) {
      actions.push({
        type: 'fillByLabelText',
        text: alias,
        value,
        label: `greenhouse_demographic:${alias.slice(0, 80)}`,
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      });
      for (const [index, selectSelector] of greenhouseQuestionSelectSelectors(alias).slice(0, GREENHOUSE_ALIAS_SELECT_SELECTOR_LIMIT).entries()) {
        managedSelect(actions, selectSelector, value, `greenhouse_demographic_select:${index}:${alias.slice(0, 80)}`);
      }
      pushGreenhouseDemographicComboboxLabelActions(actions, alias, value);
    }
  }
}

function managedActionLabelBase(action: ManagedBrowserAction): string | undefined {
  return action.label?.replace(/_(?:open|option|select)$/, '');
}

const GREENHOUSE_LOW_PRIORITY_ACTION_GROUPS = [
  /^greenhouse_demographic/,
  /^education_discipline_combo:/,
  /^education_graduation_date_combo:/,
  /^(?:graduation_date|graduation_date_label|graduation_date_expected|education_end_month|education_end_year|education_graduation_month|education_graduation_year|gpa_question)$/,
  /^first_name_label$/,
  /^education_degree_combo:2$/,
  /^education_degree_combo:1$/,
] as const;

function trimGreenhouseManagedActionsToBudget(actions: ManagedBrowserAction[], limit: number) {
  for (const pattern of GREENHOUSE_LOW_PRIORITY_ACTION_GROUPS) {
    while (actions.length > limit) {
      let removableBase: string | undefined;
      for (let index = actions.length - 1; index >= 0; index -= 1) {
        const base = managedActionLabelBase(actions[index]!);
        if (!base || !pattern.test(base)) continue;
        removableBase = base;
        break;
      }
      if (!removableBase) break;
      const before = actions.length;
      for (let index = actions.length - 1; index >= 0; index -= 1) {
        if (managedActionLabelBase(actions[index]!) === removableBase) actions.splice(index, 1);
      }
      if (actions.length === before) break;
    }
    if (actions.length <= limit) return;
  }
}

function truncateManagedActionsToBudget(actions: ManagedBrowserAction[], limit: number) {
  while (actions.length > limit) {
    const base = managedActionLabelBase(actions.at(-1)!);
    if (!base) {
      actions.pop();
      continue;
    }
    for (let index = actions.length - 1; index >= 0; index -= 1) {
      if (managedActionLabelBase(actions[index]!) !== base) break;
      actions.pop();
    }
  }
}

// ─── Workable (apply.workable.com) ────────────────────────────────────────────
// Read off a live Suade posting, 2026-07-28 (apply.workable.com/suade/j/9C43981D17/apply). Plain
// HTML, single step, stable `name` attributes - the simplest of the three added that day.
//
// THE ONE TRAP, and it is a real one: the resume input's id is randomised per render
// (`input_files_input_Zos7eYaJDFVTg6xg`), so it can never be matched by id. Worse, the form ships a
// SECOND file input, `data-ui="avatar"`, for a profile photo - so a bare `input[type="file"]` picks
// whichever comes first and can file the resume as the candidate's headshot. `data-ui="resume"` is
// the stable, correct hook. Same two-file-input hazard the extension's adapters/ashby.ts documents.
const WORKABLE_RESUME_SELECTOR = 'input[type="file"][data-ui="resume"]';
const WORKABLE_COVER_LETTER_SELECTOR =
  'input[type="file"][data-ui="cover_letter"], input[type="file"][data-ui*="cover" i]';

// ─── JazzHR (*.applytojob.com) ────────────────────────────────────────────────
// Read off a live TicketManager posting, 2026-07-28. The cleanest naming of any ATS Litos supports:
// every field is `resumator-<field>-value` on BOTH id and name, so no fallback chain is needed.
//
// Note JazzHR's submit control is `input[type="button"][name="submit_resume"]` - type BUTTON, not
// submit. The generic `button[type="submit"], input[type="submit"]` selector used for every other
// portal would never find it. Moot in practice (see CAPTCHA_GATED_FAMILIES - JazzHR never
// auto-submits) but recorded here so nobody "fixes" the omission later by wiring up the wrong one.
const JAZZHR_RESUME_SELECTOR = 'input[type="file"][name="resumator-resume-value"]';
// NOTE: JazzHR takes a cover letter as `textarea[name="resumator-coverletter-value"]` - TEXT, not a
// file. SubmissionPacket carries the cover letter only as a rendered PDF Buffer, so there is nothing
// to type into it, and no selector is declared here on purpose: a declared-but-unused constant read
// as though the field were handled. Today an approved cover letter is simply not sent to JazzHR.
// Fixing it means threading the letter's text (not just its PDF) through the packet; until then this
// is a known, deliberate gap rather than a silent one.

// ─── Paylocity (recruiting.paylocity.com) ─────────────────────────────────────
// Read off a live posting, 2026-07-28 (2000recruiting.paylocity.com/Recruiting/Jobs/Apply/44457).
// Two structural quirks:
//  1. Fields carry NO `name` attribute at all, and their ids contain dots (`info.firstName`), which
//     is invalid in a `#id` selector. They must use the [id="..."] attribute form - exactly what
//     quoteAttr() at the top of this file already exists for, so no new escaping is needed.
//  2. THREE file inputs (#btn-resume, #btn-coverLetter, #btn-additionalFiles), so a bare file
//     selector is wrong here too, for the same reason as Workable.
// Paylocity is multi-step (see MULTI_STEP_FAMILIES); these fills cover page one only.
const paylocityId = (id: string) => `[id="${quoteAttr(id)}"]`;
const PAYLOCITY_RESUME_SELECTOR = '#btn-resume';
const PAYLOCITY_COVER_LETTER_SELECTOR = '#btn-coverLetter';

// ─── Paylocity multi-step traversal ───────────────────────────────────────────
// Paylocity is a FOUR-step wizard ("Step 1 of 4" in .progress-header), and its composition is
// per-posting, driven by flags on window.pageData: hasScreener, shouldIncludeEeoQuestions,
// shouldIncludeOfccpQuestions, displayAcknowledgement. Read live 2026-07-28 off a real posting.
//
// THE HAZARD, and the reason this is one careful selector rather than a loop of clicks: the wizard
// reuses the SAME id, #btn-submit, for both "Next Step" and the terminal submit. Clicking it N times
// to walk the wizard therefore ends by pressing the real Submit on the last step. Scoping the click
// by its visible text means the advance action CANNOT match the terminal button - the moment the
// label stops saying "Next Step", the selector stops matching and the run simply stops advancing.
// That is a structural guarantee, not a count we have to keep in sync with Paylocity's step logic.
const PAYLOCITY_ADVANCE_SELECTOR = '#btn-submit:has-text("Next Step")';

// Four steps total, so at most three advances ever. Bounded rather than "advance until it stops
// matching" because the action list is built up-front and the managed runner cannot branch mid-run.
// Every advance and every fill is optional, so a posting with fewer steps just no-ops the extras.
const PAYLOCITY_MAX_ADVANCES = 3;

// What Litos must never fill or click its way past on the final step. These are the exact things
// the live model shows can appear there: EEO/OFCCP self-identification, a prior-conviction
// declaration, a work-authorization declaration, and the acknowledgement whose own text reads "you
// hereby certify that the facts set forth in the above employment application are true and
// complete". Voluntary demographics belong to the student alone; the rest are legal attestations
// made in her name. Litos fills everything up to that page and hands it over.
const PAYLOCITY_TERMINAL_MARKERS = [
  'acknowledgements.priorConviction',
  'acknowledgements.authorizedToWorkInUS',
  'acknowledgements.eeoGenderEthnicity',
] as const;

// ─── Rippling (ats.rippling.com) ──────────────────────────────────────────────
// Read off a live Rippling posting, 2026-07-29 (ats.rippling.com/rippling/jobs/875b2547-.../apply).
//
// THE TRAP: both `name` AND `id` are randomised per render - `name="Z9gMtYRYFO"`, `id="field-8"`.
// Neither can ever be matched, which rules out every hook the other adapters in this file rely on.
// `data-testid` is the one stable attribute, and it is present and stable on every field, so this is
// the rare adapter where data-testid is the correct primary selector rather than a fallback.
//
// Two file inputs again (resume + cover letter). Weaker than Workable's avatar hazard, and worth
// being precise about rather than borrowing that story: on the live form and on the fixture the
// resume input comes FIRST, so a bare input[type="file"] happens to resolve to the right one today.
// Verified in-browser 2026-07-29 - the naive selector and the captured one both resolved to
// input-resume. The captured selector is still what ships, because "correct as long as the DOM order
// never changes" is not a property worth depending on when a stable attribute is right there.
const RIPPLING_RESUME_SELECTOR = 'input[type="file"][data-testid="input-resume"]';
const RIPPLING_COVER_LETTER_SELECTOR = 'input[type="file"][data-testid="input-cover_letter"]';

// NOT filled, and this is the interesting part of the Rippling capture. The form has three
// comboboxes and they ALL share one data-testid ("input-select-search-input"), so they cannot even
// be told apart by selector. Reading the label above each one identifies them as: Pronouns, the
// phone country code, and "Please identify your race". Two of those are the student's own identity
// to declare or decline, and the third is part of a field we already fill. So there is nothing here
// Litos should be typing into, and the ambiguity is moot.
//
// Also never touched: [data-testid="radio-sms_opt_in"], whose label reads "Yes - I consent to
// receiving text messages". A consent control, covered by the standing rule below.

// ─── BreezyHR (*.breezy.hr) ───────────────────────────────────────────────────
// Read off a live Zinier posting, 2026-07-29 (zinier.breezy.hr/p/7eefd4d49b75-.../apply).
// The cleanest naming of the seven: stable `c`-prefixed names on every field.
//
// Note cName is ONE full-name field, not a first/last pair, so this family does not split the name.
const BREEZY_RESUME_SELECTOR = 'input[type="file"][name="cResume"]';

// Breezy takes its long-form answer as `textarea[name="cSummary"]`, not a file, so there is no
// cover-letter FILE input for hasCoverLetterUpload() to find. Deliberately a never-matching
// selector, exactly as JazzHR does and for the same reason: this map answers "can this portal accept
// a cover-letter FILE", and answering yes would attach a PDF to a control that cannot hold one.
// An approved cover letter is therefore not sent to Breezy today. A known, deliberate gap - and the
// same fix as JazzHR's would close both (thread the letter's TEXT through the packet, not just its
// rendered PDF). Only one tenant was captured, so if a Breezy form is ever seen with a real
// cover-letter file input, re-capture before widening this.
const BREEZY_COVER_LETTER_SELECTOR = 'input[type="file"][name="cCoverLetterFileThatDoesNotExist"]';

// NOT filled: input[name="smsConsent"] and input[name="gdprAgreement"]. Both consent checkboxes.
//
// AND NOT FILLED, the one worth reading: Breezy ships a honeypot at name="hp_<4 hex>" - randomised
// per render, so it must be matched by prefix if it is ever matched at all. It defeats a visibility
// check completely, and this was measured rather than reasoned about: against the fixture that
// reproduces it, Playwright's own isVisible() returns TRUE, because the input's own box is 293x38
// with opacity 1 and visibility visible. It is concealed ONLY by an ancestor (.apply-field-extra)
// with height 0 and overflow hidden.
//
// So ancestor geometry, not the element's own computed style and not isVisible(), is what a honeypot
// check has to look at. Same class of trap as the Workday 1px sr-only field the extension's
// isHoneypotField already guards. This adapter is safe because it fills by explicit name; anything
// that fills generically walks straight into it, and a filled honeypot means the employer silently
// discards the application.

// ─── BambooHR ({tenant}.bamboohr.com/careers/{id}) ────────────────────────────
// Read off a live PRC-Saltillo posting, 2026-07-29 (prentkeromich.bamboohr.com/careers/480). This
// closes the "not yet captured" item left open by the 2026-07-28 capture.
//
// The form is revealed by an "Apply for This Job" button and renders into the SAME url - there is no
// separate /apply route, and /careers/{id}/apply is a blank page. So the managed run has to click
// that button before anything exists to fill, the same shape as SmartRecruiters' "I'm interested".
//
// ids are FabricTextField-<n>, sequential and render-dependent, so every field matches on `name`.
// Dotted names (city.value) are fine inside a quoted attribute selector and need no escaping.
const BAMBOOHR_OPEN_FORM_SELECTOR = 'button:has-text("Apply for This Job")';
const BAMBOOHR_RESUME_SELECTOR = 'input[type="file"][aria-label="file-input"]';
// One file input only on the captured form, and it is the resume. No cover-letter file control was
// present, so the same never-matching declaration as Breezy/JazzHR applies rather than a guess.
const BAMBOOHR_COVER_LETTER_SELECTOR = 'input[type="file"][name="bambooCoverLetterThatDoesNotExist"]';

// NOT filled: input[name^="nickname_"], BambooHR's honeypot, labelled "Please leave this field
// blank" and concealed the same zero-height-ancestor way Breezy's is.
//
// AND recorded because someone will otherwise "fix" it later: this form has TWO type="submit"
// buttons, "Submit Application" and "Cancel". The generic `button[type="submit"]` selector used for
// the autonomous families is ambiguous here and could press Cancel. Moot while BambooHR is
// CAPTCHA-gated and therefore never auto-submits, which is exactly why it is written down.

const COVER_LETTER_UPLOAD_SELECTORS: Record<SupportedPortal, string> = {
  greenhouse: 'input#cover_letter[type="file"], input[type="file"][name*="cover_letter" i], input[type="file"][id*="cover_letter" i], label:has-text("Cover Letter") input[type="file"]',
  lever: 'input[type="file"][name*="cover" i], input[type="file"][id*="cover" i], label:has-text("Cover Letter") input[type="file"]',
  ashby: ASHBY_COVER_LETTER_SELECTOR,
  smartrecruiters: 'spl-dropzone[data-test*="cover" i] input[type="file"], input[type="file"][name*="cover" i], label:has-text("Cover Letter") input[type="file"]',
  controlled_test: 'input[type="file"][name*="cover" i], input[type="file"][id*="cover" i], label:has-text("Cover Letter") input[type="file"]',
  controlled_lever: 'input[type="file"][name*="cover" i], input[type="file"][id*="cover" i], label:has-text("Cover Letter") input[type="file"]',
  controlled_ashby: ASHBY_COVER_LETTER_SELECTOR,
  controlled_smartrecruiters: 'input[type="file"][name*="cover" i], input[type="file"][id*="cover" i], label:has-text("Cover Letter") input[type="file"]',
  workable: WORKABLE_COVER_LETTER_SELECTOR,
  controlled_workable: WORKABLE_COVER_LETTER_SELECTOR,
  // JazzHR takes a cover letter as a TEXTAREA, not a file upload, so there is no file input for
  // hasCoverLetterUpload() to find. Deliberately a never-matching file selector: this map answers
  // "can this portal accept a cover-letter FILE", and answering yes would make the caller attach a
  // PDF to a control that cannot hold one. See the JAZZHR_RESUME_SELECTOR note for why the textarea
  // is not filled either.
  jazzhr: 'input[type="file"][name="resumator-coverletter-file"]',
  controlled_jazzhr: 'input[type="file"][name="resumator-coverletter-file"]',
  paylocity: PAYLOCITY_COVER_LETTER_SELECTOR,
  controlled_paylocity: PAYLOCITY_COVER_LETTER_SELECTOR,
  rippling: RIPPLING_COVER_LETTER_SELECTOR,
  controlled_rippling: RIPPLING_COVER_LETTER_SELECTOR,
  breezy: BREEZY_COVER_LETTER_SELECTOR,
  controlled_breezy: BREEZY_COVER_LETTER_SELECTOR,
  bamboohr: BAMBOOHR_COVER_LETTER_SELECTOR,
  controlled_bamboohr: BAMBOOHR_COVER_LETTER_SELECTOR,
  // The account-walled four never reach a form, so there is no file input of any kind to find. A
  // never-matching selector is the honest answer to "can this portal accept a cover-letter file"
  // here, and it keeps hasCoverLetterUpload() from having to special-case them.
  jobvite: 'input[type="file"][name="noFormReachableWithoutConsent"]',
  icims: 'input[type="file"][name="noFormReachableWithoutAccount"]',
  oraclecloud: 'input[type="file"][name="noFormReachableWithoutAuthCode"]',
  ultipro: 'input[type="file"][name="noFormCaptured"]',
};

export function coverLetterUploadSelector(portal: SupportedPortal): string {
  return COVER_LETTER_UPLOAD_SELECTORS[portal];
}

export function managedResultHasCoverLetterUpload(result: ManagedBrowserResult | null, portal: SupportedPortal): boolean {
  const selector = coverLetterUploadSelector(portal);
  return result?.extracted?.some((item) => (
    item.selector === selector && item.value?.trim().toLowerCase() === 'file'
  )) === true;
}

export async function hasCoverLetterUpload(page: Page, portal: SupportedPortal): Promise<boolean> {
  if ((await page.locator(coverLetterUploadSelector(portal)).count()) > 0) return true;
  const labelled = page.getByLabel(/cover\s*letter/i);
  for (let index = 0; index < await labelled.count(); index += 1) {
    if ((await labelled.nth(index).getAttribute('type'))?.toLowerCase() === 'file') return true;
  }
  return false;
}

// Fixed-field fills only (name/email/phone/location/links/resume) - shared by
// buildManagedPortalActions (the real fill+submit run) and buildManagedDiscoveryActions (a
// cheaper first pass that also asks the runner to scan the page for custom questions). Splitting
// this out is what let R-055's discovery step reuse every portal's already-verified selectors
// instead of a third copy of them.
function pushFixedFieldActions(actions: ManagedBrowserAction[], portal: SupportedPortal, packet: SubmissionPacket) {
  const family = portalFamily(portal);
  // Nothing to fill, so nothing is pushed. Returning an EMPTY action list rather than attempting the
  // fills and letting them miss is deliberate: a run that fills nothing and says so is honest, while
  // a run that fires ten optional fills at a consent page produces a blocker card implying the form
  // was found and merely refused. It was never reached.
  if (ACCOUNT_WALLED_FAMILIES.has(family)) return;
  if (family === 'greenhouse') {
    pushGreenhouseManagedPreflightActions(actions);
    const parts = packet.fullName.trim().split(/\s+/);
    // optional (managedFill default) + bounded, not required: a branded-redirect Greenhouse customer
    // (Jump Trading serves its posting through www.jumptrading.com with a different form DOM) has
    // none of these classic selectors, and a required fill there waited the full 30s and then
    // aborted the whole run. Optional means a missed core field degrades to a required-field blocker
    // card. The resume upload is optional + bounded for the same reason (managedUpload): the live
    // Jump Trading retry proved the run now clears name/email and stops at the resume file input.
    managedFill(actions, GREENHOUSE_FIRST_NAME_SELECTOR, parts[0], 'first_name');
    managedFillByLabel(actions, 'First Name', parts[0], 'first_name_label');
    managedFill(actions, GREENHOUSE_LAST_NAME_SELECTOR, parts.slice(1).join(' '), 'last_name');
    managedFillByLabel(actions, 'Last Name', parts.slice(1).join(' '), 'last_name_label');
    managedFill(actions, GREENHOUSE_EMAIL_SELECTOR, packet.email, 'email');
    managedFillByLabel(actions, 'Email', packet.email, 'email_label');
    managedComboboxFill(actions, '#country', countryForPhoneField(packet.phone, packet.country), 'phone_country');
    managedFill(actions, GREENHOUSE_PHONE_SELECTOR, phoneForPortalField(portal, packet.phone), 'phone');
    managedComboboxFill(actions, '#candidate-location, input[autocomplete="address-level2"]', greenhouseLocationSearch(packet), 'location');
    pushGreenhouseEducationComboboxActions(actions, packet);
    managedFillByLabel(actions, 'What is your graduation date?', packet.graduationDate, 'graduation_date');
    managedFillByLabel(actions, 'Graduation Date', packet.graduationDate, 'graduation_date_label');
    managedFillByLabel(actions, 'Expected Graduation Date', packet.graduationDate, 'graduation_date_expected');
    managedFillByLabel(actions, 'End date month', packet.graduationMonth, 'education_end_month');
    managedFillByLabel(actions, 'End date year', packet.graduationYear, 'education_end_year');
    managedFillByLabel(actions, 'Graduation Month', packet.graduationMonth, 'education_graduation_month');
    managedFillByLabel(actions, 'Graduation Year', packet.graduationYear, 'education_graduation_year');
    pushGreenhouseGraduationDateComboboxActions(actions, packet);
    managedFillByLabel(actions, 'GPA', packet.gpa, 'gpa');
    managedFillByLabel(actions, 'What is your GPA?', packet.gpa, 'gpa_question');
    managedUpload(actions, GREENHOUSE_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, 'input#cover_letter[type="file"], input[type="file"][name*="cover_letter" i]', 'cover_letter', packet.coverLetter, packet.coverLetterName);
  } else if (family === 'lever') {
    managedFill(actions, 'input[name="name"]', packet.fullName, 'name', false);
    managedFill(actions, 'input[name="email"]', packet.email, 'email', false);
    managedFill(actions, 'input[name="phone"]', packet.phone, 'phone');
    managedFill(actions, 'input[name="urls[LinkedIn]"]', packet.linkedinUrl, 'linkedin');
    managedFill(actions, 'input[name="urls[GitHub]"]', packet.githubUrl, 'github');
    managedFill(actions, 'input[name="urls[Portfolio]"]', packet.portfolioUrl, 'portfolio');
    managedUpload(actions, 'input[name="resume"][type="file"]', 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, 'input[type="file"][name*="cover" i]', 'cover_letter', packet.coverLetter, packet.coverLetterName);
  } else if (family === 'smartrecruiters') {
    // See navigateToApplicationForm/SMARTRECRUITERS_APPLY_LINK_SELECTOR: the JD page and the
    // actual form are different URLs. The managed runner has no separate "navigate, then act"
    // step, so this click has to be the first action in the same sequence; optional and bounded
    // so it is a no-op when the runner already landed on the form URL directly.
    if (portal === 'smartrecruiters') {
      actions.push({
        type: 'click',
        selector: SMARTRECRUITERS_APPLY_LINK_SELECTOR,
        label: 'open application form',
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      });
    }
    const parts = packet.fullName.trim().split(/\s+/);
    const controlled = portal === 'controlled_smartrecruiters';
    managedFill(actions, controlled ? CONTROLLED_SMARTRECRUITERS_FIRST_NAME_SELECTOR : SMARTRECRUITERS_FIRST_NAME_SELECTOR, parts[0], 'first_name');
    managedFill(actions, controlled ? CONTROLLED_SMARTRECRUITERS_LAST_NAME_SELECTOR : SMARTRECRUITERS_LAST_NAME_SELECTOR, parts.slice(1).join(' '), 'last_name');
    managedFill(actions, controlled ? CONTROLLED_SMARTRECRUITERS_EMAIL_SELECTOR : SMARTRECRUITERS_EMAIL_SELECTOR, packet.email, 'email');
    managedFill(actions, controlled ? CONTROLLED_SMARTRECRUITERS_CONFIRM_EMAIL_SELECTOR : SMARTRECRUITERS_CONFIRM_EMAIL_SELECTOR, packet.email, 'confirm_email');
    managedFill(actions, SMARTRECRUITERS_PHONE_SELECTOR, phoneForPortalField(portal, packet.phone), 'phone');
    managedFill(actions, controlled ? CONTROLLED_SMARTRECRUITERS_LINKEDIN_SELECTOR : SMARTRECRUITERS_LINKEDIN_SELECTOR, packet.linkedinUrl, 'linkedin');
    managedFill(actions, controlled ? CONTROLLED_SMARTRECRUITERS_WEBSITE_SELECTOR : SMARTRECRUITERS_WEBSITE_SELECTOR, packet.portfolioUrl ?? packet.githubUrl, 'portfolio');
    managedUpload(actions, SMARTRECRUITERS_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
  } else if (family === 'workable') {
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, 'input[name="firstname"]', parts[0], 'first_name');
    managedFill(actions, 'input[name="lastname"]', parts.slice(1).join(' '), 'last_name');
    managedFill(actions, 'input[name="email"]', packet.email, 'email');
    managedFill(actions, 'input[name="phone"]', packet.phone, 'phone');
    managedFill(actions, 'input[name="city"]', packet.city, 'location');
    // Workable has no dedicated LinkedIn/GitHub field on the built-in form - those arrive as custom
    // QA_<numeric> questions when an employer adds them, and so are handled by the reviewed-question
    // path, not here. `headline` is the one free identity field, and it is left alone deliberately:
    // it is candidate-authored positioning, not a fact from the profile, so guessing it would put
    // words in the student's mouth on a real application.
    managedUpload(actions, WORKABLE_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, WORKABLE_COVER_LETTER_SELECTOR, 'cover_letter', packet.coverLetter, packet.coverLetterName);
    // NOT filled: input[name="gdpr"]. It is a consent checkbox, and the standing rule below about
    // never ticking a consent control on the student's behalf applies with full force here.
  } else if (family === 'jazzhr') {
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, 'input[name="resumator-firstname-value"]', parts[0], 'first_name');
    managedFill(actions, 'input[name="resumator-lastname-value"]', parts.slice(1).join(' '), 'last_name');
    managedFill(actions, 'input[name="resumator-email-value"]', packet.email, 'email');
    managedFill(actions, 'input[name="resumator-phone-value"]', packet.phone, 'phone');
    managedFill(actions, 'input[name="resumator-city-value"]', packet.city, 'location');
    managedFill(actions, 'input[name="resumator-linkedin-value"]', packet.linkedinUrl, 'linkedin');
    managedUpload(actions, JAZZHR_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    // NOT filled: resumator-eeo_gender-value / resumator-eeo_race-value. Voluntary EEO
    // self-identification belongs to the student alone and is never inferred or auto-answered.
  } else if (family === 'paylocity') {
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, paylocityId('info.firstName'), parts[0], 'first_name');
    managedFill(actions, paylocityId('info.lastName'), parts.slice(1).join(' '), 'last_name');
    managedFill(actions, paylocityId('info.email'), packet.email, 'email');
    managedFill(actions, paylocityId('info.cellPhone'), packet.phone, 'phone');
    managedFill(actions, paylocityId('info.linkedIn'), packet.linkedinUrl, 'linkedin');
    managedFill(actions, '#public-site-address-city', packet.city, 'location');
    managedUpload(actions, PAYLOCITY_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, PAYLOCITY_COVER_LETTER_SELECTOR, 'cover_letter', packet.coverLetter, packet.coverLetterName);
    // Work history and education live on step ONE and were previously skipped entirely, which is
    // why a Paylocity run used to hand back a page that looked half-done. Confirmed live: all seven
    // workHistory.* controls and educationHistory.certificationsAndAwards render visible on step 1.
    // Only the first row (index .0) is filled - Paylocity adds further rows through an "Add Work
    // History" button, and clicking to create rows we may not be able to complete would leave the
    // form in a worse state than one clean entry the student can extend herself.
    if (packet.mostRecentRole) {
      managedFill(actions, paylocityId('workHistory.companyName.0'), packet.mostRecentRole.company, 'work_company');
      managedFill(actions, paylocityId('workHistory.position.0'), packet.mostRecentRole.title, 'work_title');
      managedFill(actions, paylocityId('workHistory.responsibilities.0'), packet.mostRecentRole.summary, 'work_summary');
      managedFill(actions, '#txt-workHistory-startDate-0', packet.mostRecentRole.startDate, 'work_start');
      managedFill(actions, '#txt-workHistory-endDate-0', packet.mostRecentRole.endDate, 'work_end');
    }
    // NOT touched: #useAttachedResumeToFillOutApplication. Paylocity offers to parse the uploaded
    // resume back into the form, which would race our own fills and overwrite them with whatever its
    // parser inferred. Leaving it unchecked keeps the profile the single source of truth.
    // Also not filled: the required address-1/county/state/zip block. The packet carries only `city`,
    // so those surface as required-field blockers for the human rather than being invented here.
  } else if (family === 'rippling') {
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, '[data-testid="input-first_name"]', parts[0], 'first_name');
    managedFill(actions, '[data-testid="input-last_name"]', parts.slice(1).join(' '), 'last_name');
    managedFill(actions, '[data-testid="input-email"]', packet.email, 'email');
    managedFill(actions, '[data-testid="input-phone_number"]', phoneForPortalField(portal, packet.phone), 'phone');
    managedUpload(actions, RIPPLING_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, RIPPLING_COVER_LETTER_SELECTOR, 'cover_letter', packet.coverLetter, packet.coverLetterName);
    // input-current_company is left alone on purpose. The packet's mostRecentRole may be a past role
    // rather than a current one, and stating a current employer the student does not have is a
    // factual claim in her name on a real application. It surfaces as a blocker if required.
    // Location is a places-autocomplete backed by a hidden input-externalPlaceId; typing text into it
    // without selecting a suggestion leaves the hidden id empty, which is worse than leaving it.
  } else if (family === 'breezy') {
    // ONE full-name field, not a first/last pair. See BREEZY_RESUME_SELECTOR.
    managedFill(actions, 'input[name="cName"]', packet.fullName, 'name');
    managedFill(actions, 'input[name="cEmail"]', packet.email, 'email');
    managedFill(actions, 'input[name="cPhoneNumber"]', packet.phone, 'phone');
    managedFill(actions, 'input[name="cAddress"]', packet.city, 'location');
    managedUpload(actions, BREEZY_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    // textarea[name="cSummary"] is left alone: it is candidate-authored positioning, the same
    // judgement already made for Workable's `headline`.
  } else if (family === 'bamboohr') {
    // The form does not exist until this button is clicked, so this must be the FIRST action, the
    // same shape as the SmartRecruiters apply link. Optional and bounded, so a page that already
    // shows the form (or a tenant that routes differently) is a no-op rather than a failure.
    actions.push({
      type: 'click',
      selector: BAMBOOHR_OPEN_FORM_SELECTOR,
      label: 'open application form',
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, 'input[name="firstName"]', parts[0], 'first_name');
    managedFill(actions, 'input[name="lastName"]', parts.slice(1).join(' '), 'last_name');
    managedFill(actions, 'input[name="email"]', packet.email, 'email');
    managedFill(actions, 'input[name="phone"]', packet.phone, 'phone');
    managedFill(actions, 'input[name="city.value"]', packet.city, 'location');
    managedFill(actions, 'input[name="linkedinUrl"]', packet.linkedinUrl, 'linkedin');
    managedFill(actions, 'input[name="websiteUrl"]', packet.portfolioUrl ?? packet.githubUrl, 'portfolio');
    managedUpload(actions, BAMBOOHR_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    // NOT filled: state.value / countryId.value (selects, and the packet has no state), the required
    // streetAddress.value and zip.value (the packet carries only city, so inventing them is out),
    // desiredPay (R-031 governs salary and is currency-gated, handled by the reviewed-question path),
    // and educationLevelId. All surface as required-field blockers for the human.
  } else {
    managedFill(actions, 'input[name="_systemfield_name"]', packet.fullName, 'name', false);
    managedFill(actions, 'input[name="_systemfield_email"]', packet.email, 'email', false);
    managedFill(actions, ASHBY_PHONE_SELECTOR, phoneForPortalField(portal, packet.phone), 'phone');
    managedFill(actions, 'input[name="_systemfield_location"]', packet.city, 'location');
    // LinkedIn/GitHub/portfolio, previously missing entirely from this branch: the packet carries
    // them (confirmed live on a real account via GET /profile/application) and the Lever branch
    // fills its equivalents, but Ashby was silently dropping them, surfacing as a "'LinkedIn
    // Profile' is required and is still empty" blocker on a real run. Ashby does not expose these
    // as `_systemfield_*` names the way name/email/phone/location are, and custom fields carry
    // opaque UUID `name`s, so match by a case-insensitive substring across name/aria-label/
    // placeholder rather than one guessed exact name. Optional (default) and only pushed when the
    // value exists, so a form without the field is a no-op rather than a blocker.
    managedFill(actions, ASHBY_LINKEDIN_SELECTOR, packet.linkedinUrl, 'linkedin');
    managedFill(actions, ASHBY_GITHUB_SELECTOR, packet.githubUrl, 'github');
    managedFill(actions, ASHBY_PORTFOLIO_SELECTOR, packet.portfolioUrl, 'portfolio');
    managedUpload(actions, ASHBY_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, ASHBY_COVER_LETTER_SELECTOR, 'cover_letter', packet.coverLetter, packet.coverLetterName);
  }
}

// A cheap first pass: fill the fixed fields (idempotent - the real run below fills them again,
// including the resume upload) and ask the runner to scan the resulting page for custom questions
// via the 'discover' action (stratus-browser-cloud PR #7). No reviewed questions, no submit - this
// call exists only to get `result.discovered` back so the caller can resolve answers in Node
// (questionDiscovery.ts) before the real fill run. Direct-Playwright provider skips this call
// entirely (discoverPageQuestions runs against its own live Page instead); this is the managed
// path's only way to see the live DOM mid-run, since /api/run is otherwise stateless.
export function buildManagedDiscoveryActions(portal: SupportedPortal, packet: SubmissionPacket): ManagedBrowserAction[] {
  const actions: ManagedBrowserAction[] = [];
  pushFixedFieldActions(actions, portal, packet);
  actions.push({ type: 'discover', optional: true, timeout: MANAGED_FILL_TIMEOUT_MS });
  actions.push({
    type: 'extract',
    selector: coverLetterUploadSelector(portal),
    attribute: 'type',
    label: 'cover_letter_capability',
    optional: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
  });
  return actions;
}

export function buildManagedPortalActions(
  portal: SupportedPortal,
  packet: SubmissionPacket,
  submit = false,
): ManagedBrowserAction[] {
  const actions: ManagedBrowserAction[] = [];
  pushFixedFieldActions(actions, portal, packet);
  // Reviewed questions include stored attestations and EEO decline-style answers when present.
  // The managed runner scopes every choice match to this question's container and verifies text
  // values after filling, so a missing or unaccepted value returns as a blocker instead of being
  // reported as completed.
  for (const item of canFillReviewedQuestions('managed') ? packet.questions : []) {
    if (!item.answer.trim()) continue;
    const questionText = normalizeReviewQuestionLabel(item.question);
    if (!questionText) continue;
    if (isLegalConsentQuestion(questionText)) continue;
    const portalSelector = durablePortalSelector(item.portalSelector);
    if (portalSelector) {
      if (/^(?:checkbox|radio)$/i.test(item.portalInputType ?? '')) {
        if (portalFamily(portal) === 'greenhouse') {
          pushGreenhouseCheckboxOptionActions(actions, questionText, item.answer, 'question');
        }
        continue;
      }
      managedFill(actions, portalSelector, item.answer, `question:${questionText.slice(0, 80)}`);
      if (portalFamily(portal) === 'greenhouse' && questionFillShouldPressEnter(questionText)) {
        actions.push({
          type: 'press',
          selector: portalSelector,
          value: 'Enter',
          label: `question_confirm:${questionText.slice(0, 80)}`,
          optional: true,
          timeout: MANAGED_FILL_TIMEOUT_MS,
        });
      }
      if (portalFamily(portal) === 'greenhouse') {
        pushGreenhouseQuestionComboboxActions(actions, portalSelector, questionText, item.answer, 'question');
        pushGreenhouseCheckboxOptionActions(actions, questionText, item.answer, 'question');
      }
      continue;
    }
    if (portalFamily(portal) === 'greenhouse') {
      if (isGreenhouseEducationComboboxQuestion(questionText)) {
        pushGreenhouseQuestionComboboxLabelActions(actions, questionText, item.answer, 'question');
        continue;
      }
      const isReactSelectQuestion = isGreenhouseReactSelectQuestion(questionText);
      if (!isReactSelectQuestion) {
        pushScopedQuestionChoiceActions(actions, questionText, item.answer, 'question');
      }
      pushGreenhouseQuestionComboboxLabelActions(actions, questionText, item.answer, 'question');
      pushGreenhouseCheckboxOptionActions(actions, questionText, item.answer, 'question');
    } else {
      pushScopedQuestionChoiceActions(actions, questionText, item.answer, 'question');
      if (portalFamily(portal) === 'ashby') {
        pushAshbyQuestionTextFallbackActions(actions, questionText, item.answer, 'question');
      }
    }
  }
  if (portalFamily(portal) === 'greenhouse') {
    pushGreenhouseKnownQuestionAliases(actions, packet);
    pushGreenhouseReferralSourceAliases(actions, packet);
    pushGreenhouseDemographicAliases(actions, packet);
  }
  // Choice controls are filled only by the runner's scoped question-container logic. That keeps
  // short answers such as "Yes" from matching an unrelated acknowledgement elsewhere on the page.
  // portalCanAutoSubmit is the second gate, and it is deliberately NOT the caller's job. A caller
  // passing submit=true is saying "the human approved sending this"; it is not saying the platform
  // is capable of being sent in one run. Paylocity's "Next Step" button and JazzHR's reCAPTCHA both
  // sit behind a control that LOOKS submittable, so a caller acting in good faith would otherwise
  // click into a half-finished multi-page flow or bounce off a challenge, and in the Paylocity case
  // the run could report success for an application no employer ever received. Gating here means the
  // guarantee holds no matter who calls this.
  // Multi-step portals walk their wizard instead of submitting. This runs AFTER the reviewed-question
  // fills above, so step one is complete before the first advance; each later step then gets another
  // pass of the same question fills, since a screener question can appear on any page.
  // Gated on `submit`, not just on family. prepare() calls this builder with submit=false to capture
  // the preview screenshot the human approves. Traversing there advanced a real employer's wizard on
  // a run that explicitly asked not to submit, and captured the preview of step 4 - so the student
  // was shown an empty attestation page as the evidence of what she was approving.
  if (submit && portalFamily(portal) === 'paylocity') pushPaylocityTraversal(actions, packet);

  const canAppendSubmit = submit && portalCanAutoSubmit(portal);
  let skipSubmitForManagedActionBudget = false;
  if (portalFamily(portal) === 'greenhouse') {
    const actionLimit = canAppendSubmit ? MANAGED_ACTION_LIMIT - 1 : MANAGED_ACTION_LIMIT;
    trimGreenhouseManagedActionsToBudget(actions, actionLimit);
    if (actions.length > actionLimit) {
      skipSubmitForManagedActionBudget = canAppendSubmit;
      truncateManagedActionsToBudget(actions, MANAGED_ACTION_LIMIT);
    }
  }

  if (canAppendSubmit && !skipSubmitForManagedActionBudget) {
    actions.push({ type: 'click', selector: 'button[type="submit"], input[type="submit"]' });
  }
  return actions;
}

// Walk Paylocity's four-step wizard, filling each page, and stop at the last one.
//
// Every action here is optional, which is what makes a fixed sequence safe against a variable
// wizard: a posting with only two steps simply no-ops the remaining advances rather than erroring.
// The advance selector is scoped to the "Next Step" label (see PAYLOCITY_ADVANCE_SELECTOR), so the
// sequence physically cannot press the terminal submit no matter how many advances are queued.
//
// What this deliberately does NOT do is answer the final step's content. The live model shows that
// page can carry EEO/OFCCP self-identification, a prior-conviction declaration, a work-authorisation
// declaration, and an acknowledgement reading "you hereby certify that the facts set forth in the
// above employment application are true and complete". Demographics are the student's alone, and the
// rest are legal attestations in her name - so Litos fills the pages before it and hands over one
// page from the end, with everything else already done.
function pushPaylocityTraversal(actions: ManagedBrowserAction[], packet: SubmissionPacket) {
  for (let step = 0; step < PAYLOCITY_MAX_ADVANCES; step += 1) {
    actions.push({
      type: 'click',
      selector: PAYLOCITY_ADVANCE_SELECTOR,
      label: `advance to step ${step + 2}`,
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
    // Screener questions live on the steps after the first, and only reviewed answers are sent -
    // the same rule as everywhere else. Choice controls stay with the human (see the note below
    // about never matching a short answer like "Yes" against an arbitrary label).
    for (const item of canFillReviewedQuestions('managed') ? packet.questions : []) {
      if (!item.answer.trim()) continue;
      const questionText = normalizeReviewQuestionLabel(item.question);
      if (!questionText) continue;
      if (isLegalConsentQuestion(questionText)) continue;
      const portalSelector = durablePortalSelector(item.portalSelector);
      if (portalSelector) {
        managedFill(actions, portalSelector, item.answer, `question:${questionText.slice(0, 80)}`);
        continue;
      }
      pushScopedQuestionChoiceActions(actions, questionText, item.answer, 'question');
    }
  }
}

// Whether a page the runner landed on is Paylocity's terminal attestation step.
//
// READ THE SUFFIX BEFORE CHANGING THIS. The marker ids are `...notLastStep` and
// `...notLastStepOrNotIncluded` - they are Paylocity's own negative flags, rendered precisely when
// the page is NOT the last step. A first version of this function treated their PRESENCE as proof of
// the terminal page and so returned true on step one, which is exactly backwards. Their presence
// means "keep going"; their ABSENCE, on a page that still has the wizard's submit control, is what
// identifies the end.
//
// Requiring the submit control too is what keeps this from firing on an unrelated page that merely
// lacks the markers (an error page, a timeout, a redirect to the job board).
export function isPaylocityTerminalStep(pageHtml: string): boolean {
  const hasNotLastStepMarker = PAYLOCITY_TERMINAL_MARKERS.some((marker) => pageHtml.includes(marker));
  if (hasNotLastStepMarker) return false;
  return pageHtml.includes('btn-submit');
}

export function readManagedReceipt(result: ManagedBrowserResult): {
  confirmationText: string;
  finalUrl: string;
  referenceId?: string;
} {
  const body = result.text.replace(/\s+/g, ' ').trim();
  if (!/thank you|application (?:has been )?(?:submitted|received)|we received your application|success/i.test(body)) {
    throw new Error('The company never showed a confirmation we could check');
  }
  return { confirmationText: body.slice(0, 1000), finalUrl: result.url, referenceId: receiptReference(body) };
}

const HOSTS: Record<PortalFamily, RegExp> = {
  greenhouse: /(^|\.)greenhouse\.io$/i,
  lever: /(^|\.)lever\.co$/i,
  ashby: /(^|\.)ashbyhq\.com$/i,
  smartrecruiters: /(^|\.)smartrecruiters\.com$/i,
  // apply.* only. A bare workable.com match also claimed www.workable.com, which is the vendor's
  // marketing site, so a mistyped portal_url became a "supported portal" and got a fill run against
  // a page with no application on it.
  workable: /^apply\.workable\.com$/i,
  // Every JazzHR tenant is its own subdomain of applytojob.com (ticketmanager.applytojob.com, ...),
  // so the leading (^|\.) form matches the tenant without an allowlist of employers.
  jazzhr: /(^|\.)applytojob\.com$/i,
  // Tenant subdomains are arbitrary (2000recruiting.paylocity.com), so the host cannot be pinned the
  // way Workable's can - but it MUST exclude access.paylocity.com, which is Paylocity's employee
  // login. Litos filling an identity into a credential form is not a thing that should be reachable
  // from a bad URL. The apply path check in detectPortal is what actually enforces this.
  paylocity: /(^|\.)paylocity\.com$/i,
  // ats.* ONLY. app.rippling.com is Rippling's HR product, where the equivalent-looking form is an
  // employee login. Exactly the access.paylocity.com hazard, so it gets the same pinned-subdomain
  // treatment rather than the (^|\.) form.
  rippling: /^ats\.rippling\.com$/i,
  // Tenant subdomains are arbitrary (zinier.breezy.hr, recruiting.breezy.hr), so the host cannot be
  // pinned - but the bare breezy.hr is the vendor's marketing site, which the (^|\.) form also
  // matches. The /p/ path check below is what excludes it.
  breezy: /(^|\.)breezy\.hr$/i,
  // Same shape: tenant subdomains, and www.bamboohr.com is the marketing site. Note BambooHR's OWN
  // careers page runs on Greenhouse and lives at www.bamboohr.com/careers/application, which the
  // numeric-id path check below excludes without needing to special-case the host.
  bamboohr: /(^|\.)bamboohr\.com$/i,
  // jobs.* only. The bare jobvite.com is the vendor's marketing site.
  jobvite: /^jobs\.jobvite\.com$/i,
  // Tenant subdomains (careers-uci, jobs-express). www.icims.com and community.icims.com are the
  // vendor's own site and its documentation; the /jobs/ path check excludes both.
  icims: /(^|\.)icims\.com$/i,
  // The widest host space of any portal here BY FAR - oraclecloud.com hosts every Oracle Cloud
  // application there is, not just recruiting. The path check is doing the real work, and this entry
  // would be actively dangerous without it.
  oraclecloud: /(^|\.)oraclecloud\.com$/i,
  // Pinned exactly. The bare ultipro.com is the employee login for UKG's HR product.
  ultipro: /^recruiting\.ultipro\.com$/i,
};

// Host alone is not enough for a portal whose host space also serves a login page, a marketing site
// or an unrelated product. Started as one Paylocity special case; it is a map now because five of
// the seven platforms added on 2026-07-29 need the same treatment, and a chain of `if (portal ===
// ...)` in detectPortal would have been the wrong shape for that.
//
// A family absent from this map is matched on host alone, which is the old behaviour for the
// portals that were already here.
const APPLY_PATHS: Partial<Record<PortalFamily, RegExp>> = {
  // access.paylocity.com is an employee login on the same host space. Litos filling an identity into
  // a credential form is not a thing that should be reachable from a bad URL.
  paylocity: /^\/recruiting\/jobs\/(apply|details)\//i,
  // Excludes the bare breezy.hr marketing site; every real posting is /p/{id}-{slug}.
  breezy: /^\/p\//i,
  // Numeric job id. Excludes www.bamboohr.com/careers/application (their own Greenhouse-backed
  // careers page) and the /careers/{department}-team marketing routes, without an ad-hoc host rule.
  bamboohr: /^\/careers\/\d+/i,
  jobvite: /^\/[^/]+\/job\//i,
  icims: /^\/jobs\//i,
  // The one that matters most. Without it this family would claim every Oracle Cloud application
  // under the sun, including ones that are somebody's payroll or ERP login.
  oraclecloud: /^\/hcmUI\/CandidateExperience\//i,
  ultipro: /^\/[^/]+\/JobBoard\//i,
};

function databricksGreenhouseJobId(url: URL): string | undefined {
  if (!/^(?:www\.)?databricks\.com$/i.test(url.hostname)) return undefined;
  const greenhouseJobId = url.searchParams.get('gh_jid') ?? '';
  if (!/^\d+$/.test(greenhouseJobId)) return undefined;
  const canonicalDatabricksJobPath = new RegExp(`^/company/careers/[a-z0-9-]+/[a-z0-9-]+-${greenhouseJobId}$`, 'i');
  return url.pathname === '/company/careers/open-positions/job' || canonicalDatabricksJobPath.test(url.pathname)
    ? greenhouseJobId
    : undefined;
}

export function detectPortal(rawUrl: string): SupportedPortal {
  const url = new URL(rawUrl);
  if (
    process.env.LITOS_ENABLE_TEST_PORTAL === 'true' &&
    (url.hostname === 'trylitos.com' || url.hostname === 'www.trylitos.com' || url.hostname === 'localhost') &&
    url.pathname.startsWith('/qa/portal-submission') &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost'))
  ) {
    const pathBoard = url.pathname.split('/').filter(Boolean)[2];
    const board = (url.searchParams.get('board') ?? pathBoard)?.toLowerCase();
    if (board === 'lever') return 'controlled_lever';
    if (board === 'ashby') return 'controlled_ashby';
    if (board === 'smartrecruiters') return 'controlled_smartrecruiters';
    if (board === 'workable') return 'controlled_workable';
    if (board === 'jazzhr') return 'controlled_jazzhr';
    if (board === 'paylocity') return 'controlled_paylocity';
    if (board === 'rippling') return 'controlled_rippling';
    if (board === 'breezy') return 'controlled_breezy';
    if (board === 'bamboohr') return 'controlled_bamboohr';
    return 'controlled_test';
  }
  if (url.protocol !== 'https:') throw new Error('That application page is not a secure link');
  // Databricks hosts Greenhouse applications behind a company-owned wrapper URL. Keep this pinned to
  // the known careers path plus numeric Greenhouse job id so unrelated company pages with `gh_jid`
  // query strings do not become supported by accident.
  if (databricksGreenhouseJobId(url)) {
    return 'greenhouse';
  }
  for (const [portal, host] of Object.entries(HOSTS)) {
    if (!host.test(url.hostname)) continue;
    // See APPLY_PATHS. A family listed there must match its path too, because its host space also
    // serves logins, marketing pages, or in Oracle's case entire unrelated products.
    const applyPath = APPLY_PATHS[portal as PortalFamily];
    if (applyPath && !applyPath.test(url.pathname)) continue;
    return portal as SupportedPortal;
  }
  // Names the platforms it can actually DO something useful on. The account-walled four are
  // recognised by the loop above and explained by portalHandoffReason, but listing them here would
  // read as a promise to fill them, which is the opposite of what recognising them is for.
  throw new Error('Litos cannot fill in this company\u2019s application page yet. It works on Greenhouse, Lever, Ashby, SmartRecruiters, Workable, JazzHR, Paylocity, Rippling, BreezyHR and BambooHR.');
}

/**
 * Can Litos fill in this page at all? Answerable the moment we have the URL.
 *
 * detectPortal THROWS on an unrecognised page, which is correct for the runner but useless
 * everywhere else: a throw cannot be asked a question, so nothing upstream of the run ever asked.
 * The result was that a packet on a company-owned careers page (jumptrading.com, optiver.com,
 * nuro.ai) sat in the Tracker labelled "Ready" behind a live send button, and the applicant only
 * discovered Litos could not submit it after a multi-minute run failed. Nine of ten failures on the
 * owner's account on 2026-08-04 were exactly this.
 *
 * The portal is knowable from apply_url at CREATION time. This is the non-throwing form of that
 * same question so the Tracker can be honest before anyone clicks. A malformed URL is unsupported
 * rather than an exception, because a caller asking "can we?" wants an answer, not a crash.
 */
export function isPortalSupported(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    detectPortal(rawUrl);
    return true;
  } catch {
    return false;
  }
}

export function canonicalSupportedPortalUrl(rawUrl: string | undefined, atsName?: string | null): string | undefined {
  if (!rawUrl) return undefined;
  // Some company-hosted Greenhouse wrappers keep only gh_jid in the URL and are stored with a
  // generic ats_name on older packets. Only the Databricks wrapper shape is supported here; other
  // company pages with a gh_jid query string stay unsupported until we verify their embedded form.
  void atsName;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return undefined;
    const greenhouseJobId = databricksGreenhouseJobId(url);
    if (greenhouseJobId) return `https://boards.greenhouse.io/embed/job_app?token=${greenhouseJobId}`;
  } catch {
    return undefined;
  }
  if (isPortalSupported(rawUrl)) return rawUrl;
  return undefined;
}

export function canonicalMonitoredPortalUrl(
  rawUrl: string | undefined,
  atsName?: string | null,
  boardToken?: string | null,
): string | undefined {
  const canonical = canonicalSupportedPortalUrl(rawUrl, atsName);
  if (canonical && !greenhousePortalUrlNeedsBoardToken(canonical)) return canonical;
  if (!rawUrl || atsName?.trim().toLowerCase() !== 'greenhouse') return undefined;
  const token = boardToken?.trim();
  if (!token) return undefined;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return undefined;
    const greenhouseJobId = url.searchParams.get('gh_jid') ?? url.searchParams.get('token') ?? '';
    if (!/^\d+$/.test(greenhouseJobId)) return undefined;
    return `https://job-boards.greenhouse.io/${encodeURIComponent(token)}/jobs/${greenhouseJobId}`;
  } catch {
    return undefined;
  }
}

export function greenhousePortalUrlNeedsBoardToken(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io')
      && url.pathname === '/embed/job_app'
      && /^\d+$/.test(url.searchParams.get('token') ?? '')
      && !url.searchParams.get('for')
      && !url.searchParams.get('b');
  } catch {
    return false;
  }
}

export function portalApplicationUrl(portal: SupportedPortal, rawUrl: string): string {
  if (portal !== 'ashby') return rawUrl;
  const url = new URL(rawUrl);
  if (!url.pathname.endsWith('/application')) url.pathname = `${url.pathname.replace(/\/$/, '')}/application`;
  return url.toString();
}

// SmartRecruiters' job-posting URL (jobs.smartrecruiters.com/{Company}/{jobId}-{slug}) is a JD
// page only - the actual form lives at a SEPARATE URL
// (oneclick-ui/company/{Company}/publication/{uuid}) behind an "I'm interested" link, and that
// uuid is unrelated to the jobId, so it cannot be derived the way portalApplicationUrl() derives
// Ashby's /application suffix. It has to be found on the live page. Confirmed live, 2026-07-24, on
// a real Western Digital posting. A no-op on every other portal, and a no-op on SmartRecruiters
// once already on the form (the selector simply won't match).
const SMARTRECRUITERS_APPLY_LINK_SELECTOR = 'a[href*="oneclick-ui"], a[href*="/apply"]';

export async function navigateToApplicationForm(page: Page, portal: SupportedPortal): Promise<void> {
  if (portal !== 'smartrecruiters') return;
  const link = page.locator(SMARTRECRUITERS_APPLY_LINK_SELECTOR).first();
  if ((await link.count()) === 0) return; // already on the form, or the link isn't there this time
  const href = await link.getAttribute('href');
  if (!href) return;
  await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
}

async function fillFirst(page: Page, selectors: string[], value: string | undefined, label: string, out: string[]) {
  if (!value) return;
  for (const selector of selectors) {
    const field = page.locator(selector).first();
    if ((await field.count()) > 0 && (await field.isVisible().catch(() => false))) {
      await field.fill(value);
      out.push(label);
      return;
    }
  }
}

async function fillComboboxFirst(page: Page, selectors: string[], value: string | undefined, label: string, out: string[]) {
  if (!value) return;
  for (const selector of selectors) {
    const field = page.locator(selector).first();
    if ((await field.count()) > 0 && (await field.isVisible().catch(() => false))) {
      await field.fill(value);
      await field.press('Enter').catch(() => undefined);
      out.push(label);
      return;
    }
  }
}

async function selectFirst(page: Page, selectors: string[], value: string | undefined, label: string, out: string[]) {
  if (!value) return;
  for (const selector of selectors) {
    const field = page.locator(selector).first();
    if ((await field.count()) === 0 || !(await field.isVisible().catch(() => false))) continue;
    const selected = await field.selectOption({ label: value }).catch(() => field.selectOption(value).catch(() => null));
    if (selected && selected.length > 0) {
      out.push(label);
      return;
    }
  }
}

async function fillGreenhouseDemographicAliases(page: Page, packet: SubmissionPacket, out: string[]) {
  const prefs = packet.eeoPrefs;
  if (!prefs) return;
  for (const item of GREENHOUSE_DEMOGRAPHIC_ALIASES) {
    const value = prefs[item.key]?.trim();
    if (!value) continue;
    for (const alias of item.aliases) {
      await selectFirst(
        page,
        greenhouseQuestionSelectSelectors(alias),
        value,
        `greenhouse_demographic:${alias.slice(0, 80)}`,
        out,
      );
    }
  }
}

async function uploadFirst(
  page: Page,
  selectors: string[],
  file: Buffer | undefined,
  fileName: string | undefined,
  label: 'resume' | 'cover_letter',
  out: string[],
) {
  if (!file || !fileName) return;
  for (const selector of selectors) {
    const field = page.locator(selector).first();
    if ((await field.count()) > 0) {
      const type = await field.getAttribute('type').catch(() => null);
      if (type?.toLowerCase() !== 'file') continue;
      try {
        await field.setInputFiles({ name: fileName, mimeType: 'application/pdf', buffer: file });
        out.push(label);
        return;
      } catch {
        continue;
      }
    }
  }
}

async function fillReviewedQuestions(page: Page, portal: SupportedPortal, packet: SubmissionPacket, out: string[]) {
  for (const item of packet.questions) {
    if (!item.answer.trim()) continue;
    const questionText = normalizeReviewQuestionLabel(item.question);
    if (!questionText) continue;
    if (isLegalConsentQuestion(questionText)) continue;
    const portalSelector = durablePortalSelector(item.portalSelector);
    if (/^(?:checkbox|radio)$/i.test(item.portalInputType ?? '')) {
      if (portalFamily(portal) === 'greenhouse') {
        for (const selector of greenhouseCheckboxOptionSelectors(questionText, item.answer)) {
          const field = page.locator(selector).first();
          if ((await field.count()) > 0 && (await field.isVisible().catch(() => false))) {
            await field.check();
            out.push(`question_checkbox:${questionText.slice(0, 80)}`);
            break;
          }
        }
      }
      continue;
    }
    if (portalSelector) {
      const field = page.locator(portalSelector).first();
      if ((await field.count()) > 0 && (await field.isVisible().catch(() => false))) {
        await field.fill(item.answer);
        out.push(`question:${questionText.slice(0, 80)}`);
        continue;
      }
    }
    const label = page.getByText(questionText, { exact: false }).first();
    if ((await label.count()) === 0) continue;
    const container = label.locator('xpath=ancestor::*[self::div or self::fieldset][1]');
    const input = container.locator('textarea, input:not([type=file]):not([type=hidden])').first();
    if ((await input.count()) > 0 && (await input.isVisible().catch(() => false))) {
      await input.fill(item.answer);
      out.push(`question:${questionText.slice(0, 80)}`);
      continue;
    }
    const select = container.locator('select').first();
    if ((await select.count()) > 0) {
      await select.selectOption({ label: item.answer }).catch(() => select.selectOption(item.answer));
      out.push(`question:${questionText.slice(0, 80)}`);
      continue;
    }
    const answerPattern = new RegExp(`^\\s*${item.answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    const choice = container.getByLabel(answerPattern).first();
    if ((await choice.count()) > 0 && (await choice.isVisible().catch(() => false))) {
      await choice.check().catch(() => choice.click());
      out.push(`question:${questionText.slice(0, 80)}`);
    }
  }
}

export async function fillPortal(page: Page, portal: SupportedPortal, packet: SubmissionPacket): Promise<FillResult> {
  const filledFields: string[] = [];
  const family = portalFamily(portal);
  // Same stop as pushFixedFieldActions, and it has to be repeated here rather than inherited: these
  // are two independent paths to the same portals (managed runner vs direct Playwright), and the
  // 2026-07-28 review caught exactly this kind of gate existing on one path and not the other.
  // The blocker is the reason, in the student's words, so the card explains itself.
  if (ACCOUNT_WALLED_FAMILIES.has(family)) {
    return { filledFields, blockers: [portalHandoffReason(portal)!] };
  }
  if (family === 'greenhouse') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, GREENHOUSE_FIRST_NAME_SELECTOR.split(', '), parts[0], 'first_name', filledFields);
    await fillFirst(page, GREENHOUSE_LAST_NAME_SELECTOR.split(', '), parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, GREENHOUSE_EMAIL_SELECTOR.split(', '), packet.email, 'email', filledFields);
    await fillComboboxFirst(page, ['#country'], countryForPhoneField(packet.phone, packet.country), 'phone_country', filledFields);
    await fillFirst(page, GREENHOUSE_PHONE_SELECTOR.split(', '), phoneForPortalField(portal, packet.phone), 'phone', filledFields);
    await fillComboboxFirst(page, ['#candidate-location', 'input[autocomplete="address-level2"]'], greenhouseLocationSearch(packet), 'location', filledFields);
    await uploadFirst(page, GREENHOUSE_RESUME_SELECTOR.split(', '), packet.resume, packet.resumeName, 'resume', filledFields);
    await uploadFirst(page, ['input#cover_letter[type="file"]', 'input[type="file"][name*="cover_letter" i]'], packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields);
    await fillGreenhouseDemographicAliases(page, packet, filledFields);
  } else if (family === 'lever') {
    await fillFirst(page, ['input[name="name"]'], packet.fullName, 'name', filledFields);
    await fillFirst(page, ['input[name="email"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="phone"]'], packet.phone, 'phone', filledFields);
    await fillFirst(page, ['input[name="urls[LinkedIn]"]'], packet.linkedinUrl, 'linkedin', filledFields);
    await fillFirst(page, ['input[name="urls[GitHub]"]'], packet.githubUrl, 'github', filledFields);
    await fillFirst(page, ['input[name="urls[Portfolio]"]'], packet.portfolioUrl, 'portfolio', filledFields);
    await uploadFirst(page, ['input[name="resume"][type="file"]'], packet.resume, packet.resumeName, 'resume', filledFields);
    await uploadFirst(page, ['input[type="file"][name*="cover" i]'], packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields);
  } else if (family === 'smartrecruiters') {
    const parts = packet.fullName.trim().split(/\s+/);
    const controlled = portal === 'controlled_smartrecruiters';
    await fillFirst(page, [controlled ? CONTROLLED_SMARTRECRUITERS_FIRST_NAME_SELECTOR : SMARTRECRUITERS_FIRST_NAME_SELECTOR], parts[0], 'first_name', filledFields);
    await fillFirst(page, [controlled ? CONTROLLED_SMARTRECRUITERS_LAST_NAME_SELECTOR : SMARTRECRUITERS_LAST_NAME_SELECTOR], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, [controlled ? CONTROLLED_SMARTRECRUITERS_EMAIL_SELECTOR : SMARTRECRUITERS_EMAIL_SELECTOR], packet.email, 'email', filledFields);
    await fillFirst(page, [controlled ? CONTROLLED_SMARTRECRUITERS_CONFIRM_EMAIL_SELECTOR : SMARTRECRUITERS_CONFIRM_EMAIL_SELECTOR], packet.email, 'confirm_email', filledFields);
    await fillFirst(page, [SMARTRECRUITERS_PHONE_SELECTOR], phoneForPortalField(portal, packet.phone), 'phone', filledFields);
    await fillFirst(page, [controlled ? CONTROLLED_SMARTRECRUITERS_LINKEDIN_SELECTOR : SMARTRECRUITERS_LINKEDIN_SELECTOR], packet.linkedinUrl, 'linkedin', filledFields);
    await fillFirst(page, [controlled ? CONTROLLED_SMARTRECRUITERS_WEBSITE_SELECTOR : SMARTRECRUITERS_WEBSITE_SELECTOR], packet.portfolioUrl ?? packet.githubUrl, 'portfolio', filledFields);
    await uploadFirst(page, [SMARTRECRUITERS_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields);
  } else if (family === 'workable') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['input[name="firstname"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['input[name="lastname"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['input[name="email"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="phone"]'], packet.phone, 'phone', filledFields);
    await fillFirst(page, ['input[name="city"]'], packet.city, 'location', filledFields);
    await uploadFirst(page, [WORKABLE_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields);
    await uploadFirst(page, WORKABLE_COVER_LETTER_SELECTOR.split(', '), packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields);
  } else if (family === 'jazzhr') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['input[name="resumator-firstname-value"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['input[name="resumator-lastname-value"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['input[name="resumator-email-value"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="resumator-phone-value"]'], packet.phone, 'phone', filledFields);
    await fillFirst(page, ['input[name="resumator-city-value"]'], packet.city, 'location', filledFields);
    await fillFirst(page, ['input[name="resumator-linkedin-value"]'], packet.linkedinUrl, 'linkedin', filledFields);
    await uploadFirst(page, [JAZZHR_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields);
  } else if (family === 'paylocity') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, [paylocityId('info.firstName')], parts[0], 'first_name', filledFields);
    await fillFirst(page, [paylocityId('info.lastName')], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, [paylocityId('info.email')], packet.email, 'email', filledFields);
    await fillFirst(page, [paylocityId('info.cellPhone')], packet.phone, 'phone', filledFields);
    await fillFirst(page, [paylocityId('info.linkedIn')], packet.linkedinUrl, 'linkedin', filledFields);
    await fillFirst(page, ['#public-site-address-city'], packet.city, 'location', filledFields);
    await uploadFirst(page, [PAYLOCITY_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields);
    await uploadFirst(page, [PAYLOCITY_COVER_LETTER_SELECTOR], packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields);
  } else if (family === 'rippling') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['[data-testid="input-first_name"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['[data-testid="input-last_name"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['[data-testid="input-email"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['[data-testid="input-phone_number"]'], phoneForPortalField(portal, packet.phone), 'phone', filledFields);
    await uploadFirst(page, [RIPPLING_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields);
    await uploadFirst(page, [RIPPLING_COVER_LETTER_SELECTOR], packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields);
  } else if (family === 'breezy') {
    await fillFirst(page, ['input[name="cName"]'], packet.fullName, 'name', filledFields);
    await fillFirst(page, ['input[name="cEmail"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="cPhoneNumber"]'], packet.phone, 'phone', filledFields);
    await fillFirst(page, ['input[name="cAddress"]'], packet.city, 'location', filledFields);
    await uploadFirst(page, [BREEZY_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields);
  } else if (family === 'bamboohr') {
    // Unlike the managed path this one CAN branch, so the button is clicked only when it is there.
    const opener = page.locator(BAMBOOHR_OPEN_FORM_SELECTOR).first();
    if ((await opener.count()) > 0 && (await opener.isVisible().catch(() => false))) {
      await opener.click().catch(() => undefined);
      // Wait for the FIELD, not for the network. The form mounts client-side with no navigation and
      // often no request at all, so waitForLoadState('networkidle') can resolve instantly and let
      // every fill below race a form that is not in the DOM yet - which looks exactly like a bad
      // selector when it fails.
      await page.locator('input[name="firstName"]')
        .waitFor({ state: 'attached', timeout: MANAGED_FILL_TIMEOUT_MS })
        .catch(() => undefined);
    }
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['input[name="firstName"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['input[name="lastName"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['input[name="email"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="phone"]'], packet.phone, 'phone', filledFields);
    await fillFirst(page, ['input[name="city.value"]'], packet.city, 'location', filledFields);
    await fillFirst(page, ['input[name="linkedinUrl"]'], packet.linkedinUrl, 'linkedin', filledFields);
    await fillFirst(page, ['input[name="websiteUrl"]'], packet.portfolioUrl ?? packet.githubUrl, 'portfolio', filledFields);
    await uploadFirst(page, [BAMBOOHR_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields);
  } else {
    await fillFirst(page, ['input[name="_systemfield_name"]'], packet.fullName, 'name', filledFields);
    await fillFirst(page, ['input[name="_systemfield_email"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ASHBY_PHONE_SELECTOR.split(', '), phoneForPortalField(portal, packet.phone), 'phone', filledFields);
    await fillFirst(page, ['input[name="_systemfield_location"]'], packet.city, 'location', filledFields);
    // See ASHBY_*_SELECTOR: these were missing from the direct path too, so a real Ashby run
    // reported LinkedIn as an empty required field even though the packet had it.
    await fillFirst(page, ASHBY_LINKEDIN_SELECTOR.split(', '), packet.linkedinUrl, 'linkedin', filledFields);
    await fillFirst(page, ASHBY_GITHUB_SELECTOR.split(', '), packet.githubUrl, 'github', filledFields);
    await fillFirst(page, ASHBY_PORTFOLIO_SELECTOR.split(', '), packet.portfolioUrl, 'portfolio', filledFields);
    await uploadFirst(page, ASHBY_RESUME_SELECTOR.split(', '), packet.resume, packet.resumeName, 'resume', filledFields);
    await uploadFirst(page, ASHBY_COVER_LETTER_SELECTOR.split(', '), packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields);
  }
  await fillReviewedQuestions(page, portal, packet, filledFields);

  const blockers: string[] = [];
  // String kept verbatim: it is already surfaced to applicants and matched downstream.
  if (await hasUnresolvedCaptcha(page)) {
    blockers.push(CAPTCHA_BLOCKER);
  }
  const required = page.locator('input[required], textarea[required], select[required]');
  const labelledBlockers: string[] = [];
  let unlabelledCount = 0;
  for (let index = 0; index < (await required.count()); index += 1) {
    const field = required.nth(index);
    if (!(await field.isVisible().catch(() => false))) continue;
    const type = await field.getAttribute('type');
    if (type === 'hidden') continue;
    const value = await field.inputValue().catch(() => '');
    if (value) continue;

    const label = await resolveFieldLabel(page, field);
    if (label) labelledBlockers.push(describeRequiredBlocker(label, { type }));
    else unlabelledCount += 1;
  }

  // Deliberately NOT deduped together with the labelled lines. Every unlabelled field produces the
  // identical sentence, so a plain Set collapsed five distinct blocked fields into one: the student
  // would fix the one thing named, resubmit, and fail again with no new information. Labelled lines
  // still dedupe, because two fields sharing a label really are one thing to fix.
  blockers.push(...new Set(labelledBlockers));
  if (unlabelledCount > 0) blockers.push(describeUnlabelledBlockers(unlabelledCount));
  return { filledFields, blockers };
}

// ---- human-verification (CAPTCHA) detection ----
//
// Litos NEVER solves a challenge and never sends one anywhere to be solved. These functions only
// answer "is a human being asked to do something here", so the run can stop, keep what it filled,
// and hand the page back to the person whose application it is. `solveCaptchas: false` in
// browserbase.ts is the other half of that promise and there is a test pinning it.
//
// The check this replaced counted `iframe[src*=captcha], [class*=captcha], [id*=captcha]` and
// called any hit a blocker. That is wrong in both directions. reCAPTCHA v2 ALWAYS ships a
// `g-recaptcha-response` textarea, solved or not, so the old check called every reCAPTCHA page
// blocked forever; and it could not tell a widget the person already cleared from one still
// waiting. Token state is what distinguishes them: an empty response field under a rendered
// widget means a human still has to act.

// Widget count is deliberately NOT compared to token count. Providers render a variable number of
// visible nodes per widget (wrapper div, anchor iframe, and on Turnstile a shadow host), so
// "3 visible nodes, 1 token" is one solved widget, not two missing ones. The honest signal is:
// something is rendered, and at least one response field is still empty.
export function captchaSnapshotRequiresAttention(responseTokens: string[], visibleChallengeCount: number): boolean {
  if (visibleChallengeCount === 0) return false;
  if (responseTokens.length === 0) return true;
  return responseTokens.some((token) => token.trim().length === 0);
}

export const CAPTCHA_RESPONSE_SELECTOR = [
  'textarea[name*="captcha-response" i]',
  'input[name*="captcha-response" i]',
  'textarea[id*="captcha-response" i]',
  'input[id*="captcha-response" i]',
  'textarea[name="cf-turnstile-response"]',
  'input[name="cf-turnstile-response"]',
].join(', ');

// One source, two consumers. The direct path joins these as-is; the managed path maps the same
// parts through a CSS badge exclusion. Adding a sixth shape here reaches both, which a duplicated
// literal did not.
const CAPTCHA_CHALLENGE_SELECTOR_PARTS = [
  'iframe[src*="captcha" i]',
  'iframe[src*="challenges.cloudflare.com" i]',
  '[class*="captcha" i]',
  '[id*="captcha" i]',
  '[data-sitekey]',
];

export const CAPTCHA_CHALLENGE_SELECTOR = CAPTCHA_CHALLENGE_SELECTOR_PARTS.join(', ');

// reCAPTCHA v3 and invisible v2 render a floating "protected by reCAPTCHA" badge on pages that ask
// the human for NOTHING - the score is computed from behaviour and the token is minted on submit.
// The badge matches [class*="captcha"] and is genuinely visible, so counting it stops a page that
// was never blocked, on exactly the two families already typed as CAPTCHA-gated. Measured on
// BambooHR 2026-07-29: badge present, window.grecaptcha defined, no interactive widget.
//
// Matched with closest(), NOT a self-or-descendant check. The badge is a CONTAINER: `div.grecaptcha-badge`
// wraps an anchor `<iframe src=".../recaptcha/api2/anchor...">`, and that iframe matches
// `iframe[src*="captcha" i]` on its own. A self check misses it (its own class list is not the
// badge's) and a descendant check misses it too (it contains no badge). It would have been counted,
// so a v3 page would still have reported blocked - the exact false positive this exclusion exists to
// remove. closest() covers the badge node and everything inside it in one probe.
//
// Excluding it means a v3 page reports "not blocked", which is correct: there is no challenge for a
// human to clear. If v3 scores the session badly it escalates to a real interactive widget, and
// THAT widget is rendered outside the badge, so closest() returns null and it is counted normally.
const CAPTCHA_BADGE_CLASS = 'grecaptcha-badge';

// Same discipline, and the same reason, as LABEL_PROBE_TIMEOUT_MS below: locator actions AUTO-WAIT
// at 30s by default, this cost is paid once per candidate node, and every probe here is wrapped in
// a swallowing catch - so an unbounded stall would burn the run's whole budget and leave no trace of
// why. isVisible() and count() do not auto-wait; inputValue() and evaluate() do, so they are bounded.
const CAPTCHA_PROBE_TIMEOUT_MS = 750;

// A page whose CSS framework happens to use "captcha" in a utility class can match this selector
// dozens of times. The probe is per-node, so cap the scan: past ~20 candidates the page is telling
// us about its class names, not about a challenge.
const CAPTCHA_MAX_CANDIDATE_NODES = 20;

// The managed path asks a DIFFERENT question than the direct path, and the difference is the point.
//
// The direct path asks "is a challenge still waiting?", because a human may be sitting in front of
// it. The managed path is unattended by definition - the run happens inside a remote browser nobody
// is watching - so the only question worth asking there is "is there an interactive challenge on
// this page at all?". If there is, auto-submitting is wrong whatever the token says, because nobody
// is present to clear it. Presence is therefore the whole rule here.
//
// That difference is what lets this probe avoid the token entirely, which matters three ways:
//   1. Litos never handles a challenge token it does not have to. Asking a third-party runner to
//      read one and hand it back would move the token out of the applicant's session and into our
//      infrastructure for no gain, which is the boundary this feature exists to respect.
//   2. `g-recaptcha-response` is a <textarea>, which has no `value` ATTRIBUTE at all - the token
//      lives in the DOM property. An attribute read returns null on a solved widget, so a cleared
//      challenge would have read as unsolved and blocked a legitimate submission.
//   3. data-sitekey is present on every node this now matches, so a match cannot be silently
//      discarded as null the way an attribute-that-is-usually-absent would be.
//
// Narrower than the direct path on purpose: [data-sitekey] is the container reCAPTCHA v2 explicit,
// hCaptcha and Turnstile all render, and it is absent on a pure v3 page, which is exactly the page
// that must NOT be stopped. It will miss shapes the direct path catches. A narrow signal that is
// always right beats a broad one that misfires in both directions.
const MANAGED_CAPTCHA_CHALLENGE_SELECTOR = '[data-sitekey]:not(.grecaptcha-badge):not(.grecaptcha-badge *)';

// The managed runner's /api/run is STATELESS and executes the whole action list before returning,
// so a check placed inside the submit list cannot stop the click it is meant to gate - by the time
// the result comes back the application is already sent. This is a separate, cheap call made first:
// navigate and read one attribute, no fills, no upload, no screenshot. Same two-call idiom as
// buildManagedDiscoveryActions.
//
// TWO KNOWN LIMITS, stated rather than hidden:
//   - It reads the page as it LOADS. A challenge that renders only after the fields are filled, or
//     after submit is pressed, is not caught.
//   - It is a SEPARATE page load from the one that submits. An anti-bot that escalates on a repeat
//     visit can challenge the submit session while the probe session saw nothing.
// Both mean this narrows the gap rather than closing it. portalCanAutoSubmit stays load-bearing.
export function buildManagedCaptchaProbeActions(): ManagedBrowserAction[] {
  return [
    {
      type: 'extract',
      selector: MANAGED_CAPTCHA_CHALLENGE_SELECTOR,
      attribute: 'data-sitekey',
      label: 'captcha_challenge',
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    },
  ];
}

// Fails OPEN by construction, and that is deliberate rather than lazy. The remote runner's extract
// semantics are not defined in this repo, so if it returns a shape this does not recognise the
// verdict is "no challenge seen" - exactly the behaviour the managed path had before this probe
// existed. That makes the probe a strict improvement in every case and a regression in none, at the
// cost of needing one live run against the QA portal to confirm it actually fires.
export function managedResultRequiresCaptchaAttention(result: ManagedBrowserResult | null): boolean {
  const extracted = result?.extracted;
  if (!extracted) return false;
  // some(), not find(). managedResultHasCoverLetterUpload scans every entry for exactly this reason:
  // the selector is multi-match and the runner may echo one entry per matched node, so inspecting
  // only the first would let a real widget in a later entry through.
  return extracted.some((item) => (
    item.selector === MANAGED_CAPTCHA_CHALLENGE_SELECTOR && item.value !== null
  ));
}

// Which provider is asking. Recorded on the stall so the instrumentation can answer "which families
// actually gate us, and how long does each take to clear" instead of a single undifferentiated
// count. Deliberately a closed set with an 'unknown' member: a provider nobody has seen yet must
// record as unknown rather than be silently bucketed into the nearest known one.
export type CaptchaProvider =
  | 'recaptcha_v2'
  | 'recaptcha_v3'
  | 'hcaptcha'
  | 'turnstile'
  | 'arkose'
  | 'unknown';

export const RECAPTCHA_INTERACTIVE_SELECTOR = `iframe[src*="recaptcha" i]:not(.${CAPTCHA_BADGE_CLASS} *)`;

export const CAPTCHA_PROVIDER_MARKERS: ReadonlyArray<{ provider: CaptchaProvider; selector: string }> = [
  { provider: 'turnstile', selector: '[name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com" i]' },
  { provider: 'hcaptcha', selector: '[name="h-captcha-response"], iframe[src*="hcaptcha.com" i]' },
  { provider: 'arkose', selector: 'iframe[src*="arkoselabs" i], iframe[src*="funcaptcha" i]' },
  { provider: 'recaptcha_v2', selector: '[name="g-recaptcha-response"], iframe[src*="recaptcha" i]' },
];

// Ordered, and the order matters: reCAPTCHA is checked LAST because its response field is the one
// most likely to co-exist with another provider on a page that switched vendors and left markup
// behind. A page carrying both reads as the newer one, which is the one actually gating it.
//
// The reCAPTCHA branch splits v2 from v3 on the same signal the exclusion uses: if the only thing
// rendered is the badge, nothing is being asked of a human, so it is v3. Anything outside the badge
// is an interactive widget, so it is v2.
export async function detectCaptchaProvider(page: Page): Promise<CaptchaProvider> {
  for (const marker of CAPTCHA_PROVIDER_MARKERS) {
    const count = await page.locator(marker.selector).count().catch(() => 0);
    if (count === 0) continue;
    if (marker.provider !== 'recaptcha_v2') return marker.provider;
    // Fails toward v2, the BLOCKING classification, for the same reason the visibility probe fails
    // closed. v3 means "nothing is being asked of a human"; recording that because a probe threw
    // would tell the instrumentation a page was harmless precisely when we could not see it.
    const interactive = await page.locator(RECAPTCHA_INTERACTIVE_SELECTOR).count().catch(() => -1);
    return interactive === 0 ? 'recaptcha_v3' : 'recaptcha_v2';
  }
  return 'unknown';
}

// The blocker line fillPortal emits when a challenge is still waiting. Exported because the runner
// matches on it to decide whether an attention state is a human-verification stall: it is a
// contract between two files, not a local string, and re-typing the literal at the match site is how
// that contract silently breaks.
export const CAPTCHA_BLOCKER = 'CAPTCHA requires your attention';

export function blockersIncludeCaptcha(blockers: readonly string[]): boolean {
  return blockers.includes(CAPTCHA_BLOCKER);
}

export async function hasUnresolvedCaptcha(page: Page): Promise<boolean> {
  const responseFields = page.locator(CAPTCHA_RESPONSE_SELECTOR);
  const responseTokens: string[] = [];
  // count() is hoisted out of the loop CONDITION deliberately: it is a round-trip to the browser, so
  // leaving it there paid one extra crossing per iteration and let the bound move mid-scan.
  const fieldCount = await responseFields.count();
  for (let index = 0; index < fieldCount; index += 1) {
    responseTokens.push(
      await responseFields.nth(index).inputValue({ timeout: CAPTCHA_PROBE_TIMEOUT_MS }).catch(() => ''),
    );
  }

  const challenges = page.locator(CAPTCHA_CHALLENGE_SELECTOR);
  const challengeCount = Math.min(await challenges.count(), CAPTCHA_MAX_CANDIDATE_NODES);
  let visibleChallengeCount = 0;
  for (let index = 0; index < challengeCount; index += 1) {
    const challenge = challenges.nth(index);
    // Fails CLOSED, and it is the only probe here that had to be argued about. Every other catch in
    // this function pushes toward "a human is needed"; a visibility probe that swallowed its error
    // as `false` pushed the other way, so a widget that detached mid-probe (routine during a
    // reCAPTCHA re-render) would drop the count to zero and let the submit click through under an
    // uncleared challenge. A guard that cannot see must assume the thing it guards against.
    if (!await challenge.isVisible().catch(() => true)) continue;
    const insideBadge = await challenge
      .evaluate((node, badgeClass) => node.closest(`.${badgeClass}`) !== null, CAPTCHA_BADGE_CLASS, {
        timeout: CAPTCHA_PROBE_TIMEOUT_MS,
      })
      .catch(() => false);
    if (insideBadge) continue;
    visibleChallengeCount += 1;
  }
  return captchaSnapshotRequiresAttention(responseTokens, visibleChallengeCount);
}

// Playwright's locator actions AUTO-WAIT, defaulting to 30s. Probing four label sources per field
// with the default would spend up to two minutes on a single unlabelled field and blow the
// function's runtime budget, killing the whole submission run: strictly worse than the ugly UUID
// text this replaced. Every probe is therefore explicitly bounded, and the probes run LAZILY,
// stopping at the first source that yields something a human wrote.
const LABEL_PROBE_TIMEOUT_MS = 750;

async function resolveFieldLabel(page: Page, field: Locator): Promise<string | null> {
  const id = await field.getAttribute('id').catch(() => null);
  const labelledBy = await field.getAttribute('aria-labelledby').catch(() => null);
  // aria-labelledby is a space-separated ID list; leading whitespace would make split()[0] the
  // empty string and produce [id=""], which matches nothing and costs a probe for no reason.
  const labelledByFirst = labelledBy?.trim().split(/\s+/)[0] || null;

  // Ordered best to worst. The visible <label> comes first because Greenhouse and Ashby name their
  // custom question inputs with UUIDs, so `name` and `id` are opaque tokens; humanFieldLabel
  // rejects those rather than printing them, and the loop simply moves on to the next source.
  const probes: Array<() => Promise<string | null>> = [];

  if (id) {
    probes.push(() =>
      page.locator(`label[for="${quoteAttr(id)}"]`).first().innerText({ timeout: LABEL_PROBE_TIMEOUT_MS }),
    );
  }
  if (labelledByFirst) {
    // textContent, not innerText: a legitimate sr-only label is display:none-adjacent and innerText
    // renders it as the empty string, discarding a perfectly good name.
    probes.push(() =>
      page.locator(`[id="${quoteAttr(labelledByFirst)}"]`).first().textContent({ timeout: LABEL_PROBE_TIMEOUT_MS }),
    );
  }
  probes.push(async () => {
    // Gated on count() so a field with no ancestor label costs one cheap query instead of a full
    // timeout. Skipped when the label wraps more than one control: innerText of a label wrapping a
    // radio group returns the whole group's text, which is not this field's name.
    const ancestor = field.locator('xpath=ancestor::label[1]');
    if ((await ancestor.count().catch(() => 0)) === 0) return null;
    if ((await ancestor.locator('input, select, textarea').count().catch(() => 0)) > 1) return null;
    return ancestor.first().innerText({ timeout: LABEL_PROBE_TIMEOUT_MS });
  });
  probes.push(() => field.getAttribute('aria-label'));
  probes.push(() => field.getAttribute('placeholder'));
  probes.push(() => field.getAttribute('name'));
  probes.push(async () => id);

  for (const probe of probes) {
    let raw: string | null = null;
    // The try wraps locator CONSTRUCTION as well as the await: a page-controlled id containing a
    // character that is not legal in a CSS string can throw synchronously, and an unhandled throw
    // here would abort the entire fill run rather than degrading to "no label".
    try {
      raw = await probe();
    } catch {
      raw = null;
    }
    const label = humanFieldLabel([raw]);
    if (label) return label;
  }
  return null;
}

// Thrown when a challenge is still unresolved at the moment of the final click. A class, not a
// message prefix, so the runner narrows on `instanceof` the way it already does for
// FieldDecryptError and ResumeUploadError. The message is plain English because it lands in
// submission_error, which is read by a person.
// `stage` exists because the two stop points owe the applicant DIFFERENT sentences, and getting that
// wrong is the specific mistake this whole feature was built to avoid. At 'at_submit' the form is
// filled and one check remains. At 'before_fill' the managed probe stopped the run before it touched
// anything, so the page is blank - telling that applicant "Litos filled everything in, just finish
// the last step" sends them to a form that does not match what they were told. Exactly the
// distinction portalHandoffReason and unattendedHandoffReason already draw, for the same reason.
export type CaptchaStopStage = 'before_fill' | 'at_submit';

export class CaptchaUnresolvedError extends Error {
  constructor(
    readonly stage: CaptchaStopStage = 'at_submit',
    readonly provider: CaptchaProvider = 'unknown',
    message = 'The submit button was not pressed: a human verification check is still waiting.',
  ) {
    super(message);
    this.name = 'CaptchaUnresolvedError';
  }
}

/* Named providers, used ONLY for the shape that carries no preposition - "Apply LinkedIn". The
   general "<verb> ... with|using|via <object>" case is handled by THIRD_PARTY_HANDOFF, which does
   not consult this list: a hard-coded roster of somebody-elses can only ever be incomplete, and
   relying on it was how "Apply now with Wellfound" became pressable. */
const PROVIDER = 'handshake|symplicity|linkedin|indeed|seek|glassdoor|ziprecruiter|monster|xing'
  + '|stepstone|google|facebook|github|apple|greenhouse|workday|workable|ashby|smartrecruiters'
  + '|okta|microsoft|sso';
const HANDOFF_VERB_PROVIDER = new RegExp(
  `\\b(?:apply|autofill|continue|import)\\s+(?:${PROVIDER})\\b`, 'i',
);

/* The send-clause is SHARED with APPLICATION_SUBMIT rather than written twice. The two copies had
   already drifted - this one required "send my application" and the other allowed "your", so
   "Send your application" failed eligibility entirely while the strongest tier would have taken it.
   Same defect as the two label readers, in the regexes. */
const SEND_APPLICATION = '\\bsend\\s+(?:your\\s+|my\\s+|the\\s+)?application\\b';

/* CONTROLS THAT SAY "APPLY" AND HAND OFF TO SOMEBODY ELSE.
 *
 * "Apply with LinkedIn", "Apply With Indeed", "Apply with SEEK" are not submit buttons. They are
 * OAuth handoffs that leave the employer's form and open a third party's consent screen, and every
 * one of them matches the word "apply".
 *
 * THIS IS LIVE ON PORTALS THAT ARE AUTONOMOUS TODAY, not a SmartRecruiters curiosity: Greenhouse
 * and Lever both render "Apply with LinkedIn", and SmartRecruiters' first step carries two of them
 * before the applicant has typed anything. The old selector matched all of them and took `.last()`,
 * so which control got pressed depended on DOM order - it happened to work because the real submit
 * usually sits at the bottom of the form. That is a coin flip, not a guarantee, and the losing side
 * sends the applicant's browser to a third-party sign-in while Litos reports a submitted
 * application the employer never received.
 *
 * Matched on the WHOLE label, anchored, so "apply" as a preposition inside a longer sentence cannot
 * sneak past: it is the shape "<verb> with|using|via <somebody>" that gives these away. */
const THIRD_PARTY_HANDOFF =
  new RegExp(
    /* BROAD ON THE OBJECT, NARROW ON THE EXCEPTION, and that direction is the whole lesson of this
       branch. An earlier round required the object to be a NAMED provider, which stopped
       "Submit application with attachments" being rejected - and re-opened the main hole, because
       every board not on the list walked through: "Apply now with Wellfound", "Apply now with
       Dice", "Apply now with our partner", "Apply now with Career Services". Worse, "Submit
       application with our recruiting partner" reached the top tier and OUTRANKED a real submit.
       A hard-coded list of somebody-elses can only ever be incomplete. A list of the things a
       button legitimately carries - your own documents - is short and closed. So: any
       "<verb> ... with|using|via|from <object>" is a handoff UNLESS the object is a document you
       are attaching. Wrong guesses cost a handoff, never a phantom submission. */
    '\\b(?:apply|submit|send|autofill|sign\\s?in|log\\s?in|continue|register|import)\\b'
    /* Four words of slack, not two: "Submit your saved candidate profile with Handshake" puts
       four between the verb and the preposition, and two let it through. */
    + '(?:\\s+\\w+){0,4}\\s+(?:with|using|via|from)\\s+'
    + '(?!(?:the\\s+|your\\s+|my\\s+|a\\s+|an\\s+)?'
    /* BARE possessive only - "your profile", never "your Handshake profile". The article-and-noun
       form is your own saved details on this same site ("Send application from your profile"); an
       intervening word is almost always somebody else's name, which is the handoff. */
    + '(?:attachments?|resumes?|cvs?|cover\\s+letters?|documents?|files?|e-?signature'
    + '|profiles?|accounts?|saved\\s+(?:details|information))\\b)'
    + '|\\bquick apply\\b|\\bone[-\\s]?click apply\\b|\\bpowered\\s+by\\b',
    'i',
  );

/** Names the application outright. The strongest thing a submit control can say. */
const APPLICATION_SUBMIT = new RegExp(
  `\\bsubmit\\s+(?:your\\s+|my\\s+|the\\s+)?application\\b|${SEND_APPLICATION}`, 'i',
);
/** Help-desk widgets that also say "submit" and also sit at the foot of the page. */
/* A WORD LIST, not a list of exact phrasings. "Submit a request" was covered only because that
   literal string happened to be in it; "Submit a support request", "Submit your question" and
   "Submit an issue" all walked straight through and then won last-wins over the real control. */
const SUPPORT_WIDGET_NOUN =
  /\b(?:feedback|request|ticket|comment|search|report|question|issue|review|rating|survey|contact|bug)\b/i;

/**
 * A help-desk control rather than the thing that sends the application.
 *
 * THE DISCRIMINATOR IS THE WORD "APPLICATION", and it is better than anchoring to the verb. As a
 * bare noun list this rejected "Submit application for review", "Review and submit", and any label
 * carrying a job title that happens to contain one of the words - "Submit your application -
 * Contact Center Agent". Anchoring the noun to the verb instead broke the real widgets, because
 * they say "Submit a support request" and "Submit your question" with words in between.
 * What actually separates them: a help desk never calls the thing an application. Intercom and
 * Zendesk ship "Submit feedback" and "Submit a request"; no employer's application button omits
 * the word while a support widget includes it.
 */
function isSupportWidget(label: string): boolean {
  /* "Submit application feedback" and "Submit application survey" ARE help desks, and blanket-
     exempting anything containing "application" put them back in the top tier - where, on
     last-wins, the feedback widget beat the real submit control. A widget noun sitting on the
     application is the giveaway. */
  if (/\bapplication\s+(?:feedback|survey|issue|question|review|experience)\b/i.test(label)) return true;
  if (/\bfeedback\s+on\s+your\s+application\b/i.test(label)) return true;
  /* Otherwise the word "application" clears it: a help desk never calls the thing an application,
     and without this every job title carrying one of the nouns ("Submit your application -
     Contact Center Agent") is falsely rejected. */
  if (/\bapplication\b/i.test(label)) return false;
  return SUPPORT_WIDGET_NOUN.test(label);
}

const SUBMIT_LABEL = new RegExp(
  `\\bsubmit\\b|${SEND_APPLICATION}|^\\s*apply\\s*$|\\bapply now\\b|\\bfinish (?:and|&) apply\\b`,
  'i',
);

/**
 * Which of a page's buttons is the one that actually submits, or null.
 *
 * A pure function over the visible labels, so the rule that decides whether to press a button on a
 * real person's job application is testable without standing up a browser. Returns an INDEX rather
 * than a label because two buttons can read the same and only the position tells them apart.
 *
 * Order matters and is the whole design: reject the handoffs FIRST, then prefer the most explicit
 * remaining label. An explicit "Submit application" always beats a bare "Apply", and the LAST such
 * control wins because a form's real submit sits at its foot.
 */
export function chooseSubmitControl(labels: string[]): number | null {
  const eligible = labels
    .map((label, index) => ({ label: label.replace(/\s+/g, ' ').trim(), index }))
    .filter(({ label }) => label
      && !THIRD_PARTY_HANDOFF.test(label)
      && !HANDOFF_VERB_PROVIDER.test(label)
      && SUBMIT_LABEL.test(label));
  if (eligible.length === 0) return null;
  /* SUPPORT WIDGETS ARE REMOVED FROM THE WHOLE POOL, not demoted within one tier.
     Intercom and Zendesk render "Submit feedback" and "Submit a request" as [role=button] at the
     FOOT of a careers page, so they sort after the real control and last-wins hands them the click,
     which submits nothing and then tells the applicant to check her email. Excluding them only
     inside the explicit tier left two holes: "Submit application feedback" reached the strongest
     tier on its prefix, and a page whose real control says "Apply now" fell through to a pool that
     still contained the widget. If removing them empties the pool, the honest answer is that this
     page has no submit control - never press the help desk. */
  const clean = eligible.filter(({ label }) => !isSupportWidget(label));
  if (clean.length === 0) return null;
  /* Then two tiers, because "the last thing saying submit" is still not specific enough. A label
     that names the application outright is the strongest signal a control can give. */
  const application = clean.filter(({ label }) => APPLICATION_SUBMIT.test(label));
  const explicit = clean.filter(({ label }) => /\bsubmit\b/i.test(label));
  /* And a third rung below those: "Apply now" is a primary control, a bare "Apply" is as often a
     sticky footer or a card link. Without this, last-wins prefers whichever happens to sit lower. */
  const applyNow = clean.filter(({ label }) => /\bapply now\b/i.test(label));
  const pool = application.length > 0 ? application
    : explicit.length > 0 ? explicit
      : applyNow.length > 0 ? applyNow : clean;
  return pool[pool.length - 1]!.index;
}

/** Every control that could conceivably be a submit button. Exported so a test can match it. */
export const SUBMIT_CANDIDATE_SELECTOR =
  'button, input[type=submit], input[type=button], input[type=image], [role=button]';

/**
 * No control on this page submits the application.
 *
 * ITS OWN TYPE FOR THE SAME REASON CaptchaUnresolvedError HAS ONE. A plain Error falls through
 * fail()'s `uncertainAfterClaim` branch, which tells the applicant "the final submission was
 * attempted, but Litos could not verify the employer confirmation - check the portal or your
 * email". When this throws, the click PROVABLY did not happen, so there is no receipt to look for
 * and that sentence sends her hunting for one that cannot exist.
 *
 * It matters more now than it used to. This used to fire only when a page had no buttons at all;
 * with the handoff filter it is the ROUTINE outcome on every multi-step first page and every page
 * whose only apply-ish controls belong to LinkedIn or Indeed.
 */
export class NoSubmitControlError extends Error {
  constructor(message = 'We could not find the Submit button') {
    super(message);
    this.name = 'NoSubmitControlError';
  }
}

/* ONE READER, USED BY BOTH PASSES.
 *
 * It was two, and the second was a strict subset of the first: selection read title and
 * aria-labelledby and the UA default, the pre-click re-check read only innerText/value/aria-label.
 * So an <input type=submit> with no value - the exact control the fallbacks were added for -
 * selected fine and then re-read as the empty string, and a page with one perfectly good submit
 * button threw "the submit button changed to ''" and sent nothing. Two copies of a rule is one
 * copy too many when disagreeing between them means no application is ever submitted.
 *
 * Serialised into the page, so it is written against a hand-rolled shape rather than the DOM lib:
 * those types are not in scope for the server build.
 */
export const READ_CONTROL_LABEL = (node: unknown) => {
  const el = node as unknown as {
    innerText?: string; value?: string; title?: string; disabled?: boolean; type?: string;
    tagName?: string;
    getAttribute(name: string): string | null; getClientRects(): { length: number };
  };
  /* A control the accessibility tree would not offer is not a submit button. getByRole did this
     filtering for us; a raw CSS selector does not, and innerText falls back to textContent on a
     hidden node, so a display:none mobile duplicate reads as a perfectly good "Submit
     application" - which the last-wins rule would then prefer over the real one. */
  if (el.disabled === true) return '';
  /* `disabled` is meaningless on a [role=button] div, which is how several ATSs render their
     controls, so the ARIA form has to be honoured too. */
  if (el.getAttribute('aria-disabled') === 'true') return '';
  if (el.getAttribute('aria-hidden') === 'true') return '';
  if (el.getClientRects().length === 0) return '';
  /* getClientRects() is non-empty for visibility:hidden, and aria-hidden hides a whole SUBTREE.
     getByRole excluded both; a raw selector plus a self-only check does not, so a responsive
     duplicate hidden either way still reads as a perfectly good "Submit application". */
  const view = (node as unknown as { ownerDocument: { defaultView: {
    getComputedStyle(e: unknown): { visibility: string } } } }).ownerDocument.defaultView;
  if (view.getComputedStyle(node).visibility === 'hidden') return '';
  let parent = (node as unknown as { parentElement: unknown }).parentElement as {
    getAttribute(name: string): string | null; parentElement: unknown } | null;
  while (parent) {
    if (parent.getAttribute('aria-hidden') === 'true') return '';
    parent = parent.parentElement as typeof parent;
  }
  const labelledBy = el.getAttribute('aria-labelledby');
  const referenced = labelledBy
    ? (node as unknown as { ownerDocument: { getElementById(id: string): { innerText?: string } | null } })
      .ownerDocument.getElementById(labelledBy.split(/\s+/)[0]!)?.innerText ?? ''
    : '';
  /* An <input type=submit> with no value attribute renders the UA default "Submit" and reports
     value === '', so without this a real submit reads as unlabelled and gets skipped.
     GATED ON THE TAG, NOT THE TYPE, and that distinction is the whole thing: HTMLButtonElement.type
     ALSO defaults to "submit" and its value defaults to "", so keying off type alone made every
     text-free icon button - a chat launcher, a scroll-to-top, a cookie close - read as "Submit".
     Those sit at the foot of the page, which is exactly where last-wins looks. */
  const uaDefault = el.tagName === 'INPUT' && el.type === 'submit' && !el.value ? 'Submit' : '';
  return (el.innerText || el.value || el.getAttribute('aria-label') || el.title || referenced
    || el.getAttribute('alt') || uaDefault || '').trim();
};

/** How long to give a submit control that is disabled until client-side validation settles. */
const SUBMIT_ENABLE_WAIT_MS = 3_000;

export async function clickFinalSubmit(page: Page): Promise<void> {
  /* ELEMENT HANDLES, NOT nth(). An index is only meaningful against the DOM that produced it, and
     the captcha probe below sits between the two: it can spend the better part of fifteen seconds
     in live round trips, and any re-render, lazy-loaded chat widget or dismissed banner in that
     window shifts every ordinal. `locator.nth(i)` re-queries at click time and carries no label
     constraint, so a shift would land the click on whatever control now holds that position -
     which on these boards is "Apply with LinkedIn" at index 0. A handle references ONE node and
     throws if it detaches, which is the failure we want. */
  let handles: Awaited<ReturnType<ReturnType<Page['locator']>['elementHandles']>> = [];
  /* Flipped immediately before the click, and read in the catch below. Everything up to that point
     is inspection: reading labels, probing for a challenge. If any of it throws - an SPA re-render
     destroying the execution context mid-read is the likely one, and it is the same re-render the
     retry exists to ride out - then no click happened, and a plain Error would reach fail() as
     neither captcha nor no-control and take the uncertainAfterClaim branch: "the final submission
     was attempted... check the portal or your email", for a run that never pressed anything. */
  let clicked = false;
  try {
    handles = await page.locator(SUBMIT_CANDIDATE_SELECTOR).elementHandles();
    let labels = await Promise.all(handles.map((handle) => handle.evaluate(READ_CONTROL_LABEL)));
    let chosen = chooseSubmitControl(labels);

    /* ONE RETRY, and it is not defensive padding. Plenty of ATS forms render the final button
       DISABLED until async client-side validation settles after the fill, and the disabled filter
       reads once, synchronously. The old getByRole().click() waited out that window through
       Playwright's actionability check; reading labels does not, so without this a form that used
       to submit itself quietly becomes a manual handoff.
       INSIDE the try, so the handles it acquires are reachable by the finally even if the wait or
       the second read throws - which is likeliest during exactly the re-render this rides out. */
    if (chosen === null) {
      await page.waitForTimeout(SUBMIT_ENABLE_WAIT_MS);
      await Promise.all(handles.map((handle) => handle.dispose().catch(() => undefined)));
      handles = await page.locator(SUBMIT_CANDIDATE_SELECTOR).elementHandles();
      labels = await Promise.all(handles.map((handle) => handle.evaluate(READ_CONTROL_LABEL)));
      chosen = chooseSubmitControl(labels);
    }

    /* THE CAPTCHA PROBE COMES FIRST, before the no-control throw, and the order is the point. A
       challenge routinely suppresses the form entirely, so the page has no submit control BECAUSE
       of the challenge. Reporting "we could not find the button" there hides the one thing the
       applicant can act on, and discards the provider while the page is still open. This mirrors
       fail()'s own precedence, where captchaStop outranks noSubmitControl. */
    if (await hasUnresolvedCaptcha(page)) {
      throw new CaptchaUnresolvedError('at_submit', await detectCaptchaProvider(page));
    }
    if (chosen === null) {
      /* A page whose only apply-ish controls are third-party handoffs, or which renders no controls
         at all, is a page this run cannot finish - and saying so as a type fail() recognises is the
         honest answer. */
      throw new NoSubmitControlError();
    }
    /* Defence in depth, and it covers a case the call-site gate cannot. portalCanAutoSubmit() stops
       the families KNOWN to be gated (JazzHR, BambooHR) before this function is ever reached. It
       knows nothing about a Greenhouse or Lever board whose employer switched a challenge on last
       week. Pressing submit under an unsolved challenge does not just fail: it submits the
       applicant as bot traffic, and the posting can discard it with no error shown to anyone.
       NOTE: this guard only covers the direct-Playwright path. The managed-Stratus path in
       submissionRunner never builds a Page, so it never reaches here. */
    const button = handles[chosen]!;
    /* Read the label again, off the same node, immediately before pressing it. The handle cannot
       drift to a different element, but the element itself can be relabelled by a re-render, and
       the cost of being wrong here is clicking a handoff on a real application. */
    const finalLabel = await button.evaluate(READ_CONTROL_LABEL);
    if (chooseSubmitControl([finalLabel]) === null) {
      throw new NoSubmitControlError(
        `The submit button changed to "${finalLabel}" before it could be pressed`,
      );
    }
    /* THE BARRIER IS ARMED BEFORE THE CLICK, and that ordering is the whole reason this exists.
       noWaitAfter (below) is what makes "a TimeoutError from click() is pre-dispatch" true rather
       than merely plausible - by default click() awaits scheduled navigations after dispatching,
       inside the same deadline, so a slow confirmation page produced a POST-dispatch timeout that
       got reported as "nothing was sent", and the applicant re-applied into a duplicate.
       But turning that wait off ALSO removes the barrier Playwright had armed before dispatch, and
       without it waitForLoadState resolves against the document we are still standing on: measured
       on an ATS-shaped form, 10 of 15 runs then read the open form rather than the confirmation,
       readReceipt threw, and a genuinely submitted application was reported as unverified. So the
       navigation promise is created HERE, before anything is pressed, and awaited after.
       Five seconds, not twenty: a portal that submits over XHR never navigates at all, and that
       path should not pay a twenty-second wait for a navigation that is never coming. */
    const navigation = page
      .waitForNavigation({ waitUntil: 'networkidle', timeout: 5_000 })
      .catch(() => undefined);
    clicked = true;
    await button.click({ noWaitAfter: true });
    await navigation;
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  } catch (error) {
    if (error instanceof CaptchaUnresolvedError || error instanceof NoSubmitControlError) throw error;
    /* A TIMEOUT FROM click() IS PRE-DISPATCH, and this is the likelier half of the problem. The
       flag is set before the call because the click is the boundary, but Playwright's actionability
       wait fails BEFORE dispatching anything - an obscured button under a cookie banner or a sticky
       consent footer is a routine headless failure, more common than finding no control at all.
       Treating it as "maybe sent" tells the applicant to go looking for a confirmation that cannot
       exist, which is the exact harm this whole change exists to remove. A non-timeout failure
       after the click genuinely might have sent, and stays on the uncertain branch. */
    /* A detached, invisible or disabled element throws a PLAIN Error, not a TimeoutError, and it is
       just as provably pre-dispatch: Playwright reports "Element is not attached to the DOM" from
       the actionability check, before any event is sent. That is the SPA-re-render case the retry
       above exists for, and Ashby and Workable are both React. */
    const message = (error as Error)?.message ?? '';
    const preDispatch = (error as Error)?.name === 'TimeoutError'
      || /not attached to the DOM|Element is not visible|Element is not enabled/i.test(message);
    if (!clicked || preDispatch) {
      throw new NoSubmitControlError(
        `Litos could not press the submit button: ${message || 'unknown error'}`,
      );
    }
    throw error;
  } finally {
    /* EVERY path, including the two throws above and a click that times out. Disposal was on three
       of six exits before; the browser is closed by the caller either way, so this is hygiene
       rather than a live leak, but "hygiene that happens to be covered elsewhere" is how a leak
       gets in later. */
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => undefined)));
  }
}

export async function readReceipt(page: Page): Promise<{ confirmationText: string; finalUrl: string; referenceId?: string }> {
  /* THE AUTO-WAIT HERE IS LOAD-BEARING, and it is not obvious from this line.
   * clickFinalSubmit arms a 5-second navigation barrier before pressing submit. When an employer's
   * POST takes longer than that the barrier expires, and the only thing then carrying the read
   * across the still-pending navigation is `locator.innerText()`, which auto-waits and retries -
   * verified at 7s and 12s server latency. Replacing this with a non-auto-waiting read
   * (`page.content()`, an `evaluate`) would silently reintroduce the stale-read bug: the form would
   * be scraped instead of the confirmation, and a submitted application would be reported as
   * unverified. Measured before the barrier existed: 10 stale reads in 15 runs. */
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
  if (!/thank you|application (?:has been )?(?:submitted|received)|we received your application|success/i.test(body)) {
    throw new Error('The company never showed a confirmation we could check');
  }
  return { confirmationText: body.slice(0, 1000), finalUrl: page.url(), referenceId: receiptReference(body) };
}
