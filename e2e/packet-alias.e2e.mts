/**
 * DOES A GENERATED PACKET GET AN ALIAS ROW? Measured against a real Postgres, both ways.
 *
 * The defect: POST /resume/generate decided the applicant's employer-facing address inside a
 * `body.application && ...` gate, and `application` is optional in the request schema. A packet
 * generated before its apply URL is known therefore got no alias row and no frozen decision. The
 * URL is recovered from the monitored posting afterwards, the packet becomes a real application,
 * and by then there is no alias: the submission falls back to the applicant's personal mailbox and
 * an emailed security code lands somewhere Litos cannot read. Measured on production packet
 * cbebbfaa (Flow Traders, Greenhouse, 2026-08-11), which is still stuck at awaiting_security_code.
 *
 * WHAT IS REAL HERE: Postgres, the real schema, the real deliverability decision
 * (planPacketApplicantEmail), the real alias writer (ensureApplicationEmailAlias) and the real
 * foreign key from application_email_aliases onto generated_resumes.
 *
 * WHAT IS NOT: POST /resume/generate is not called over HTTP. Reaching its alias code needs a live
 * Anthropic call, a PDF render and a blob upload, for the same reason e2e/README.md gives for
 * applied-badge.e2e.mts. The BEFORE side instead runs main's own gate, and refuses to run at all
 * unless it still finds that gate in `git show origin/main:src/routes/resume.ts`, so it cannot
 * quietly become a story about code that no longer exists.
 */
process.env.VERCEL = '1';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = `postgresql://${process.env.USER}@localhost:5432/litos_alias_e2e`;
process.env.JWT_SIGNING_SECRET = 'e2e-test-only-signing-secret-at-least-32-chars';
process.env.ENCRYPTION_KEY = 'e2e-test-only-encryption-key-at-least-32-chars';
process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'apply.litos.test';
process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'e2e-alias-secret';
delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const { db, pool } = await import('../src/db/index.ts');
const { users, generated_resumes, application_email_aliases } = await import('../src/db/schema.ts');
const { eq } = await import('drizzle-orm');
const { applicationAliasFor, applicationForwardingAddress, ensureApplicationEmailAlias } =
  await import('../src/lib/applicationEmail.ts');
const { planPacketApplicantEmail } = await import('../src/lib/packetApplicantEmail.ts');
const { applicationAliasDeliverability } = await import('../src/lib/applicationEmailDeliverability.ts');

const EXPECTED_DB = 'litos_alias_e2e';
const CONTACT = 'mehekmandal05@gmail.com';

async function assertThrowawayDatabase() {
  const { rows } = await pool.query('select current_database() as db');
  const name = rows[0]?.db;
  if (name !== EXPECTED_DB) {
    throw new Error(`REFUSING TO RUN: connected to "${name}", expected "${EXPECTED_DB}". This test deletes rows.`);
  }
  console.log(`connected to ${name} (throwaway), safe to delete`);
}

/* The route reads a live MX/Resend probe. Both sides get the same stub so the only variable left
 * is the gate itself. `deliverable: true` is the state production is in right now: /health reports
 * application_email ok with deliverable true and 74 enabled aliases. */
const deliverable = async () => ({
  deliverable: true,
  domain: 'apply.litos.test',
  reason: 'deliverable' as const,
  mx_hosts: ['mx.resend.test'],
  mx_provider: 'resend' as const,
  mx_provider_agrees: true,
  resend_domain_status: 'verified',
  resend_receiving_status: 'enabled',
  inbound_route_configured: true,
  checked_at: new Date().toISOString(),
});

/**
 * MAIN'S GATE, restated, and verified against main's own source before it is trusted.
 *
 * `application` is the optional request field. Everything below is `git show
 * origin/main:src/routes/resume.ts` lines 485 to 518, with the four expressions kept in order.
 */
async function mainWouldWriteAlias(input: {
  userId: string;
  resumeId: string;
  contactEmail: string;
  application: { portal_url: string; ats_name: string } | undefined;
}): Promise<{ aliasAttempted: boolean; pinned: boolean }> {
  const aliasDeliverability = input.application && input.contactEmail ? await deliverable() : null;
  const litosApplicationAlias = aliasDeliverability?.deliverable
    ? applicationAliasFor(input.userId, input.resumeId)
    : null;
  const aliasForwardTo = litosApplicationAlias && input.contactEmail
    ? await applicationForwardingAddress(input.userId, input.contactEmail)
    : null;
  const applicationEmail = litosApplicationAlias && aliasForwardTo
    ? { alias: litosApplicationAlias, forwards_to: aliasForwardTo, mode: 'litos_application_alias' as const }
    : null;
  const pinned = Boolean(input.application && input.contactEmail);
  if (applicationEmail) {
    await ensureApplicationEmailAlias({
      userId: input.userId,
      applicationId: input.resumeId,
      forwardTo: applicationEmail.forwards_to,
    });
  }
  return { aliasAttempted: Boolean(applicationEmail), pinned };
}

