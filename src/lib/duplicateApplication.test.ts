import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe } from 'node:test';
import {
  atsPostingKey,
  comparePostings,
  duplicateAmong,
  duplicateApplicationReason,
  duplicateApplicationResponse,
  isLegacyUnverifiedAttemptReason,
  ledgerTwin,
  postingIdentity,
  type SubmittedTwinRow,
} from './duplicateApplication';
import type { BlockingSubmissionAttempt } from './submissionAttemptLedger';
import { attentionCategoriesForReasons } from './submissionTerminalCause';

/* THE MEASUREMENT THESE TESTS ARE WRITTEN AGAINST.
 *
 * Production, user a18f774b-a306-4804-93f3-cd6020c27fb3, 85 packets covering roughly 46 postings.
 * Eighteen postings have more than one packet, and the Akuna Full Stack Web role has TWELVE, all
 * created on 2026-08-06 between 08:48 and 13:20, all sharing job_id b3ee590f. Not one of the 85
 * ever reached 'submitted', which is the only reason twelve applications did not go to a firm
 * whose form carries a season-long exclusivity acknowledgement.
 *
 * Every fixture below is a real row, copied field for field.
 */

const AKUNA_JOB_ID = 'b3ee590f-16f3-429f-940a-5edfb1b1b6dd';
const AKUNA_ROLE = 'Software Engineer Intern - Full Stack Web, Summer 2027';
const AKUNA_DIRECT_URL = 'https://job-boards.greenhouse.io/akunacapital/jobs/8018893';
const AKUNA_EMBED_URL = 'https://job-boards.greenhouse.io/embed/job_app?for=akunacapital&token=8018893';

function akunaContext(over: Record<string, unknown> = {}) {
  return {
    role: AKUNA_ROLE,
    job_id: AKUNA_JOB_ID,
    company: 'Akuna',
    jd_hash: '4f2a1c9d0e7b3a58',
    location: 'Chicago, IL',
    ...over,
  };
}

function submitted(over: Partial<SubmittedTwinRow> = {}): SubmittedTwinRow {
  return {
    id: 'd26aca4c-db65-4f07-a69e-811d85c52cf9',
    job_context: akunaContext(),
    portal_url: AKUNA_DIRECT_URL,
    submitted_at: '2026-08-06T08:48:16.764Z',
    ...over,
  };
}

