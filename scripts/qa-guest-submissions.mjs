#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { chromium } from 'playwright-core';

const apiBase = process.env.QA_API_BASE ?? 'http://localhost:3301';
const portalUrl = process.env.QA_PORTAL_URL ?? 'http://localhost:3300/qa/portal-submission';
const databaseUrl = process.env.DATABASE_URL;
const websiteBase = process.env.QA_WEBSITE_BASE ?? 'http://localhost:3300';
const screenshotDir = process.env.QA_SCREENSHOT_DIR;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
const browser = await chromium.launch({
  executablePath: process.env.LITOS_TEST_BROWSER_EXECUTABLE
    ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });

async function api(path, token, init = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Litos-Client': 'web',
      'X-Litos-Version': 'qa-guest-mode',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const evidence = [];
try {
  for (let run = 1; run <= 3; run += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${websiteBase}/login`, { waitUntil: 'domcontentloaded' });
    const guestButton = page.getByRole('button', { name: 'Try as a guest' });
    await guestButton.waitFor({ state: 'visible' });
    await guestButton.click();
    await page.waitForURL(/\/start(?:\?|$)/, { timeout: 15_000 });
    const session = await page.evaluate(() => ({
      token: window.localStorage.getItem('rq_token'),
      guestKey: window.localStorage.getItem('litos_guest_idempotency_v1'),
      history: window.localStorage.getItem('litos_has_history_v1'),
      mode: window.localStorage.getItem('litos_session_mode_v1'),
    }));
    assert.ok(session.token);
    assert.ok(session.guestKey);
    assert.equal(session.history, 'true');
    assert.equal(session.mode, 'guest');
    const guest = await api('/me', session.token);
    assert.equal(guest.is_guest, true);
    assert.ok(Date.parse(guest.trial_ends_at) > Date.now() + 6 * 24 * 60 * 60 * 1000);

    const resumed = await api('/auth/guest', null, {
      method: 'POST',
      body: JSON.stringify({ idempotency_key: session.guestKey }),
    });
    assert.equal(resumed.is_guest, true);

    const keyHash = createHash('sha256').update(session.guestKey).digest('hex');
    const userResult = await client.query(
      'select id, trial_ends_at from users where guest_key_hash = $1 and is_guest = true',
      [keyHash],
    );
    assert.equal(userResult.rowCount, 1);
    const userId = userResult.rows[0].id;
    const applicationId = randomUUID();
    const now = new Date().toISOString();
    const email = `guest-${run}@controlled.trylitos.test`;
    const spec = {
      school: 'Litos Test University',
      degree: 'Computer Science',
      grad_date: '2027',
      coursework: '',
      experience: [],
      skills: ['TypeScript'],
      _contact: { full_name: `Guest Tester ${run}`, email },
      _review: {
        jd_text: 'Controlled software engineering internship used only for Litos submission QA.',
        role: 'Software Engineering Intern',
        portal_url: portalUrl,
        ats_name: 'controlled_test',
        status: 'ready_to_submit',
        edited_terms: [],
        questions: [],
        skipped_reasons: [],
        updated_at: now,
      },
    };
    await client.query(
      'insert into generated_resumes (id, user_id, job_context, spec, resume_object_key) values ($1, $2, $3::jsonb, $4::jsonb, $5)',
      [applicationId, userId, JSON.stringify({ company: 'Litos Controlled QA', role: 'Software Engineering Intern' }), JSON.stringify(spec), `qa/${applicationId}.pdf`],
    );

    const meDuringTrial = await api('/me', session.token);
    assert.equal(meDuringTrial.is_guest, true);
    assert.equal(meDuringTrial.tier, 'trial');

    const prepared = await api(`/applications/${applicationId}/submit-request`, session.token, {
      method: 'POST',
      body: JSON.stringify({ questions: [] }),
    });
    assert.equal(prepared.review.status, 'ready_for_final_approval');
    assert.ok(prepared.review.filled_fields.includes('first_name'));
    assert.ok(prepared.review.filled_fields.includes('last_name'));
    assert.ok(prepared.review.filled_fields.includes('email'));
    assert.ok(prepared.review.filled_fields.includes('resume'));

    await page.goto(`${websiteBase}/dashboard/applications?application=${applicationId}`, { waitUntil: 'domcontentloaded' });
    const submitButton = page.getByRole('button', { name: 'Submit application' });
    await submitButton.waitFor({ state: 'visible', timeout: 15_000 });
    await submitButton.click();
    await page.getByText('Application submitted.').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByText('LITOS-QA-2027', { exact: true }).waitFor({ state: 'visible' });
    const submissionScreenshot = screenshotDir ? `${screenshotDir}/guest-submission-${run}.png` : undefined;
    if (submissionScreenshot) await page.screenshot({ path: submissionScreenshot, fullPage: true });

    const finalState = await api(`/applications/${applicationId}/submission`, session.token);
    assert.equal(finalState.review.status, 'submitted');
    assert.match(finalState.review.receipt.confirmation_text, /thank you|received/i);
    assert.equal(finalState.review.receipt.reference_id, 'LITOS-QA-2027');

    await client.query("update users set trial_ends_at = now() - interval '1 minute' where id = $1", [userId]);
    const meAfterTrial = await api('/me', session.token);
    assert.equal(meAfterTrial.tier, 'free');
    assert.match(meAfterTrial.upgrade_url, /^https:\/\/buy\.stripe\.com\//);
    await page.goto(`${websiteBase}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'Upgrade to Pro' }).waitFor({ state: 'visible', timeout: 15_000 });
    const proScreenshot = screenshotDir ? `${screenshotDir}/guest-pro-offer-${run}.png` : undefined;
    if (proScreenshot) await page.screenshot({ path: proScreenshot, fullPage: true });
    await page.evaluate(() => {
      window.localStorage.removeItem('rq_token');
      window.localStorage.removeItem('rq_email');
      window.localStorage.removeItem('litos_session_mode_v1');
      window.localStorage.removeItem('litos_guest_idempotency_v1');
    });
    await page.goto(`${websiteBase}/login`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Continue with email' }).waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: 'Try as a guest' }).count(), 0);

    evidence.push({
      run,
      user_id: userId,
      application_id: applicationId,
      guest_session_resumed: true,
      trial_tier_before_expiry: meDuringTrial.tier,
      prepared_status: prepared.review.status,
      filled_fields: prepared.review.filled_fields,
      submitted_status: finalState.review.status,
      receipt_reference: finalState.review.receipt.reference_id,
      tier_after_expiry: meAfterTrial.tier,
      pro_offer_present_after_expiry: Boolean(meAfterTrial.upgrade_url),
      first_run_guest_entry_visible: true,
      guest_history_marker_written: true,
      guest_entry_hidden_on_return: true,
      submission_screenshot: submissionScreenshot,
      pro_offer_screenshot: proScreenshot,
    });
    await context.close();
  }
} finally {
  await Promise.all([browser.close(), client.end()]);
}

const result = { passed: true, runs: evidence };
if (process.env.QA_EVIDENCE_PATH) {
  await writeFile(process.env.QA_EVIDENCE_PATH, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result, null, 2));
