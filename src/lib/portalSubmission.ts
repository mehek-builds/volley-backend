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

type PortalFamily = 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters';
type ControlledPortal = 'controlled_test' | 'controlled_lever' | 'controlled_ashby' | 'controlled_smartrecruiters';
export type SupportedPortal = PortalFamily | ControlledPortal;

function portalFamily(portal: SupportedPortal): PortalFamily {
  if (portal === 'controlled_test') return 'greenhouse';
  if (portal === 'controlled_lever') return 'lever';
  if (portal === 'controlled_ashby') return 'ashby';
  if (portal === 'controlled_smartrecruiters') return 'smartrecruiters';
  return portal;
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
const SMARTRECRUITERS_FIRST_NAME_SELECTOR = '[id="first-name-input"], spl-input#first-name-input input';
const SMARTRECRUITERS_LAST_NAME_SELECTOR = '[id="last-name-input"], spl-input#last-name-input input';
const SMARTRECRUITERS_EMAIL_SELECTOR = '[id="email-input"], spl-input#email-input input';
const SMARTRECRUITERS_CONFIRM_EMAIL_SELECTOR = '[id="confirm-email-input"], spl-input#confirm-email-input input';
const SMARTRECRUITERS_LINKEDIN_SELECTOR = '[id="linkedin-input"], spl-input#linkedin-input input';
const SMARTRECRUITERS_WEBSITE_SELECTOR = '[id="website-input"], spl-input#website-input input';
const ASHBY_RESUME_SELECTOR = 'input#_systemfield_resume[type="file"], input[type="file"][name="_systemfield_resume"], input[type="file"][name*="resume" i]';
const ASHBY_COVER_LETTER_SELECTOR = 'input#cover_letter[type="file"], input[type="file"][id*="cover" i], input[type="file"][name*="cover" i], input[type="file"][aria-label*="cover" i]';

const COVER_LETTER_UPLOAD_SELECTORS: Record<SupportedPortal, string> = {
  greenhouse: 'input#cover_letter[type="file"], input[type="file"][name*="cover_letter" i], input[type="file"][id*="cover_letter" i], label:has-text("Cover Letter") input[type="file"]',
  lever: 'input[type="file"][name*="cover" i], input[type="file"][id*="cover" i], label:has-text("Cover Letter") input[type="file"]',
  ashby: ASHBY_COVER_LETTER_SELECTOR,
  smartrecruiters: 'spl-dropzone[data-test*="cover" i] input[type="file"], input[type="file"][name*="cover" i], label:has-text("Cover Letter") input[type="file"]',
  controlled_test: 'input[type="file"][name*="cover" i], input[type="file"][id*="cover" i], label:has-text("Cover Letter") input[type="file"]',
  controlled_lever: 'input[type="file"][name*="cover" i], input[type="file"][id*="cover" i], label:has-text("Cover Letter") input[type="file"]',
  controlled_ashby: ASHBY_COVER_LETTER_SELECTOR,
  controlled_smartrecruiters: 'input[type="file"][name*="cover" i], input[type="file"][id*="cover" i], label:has-text("Cover Letter") input[type="file"]',
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
    managedFill(actions, SMARTRECRUITERS_FIRST_NAME_SELECTOR, parts[0], 'first_name');
    managedFill(actions, SMARTRECRUITERS_LAST_NAME_SELECTOR, parts.slice(1).join(' '), 'last_name');
    managedFill(actions, SMARTRECRUITERS_EMAIL_SELECTOR, packet.email, 'email');
    managedFill(actions, SMARTRECRUITERS_CONFIRM_EMAIL_SELECTOR, packet.email, 'confirm_email');
    managedFill(actions, SMARTRECRUITERS_PHONE_SELECTOR, packet.phone, 'phone');
    managedFill(actions, SMARTRECRUITERS_LINKEDIN_SELECTOR, packet.linkedinUrl, 'linkedin');
    managedFill(actions, SMARTRECRUITERS_WEBSITE_SELECTOR, packet.portfolioUrl ?? packet.githubUrl, 'portfolio');
    managedUpload(actions, SMARTRECRUITERS_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
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
  if (submit) actions.push({ type: 'click', selector: 'button[type="submit"], input[type="submit"]' });
  return actions;
}

export function readManagedReceipt(result: ManagedBrowserResult): {
  confirmationText: string;
  finalUrl: string;
  referenceId?: string;
} {
  const body = result.text.replace(/\s+/g, ' ').trim();
  if (!/thank you|application (?:has been )?(?:submitted|received)|we received your application|success/i.test(body)) {
    throw new Error('The portal did not show a verifiable submission confirmation');
  }
  return { confirmationText: body.slice(0, 1000), finalUrl: result.url, referenceId: receiptReference(body) };
}

const HOSTS: Record<PortalFamily, RegExp> = {
  greenhouse: /(^|\.)greenhouse\.io$/i,
  lever: /(^|\.)lever\.co$/i,
  ashby: /(^|\.)ashbyhq\.com$/i,
  smartrecruiters: /(^|\.)smartrecruiters\.com$/i,
};

export function detectPortal(rawUrl: string): SupportedPortal {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('Application portal must use HTTPS');
  for (const [portal, host] of Object.entries(HOSTS)) {
    if (host.test(url.hostname)) return portal as SupportedPortal;
  }
  if (
    process.env.LITOS_ENABLE_TEST_PORTAL === 'true' &&
    (url.hostname === 'trylitos.com' || url.hostname === 'www.trylitos.com' || url.hostname === 'localhost') &&
    url.pathname.startsWith('/qa/portal-submission')
  ) {
    const pathBoard = url.pathname.split('/').filter(Boolean)[2];
    const board = (url.searchParams.get('board') ?? pathBoard)?.toLowerCase();
    if (board === 'lever') return 'controlled_lever';
    if (board === 'ashby') return 'controlled_ashby';
    if (board === 'smartrecruiters') return 'controlled_smartrecruiters';
    return 'controlled_test';
  }
  throw new Error('This portal is not supported yet. Supported portals are Greenhouse, Lever, Ashby, and SmartRecruiters.');
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
    await fillFirst(page, [SMARTRECRUITERS_FIRST_NAME_SELECTOR], parts[0], 'first_name', filledFields);
    await fillFirst(page, [SMARTRECRUITERS_LAST_NAME_SELECTOR], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, [SMARTRECRUITERS_EMAIL_SELECTOR], packet.email, 'email', filledFields);
    await fillFirst(page, [SMARTRECRUITERS_CONFIRM_EMAIL_SELECTOR], packet.email, 'confirm_email', filledFields);
    await fillFirst(page, [SMARTRECRUITERS_PHONE_SELECTOR], packet.phone, 'phone', filledFields);
    await fillFirst(page, [SMARTRECRUITERS_LINKEDIN_SELECTOR], packet.linkedinUrl, 'linkedin', filledFields);
    await fillFirst(page, [SMARTRECRUITERS_WEBSITE_SELECTOR], packet.portfolioUrl ?? packet.githubUrl, 'portfolio', filledFields);
    await uploadFirst(page, [SMARTRECRUITERS_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields);
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
  if ((await button.count()) === 0) throw new Error('Final submit control was not found');
  await button.click();
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
}

export async function readReceipt(page: Page): Promise<{ confirmationText: string; finalUrl: string; referenceId?: string }> {
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
  if (!/thank you|application (?:has been )?(?:submitted|received)|we received your application|success/i.test(body)) {
    throw new Error('The portal did not show a verifiable submission confirmation');
  }
  return { confirmationText: body.slice(0, 1000), finalUrl: page.url(), referenceId: receiptReference(body) };
}