describe('what counts as the same posting', () => {
  test('the two URL shapes of ONE Greenhouse posting reduce to one key', () => {
    // This is the shape that makes raw portal_url comparison useless: six of the twelve Akuna
    // packets store the direct board URL and six store the embed URL, for one posting.
    assert.equal(atsPostingKey(AKUNA_DIRECT_URL), 'greenhouse:akunacapital:8018893');
    assert.equal(atsPostingKey(AKUNA_EMBED_URL), 'greenhouse:akunacapital:8018893');
    assert.notEqual(AKUNA_DIRECT_URL, AKUNA_EMBED_URL);
  });

  test('Ashby and Lever postings are keyed too, so the fallback tier is rarely needed', () => {
    assert.equal(
      atsPostingKey('https://jobs.ashbyhq.com/deepgram/dc8693b5-72ce-4ca3-ab15-9c8434d35da1/application'),
      'ashby:deepgram:dc8693b5-72ce-4ca3-ab15-9c8434d35da1',
    );
    assert.equal(
      atsPostingKey('https://jobs.ashbyhq.com/fluency/2aced4e2-485b-4525-802c-763e62c91e88'),
      'ashby:fluency:2aced4e2-485b-4525-802c-763e62c91e88',
    );
    assert.equal(atsPostingKey('https://jobs.lever.co/matician/6a1b2c3d'), 'lever:matician:6a1b2c3d');
  });

  test('a company careers page yields no key, which is what the lower tiers are for', () => {
    // Two of the owner's 85 packets sit on www.jumptrading.com and one on oldmissioncapital.com.
    assert.equal(atsPostingKey('https://www.jumptrading.com/careers/1234567/'), null);
    assert.equal(atsPostingKey(undefined), null);
    assert.equal(atsPostingKey(''), null);
  });

  test('the posting key outranks job_id, so one posting under two ids is still one posting', () => {
    const a = postingIdentity(akunaContext(), AKUNA_DIRECT_URL);
    const b = postingIdentity(akunaContext({ job_id: '00000000-0000-4000-8000-000000000999' }), AKUNA_EMBED_URL);
    assert.deepEqual(comparePostings(a, b), { same: true, basis: 'ats_posting' });
  });

  test('job_id decides when neither side has a readable portal URL', () => {
    const a = postingIdentity(akunaContext(), 'https://www.jumptrading.com/careers/1/');
    const b = postingIdentity(akunaContext({ role: 'Full Stack Web Intern' }), 'https://www.jumptrading.com/careers/2/');
    assert.deepEqual(comparePostings(a, b), { same: true, basis: 'job_id' });
  });

  test('company plus role carries the packets that have no job_id at all', () => {
    // Fluency Engineering Intern: three packets, job_id null on every one of them.
    const context = { company: 'Fluency', role: 'Engineering Intern' };
    const a = postingIdentity(context, 'https://fluency.example.com/apply');
    const b = postingIdentity({ company: 'fluency  ', role: 'Engineering   Intern' }, 'https://fluency.example.com/careers');
    assert.deepEqual(comparePostings(a, b), { same: true, basis: 'company_role' });
  });

  test('location is NOT part of the key, because production proves it drifts', () => {
    // One Deepgram posting, three packets, location null / "USA | Remote" / "USA | Remote".
    const url = 'https://jobs.ashbyhq.com/deepgram/dc8693b5-72ce-4ca3-ab15-9c8434d35da1/application';
    const a = postingIdentity({ company: 'Deepgram', role: 'Software Engineering- Internship' }, url);
    const b = postingIdentity(
      { company: 'Deepgram', role: 'Software Engineering- Internship', location: 'USA | Remote' },
      url,
    );
    assert.equal(comparePostings(a, b).same, true);
  });

  test('two genuinely different postings at one employer stay apart', () => {
    // Palantir FDSE Internship, Intel (Washington D.C.) and Commercial (Chicago). Distinct
    // requisitions, distinct job_ids, and the applicant is entitled to apply to both.
    const intel = postingIdentity(
      { company: 'Palantir', role: 'Forward Deployed Software Engineer, Internship - Intel', job_id: 'ec7002b9-ffcc-4cfd-8146-87ad77720d6a' },
      'https://job-boards.greenhouse.io/palantir/jobs/7000001',
    );
    const commercial = postingIdentity(
      { company: 'Palantir', role: 'Forward Deployed Software Engineer, Internship - Commercial', job_id: '8fb1ef1e-8b43-45c9-bb19-4fa0469d8dc0' },
      'https://job-boards.greenhouse.io/palantir/jobs/7000002',
    );
    assert.deepEqual(comparePostings(intel, commercial), { same: false, basis: 'ats_posting' });
  });

  test('the three Akuna roles are three postings, not one employer', () => {
    const web = postingIdentity(akunaContext(), AKUNA_DIRECT_URL);
    const python = postingIdentity(
      akunaContext({ role: 'Software Engineer Intern - Python, Summer 2027', job_id: 'b5a42d56-2a4a-475a-969b-4fadfc16d7ef' }),
      'https://job-boards.greenhouse.io/akunacapital/jobs/8018894',
    );
    assert.equal(comparePostings(web, python).same, false);
  });

  test('a weak key never overrules a strong one', () => {
    // Same company and role text, different Greenhouse postings. The union of all three tiers
    // would call these a duplicate; the tiered read does not.
    const a = postingIdentity({ company: 'Acme', role: 'Software Engineer Intern' }, 'https://job-boards.greenhouse.io/acme/jobs/1');
    const b = postingIdentity({ company: 'Acme', role: 'Software Engineer Intern' }, 'https://job-boards.greenhouse.io/acme/jobs/2');
    assert.deepEqual(comparePostings(a, b), { same: false, basis: 'ats_posting' });
  });

  test('no shared tier is reported, never silently treated as a clear', () => {
    const a = postingIdentity({}, undefined);
    const b = postingIdentity({ company: 'Akuna', role: AKUNA_ROLE }, AKUNA_DIRECT_URL);
    assert.deepEqual(comparePostings(a, b), { same: false, basis: null });
  });

  test('two weak-identity postings with different company are proven different, not unknown', () => {
    // No ATS posting key, no job id, no comparable URL: the only shared tier is company|role. A
    // confirmed application to one company is not a prior submission of another, so this must read
    // as a different posting rather than the null "cannot compare" that becomes an unidentifiable
    // refusal and blocks every new weak-identity application.
    const cresta = postingIdentity({ company: 'cresta', role: 'Data Science Intern (Customer Success)' }, undefined);
    const verkada = postingIdentity({ company: 'Verkada', role: 'Frontend Software Engineering Intern 2027' }, undefined);
    assert.deepEqual(comparePostings(verkada, cresta), { same: false, basis: 'company_role' });
  });

  test('two weak-identity postings that are the same company and role still read as the same', () => {
    // The exact posting re-sent must still be caught, so a real duplicate stays blocked.
    const a = postingIdentity({ company: 'Verkada', role: 'Frontend Software Engineering Intern 2027' }, undefined);
    const b = postingIdentity({ company: 'Verkada', role: 'Frontend Software Engineering Intern 2027' }, undefined);
    assert.deepEqual(comparePostings(a, b), { same: true, basis: 'company_role' });
  });

  test('different roles at the same company are different postings', () => {
    const frontend = postingIdentity({ company: 'Verkada', role: 'Frontend Software Engineering Intern 2027' }, undefined);
    const backend = postingIdentity({ company: 'Verkada', role: 'Backend Software Engineering Intern 2027' }, undefined);
    assert.deepEqual(comparePostings(frontend, backend), { same: false, basis: 'company_role' });
  });
});

