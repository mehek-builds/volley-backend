#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { chromium } from 'playwright-core';
import {
  assertDisposableDatabaseMarker,
  assertRemoteManagedRunner,
  assertControlledSecurityCodeTarget,
  controlledManagedReceivingProof,
  managedApplicationAlias,
  securityCodeCase,
  securityCodeMailboxUrl,
  securityCodePortalUrl,
  signedInboundRequest,
} from './qa-guest-submissions-lib.mjs';

const apiBase = process.env.QA_API_BASE ?? 'http://localhost:3301';
const portalUrl = process.env.QA_PORTAL_URL ?? 'http://localhost:3300/qa/portal-submission';
const databaseUrl = process.env.DATABASE_URL;
const websiteBase = process.env.QA_WEBSITE_BASE ?? 'http://localhost:3300';
const portalPublicBase = process.env.QA_PORTAL_PUBLIC_BASE ?? websiteBase;
const screenshotDir = process.env.QA_SCREENSHOT_DIR;
const runCount = Number(process.env.QA_RUNS ?? '3');
const autoApply = process.env.QA_AUTO_APPLY === '1';
const portalShape = process.env.QA_PORTAL_SHAPE?.trim() ?? '';
const securityCodeMode = portalShape === 'security-code';
const aliasSecret = process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET
  ?? process.env.LITOS_APPLICATION_EMAIL_SECRET
  ?? process.env.JWT_SIGNING_SECRET;
const managedDomain = process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
const inboundSecret = process.env.RESEND_WEBHOOK_SECRET
  ?? process.env.LITOS_INBOUND_EMAIL_WEBHOOK_SECRET
  ?? process.env.LITOS_APPLICATION_EMAIL_WEBHOOK_SECRET;
