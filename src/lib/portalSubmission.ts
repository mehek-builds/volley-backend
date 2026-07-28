import type { Page } from 'playwright-core';
import type { ManagedBrowserAction, ManagedBrowserResult } from './browserbase';
import { describeRequiredBlocker, describeUnlabelledBlockers, humanFieldLabel } from './fieldLabel';
import type { Locator } from 'playwright-core';

// Portal field ids legitimately contain CSS-syntax characters (Greenhouse uses UUIDs, others use
// dots and colons), so they are matched with the [id="..."] attribute form rather than #id. Inside
// a quoted attribute value only the quote and the backslash need escaping, which keeps this to one
// rule instead of a full CSS identifier escaper, and means a field id can never terminate the
// selector and match something unintended.
function quoteAttr(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

type PortalFamily = 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable' | 'jazzhr' | 'paylocity';
type ControlledPortal =
  | 'controlled_test'
  | 'controlled_lever'
  | 'controlled_ashby'
  | 'controlled_smartrecruiters'
  | 'controlled_workable'
  | 'controlled_jazzhr'
  | 'controlled_paylocity';
export type SupportedPortal = PortalFamily | ControlledPortal;

function portalFamily(portal: SupportedPortal): PortalFamily {
  if (portal === 'controlled_test') return 'greenhouse';
  if (portal === 'controlled_lever') return 'lever';
  if (portal === 'controlled_ashby') return 'ashby';
  if (portal === 'controlled_smartrecruiters') return 'smartrecruiters';
  if (portal === 'controlled_workable') return 'workable';
  if (portal === 'controlled_jazzhr') return 'jazzhr';
  if (portal === 'controlled_paylocity') return 'paylocity';
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
type CaptchaGatedFamily = 'jazzhr';

const MULTI_STEP_FAMILIES: ReadonlySet<PortalFamily> = new Set<PortalFamily>(
  ['paylocity', 'smartrecruiters'] satisfies MultiStepFamily[],
);

// Portals that gate submission behind a CAPTCHA. Litos fills these and hands off to the human; it
// never attempts the challenge (standing rule, and the same correct stop the Ashby/CTGT run made).
// Confirmed live 2026-07-28: every JazzHR application form carries a g-recaptcha-response field.
const CAPTCHA_GATED_FAMILIES: ReadonlySet<PortalFamily> = new Set<PortalFamily>(
  ['jazzhr'] satisfies CaptchaGatedFamily[],
);

export function portalCanAutoSubmit(portal: SupportedPortal): boolean {
  const family = portalFamily(portal);
  return !MULTI_STEP_FAMILIES.has(family) && !CAPTCHA_GATED_FAMILIES.has(family);
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
export type AutonomousPortalFamily = Exclude<PortalFamily, MultiStepFamily | CaptchaGatedFamily>;

export const AUTONOMOUS_PORTAL_FAMILIES = ['greenhouse', 'lever', 'ashby', 'workable'] as const satisfies readonly AutonomousPortalFamily[];

export function isAutonomousPortalFamily(value: string): value is AutonomousPortalFamily {
  return (AUTONOMOUS_PORTAL_FAMILIES as readonly string[]).includes(value);
}

// Why a run stopped short of submitting, in the student's words. Surfaced on the blocker card so
// "needs attention" reads as a known platform limit rather than an unexplained failure.
export function portalHandoffReason(portal: SupportedPortal): string | null {
  const family = portalFamily(portal);
  if (CAPTCHA_GATED_FAMILIES.has(family)) {
    return 'This company’s application page asks you to prove you are human. Litos filled everything in, so all that is left is that check and the send button.';
  }
  if (MULTI_STEP_FAMILIES.has(family)) {
    return 'Litos filled in this application and stopped on the last page. That page asks you to confirm the details are true, and it can ask about your background and your right to work, so those answers need to be yours.';
  }
  return null;
}

export type SubmissionPacket = {
  fullName: string;
  email: string;
  phone?: string;
  city?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
  resume: Buffer;
  resumeName: string;
  coverLetter?: Buffer;
  coverLetterName?: string;
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
  questions: Array<{ question: string; answer: string }>;
};

export type FillResult = {
  filledFields: string[];
  blockers: string[];
};

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
const GREENHOUSE_PHONE_SELECTOR =
  `#phone, input[name="job_application[phone]"], ${SEMANTIC_PHONE_SELECTOR}`;
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
  if (family === 'greenhouse') {
    const parts = packet.fullName.trim().split(/\s+/);
    // optional (managedFill default) + bounded, not required: a branded-redirect Greenhouse customer
    // (Jump Trading serves its posting through www.jumptrading.com with a different form DOM) has
    // none of these classic selectors, and a required fill there waited the full 30s and then
    // aborted the whole run. Optional means a missed core field degrades to a required-field blocker
    // card. The resume upload is optional + bounded for the same reason (managedUpload): the live
    // Jump Trading retry proved the run now clears name/email and stops at the resume file input.
    managedFill(actions, '#first_name, input[name="job_application[first_name]"]', parts[0], 'first_name');
    managedFill(actions, '#last_name, input[name="job_application[last_name]"]', parts.slice(1).join(' '), 'last_name');
    managedFill(actions, '#email, input[name="job_application[email]"]', packet.email, 'email');
    managedFill(actions, GREENHOUSE_PHONE_SELECTOR, packet.phone, 'phone');
    managedFill(actions, '#candidate-location, input[autocomplete="address-level2"]', packet.city, 'location');
    managedUpload(actions, '#resume, input[type="file"][name="job_application[resume]"]', 'resume', packet.resume, packet.resumeName);
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
    managedFill(actions, SMARTRECRUITERS_PHONE_SELECTOR, packet.phone, 'phone');
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
  } else {
    managedFill(actions, 'input[name="_systemfield_name"]', packet.fullName, 'name', false);
    managedFill(actions, 'input[name="_systemfield_email"]', packet.email, 'email', false);
    managedFill(actions, ASHBY_PHONE_SELECTOR, packet.phone, 'phone');
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
  // See canFillReviewedQuestions: the managed runner throws on any non-text control and ignores
  // `optional`, so a single checkbox takes down a run that had otherwise filled five fields
  // correctly. Sending none of them is what makes the run survive to a usable handoff.
  for (const item of canFillReviewedQuestions('managed') ? packet.questions : []) {
    if (!item.answer.trim()) continue;
    actions.push({
      type: 'fillByLabelText',
      text: item.question,
      value: item.answer,
      label: `question:${item.question.slice(0, 80)}`,
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
  }
  // Deliberately NOT attempted: clicking checkboxes and radios by matching their label to the
  // answer text. It would fill more of the form, and it is the obvious next step, but a short
  // generic answer ("Yes", "No") can match a label anywhere on the page, including a legal
  // acknowledgement or a consent box. Ticking the wrong consent on a real application is a harm
  // the student cannot undo, while an unanswered choice question is a blocker she resolves in
  // seconds. Choice controls stay with the human until they can be scoped to their own question.
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

  if (submit && portalCanAutoSubmit(portal)) {
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
      actions.push({
        type: 'fillByLabelText',
        text: item.question,
        value: item.answer,
        label: `question:${item.question.slice(0, 80)}`,
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      });
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
};

// Paylocity alone needs a path check as well as a host check, because its host space includes a
// login portal. Only the recruiting apply/details routes are application pages.
const PAYLOCITY_APPLY_PATH = /^\/recruiting\/jobs\/(apply|details)\//i;

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
    return 'controlled_test';
  }
  if (url.protocol !== 'https:') throw new Error('That application page is not a secure link');
  for (const [portal, host] of Object.entries(HOSTS)) {
    if (!host.test(url.hostname)) continue;
    // See PAYLOCITY_APPLY_PATH: access.paylocity.com is an employee login on the same host space.
    if (portal === 'paylocity' && !PAYLOCITY_APPLY_PATH.test(url.pathname)) continue;
    return portal as SupportedPortal;
  }
  throw new Error('Litos cannot fill in this company\u2019s application page yet. It works on Greenhouse, Lever, Ashby, SmartRecruiters, Workable, JazzHR and Paylocity.');
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

async function fillReviewedQuestions(page: Page, packet: SubmissionPacket, out: string[]) {
  for (const item of packet.questions) {
    if (!item.answer.trim()) continue;
    const label = page.getByText(item.question, { exact: false }).first();
    if ((await label.count()) === 0) continue;
    const container = label.locator('xpath=ancestor::*[self::div or self::fieldset][1]');
    const input = container.locator('textarea, input:not([type=file]):not([type=hidden])').first();
    if ((await input.count()) > 0 && (await input.isVisible().catch(() => false))) {
      await input.fill(item.answer);
      out.push(`question:${item.question.slice(0, 80)}`);
      continue;
    }
    const select = container.locator('select').first();
    if ((await select.count()) > 0) {
      await select.selectOption({ label: item.answer }).catch(() => select.selectOption(item.answer));
      out.push(`question:${item.question.slice(0, 80)}`);
    }
  }
}

export async function fillPortal(page: Page, portal: SupportedPortal, packet: SubmissionPacket): Promise<FillResult> {
  const filledFields: string[] = [];
  const family = portalFamily(portal);
  if (family === 'greenhouse') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['#first_name', 'input[name="job_application[first_name]"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['#last_name', 'input[name="job_application[last_name]"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['#email', 'input[name="job_application[email]"]'], packet.email, 'email', filledFields);
    await fillFirst(page, GREENHOUSE_PHONE_SELECTOR.split(', '), packet.phone, 'phone', filledFields);
    await fillFirst(page, ['#candidate-location', 'input[autocomplete="address-level2"]'], packet.city, 'location', filledFields);
    await uploadFirst(page, ['#resume', 'input[type="file"][name="job_application[resume]"]'], packet.resume, packet.resumeName, 'resume', filledFields);
    await uploadFirst(page, ['input#cover_letter[type="file"]', 'input[type="file"][name*="cover_letter" i]'], packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields);
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
    await fillFirst(page, [SMARTRECRUITERS_PHONE_SELECTOR], packet.phone, 'phone', filledFields);
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
  } else {
    await fillFirst(page, ['input[name="_systemfield_name"]'], packet.fullName, 'name', filledFields);
    await fillFirst(page, ['input[name="_systemfield_email"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ASHBY_PHONE_SELECTOR.split(', '), packet.phone, 'phone', filledFields);
    await fillFirst(page, ['input[name="_systemfield_location"]'], packet.city, 'location', filledFields);
    // See ASHBY_*_SELECTOR: these were missing from the direct path too, so a real Ashby run
    // reported LinkedIn as an empty required field even though the packet had it.
    await fillFirst(page, ASHBY_LINKEDIN_SELECTOR.split(', '), packet.linkedinUrl, 'linkedin', filledFields);
    await fillFirst(page, ASHBY_GITHUB_SELECTOR.split(', '), packet.githubUrl, 'github', filledFields);
    await fillFirst(page, ASHBY_PORTFOLIO_SELECTOR.split(', '), packet.portfolioUrl, 'portfolio', filledFields);
    await uploadFirst(page, ASHBY_RESUME_SELECTOR.split(', '), packet.resume, packet.resumeName, 'resume', filledFields);
    await uploadFirst(page, ASHBY_COVER_LETTER_SELECTOR.split(', '), packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields);
  }
  await fillReviewedQuestions(page, packet, filledFields);

  const blockers: string[] = [];
  if ((await page.locator('iframe[src*="captcha" i], [class*="captcha" i], [id*="captcha" i]').count()) > 0) {
    blockers.push('CAPTCHA requires your attention');
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

export async function clickFinalSubmit(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: /submit application|submit|apply/i }).last();
  if ((await button.count()) === 0) throw new Error('We could not find the Submit button');
  await button.click();
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
}

export async function readReceipt(page: Page): Promise<{ confirmationText: string; finalUrl: string; referenceId?: string }> {
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
  if (!/thank you|application (?:has been )?(?:submitted|received)|we received your application|success/i.test(body)) {
    throw new Error('The company never showed a confirmation we could check');
  }
  return { confirmationText: body.slice(0, 1000), finalUrl: page.url(), referenceId: receiptReference(body) };
}