describe('the verdict over a set of already-submitted applications', () => {
  test('the thirteenth Akuna packet is refused against the one that went', () => {
    const verdict = duplicateAmong(akunaContext(), AKUNA_EMBED_URL, [submitted()]);
    assert.equal(verdict.kind, 'duplicate');
    assert.equal(verdict.kind === 'duplicate' && verdict.match.basis, 'ats_posting');
    assert.equal(verdict.kind === 'duplicate' && verdict.match.application_id, 'd26aca4c-db65-4f07-a69e-811d85c52cf9');
  });

  test('a different posting at the same employer is allowed through', () => {
    const verdict = duplicateAmong(
      akunaContext({ role: 'Software Engineer Intern - C# .NET Desktop, Summer 2027', job_id: '9870b463-d930-4db9-9305-4f38a97ca183' }),
      'https://job-boards.greenhouse.io/akunacapital/jobs/8018895',
      [submitted()],
    );
    assert.equal(verdict.kind, 'clear');
  });

  test('nothing submitted yet is clear, not unidentifiable', () => {
    assert.deepEqual(duplicateAmong(akunaContext(), AKUNA_DIRECT_URL, []), { kind: 'clear' });
  });

  test('a confirmed application to a different employer does not block one it cannot key-compare', () => {
    // The prior went to cresta on Greenhouse; the candidate is Verkada on Greenhouse. Different
    // tenants resolve to basis null (not a proven-different ats_posting), which would otherwise
    // refuse as unidentifiable. The company|role guard recognizes them as different postings.
    const cresta = submitted({
      id: 'a1111111-1111-4111-8111-111111111111',
      job_context: { company: 'cresta', role: 'Data Science Intern (Customer Success)' },
      portal_url: 'https://job-boards.greenhouse.io/cresta/jobs/1',
    });
    const verdict = duplicateAmong(
      { company: 'Verkada', role: 'Frontend Software Engineering Intern 2027' },
      'https://job-boards.greenhouse.io/verkada/jobs/2',
      [cresta],
    );
    assert.equal(verdict.kind, 'clear');
  });

  test('a confirmed application to the SAME employer and role is still refused, not cleared', () => {
    // The company|role guard must not clear a genuine same-posting retry. Same tenant, same key.
    const verdict = duplicateAmong(akunaContext(), AKUNA_EMBED_URL, [submitted()]);
    assert.equal(verdict.kind, 'duplicate');
  });

  test('legacy unverified-attempt prose blocks a modern retry as unverified', () => {
    const url = 'https://jobs.ashbyhq.com/deepgram/dc8693b5-72ce-4ca3-ab15-9c8434d35da1/application';
    const context = {
      company: 'Deepgram',
      role: 'Software Engineering- Internship (Fall 2026/Summer 2027)',
    };
    const verdict = duplicateAmong(context, url, [submitted({
      id: '4bfd5827-5518-4fb6-8fae-4b79f3e0cde0',
      job_context: context,
      portal_url: url,
      submitted_at: null,
      unverified_at: null,
      legacy_unverified_attempt: true,
    })]);

    assert.equal(verdict.kind, 'duplicate');
    if (verdict.kind !== 'duplicate') return;
    assert.equal(verdict.match.application_id, '4bfd5827-5518-4fb6-8fae-4b79f3e0cde0');
    assert.equal(verdict.match.certainty, 'unverified');
    assert.equal(verdict.match.basis, 'ats_posting');
    assert.match(verdict.reason, /employer may already have that application/i);
    assert.deepEqual(attentionCategoriesForReasons([verdict.reason]), ['unverified_submission']);
  });

  test('an opened-only attempt still blocks, but is not described as a press', () => {
    // A legacy_backfill attempt that only reached attempt_opened - no boundary authorized, no press,
    // no confirmation. It must still fail closed (a second application cannot be withdrawn), but the
    // sentence must not claim Litos pressed Send when nothing in evidence shows a send.
    const verdict = duplicateAmong(akunaContext(), AKUNA_DIRECT_URL, [submitted({
      submitted_at: null,
      unverified_at: '2026-08-27T14:11:35.408Z',
      unverified_send_evidence: 'opened',
    })]);

    assert.equal(verdict.kind, 'duplicate');
    if (verdict.kind !== 'duplicate') return;
    assert.equal(verdict.match.certainty, 'unverified');
    assert.equal(verdict.match.send_evidence, 'opened');
    // Honest: no false press, but the same fail-closed refusal and the same resolution path.
    assert.doesNotMatch(verdict.reason, /already pressed Send/i);
    assert.match(verdict.reason, /does not know whether this application went through/i);
    assert.match(verdict.reason, /could make it two/i);
    // Still the must-not-retry bucket, exactly like the pressed sentence.
    assert.deepEqual(attentionCategoriesForReasons([verdict.reason]), ['unverified_submission']);
  });

  test('a real unverified press keeps the pressed-Send sentence', () => {
    const verdict = duplicateAmong(akunaContext(), AKUNA_DIRECT_URL, [submitted({
      submitted_at: null,
      unverified_at: '2026-08-27T14:11:35.408Z',
      unverified_send_evidence: 'pressed',
    })]);

    assert.equal(verdict.kind, 'duplicate');
    if (verdict.kind !== 'duplicate') return;
    assert.equal(verdict.match.certainty, 'unverified');
    assert.match(verdict.reason, /already pressed Send/i);
    assert.deepEqual(attentionCategoriesForReasons([verdict.reason]), ['unverified_submission']);
  });

  test('a packet that shares no key with anything submitted says so', () => {
    const verdict = duplicateAmong({}, undefined, [submitted()]);
    assert.equal(verdict.kind, 'unidentifiable');
    if (verdict.kind !== 'unidentifiable') return;
    assert.equal(verdict.prior_packet_id, 'd26aca4c-db65-4f07-a69e-811d85c52cf9');
    assert.equal(verdict.reason.includes('cannot be safely compared'), true);
  });

  test('the refusal names the employer, the role and the day', () => {
    const verdict = duplicateAmong(akunaContext(), AKUNA_EMBED_URL, [submitted()]);
    assert.equal(verdict.kind, 'duplicate');
    if (verdict.kind !== 'duplicate') return;
    assert.match(verdict.reason, /Akuna/);
    assert.match(verdict.reason, /Full Stack Web/);
    assert.match(verdict.reason, /6 August 2026/);
    assert.match(verdict.reason, /Nothing has been sent this time/);
    // It must not read as a breakage, and must not invite a retry of the thing just refused.
    assert.doesNotMatch(verdict.reason, /try (this|it) again/i);
    assert.doesNotMatch(verdict.reason, /could not/i);
  });

  test('a missing submitted_at degrades to "earlier" rather than an Invalid Date', () => {
    const reason = duplicateApplicationReason({
      application_id: 'x', company: 'Akuna', role: AKUNA_ROLE, basis: 'job_id', certainty: 'submitted',
    });
    assert.match(reason, /applied to .* at Akuna, earlier\./);
    assert.doesNotMatch(reason, /Invalid Date|NaN|undefined/);
  });

  test('the HTTP body every route sends carries the code and the twin', () => {
    const verdict = duplicateAmong(akunaContext(), AKUNA_DIRECT_URL, [submitted()]);
    assert.equal(verdict.kind, 'duplicate');
    if (verdict.kind !== 'duplicate') return;
    assert.deepEqual(duplicateApplicationResponse(verdict), {
      error: verdict.reason,
      code: 'DUPLICATE_APPLICATION',
      duplicate_of: 'd26aca4c-db65-4f07-a69e-811d85c52cf9',
      matched_on: 'ats_posting',
      duplicate_certainty: 'submitted',
    });
  });
});

