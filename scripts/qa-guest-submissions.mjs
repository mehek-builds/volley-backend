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
const runCount = Number(process.env.QA_RUNS ?? '3');
const autoApply = process.env.QA_AUTO_APPLY === '1';
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!Number.isInteger(runCount) || runCount < 1) throw new Error('QA_RUNS must be a positive integer');

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

async function waitForSubmitted(applicationId, token) {
  let current = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    current = await api(`/applications/${applicationId}/submission`, token);
    if (current.review?.status === 'submitted') return current;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return current;
}

const evidence = [];
try {
  for (let run = 1; run <= runCount; run += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${websiteBase}/login`, { waitUntil: 'domcontentloaded' });
    await client.query("delete from usage_counters where kind = 'rate:guest-create-ip'");
    const guestButton = page.getByRole('button', { name: 'Guest mode' });
    await guestButton.waitFor({ state: 'visible' });
    await guestButton.click();
    await page.waitForFunction(() => window.location.pathname === '/start', { timeout: 15_000 });
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
    if (autoApply) {
      await client.query(
        "update users set automatic_submission_enabled = true, automatic_submission_consented_at = now(), automatic_submission_consent_version = '2026-07-25' where id = $1",
        [userId],
      );
    }
    const applicationId = randomUUID();
    const now = new Date().toISOString();
    const email = `guest-${run}@controlled.trylitos.test`;
    const education = {
      school: 'Litos Test University',
      degree: 'Computer Science',
      grad_date: '2027',
      grad_year: 2027,
      currently_enrolled: true,
      coursework: [],
    };
    const spec = {
      school: education.school,
      degree: education.degree,
      grad_date: education.grad_date,
      coursework: '',
      experience: [{
        type: 'job',
        org: 'Northwind Labs',
        title: 'Software Engineering Intern',
        date_range: 'Summer 2026',
        bullets: [
          'Built TypeScript workflows that automated internal application review steps.',
          'Added dashboard states that surfaced missing applicant inputs before submit.',
          'Tested controlled portal submissions across browser and API checkpoints.',
        ],
      }],
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
      'insert into profiles (user_id, parsed_json, skills) values ($1, $2::jsonb, $3::jsonb) on conflict (user_id) do update set parsed_json = excluded.parsed_json, skills = excluded.skills',
      [userId, JSON.stringify(education), JSON.stringify(spec.skills)],
    );
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
    assert.equal(prepared.review.status, autoApply ? 'submitted' : 'ready_for_final_approval');
    assert.ok(prepared.review.filled_fields.includes('first_name'));
    assert.ok(prepared.review.filled_fields.includes('last_name'));
    assert.ok(prepared.review.filled_fields.includes('email'));
    assert.ok(prepared.review.filled_fields.includes('resume'));

    await page.goto(`${websiteBase}/dashboard/applications?application=${applicationId}`, { waitUntil: 'domcontentloaded' });
    let finalState = prepared;
    if (!autoApply) {
      const submitButton = page.getByRole('button', { name: 'Send it' });
      await submitButton.waitFor({ state: 'visible', timeout: 15_000 });
      await submitButton.click();
      finalState = await waitForSubmitted(applicationId, session.token);
    }
    assert.equal(finalState.review.status, 'submitted');
    await page.goto(`${websiteBase}/dashboard/applications?application=${applicationId}`, { waitUntil: 'domcontentloaded' });
    try {
      await page.getByText(/LITOS-QA-/).first().waitFor({ state: 'visible', timeout: 15_000 });
    } catch (error) {
      if (screenshotDir) {
        await page.screenshot({ path: `${screenshotDir}/guest-submission-${run}-missing-reference.png`, fullPage: true });
        await writeFile(`${screenshotDir}/guest-submission-${run}-missing-reference.txt`, await page.locator('body').innerText());
      }
      throw error;
    }
    const submissionScreenshot = screenshotDir ? `${screenshotDir}/guest-submission-${run}.png` : undefined;
    if (submissionScreenshot) await page.screenshot({ path: submissionScreenshot, fullPage: true });

    assert.match(finalState.review.receipt.confirmation_text, /thank you|received/i);
    assert.match(finalState.review.receipt.reference_id, /^LITOS-QA-/);

    await page.evaluate(() => {
      window.localStorage.removeItem('rq_token');
      window.localStorage.removeItem('rq_email');
      window.localStorage.removeItem('litos_session_mode_v1');
      window.localStorage.removeItem('litos_guest_idempotency_v1');
    });

    evidence.push({
      run,
      user_id: userId,
      application_id: applicationId,
      guest_session_resumed: true,
      trial_tier_before_expiry: meDuringTrial.tier,
      auto_apply: autoApply,
      prepared_status: prepared.review.status,
      filled_fields: prepared.review.filled_fields,
      submitted_status: finalState.review.status,
      receipt_reference: finalState.review.receipt.reference_id,
      first_run_guest_entry_visible: true,
      guest_history_marker_written: true,
      submission_screenshot: submissionScreenshot,
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