const qaForwardTo = process.env.QA_APPLICATION_EMAIL_FORWARD_TO;
const databaseMarker = process.env.QA_CONTROLLED_DATABASE_MARKER;
const portalBindingSecret = process.env.LITOS_TEST_PORTAL_BINDING_SECRET;
const runnerOrigin = securityCodeMode ? assertRemoteManagedRunner({
  provider: process.env.BROWSER_PROVIDER,
  baseUrl: process.env.STRATUS_BASE_URL,
  apiKey: process.env.STRATUS_API_KEY,
  oidcToken: process.env.VERCEL_OIDC_TOKEN,
  vercelEnv: process.env.VERCEL_ENV,
  expectedOrigin: process.env.QA_EXPECTED_STRATUS_ORIGIN,
}) : null;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!Number.isInteger(runCount) || runCount < 1) throw new Error('QA_RUNS must be a positive integer');
if (securityCodeMode && !autoApply) throw new Error('QA_AUTO_APPLY=1 is required for the security-code continuation trial');
if (securityCodeMode && !qaForwardTo) throw new Error('QA_APPLICATION_EMAIL_FORWARD_TO is required for the forwarding assertion');
if (securityCodeMode && !aliasSecret) throw new Error('The managed application-email alias secret is required');
if (securityCodeMode && !managedDomain) throw new Error('LITOS_RESEND_MANAGED_RECEIVING_DOMAIN is required');
if (securityCodeMode && !inboundSecret) throw new Error('The inbound application-email webhook secret is required');
if (securityCodeMode) {
  assertControlledSecurityCodeTarget({
    apiBase,
    websiteBase,
    portalPublicBase,
    databaseConfirmed: process.env.QA_CONTROLLED_DATABASE === '1',
    publicPortalConfirmed: process.env.QA_CONTROLLED_PORTAL_PUBLIC === '1',
    databaseUrl,
    databaseMarker,
    portalBindingSecret,
    configuredPortalOrigin: process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN,
  });
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
const browser = await chromium.launch({
  executablePath: process.env.LITOS_TEST_BROWSER_EXECUTABLE
    ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });

function errorDetail(error) {
  if (!(error instanceof Error)) return String(error);
  const details = [error.message];
  const cause = error.cause;
  if (cause && typeof cause === 'object') {
    if (typeof cause.code === 'string') details.push(cause.code);
    if (Array.isArray(cause.errors)) {
      for (const nested of cause.errors.slice(0, 3)) {
        if (nested && typeof nested === 'object') {
          const address = typeof nested.address === 'string' ? nested.address : '';
          const port = typeof nested.port === 'number' ? `:${nested.port}` : '';
          const code = typeof nested.code === 'string' ? nested.code : 'network_error';
          details.push(`${code} ${address}${port}`.trim());
        }
      }
    }
  }
  return [...new Set(details.filter(Boolean))].join('; ').slice(0, 1000);
}

async function api(path, token, init = {}) {
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Litos-Client': 'web',
        'X-Litos-Version': 'qa-guest-mode',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    throw new Error(`${path} request failed: ${errorDetail(error)}`);
  }
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

async function readSecurityCode(caseId) {
  const response = await fetch(securityCodeMailboxUrl(portalPublicBase, caseId), {
    headers: { 'Cache-Control': 'no-store' },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body.code !== 'string' || body.code.length < 6) {
    throw new Error(`controlled mailbox returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body.code;
}

async function injectSecurityCodeEmail({ alias, applicationId, caseId, run }) {
  const code = await readSecurityCode(caseId);
  const payload = {
    provider: 'litos-controlled-portal',
    provider_message_id: `qa-security-code-${applicationId}-${randomUUID()}`,
    from: 'no-reply@greenhouse.io',
    to: [alias],
    subject: 'Your Greenhouse application security code',
    text: `Your security code is ${code}. It expires soon.`,
    html: `<p>Your security code is <strong>${code}</strong>. It expires soon.</p>`,
    received_at: new Date().toISOString(),
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    qa: { application_id: applicationId, case_id: caseId, run },
  };
  const signed = signedInboundRequest(payload, inboundSecret);
  const response = await fetch(`${apiBase}/webhooks/application-email/inbound`, {
    method: 'POST',
    headers: signed.headers,
    body: signed.body,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`signed inbound email returned ${response.status}: ${JSON.stringify(body)}`);
  assert.equal(body.accepted, true);
  assert.equal(body.classification, 'verification_code');
  assert.equal(body.forwarded, true);
  return { code, response: body };
}

async function forwardedVerificationMessage(applicationId, alias) {
  const result = await client.query(
    `select alias, generated_resume_id, direction, classification, forwarded_at, forward_error
       from application_email_messages
      where generated_resume_id = $1 and alias = $2
      order by created_at desc
      limit 1`,
    [applicationId, alias],
  );
  assert.equal(result.rowCount, 1);
  const row = result.rows[0];
  assert.equal(row.alias, alias);
  assert.equal(row.generated_resume_id, applicationId);
  assert.equal(row.direction, 'forwarded');
  assert.equal(row.classification, 'verification_code');
  assert.ok(row.forwarded_at);
  assert.equal(row.forward_error, null);
  return row;
}

const evidence = [];
const seenSecurityCodes = new Set();
let activeRun = null;
try {
  if (securityCodeMode) {
    activeRun = { run: null, stage: 'verify_disposable_database_marker' };
    let markerResult;
    try {
      markerResult = await client.query(
        `select marker, expires_at
           from litos_qa_control
          where scope = 'security-code-e2e'
          limit 1`,
      );
    } catch (error) {
      throw new Error(`disposable QA database marker lookup failed: ${errorDetail(error)}`);
    }
    assertDisposableDatabaseMarker(markerResult.rows[0], databaseMarker);
    activeRun = { run: null, stage: 'seed_controlled_managed_receiving_proof' };
    const receivingProof = controlledManagedReceivingProof({
      routeMode: process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE,
      domain: managedDomain,
      aliasSecret,
      canaryToken: process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN,
      webhookEndpoint: process.env.LITOS_APPLICATION_EMAIL_WEBHOOK_URL,
      webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
      databaseMarker,
    });
    await client.query(
      `insert into application_email_receiving_proofs
         (provider_message_hash, route_fingerprint, proof_version, domain, verified_at)
       values ($1, $2, $3, $4, now())
       on conflict (route_fingerprint) do update
         set provider_message_hash = excluded.provider_message_hash,
             proof_version = excluded.proof_version,
             domain = excluded.domain,
             verified_at = now()`,
      [
        receivingProof.provider_message_hash,
        receivingProof.route_fingerprint,
        receivingProof.proof_version,
        receivingProof.domain,
      ],
    );
    activeRun = { run: null, stage: 'verify_managed_application_email_route' };
    const health = await api('/health');
    assert.equal(health.application_email?.deliverable, true, 'managed application email route is not deliverable');
    assert.equal(health.application_email?.domain, managedDomain, 'backend health and QA alias domain disagree');
    activeRun = null;
  }
  for (let run = 1; run <= runCount; run += 1) {
    let stage = 'open_browser_context';
    activeRun = { run, stage };
    const context = await browser.newContext();
    const page = await context.newPage();
    stage = 'create_guest_session';
    activeRun.stage = stage;
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
    if (autoApply || securityCodeMode) {
      await client.query(
        `update users
            set automatic_submission_enabled = true,
                automatic_submission_consented_at = now(),
                automatic_submission_consent_version = '2026-07-25',
                automatic_verification_enabled = $2,
                automatic_verification_consented_at = case when $2 then now() else automatic_verification_consented_at end,
                application_email_forward_to = coalesce($3, application_email_forward_to)
          where id = $1`,
        [userId, securityCodeMode, qaForwardTo ?? null],
      );
    }
    const applicationId = randomUUID();
    const now = new Date().toISOString();
    const caseId = securityCodeMode ? securityCodeCase(applicationId, run) : null;
    const runPortalUrl = securityCodeMode ? securityCodePortalUrl(portalPublicBase, caseId) : portalUrl;
    const alias = securityCodeMode
      ? managedApplicationAlias({ aliasSecret, domain: managedDomain, userId, applicationId })
      : null;
    const email = alias ?? `guest-${run}@controlled.trylitos.test`;
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
        portal_url: runPortalUrl,
        ats_name: 'controlled_test',
        status: 'ready_to_submit',
        edited_terms: [],
        questions: [],
        skipped_reasons: [],
        updated_at: now,
      },
      ...(alias ? {
        _applicant_email: {
          address: alias,
          source: 'litos_alias',
          reason: 'deliverable',
          tracked: true,
          decided_at: now,
        },
        _application_email: {
          alias,
          forwards_to: qaForwardTo,
          mode: 'litos_application_alias',
        },
      } : {}),
    };
    stage = 'seed_packet_and_alias';
    activeRun.stage = stage;
    await client.query(
      'insert into profiles (user_id, parsed_json, skills) values ($1, $2::jsonb, $3::jsonb) on conflict (user_id) do update set parsed_json = excluded.parsed_json, skills = excluded.skills',
      [userId, JSON.stringify(education), JSON.stringify(spec.skills)],
    );
    await client.query(
      'insert into generated_resumes (id, user_id, job_context, spec, resume_object_key) values ($1, $2, $3::jsonb, $4::jsonb, $5)',
      [applicationId, userId, JSON.stringify({ company: 'Litos Controlled QA', role: 'Software Engineering Intern' }), JSON.stringify(spec), `qa/${applicationId}.pdf`],
    );
    if (alias) {
      await client.query(
        `insert into application_email_aliases (alias, user_id, generated_resume_id, forward_to, status, updated_at)
         values ($1, $2, $3, $4, 'active', now())
         on conflict (alias) do update
           set forward_to = excluded.forward_to, status = 'active', updated_at = now()`,
        [alias, userId, applicationId, qaForwardTo],
      );
    }

    const meDuringTrial = await api('/me', session.token);
    assert.equal(meDuringTrial.is_guest, true);
    assert.equal(meDuringTrial.tier, 'trial');

    stage = 'submit_and_receive_verification_email';
    activeRun.stage = stage;
    const submitPromise = api(`/applications/${applicationId}/submit-request`, session.token, {
      method: 'POST',
      body: JSON.stringify({ questions: [] }),
    });
    const inboundPromise = securityCodeMode
      ? new Promise((resolve) => setTimeout(resolve, 1_000)).then(() => injectSecurityCodeEmail({
        alias,
        applicationId,
        caseId,
        run,
      }))
      : Promise.resolve(null);
    const [prepared, inboundEvidence] = await Promise.all([submitPromise, inboundPromise]);
    assert.equal(prepared.review.status, autoApply ? 'submitted' : 'ready_for_final_approval');
    assert.ok(prepared.review.filled_fields.includes('first_name'));
    assert.ok(prepared.review.filled_fields.includes('last_name'));
    assert.ok(prepared.review.filled_fields.includes('email'));
    assert.ok(prepared.review.filled_fields.includes('resume'));
    if (securityCodeMode) {
      assert.equal(prepared.review.verification?.status, 'completed');
      assert.equal(prepared.review.verification?.runner, 'stratus-managed');
      assert.equal(prepared.review.verification?.continuation_resumed, true);
      assert.match(prepared.review.verification?.continuation_fingerprint ?? '', /^[a-f0-9]{24}$/);
      assert.equal(prepared.review.receipt?.source, 'managed_browser');
      assert.ok(inboundEvidence);
      assert.equal(seenSecurityCodes.has(inboundEvidence.code), false, 'controlled portal reused a security code');
      seenSecurityCodes.add(inboundEvidence.code);
      await forwardedVerificationMessage(applicationId, alias);
    }

    stage = 'verify_dashboard_receipt';
    activeRun.stage = stage;
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
      portal_shape: portalShape || 'default',
      application_alias: alias,
      security_code_fingerprint: inboundEvidence
        ? createHash('sha256').update(`${applicationId}:${inboundEvidence.code}`).digest('hex').slice(0, 16)
        : null,
      verification_status: finalState.review.verification?.status ?? null,
      runner: finalState.review.verification?.runner ?? null,
      runner_origin: runnerOrigin?.origin ?? null,
      runner_auth_mode: runnerOrigin?.authMode ?? null,
      continuation_fingerprint: finalState.review.verification?.continuation_fingerprint ?? null,
      continuation_resumed: finalState.review.verification?.continuation_resumed ?? false,
      receipt_source: finalState.review.receipt?.source ?? null,
      email_message_received: Boolean(inboundEvidence),
      email_message_forwarded: Boolean(inboundEvidence?.response?.forwarded),
      controlled_managed_receiving_proof_seeded: securityCodeMode,
      first_run_guest_entry_visible: true,
      guest_history_marker_written: true,
      submission_screenshot: submissionScreenshot,
    });
    await context.close();
    activeRun = null;
  }
} catch (error) {
  evidence.push({
    ...(activeRun ?? { run: null, stage: 'initialization' }),
    passed: false,
    error: errorDetail(error),
  });
  if (process.env.QA_EVIDENCE_PATH) {
    await writeFile(process.env.QA_EVIDENCE_PATH, `${JSON.stringify({ passed: false, runs: evidence }, null, 2)}\n`);
  }
  throw error;
} finally {
  await Promise.all([browser.close(), client.end()]);
}

const result = { passed: true, runs: evidence };
if (process.env.QA_EVIDENCE_PATH) {
  await writeFile(process.env.QA_EVIDENCE_PATH, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result, null, 2));