describe('legacy unverified-attempt recognition', () => {
  const productionReason = 'The final submission was attempted, but Litos could not verify the employer confirmation. Check the portal or your email before trying again.';

  test('recognizes the production sentence despite casing or surrounding whitespace', () => {
    assert.equal(isLegacyUnverifiedAttemptReason(productionReason), true);
    assert.equal(isLegacyUnverifiedAttemptReason(`  ${productionReason.toUpperCase()}  `), true);
  });

  test('does not widen generic verification failures into possible employer sends', () => {
    assert.equal(isLegacyUnverifiedAttemptReason('Litos could not verify the employer confirmation before submit.'), false);
    assert.equal(isLegacyUnverifiedAttemptReason('The final submission was not attempted.'), false);
    assert.equal(isLegacyUnverifiedAttemptReason(undefined), false);
  });

  test('the database predicate uses the same marker and excludes structured records', async () => {
    const source = await readFile('src/lib/duplicateApplication.ts', 'utf8');
    const predicateAt = source.indexOf('function legacyUnverifiedAttempt()');
    assert.ok(predicateAt > 0, 'legacy predicate is missing');
    const predicate = source.slice(predicateAt, source.indexOf('\n}', predicateAt) + 2);
    assert.match(predicate, /jsonb_typeof/);
    assert.match(predicate, /unverified_submission/);
    assert.match(predicate, /attention_reason/);
    assert.match(source, /or \$\{legacyUnverifiedAttempt\(\)\}/);
    assert.match(source, /legacy_unverified_attempt: sql<boolean>`\$\{legacyUnverifiedAttempt\(\)\}`/);
  });
});

