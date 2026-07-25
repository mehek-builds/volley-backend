import type { Locator, Page } from 'playwright-core';
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

async function visibleOtpField(page: Page): Promise<Locator | null> {
  const fields = page.locator(OTP_SELECTORS);
  for (let index = 0; index < await fields.count(); index += 1) {
    const field = fields.nth(index);
    if (await field.isVisible().catch(() => false)) return field;
  }
  return null;
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
  findCode: typeof findComposioVerificationCode;
}): Promise<VerificationCodeMatch | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const match = await options.findCode({
      userId: options.userId,
      portalUrl: options.portalUrl,
      requestedAt: options.requestedAt,
    }).catch(() => null);
    if (match) return match;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return null;
}

export async function completeEmailVerificationIfPresent(options: {
  page: Page;
  userId: string;
  portalUrl: string;
  requestedAt: Date;
  permissionGranted: boolean;
  findCode?: typeof findComposioVerificationCode;
}): Promise<BrowserVerificationResult> {
  const field = await visibleOtpField(options.page);
  if (!field) return { status: 'not_needed' };
  if (!options.permissionGranted) return { status: 'handoff' };

  const match = await waitForCode({
    userId: options.userId,
    portalUrl: options.portalUrl,
    requestedAt: options.requestedAt,
    findCode: options.findCode ?? findComposioVerificationCode,
  });
  if (!match) return { status: 'handoff' };

  await field.fill(match.code);
  await options.page.waitForTimeout(400);
  if (!await field.isVisible().catch(() => false)) return { status: 'completed', provider: match.provider };

  const continueButton = await safeContinueButton(field);
  if (!continueButton) {
    await field.fill('').catch(() => undefined);
    return { status: 'handoff' };
  }
  const beforeUrl = options.page.url();
  await continueButton.click();
  await options.page.waitForTimeout(1_500);
  const completed = options.page.url() !== beforeUrl || !await field.isVisible().catch(() => false);
  if (!completed) {
    await field.fill('').catch(() => undefined);
    return { status: 'handoff' };
  }
  return { status: 'completed', provider: match.provider };
}
