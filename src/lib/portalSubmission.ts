import type { Page } from 'playwright-core';

export type SupportedPortal = 'greenhouse' | 'lever' | 'ashby' | 'controlled_test';

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
  questions: Array<{ question: string; answer: string }>;
};

export type FillResult = {
  filledFields: string[];
  blockers: string[];
};

const HOSTS: Record<Exclude<SupportedPortal, 'controlled_test'>, RegExp> = {
  greenhouse: /(^|\.)greenhouse\.io$/i,
  lever: /(^|\.)lever\.co$/i,
  ashby: /(^|\.)ashbyhq\.com$/i,
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
    return 'controlled_test';
  }
  throw new Error('This portal is not supported yet. Supported portals are Greenhouse, Lever, and Ashby.');
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

async function uploadFirst(page: Page, selectors: string[], packet: SubmissionPacket, out: string[]) {
  for (const selector of selectors) {
    const field = page.locator(selector).first();
    if ((await field.count()) > 0) {
      await field.setInputFiles({ name: packet.resumeName, mimeType: 'application/pdf', buffer: packet.resume });
      out.push('resume');
      return;
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
  if (portal === 'greenhouse' || portal === 'controlled_test') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['#first_name', 'input[name="job_application[first_name]"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['#last_name', 'input[name="job_application[last_name]"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['#email', 'input[name="job_application[email]"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['#phone', 'input[name="job_application[phone]"]'], packet.phone, 'phone', filledFields);
    await fillFirst(page, ['#candidate-location', 'input[autocomplete="address-level2"]'], packet.city, 'location', filledFields);
    await uploadFirst(page, ['#resume', 'input[type="file"][name="job_application[resume]"]'], packet, filledFields);
  } else if (portal === 'lever') {
    await fillFirst(page, ['input[name="name"]'], packet.fullName, 'name', filledFields);
    await fillFirst(page, ['input[name="email"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="phone"]'], packet.phone, 'phone', filledFields);
    await fillFirst(page, ['input[name="urls[LinkedIn]"]'], packet.linkedinUrl, 'linkedin', filledFields);
    await fillFirst(page, ['input[name="urls[GitHub]"]'], packet.githubUrl, 'github', filledFields);
    await fillFirst(page, ['input[name="urls[Portfolio]"]'], packet.portfolioUrl, 'portfolio', filledFields);
    await uploadFirst(page, ['input[name="resume"][type="file"]'], packet, filledFields);
  } else {
    await fillFirst(page, ['input[name="_systemfield_name"]'], packet.fullName, 'name', filledFields);
    await fillFirst(page, ['input[name="_systemfield_email"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="_systemfield_phone"]'], packet.phone, 'phone', filledFields);
    await fillFirst(page, ['input[name="_systemfield_location"]'], packet.city, 'location', filledFields);
    await uploadFirst(page, ['input[type="file"]'], packet, filledFields);
  }
  await fillReviewedQuestions(page, packet, filledFields);

  const blockers: string[] = [];
  if ((await page.locator('iframe[src*="captcha" i], [class*="captcha" i], [id*="captcha" i]').count()) > 0) {
    blockers.push('CAPTCHA requires your attention');
  }
  const required = page.locator('input[required], textarea[required], select[required]');
  for (let index = 0; index < (await required.count()); index += 1) {
    const field = required.nth(index);
    if (!(await field.isVisible().catch(() => false))) continue;
    const type = await field.getAttribute('type');
    if (type === 'hidden') continue;
    const value = await field.inputValue().catch(() => '');
    if (value) continue;
    const name = (await field.getAttribute('aria-label')) ?? (await field.getAttribute('name')) ?? 'required field';
    blockers.push(`${name.slice(0, 120)} is required`);
  }
  return { filledFields, blockers: [...new Set(blockers)] };
}

export async function clickFinalSubmit(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: /submit application|submit|apply/i }).last();
  if ((await button.count()) === 0) throw new Error('Final submit control was not found');
  await button.click();
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
}

export async function readReceipt(page: Page): Promise<{ confirmationText: string; finalUrl: string; referenceId?: string }> {
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
  const match = body.match(/(?:application|confirmation|reference)\s*(?:id|number|#)?\s*[:#]?\s*([A-Z0-9-]{5,})/i);
  if (!/thank you|application (?:has been )?(?:submitted|received)|we received your application|success/i.test(body)) {
    throw new Error('The portal did not show a verifiable submission confirmation');
  }
  return { confirmationText: body.slice(0, 1000), finalUrl: page.url(), referenceId: match?.[1] };
}