describe('the refusal is a legible terminal cause, not a generic failure', () => {
  test('the sentence classifies as duplicate_application and nothing else', () => {
    const reason = duplicateApplicationReason({
      application_id: 'x', company: 'Akuna', role: AKUNA_ROLE, submitted_at: '2026-08-06T08:48:16.764Z', basis: 'ats_posting', certainty: 'submitted',
    });
    assert.deepEqual(attentionCategoriesForReasons([reason]), ['duplicate_application']);
  });

  test('it is not swept into run_failed, which is the bucket the applicant is told to retry', () => {
    const reason = duplicateApplicationReason({
      application_id: 'x', company: 'Akuna', role: AKUNA_ROLE, basis: 'job_id', certainty: 'submitted',
    });
    assert.equal(attentionCategoriesForReasons([reason]).includes('run_failed'), false);
    assert.equal(attentionCategoriesForReasons([reason]).includes('unknown'), false);
  });
});

/* ---- the guard has to be on every send path, and a guard on one of five is worth nothing ---- */

describe('every path that can write status submitted is behind the guard', () => {
  test('the browser run, standing consent and the ATS API channel: submissionRunner.submit', async () => {
    const source = await readFile('src/routes/submissionRunner.ts', 'utf8');
    const submitAt = source.indexOf('async function submit(row: ResumeRow');
    assert.ok(submitAt > 0, 'submit() moved; the guard has to move with it');
    const body = source.slice(submitAt);
    const guardAt = body.indexOf('duplicateApplicationVerdict');
    const claimAt = body.indexOf('await claimSubmission(row, options.claimAlreadyHeld)');
    assert.ok(guardAt > 0, 'submit() does not consult the duplicate guard');
    assert.ok(
      guardAt < claimAt,
      'the guard must run BEFORE claimSubmission, or a refused application still spends a daily cap slot',
    );
    // submitViaAtsSubmissionChannel and submitControlled both live below the claim, so a guard
    // above it covers them. Pinned so a later move of either one cannot slip out from under it.
    assert.ok(body.indexOf('submitViaAtsSubmissionChannel(') > claimAt);
    assert.ok(body.indexOf('submitControlled(') > claimAt);
  });

  test('the unsupported-portal email fallback: POST /submit-request', async () => {
    const source = await readFile('src/routes/applications.ts', 'utf8');
    const routeAt = source.indexOf("'/applications/:id/submit-request'");
    assert.ok(routeAt > 0);
    const body = source.slice(routeAt);
    const guardAt = body.indexOf('refuseDuplicateApplication');
    const emailAt = body.indexOf('sendPreparedUnsupportedPortalApplicationEmail');
    assert.ok(guardAt > 0, 'submit-request does not consult the duplicate guard');
    assert.ok(guardAt < emailAt, 'the guard must run before the packet is emailed to the employer');
  });

  test('per-application approve: POST /submission/approve', async () => {
    const source = await readFile('src/routes/applications.ts', 'utf8');
    const routeAt = source.indexOf("'/applications/:id/submission/approve'");
    assert.ok(routeAt > 0);
    const body = source.slice(routeAt);
    const guardAt = body.indexOf('refuseDuplicateApplication');
    const runAt = body.indexOf('processSubmissionApplication');
    assert.ok(guardAt > 0, 'the approve route does not consult the duplicate guard');
    assert.ok(guardAt < runAt, 'the guard must answer the applicant before the run is started');
  });

  test('the extension: POST /submission/extension-start', async () => {
    const source = await readFile('src/routes/applications.ts', 'utf8');
    const routeAt = source.indexOf("'/applications/:id/submission/extension-start'");
    assert.ok(routeAt > 0);
    const body = source.slice(routeAt, source.indexOf("'/applications/:id/submission/extension-outcome'"));
    const guardAt = body.indexOf('refuseDuplicateApplication');
    const claimAt = body.indexOf('const runExtensionStartTransaction =');
    assert.ok(guardAt > 0, 'extension-start does not consult the duplicate guard');
    assert.ok(
      guardAt < claimAt,
      'the extension is authorized to fill and click here, so the guard has to answer before the claim',
    );
  });

  test('the extension outcome path is downstream of extension-start and must stay so', async () => {
    const source = await readFile('src/routes/applications.ts', 'utf8');
    const outcomeAt = source.indexOf("'/applications/:id/submission/extension-outcome'");
    const body = source.slice(outcomeAt, outcomeAt + 3000);
    // extension-outcome RECORDS a submission the extension already performed. Guarding it would be
    // refusing to write down something that already happened, which loses the receipt rather than
    // preventing the send. The gate for this path is extension-start, above.
    assert.match(body, /current\.submission_claim_id !== parsed\.data\.claim_id \|\| current\.status !== 'submitting'/);
  });

  test('the refusal is written through the shared merge, so it carries its cause', async () => {
    const applications = await readFile('src/routes/applications.ts', 'utf8');
    const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
    assert.match(applications, /applyReviewPatch\(current, \{\s*\n\s*status: 'needs_attention',\s*\n\s*attention_reason: verdict\.reason/);
    /* The runner's arm asserts the PROPERTIES rather than one literal spelling of them, because the
       status is no longer a constant there. A packet finishing a security-code submission has
       already had its form accepted by the employer once and is waiting on the emailed code;
       demoting that to needs_attention would say nothing was sent, and would hand it back to
       submitRequestDisposition as re-runnable. So the refusal stands and the status it lands in
       depends on the packet. What this test exists to protect is unchanged and still checked: the
       write goes through the shared merge, and it carries duplicate.reason. */
    const submitAt = runner.indexOf('async function submit(row: ResumeRow');
    const gateAt = runner.indexOf("if (duplicate.kind !== 'clear')", submitAt);
    assert.ok(gateAt > 0, 'the duplicate gate must still be in the runner');
    const gate = runner.slice(
      gateAt,
      runner.indexOf('const claimedRow = await claimSubmission(row, options.claimAlreadyHeld);', gateAt),
    );
    assert.match(gate, /nextReview\(current, \{/);
    assert.match(gate, /duplicate\.reason/);
    assert.match(gate, /attention_categories:[\s\S]{0,300}'duplicate_application'/);
    assert.match(gate, /'needs_attention'/);
  });
});

describe('the match names the attempt and packet the guard actually matched', () => {
  const twinAttempt: BlockingSubmissionAttempt = {
    attemptId: '23f289d6-f68b-4f90-ab6f-b3951b11f242',
    parentAttemptId: null,
    userId: 'a18f774b-0000-4000-8000-000000000000',
    packetId: '9f1d9e52-06b0-4786-baa6-201d3422104a',
    applicationId: '222d70a6-6f4b-4293-b752-4252c768482f',
    source: 'legacy_backfill',
    operation: 'initial_submission',
    postingIdentity: {
      postingKey: null,
      jobId: '3fba1c39-c5cb-47d7-9ad2-1cec4d7e9d0c',
      companyRole: 'notion|software engineer intern summer 2027',
      company: 'Notion',
      role: 'Software Engineer Intern (Summer 2027)',
      portalUrl: 'https://jobs.ashbyhq.com/notion/3fba1c39-c5cb-47d7-9ad2-1cec4d7e9d0c/application',
      portalIdentity: 'https://jobs.ashbyhq.com/notion',
    },
    retrySafety: {
      kind: 'blocked_unverified',
      attemptId: '23f289d6-f68b-4f90-ab6f-b3951b11f242',
      at: '2026-08-17T20:01:00.000Z',
      reason: 'pressed',
    },
  };

  test('a ledger twin carries its attempt and its packet beside the Tracker row it points to', () => {
    /* Notion a4b7295c, 2026-09-05: refused for a press on canonical application 222d70a6, whose
       attempt lives on packet 9f1d9e52 - a row the applicant could not find from the sentence,
       because application_id named the canonical row and nothing named the packet. */
    const verdict = duplicateAmong(
      { company: 'Notion', role: 'Software Engineer Intern (Summer 2027)', job_id: '3fba1c39-c5cb-47d7-9ad2-1cec4d7e9d0c' },
      'https://jobs.ashbyhq.com/notion/3fba1c39-c5cb-47d7-9ad2-1cec4d7e9d0c/application',
      [ledgerTwin(twinAttempt)],
      'a4b7295c-9d70-4b93-8c76-a6d4ba05f781',
    );
    assert.equal(verdict.kind, 'duplicate');
    if (verdict.kind !== 'duplicate') return;
    assert.equal(verdict.match.application_id, '222d70a6-6f4b-4293-b752-4252c768482f');
    assert.equal(verdict.match.attempt_id, '23f289d6-f68b-4f90-ab6f-b3951b11f242');
    assert.equal(verdict.match.packet_id, '9f1d9e52-06b0-4786-baa6-201d3422104a');
    assert.equal(verdict.match.certainty, 'unverified');
    assert.equal(verdict.match.send_evidence, 'pressed');
  });

  test('a legacy Sent row with no attempt names its own packet and no attempt', () => {
    const legacyRow: SubmittedTwinRow = {
      id: '4bfd5827-5518-4fb6-8fae-4b79f3e0cde0',
      job_context: { company: 'Deepgram', role: 'Software Engineering- Internship (Fall 2026/Summer 2027)', job_id: 'dc8693b5-72ce-4ca3-ab15-9c8434d35da1' },
      portal_url: 'https://jobs.ashbyhq.com/deepgram/dc8693b5-72ce-4ca3-ab15-9c8434d35da1/application',
      submitted_at: '2026-08-11T04:12:00.000Z',
      mutable_sent_marker: true,
      receipt_authority: 'confirmed',
    };
    const verdict = duplicateAmong(
      { company: 'Deepgram', role: 'Software Engineering- Internship (Fall 2026/Summer 2027)', job_id: 'dc8693b5-72ce-4ca3-ab15-9c8434d35da1' },
      'https://jobs.ashbyhq.com/deepgram/dc8693b5-72ce-4ca3-ab15-9c8434d35da1/application',
      [legacyRow],
      '4ef78910-b11b-47a8-878e-05fbc9fdf174',
    );
    assert.equal(verdict.kind, 'duplicate');
    if (verdict.kind !== 'duplicate') return;
    assert.equal(verdict.match.attempt_id, undefined);
    assert.equal(verdict.match.packet_id, '4bfd5827-5518-4fb6-8fae-4b79f3e0cde0');
  });
});

describe('ledgerTwin translates the attempt retry-safety reason into send evidence', () => {
  const blockingAttempt = (
    retrySafety: Extract<BlockingSubmissionAttempt['retrySafety'], { kind: 'blocked_unverified' }>,
  ): BlockingSubmissionAttempt => ({
    attemptId: '23f289d6-f68b-4f90-ab6f-b3951b11f242',
    parentAttemptId: null,
    userId: 'a18f774b-0000-4000-8000-000000000000',
    packetId: '9f1d9e52-06b0-4786-baa6-201d3422104a',
    applicationId: '222d70a6-6f4b-4293-b752-4252c768482f',
    source: 'legacy_backfill',
    operation: 'initial_submission',
    postingIdentity: {
      postingKey: null,
      jobId: null,
      companyRole: 'notion|software engineer intern',
      company: 'Notion',
      role: 'Software Engineer Intern (Summer 2027)',
      portalUrl: 'https://jobs.ashbyhq.com/notion',
      portalIdentity: null,
    },
    retrySafety,
  });

  test("an attempt that only opened is 'opened', not a press", () => {
    const row = ledgerTwin(blockingAttempt({
      kind: 'blocked_unverified',
      attemptId: '23f289d6-f68b-4f90-ab6f-b3951b11f242',
      at: '2026-08-27T14:11:35.408Z',
      reason: 'opened',
    }));
    assert.equal(row.unverified_send_evidence, 'opened');
    assert.equal(row.unverified_at, '2026-08-27T14:11:35.408Z');
  });

  test("a boundary-authorized attempt is a real 'pressed' send", () => {
    const row = ledgerTwin(blockingAttempt({
      kind: 'blocked_unverified',
      attemptId: '23f289d6-f68b-4f90-ab6f-b3951b11f242',
      at: '2026-08-27T14:11:35.408Z',
      reason: 'boundary_authorized',
      leaseId: 'lease-1',
      expiresAt: '2026-08-27T14:41:35.408Z',
    }));
    assert.equal(row.unverified_send_evidence, 'pressed');
  });
});