function assertMainStillHasTheGate() {
  const source = execFileSync('git', ['show', 'origin/main:src/routes/resume.ts'], { encoding: 'utf8' });
  const expected = [
    /const aliasDeliverability = body\.application && contactOfRecord\.email/,
    /const litosApplicationAlias = aliasDeliverability\?\.deliverable \? applicationAliasFor\(userId, resumeId\) : null;/,
    /const pinnedApplicantEmail: ApplicantEmailChoice \| null = body\.application && applicationContact\.email/,
    /if \(applicationEmail\) \{\s*await ensureApplicationEmailAlias\(\{/,
  ];
  for (const pattern of expected) {
    if (!pattern.test(source)) {
      throw new Error(`REFUSING TO RUN: origin/main no longer contains ${pattern}. Re-read the route before trusting the BEFORE side.`);
    }
  }
  console.log('origin/main still carries the body.application gate this test measures');
}

async function seedUser(email: string | null): Promise<string> {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email, is_guest: email === null, session_version: 0 });
  return userId;
}

async function seedPacket(userId: string): Promise<string> {
  const resumeId = randomUUID();
  await db.insert(generated_resumes).values({
    id: resumeId,
    user_id: userId,
    job_context: { company: 'Flow Traders', role: 'Quantitative Trading Intern Summer 2027', jd_hash: '5bd055148b3c5fab' },
    spec: {},
    resume_object_key: `users/${userId}/resumes/${resumeId}.pdf`,
  });
  return resumeId;
}

async function aliasRowCount(resumeId: string): Promise<number> {
  const rows = await db.select({ alias: application_email_aliases.alias })
    .from(application_email_aliases)
    .where(eq(application_email_aliases.generated_resume_id, resumeId));
  return rows.length;
}

let failures = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${label}\n       ${(err as Error).message.split('\n')[0]}`);
  }
}

await assertThrowawayDatabase();
assertMainStillHasTheGate();
await db.delete(application_email_aliases);
await db.delete(generated_resumes);
await db.delete(users);

// ── BEFORE: main, generating the packet the dashboard generates before it knows the apply URL ──
console.log('\nBEFORE (origin/main): a packet generated with no portal link');
{
  const userId = await seedUser(CONTACT);
  const resumeId = await seedPacket(userId);
  const outcome = await mainWouldWriteAlias({ userId, resumeId, contactEmail: CONTACT, application: undefined });
  const count = await aliasRowCount(resumeId);
  check('main writes no alias row', () => assert.equal(count, 0));
  check('main pins no applicant email decision', () => assert.equal(outcome.pinned, false));
  console.log(`       alias rows for this packet: ${count}`);
}

console.log('\nBEFORE (origin/main): the same packet, generated WITH a portal link');
{
  const userId = await seedUser(`with-portal-${CONTACT}`);
  const resumeId = await seedPacket(userId);
  await mainWouldWriteAlias({
    userId,
    resumeId,
    contactEmail: CONTACT,
    application: { portal_url: 'https://job-boards.greenhouse.io/flowtraders/jobs/8047166', ats_name: 'greenhouse' },
  });
  const count = await aliasRowCount(resumeId);
  check('main writes an alias row only when the link happened to be known', () => assert.equal(count, 1));
}

// ── AFTER: this branch, same packet, same absent portal link ──────────────────────────────────
console.log('\nAFTER (this branch): a packet generated with no portal link');
let trackedAddress = '';
{
  const userId = await seedUser(`after-${CONTACT}`);
  const resumeId = await seedPacket(userId);
  const plan = await planPacketApplicantEmail({
    userId,
    applicationId: resumeId,
    contactEmail: CONTACT,
    accountEmail: `after-${CONTACT}`,
    contactFromRequest: true,
  }, { deliverability: deliverable });
  assert.ok(plan.identity, 'the branch must produce an identity for a deliverable route');
  const written = await ensureApplicationEmailAlias({
    userId,
    applicationId: resumeId,
    forwardTo: plan.identity!.forwards_to,
  });
  const count = await aliasRowCount(resumeId);
  trackedAddress = plan.choice?.address ?? '';
  check('the branch writes exactly one alias row', () => assert.equal(count, 1));
  check('the alias row is bound to this packet', () => assert.equal(written?.alias, plan.identity!.alias));
  check('the frozen decision is tracked', () => assert.equal(plan.choice?.tracked, true));
  check('the frozen decision is the alias, not the personal address', () => {
    assert.equal(plan.choice?.address, plan.identity!.alias);
    assert.notEqual(plan.choice?.address, CONTACT);
  });
  check('a tracked packet carries no notice', () => assert.equal(plan.notice, null));
  console.log(`       alias rows for this packet: ${count} (${trackedAddress})`);

  // A repeat generation for the same packet id must not mint a second address or a second row.
  const repeat = await planPacketApplicantEmail({
    userId,
    applicationId: resumeId,
    contactEmail: CONTACT,
    accountEmail: `after-${CONTACT}`,
    contactFromRequest: true,
  }, { deliverability: deliverable });
  await ensureApplicationEmailAlias({ userId, applicationId: resumeId, forwardTo: repeat.identity!.forwards_to });
  const afterRepeat = await aliasRowCount(resumeId);
  check('a duplicate generation for the same packet id creates no second alias', () => assert.equal(afterRepeat, 1));
  check('a duplicate generation reuses the same address', () => assert.equal(repeat.identity!.alias, plan.identity!.alias));
}

// ── ADVERSARIAL: an account with nowhere to forward employer mail ─────────────────────────────
console.log('\nADVERSARIAL: a guest with no forwarding address');
{
  const userId = await seedUser(null);
  const resumeId = await seedPacket(userId);
  const plan = await planPacketApplicantEmail({
    userId,
    applicationId: resumeId,
    contactEmail: '',
    accountEmail: null,
    contactFromRequest: false,
  }, { deliverability: deliverable });
  const count = await aliasRowCount(resumeId);
  check('generation is not refused', () => assert.equal(plan.identity, null));
  check('no alias row is written', () => assert.equal(count, 0));
  check('nothing is pinned when there is no address at all', () => assert.equal(plan.choice, null));
}

/* An account row with NEITHER a stored forwarding preference NOR an account email. The real
 * applicationForwardingAddress runs here, against the real users table, so this is the state the
 * owner's own account is in today: application_email_forward_to is NULL. Employer mail goes to
 * the address the resume prints, which is a real mailbox, so the packet stays tracked. Recorded
 * because "the fallback fired" was the assumption in the brief and it is not what the column does. */
console.log('\nADVERSARIAL: a real account row with no stored forwarding preference');
{
  const userId = await seedUser(null);
  const resumeId = await seedPacket(userId);
  const plan = await planPacketApplicantEmail({
    userId,
    applicationId: resumeId,
    contactEmail: 'typed-by-hand@example.com',
    accountEmail: null,
    contactFromRequest: true,
  }, { deliverability: deliverable, forwardingAddress: applicationForwardingAddress });
  check('forwards to the address the resume prints', () => assert.equal(plan.identity?.forwards_to, 'typed-by-hand@example.com'));
  check('and the packet is tracked', () => assert.equal(plan.choice?.tracked, true));
  const written = await ensureApplicationEmailAlias({
    userId,
    applicationId: resumeId,
    forwardTo: plan.identity!.forwards_to,
  });
  const count = await aliasRowCount(resumeId);
  check('one alias row, forwarding to that address', () => {
    assert.equal(count, 1);
    assert.equal(written?.forwards_to, 'typed-by-hand@example.com');
  });
}

console.log('\nADVERSARIAL: a deployment whose application email route is unset');
{
  const previousDomain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  const previousSecret = process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
  const previousJwt = process.env.JWT_SIGNING_SECRET;
  delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
  delete process.env.JWT_SIGNING_SECRET;
  try {
    const userId = await seedUser(`unset-${CONTACT}`);
    const resumeId = await seedPacket(userId);
    const plan = await planPacketApplicantEmail({
      userId,
      applicationId: resumeId,
      contactEmail: CONTACT,
      accountEmail: `unset-${CONTACT}`,
      contactFromRequest: true,
    }, { deliverability: deliverable });
    const count = await aliasRowCount(resumeId);
    check('generation is not refused', () => assert.equal(plan.choice?.tracked, false));
    check('records alias_not_configured', () => assert.equal(plan.choice?.reason, 'alias_not_configured'));
    check('keeps the real address on the resume', () => assert.equal(plan.choice?.address, CONTACT));
    check('writes no alias row', () => assert.equal(count, 0));
  } finally {
    if (previousDomain) process.env.LITOS_APPLICATION_EMAIL_DOMAIN = previousDomain;
    if (previousSecret) process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = previousSecret;
    if (previousJwt) process.env.JWT_SIGNING_SECRET = previousJwt;
  }
}

console.log('\nADVERSARIAL: the real deliverability probe, unconfigured, must not throw');
{
  const userId = await seedUser(`probe-${CONTACT}`);
  const resumeId = await seedPacket(userId);
  const plan = await planPacketApplicantEmail({
    userId,
    applicationId: resumeId,
    contactEmail: CONTACT,
    accountEmail: `probe-${CONTACT}`,
    contactFromRequest: true,
  }, { deliverability: applicationAliasDeliverability });
  const count = await aliasRowCount(resumeId);
  check('a real probe on an unconfigured deployment falls back', () => assert.equal(plan.choice?.tracked, false));
  check('with a recorded reason', () => assert.ok((plan.choice?.reason ?? '').length > 0));
  check('and no alias row', () => assert.equal(count, 0));
  console.log(`       measured reason: ${plan.choice?.reason}`);
}

await db.delete(application_email_aliases);
await db.delete(generated_resumes);
await db.delete(users);
await pool.end();

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
