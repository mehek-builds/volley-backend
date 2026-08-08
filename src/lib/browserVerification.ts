import type { Locator, Page } from 'playwright-core';
import type { ManagedBrowserAction, ManagedBrowserResult } from './browserbase';
import { findComposioVerificationCode, type VerificationCodeMatch } from './emailVerification';

const OTP_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="verification" i][inputmode="numeric"]',
  'input[id*="verification" i][inputmode="numeric"]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name*="security-code" i]',
  'input[id*="security-code" i]',
].join(', ');

const SAFE_CONTINUE_BUTTON = /^(?:verify|verify code|confirm|confirm code|continue|next)$/i;

export type BrowserVerificationResult = {
  status: 'not_needed' | 'completed' | 'handoff';
  provider?: 'gmail' | 'outlook';
};

async function visibleOtpFields(page: Page): Promise<Locator[]> {
  const fields = page.locator(OTP_SELECTORS);
  const visible: Locator[] = [];
  for (let index = 0; index < await fields.count(); index += 1) {
    const field = fields.nth(index);
    if (await field.isVisible().catch(() => false)) visible.push(field);
  }
  return visible;
}
async function safeContinueButton(field: Locator): Promise<Locator | null> {
  const form = field.locator('xpath=ancestor::form[1]');
  if (await form.count() === 0) return null;
  const buttons = form.getByRole('button');
  for (let index = 0; index < await buttons.count(); index += 1) {
    const button = buttons.nth(index);
    const label = (await button.innerText().catch(() => '')).trim();
    if (SAFE_CONTINUE_BUTTON.test(label) && await button.isVisible().catch(() => false)) return button;
  }
  return null;
}

