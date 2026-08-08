import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const resumeRoute = readFileSync('src/routes/resume.ts', 'utf8');
const indexRoute = readFileSync('src/index.ts', 'utf8');
const schema = readFileSync('src/db/schema.ts', 'utf8');
const route = readFileSync('src/routes/applicationEmail.ts', 'utf8');
const service = readFileSync('src/lib/applicationEmail.ts', 'utf8');
const applicationsRoute = readFileSync('src/routes/applications.ts', 'utf8');

test('application packet generation uses the Litos alias as the employer-facing email', () => {
  assert.match(resumeRoute, /applicationAliasFor\(userId, resumeId\)/);
  assert.match(resumeRoute, /applicationContact = applicationEmail[\s\S]*email: applicationEmail\.alias/);
  assert.match(resumeRoute, /_contact: applicationContact/);
  assert.match(resumeRoute, /_applicant_email: pinnedApplicantEmail/);
  assert.match(resumeRoute, /_application_email: applicationEmail/);
  assert.match(resumeRoute, /ensureApplicationEmailAlias/);
  assert.match(resumeRoute, /applicant_email: pinnedApplicantEmail/);
  assert.match(resumeRoute, /address: applicationContact\.email/);
  assert.match(resumeRoute, /if \(body\.application\) \{[\s\S]*application_identity_persistence_failed/);
});

test('dashboard resume edits preserve both immutable application email keys', () => {
  assert.match(applicationsRoute, /'_applicant_email' in stored \? \{ _applicant_email: stored\._applicant_email \} : \{\}/);
  assert.match(applicationsRoute, /'_application_email' in stored \? \{ _application_email: stored\._application_email \} : \{\}/);
});

test('application inbox schema and webhook route are registered', () => {
  assert.match(schema, /application_email_aliases/);
  assert.match(schema, /application_email_messages/);
  assert.match(indexRoute, /applicationEmailRoutes/);
  assert.match(route, /\/webhooks\/application-email\/inbound/);
  assert.match(route, /inboundSecretMatches/);
  assert.match(route, /resendReceivedBodySchema/);
  assert.match(route, /retrieveResendReceivedEmail/);
  assert.match(route, /x-litos-webhook-signature/);
  assert.match(route, /svix-signature/);
  assert.match(route, /\/applications\/:id\/email-messages/);
  // Reply-to is the ALIAS, never the employer: a reply that leaves the applicant's own mailbox
  // publishes the address the alias exists to keep out of the thread. See relayApplicantReply.
  assert.match(service, /to: \[input\.forwardTo\],[\s\S]*\{ reply_to: input\.alias \}/);
  assert.doesNotMatch(service, /reply_to: input\.inbound\.from/);
  assert.match(service, /LITOS_APPLICATION_EMAIL_MAILBOX/);
  assert.match(service, /\$\{mailbox\.local\}\+\$\{route\}@\$\{mailbox\.domain\}/);
  assert.match(route, /applicationEmailRouteLabel\(\)/);
  assert.match(route, /route_generation_fingerprint: applicationEmailRouteGenerationFingerprint\(\)/);
});

test('the alias never reaches a form or a rendered resume without the deliverability precondition', () => {
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  // Both call sites go through the precondition. resume.ts matters as much as the runner: the
  // contact block it builds is rendered INTO the PDF, so an undeliverable alias is frozen into the
  // document the employer keeps.
  assert.match(runner, /resolveFrozenApplicantEmail\(\{/);
  assert.match(resumeRoute, /applicationAliasDeliverability\(\)/);
  assert.match(resumeRoute, /aliasDeliverability\?\.deliverable \? applicationAliasFor\(userId, resumeId\) : null/);
  assert.match(service, /if \(!check\.deliverable\) return \{ \.\.\.fallback, reason: check\.reason \}/);
});

test('the health probe measures the world instead of reading environment variables', () => {
  assert.match(service, /export async function applicationEmailHealth/);
  assert.match(service, /const check = await applicationAliasDeliverability\(\)/);
  assert.match(service, /mx_hosts: check\.mx_hosts/);
  assert.match(service, /resend_domain_status: check\.resend_domain_status/);
  assert.match(service, /inbound_route_configured: check\.inbound_route_configured/);
  assert.match(service, /last_inbound_message_at/);
  // 'degraded' must be reachable and must not be the same answer as 'ok'.
  assert.match(service, /status: check\.deliverable\s*\n\s*\? 'ok'/);
  assert.match(service, /'degraded'/);
});

test('the reply relay exists, is outbound, and cannot loop', () => {
  assert.match(service, /direction: 'outbound'/);
  assert.match(service, /classification: 'applicant_reply'/);
  // Identity: only the address the alias forwards to may relay through it.
  assert.match(service, /if \(sender !== forwardTo\) return \{ kind: 'employer_message' \}/);
  // Loop guards: mail from the alias is dropped, and the relay target can never be the alias or
  // the applicant's own mailbox.
  assert.match(service, /if \(sender === alias\) return \{ kind: 'drop', reason: 'self_addressed' \}/);
  assert.match(service, /if \(candidate === alias \|\| candidate === forwardTo\) continue/);
  // The employer is taken from the recorded thread, never from the reply's own headers.
  assert.match(service, /const recipient = relayRecipientFor\(thread/);
});

test('managed receiving rejects applicant replies before any relay ledger insert, claim, or send', () => {
  const processor = service.slice(
    service.indexOf('export async function processInboundApplicationEmail'),
    service.indexOf('export async function applicationEmailHealth'),
  );
  const drop = processor.indexOf("if (route.kind === 'drop')");
  const relay = processor.indexOf('return relayApplicantReply');
  assert.ok(drop >= 0);
  assert.ok(relay > drop);
  assert.match(service, /if \(aliasUsesManagedReceiving\(alias\)\) return \{ kind: 'drop', reason: 'managed_reply_unsupported' \}/);
  assert.match(service, /return \/\^\[a-z0-9\].*\\\.resend\\\.app\$\/i\.test\(domain\)/);
});

test('the forwarding destination is a stored preference, not the login address', () => {
  const schemaSource = readFileSync('src/db/schema.ts', 'utf8');
  assert.match(schemaSource, /application_email_forward_to: text\('application_email_forward_to'\)/);
  assert.match(service, /export async function applicationForwardingAddress/);
  assert.match(route, /\/application-email\/forwarding/);
  assert.match(route, /forwardingAddressWouldLoop\(requested\)/);
  // Survives the migration not having run yet, because on Vercel a merge is a deploy.
  assert.match(service, /'42703'/);
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  assert.doesNotMatch(runner, /forwardTo: accountEmail/);
});
