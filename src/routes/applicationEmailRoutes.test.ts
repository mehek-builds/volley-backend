import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const resumeRoute = readFileSync('src/routes/resume.ts', 'utf8');
const indexRoute = readFileSync('src/index.ts', 'utf8');
const schema = readFileSync('src/db/schema.ts', 'utf8');
const route = readFileSync('src/routes/applicationEmail.ts', 'utf8');
const service = readFileSync('src/lib/applicationEmail.ts', 'utf8');
const routeSelector = readFileSync('src/lib/applicationEmailRoute.ts', 'utf8');
const applicationsRoute = readFileSync('src/routes/applications.ts', 'utf8');
const packetEmail = readFileSync('src/lib/packetApplicantEmail.ts', 'utf8');

test('application packet generation uses the Litos alias as the employer-facing email', () => {
  assert.match(resumeRoute, /planPacketApplicantEmail\(\{/);
  assert.match(resumeRoute, /applicationId: resumeId/);
  assert.match(resumeRoute, /const applicationContact = contactOfRecord/);
  assert.match(resumeRoute, /pinnedApplicantEmail\.source !== 'litos_alias'/);
  assert.match(resumeRoute, /pinnedApplicantEmail\.tracked !== true/);
  assert.match(resumeRoute, /pinnedApplicantEmail\.address\.toLowerCase\(\) !== applicationEmail\.alias\.toLowerCase\(\)/);
  assert.match(resumeRoute, /pinnedApplicantEmail\.address\.toLowerCase\(\) === resumeEmail\.toLowerCase\(\)/);
  assert.match(resumeRoute, /_contact: applicationContact/);
  assert.match(resumeRoute, /_applicant_email: pinnedApplicantEmail/);
  assert.match(resumeRoute, /_application_email: applicationEmail/);
  assert.match(resumeRoute, /ensureApplicationEmailAlias/);
  assert.match(resumeRoute, /applicant_email: pinnedApplicantEmail/);
  assert.match(resumeRoute, /email: pinnedApplicantEmail\.address/);
  assert.match(packetEmail, /address: alias,\n\s+source: 'litos_alias'/);
});

/* THE GATE THAT PUT A PERSONAL ADDRESS ON AN EMPLOYER'S FORM.
 *
 * Measured on 2026-08-11: packet cbebbfaa was generated with no `application` in the body, so the
 * old code skipped the alias entirely, and the portal link was recovered from the monitored
 * posting afterwards. The packet became a live Greenhouse application whose reply address was the
 * applicant's own Gmail, and the security code Greenhouse emailed there is unreadable by Litos.
 *
 * These assertions are about a condition that must NOT come back, so they are written as absence
 * checks on the two expressions that decide the address and write the row. */
test('the applicant email decision is not conditioned on a portal link being known yet', () => {
  const decision = resumeRoute.slice(
    resumeRoute.indexOf('const applicantEmailPlan = await planPacketApplicantEmail'),
    resumeRoute.indexOf('const applicationContact = contactOfRecord'),
  );
  assert.ok(decision.length > 0);
  assert.doesNotMatch(decision, /body\.application/);
  const aliasWrite = resumeRoute.slice(
    resumeRoute.indexOf('if (persisted && applicationEmail) {'),
    resumeRoute.indexOf('/* Warm the requirement breakdown'),
  );
  assert.ok(aliasWrite.length > 0);
  assert.doesNotMatch(aliasWrite, /body\.application/);
  assert.match(aliasWrite, /application_identity_persistence_failed/);
});

/* A configured route that fails to write is an error. An unconfigured one is not. */
test('only a configured route turns a missing alias into a refusal', () => {
  assert.match(packetEmail, /ROUTE_NOT_CONFIGURED_REASONS/);
  assert.match(packetEmail, /'no_forwarding_address'/);
  assert.match(packetEmail, /export function applicantEmailNotice/);
  assert.match(resumeRoute, /notice: applicantEmailPlan\.notice/);
  assert.match(resumeRoute, /code: 'applicant_email_regeneration_required'/);
});

test('dashboard resume edits preserve both immutable application email keys', () => {
  assert.match(applicationsRoute, /'_applicant_email' in stored \? \{ _applicant_email: stored\._applicant_email \} : \{\}/);
  assert.match(applicationsRoute, /'_application_email' in stored \? \{ _application_email: stored\._application_email \} : \{\}/);
});

test('application inbox schema and webhook route are registered', () => {
  assert.match(schema, /application_email_aliases/);
  assert.match(schema, /application_email_messages/);
  assert.match(schema, /application_email_receiving_proofs/);
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
  assert.match(routeSelector, /LITOS_APPLICATION_EMAIL_MAILBOX/);
  assert.match(routeSelector, /LITOS_APPLICATION_EMAIL_ROUTE_MODE/);
  assert.match(service, /\$\{mailbox\.local\}\+\$\{route\}@\$\{mailbox\.domain\}/);
  assert.match(route, /applicationEmailRouteLabel\(\)/);
  assert.match(route, /route_generation_fingerprint: applicationEmailRouteGenerationFingerprint\(\)/);
});

test('signed managed canary proof is accepted before provider content retrieval and alias routing', () => {
  const webhook = route.slice(route.indexOf("fastify.post('/webhooks/application-email/inbound'"));
  const endpointMatch = webhook.indexOf('signedWebhookRequestMatchesConfiguredEndpoint(request)');
  const proof = webhook.indexOf('acceptSignedManagedReceivingCanary(event)');
  const retrieveAndNormalize = webhook.indexOf('inboundEmailFromWebhookBody(request.body)');
  const aliasRoute = webhook.indexOf('processInboundApplicationEmail(inbound)');
  assert.ok(proof >= 0);
  assert.ok(endpointMatch >= 0 && endpointMatch < proof);
  assert.ok(retrieveAndNormalize > proof);
  assert.ok(aliasRoute > retrieveAndNormalize);
  assert.match(webhook, /signedByResend = resendProofSignatureMatches\(request\)/);
  assert.match(route, /resendProofSignatureMatches[\s\S]*process\.env\.RESEND_WEBHOOK_SECRET/);
  assert.match(webhook, /receiving_proof: 'verified'/);
  assert.doesNotMatch(webhook, /receiving_proof:[\s\S]{0,80}(emailId|recipient|fingerprint)/);
});

test('the alias never reaches a form or a rendered resume without the deliverability precondition', () => {
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  // Both call sites go through the precondition. resume.ts matters as much as the runner: the
  // contact block it builds is rendered INTO the PDF, so an undeliverable alias is frozen into the
  // document the employer keeps.
  assert.match(runner, /resolveFrozenApplicantEmail\(\{/);
  // The generation-side precondition moved into lib/packetApplicantEmail.ts with the rest of the
  // decision. It is still measured, still first, and still the thing that can veto an alias.
  assert.match(packetEmail, /applicationAliasDeliverability/);
  assert.match(packetEmail, /if \(!deliverability\.deliverable\) return fallback\(deliverability\.reason\);/);
  assert.match(packetEmail, /const alias = \(deps\.aliasFor \?\? applicationAliasFor\)\(input\.userId, input\.applicationId\);/);
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

/* Storing and disposing are two functions now, so this reads across both instead of inside one.
 *
 * The property is exactly what it always was: the ledger row is written FIRST, and only then does
 * anything decide whether that message may leave Litos. What moved is where the deciding happens -
 * handleStoredEmployerMessage - and why: resolution of a submission confirmation had to stop being a
 * side effect of a successful first forward. */
test('employer mail is stored before the strict forwarding whitelist is applied', () => {
  const handlerStart = service.indexOf('export async function handleStoredEmployerMessage');
  const processorStart = service.indexOf('export async function processInboundApplicationEmail');
  const handler = service.slice(handlerStart, processorStart);
  const processor = service.slice(processorStart, service.indexOf('export async function reconcileSubmissionConfirmations'));
  const ledgerInsert = processor.indexOf("direction: 'inbound'");
  const handoff = processor.indexOf('return handleStoredEmployerMessage({');
  assert.ok(ledgerInsert >= 0);
  assert.ok(handoff > ledgerInsert, 'the message must be in the ledger before anything decides what to do with it');
  const decision = handler.indexOf('applicationEmailForwardingDecision(classification)');
  const claim = handler.indexOf('deps.claimForwarding(');
  const send = handler.indexOf('deps.forward(');
  assert.ok(decision >= 0);
  assert.ok(claim > decision);
  assert.ok(send > claim);
  assert.match(handler, /reason: forwardingDecision\.reason/);
  assert.match(service, /classification === 'submission_confirmation' \|\| classification === 'interview_request'/);
  assert.match(processor, /onConflictDoNothing\(\{ target: application_email_messages\.dedupe_key \}\)/);
  assert.match(service, /sql`\(\$\{application_email_messages\.forwarding_claimed_at\} is null or/);
  assert.match(processor, /storedApplicationEmailClassification\(message\.classification\)/);
  // The forward is built from the STORED row, never from the raw webhook body.
  assert.match(handler, /subject: message\.subject \?\? undefined/);
  assert.doesNotMatch(handler, /inbound: input/);
  const verificationReader = readFileSync('src/lib/emailVerification.ts', 'utf8');
  assert.match(verificationReader, /from\(application_email_messages\)/);
  assert.match(verificationReader, /extractLitosVerificationCode\(rows/);
});

test('the forwarding destination is a stored preference, not the login address', () => {
  const schemaSource = readFileSync('src/db/schema.ts', 'utf8');
  assert.match(schemaSource, /application_email_forward_to: text\('application_email_forward_to'\)/);
  assert.match(service, /export async function applicationForwardingAddress/);
  assert.match(route, /\/application-email\/forwarding/);
  assert.match(route, /forwardingAddressWouldLoop\(requested\)/);
  /* Survives the migration not having run yet, because on Vercel a merge is a deploy.
   *
   * Through the SHARED check, not a local `error.code === '42703'`. That literal was what this line
   * used to pin, and it was measured on 2026-08-09 to never match: Drizzle wraps the pg error in a
   * DrizzleQueryError whose own `code` is undefined, so the fallback could not fire and the
   * tolerance was decorative. isUndefinedColumnError walks the cause chain. */
  assert.match(service, /if \(isUndefinedColumnError\(error\)\) return fallback;/);
  assert.match(route, /if \(isUndefinedColumnError\(error\)\)/);
  assert.doesNotMatch(service, /\?\.code === '42703'/);
  assert.doesNotMatch(route, /\?\.code === '42703'/);
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  assert.doesNotMatch(runner, /forwardTo: accountEmail/);
});