async function waitForCode(options: {
  userId: string;
  portalUrl: string;
  requestedAt: Date;
  expectedRecipient?: string;
  applicationId?: string;
  attempts?: number;
  delayMs?: number;
  findCode: typeof findComposioVerificationCode;
}): Promise<VerificationCodeMatch | null> {
  const attempts = Math.min(Math.max(options.attempts ?? 3, 1), 30);
  const delayMs = Math.min(Math.max(options.delayMs ?? 2_000, 0), 5_000);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const match = await options.findCode({
      userId: options.userId,
      portalUrl: options.portalUrl,
      requestedAt: options.requestedAt,
      expectedRecipient: options.expectedRecipient,
      applicationId: options.applicationId,
    }).catch(() => null);
    if (match) return match;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function fillVisibleOtpFields(fields: Locator[], code: string): Promise<void> {
  const split = fields.length >= code.length && await Promise.all(fields.slice(0, code.length).map(async (field) => {
    const maxLength = await field.getAttribute('maxlength').catch(() => null);
    return maxLength === '1';
  })).then((values) => values.every(Boolean));
  if (split) {
    for (let index = 0; index < code.length; index += 1) await fields[index].fill(code[index]);
    return;
  }
  await fields[0].fill(code);
}

async function clearVisibleOtpFields(fields: Locator[]): Promise<void> {
  await Promise.all(fields.map((field) => field.fill('').catch(() => undefined)));
}

const MANAGED_VERIFICATION_SINGLE_SELECTOR = [
  'input[autocomplete="one-time-code"]:not([maxlength="1"])',
  'input[name*="verification" i]:not([maxlength="1"])',
  'input[id*="verification" i]:not([maxlength="1"])',
  'input[name*="otp" i]:not([maxlength="1"])',
  'input[id*="otp" i]:not([maxlength="1"])',
  'input[name*="security-code" i]:not([maxlength="1"])',
  'input[id*="security-code" i]:not([maxlength="1"])',
].join(', ');

const MANAGED_VERIFICATION_PAGE = /(?:enter|type|provide|sent|email|check)[\s\S]{0,100}(?:verification|security|authentication|confirmation|one[ -]?time|passcode|otp)[\s\S]{0,40}code|(?:verification|security|authentication|confirmation|one[ -]?time|passcode|otp)[\s\S]{0,40}code[\s\S]{0,100}(?:sent|email|inbox|continue)/i;

export function managedResultNeedsEmailVerification(result: ManagedBrowserResult): boolean {
  return MANAGED_VERIFICATION_PAGE.test([
    result.title,
    result.text,
    ...(result.blockers ?? []),
  ].join('\n'));
}

export function buildManagedVerificationActions(code: string): ManagedBrowserAction[] {
  const actions: ManagedBrowserAction[] = [{
    type: 'fill',
    selector: MANAGED_VERIFICATION_SINGLE_SELECTOR,
    value: code,
    label: 'email_verification_code_single',
    optional: true,
  }];
  for (let index = 0; index < code.length; index += 1) {
    actions.push({
      type: 'fill',
      selector: `:nth-match(input[maxlength="1"], ${index + 1})`,
      value: code[index],
      label: `email_verification_code_character_${index + 1}`,
      optional: true,
    });
  }
  actions.push({
    type: 'click',
    selector: 'button[type="submit"], input[type="submit"]',
    label: 'continue_email_verification',
  });
  return actions;
}

export async function prepareManagedEmailVerification(options: {
  result: ManagedBrowserResult;
  userId: string;
  portalUrl: string;
  requestedAt: Date;
  permissionGranted: boolean;
  expectedRecipient?: string;
  applicationId?: string;
  attempts?: number;
  delayMs?: number;
  findCode?: typeof findComposioVerificationCode;
}): Promise<
  | { status: 'not_needed' | 'handoff' }
  | { status: 'ready'; provider: VerificationCodeMatch['provider']; actions: ManagedBrowserAction[] }
> {
  if (!managedResultNeedsEmailVerification(options.result)) return { status: 'not_needed' };
  if (!options.permissionGranted) return { status: 'handoff' };
  const match = await waitForCode({
    userId: options.userId,
    portalUrl: options.portalUrl,
    requestedAt: options.requestedAt,
    expectedRecipient: options.expectedRecipient,
    applicationId: options.applicationId,
    attempts: options.attempts,
    delayMs: options.delayMs,
    findCode: options.findCode ?? findComposioVerificationCode,
  });
  if (!match) return { status: 'handoff' };
  return { status: 'ready', provider: match.provider, actions: buildManagedVerificationActions(match.code) };
}

export async function completeEmailVerificationIfPresent(options: {
  page: Page;
  userId: string;
  portalUrl: string;
  requestedAt: Date;
  permissionGranted: boolean;
  expectedRecipient?: string;
  applicationId?: string;
  findCode?: typeof findComposioVerificationCode;
}): Promise<BrowserVerificationResult> {
  const fields = await visibleOtpFields(options.page);
  const field = fields[0];
  if (!field) return { status: 'not_needed' };
  if (!options.permissionGranted) return { status: 'handoff' };

  const match = await waitForCode({
    userId: options.userId,
    portalUrl: options.portalUrl,
    requestedAt: options.requestedAt,
    expectedRecipient: options.expectedRecipient,
    applicationId: options.applicationId,
    findCode: options.findCode ?? findComposioVerificationCode,
  });
  if (!match) return { status: 'handoff' };

  await fillVisibleOtpFields(fields, match.code);
  await options.page.waitForTimeout(400);
  if (!(await visibleOtpFields(options.page)).length) return { status: 'completed', provider: match.provider };

  const continueButton = await safeContinueButton(field);
  if (!continueButton) {
    await clearVisibleOtpFields(fields);
    return { status: 'handoff' };
  }
  const beforeUrl = options.page.url();
  await continueButton.click();
  await options.page.waitForTimeout(1_500);
  const completed = options.page.url() !== beforeUrl || !(await visibleOtpFields(options.page)).length;
  if (!completed) {
    await clearVisibleOtpFields(fields);
    return { status: 'handoff' };
  }
  return { status: 'completed', provider: match.provider };
}
