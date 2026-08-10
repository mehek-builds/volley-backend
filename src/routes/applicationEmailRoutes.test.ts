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
  /* A FRESH last_inbound_message_at IS NOT A WORKING INBOX. On 2026-08-10 mail was landing, that
   * timestamp was current, and every message was being dropped. The count of what was withheld is
   * the field that can see that, and null rather than 0 when it cannot be taken. */
  assert.match(service, /withheld_messages_recent: withheldCount/);
  assert.match(service, /like 'withheld:%'/);
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

test('employer mail is stored before the forwarding decision, and every decision is recorded', () => {
  const processor = service.slice(
    service.indexOf('export async function processInboundApplicationEmail'),
    service.indexOf('export async function applicationEmailHealth'),
  );
  const ledgerInsert = processor.indexOf("direction: 'inbound'");
  const decision = processor.indexOf('applicationEmailForwardingDecision(storedClassification, {');
  const claim = processor.indexOf('forwarding_claimed_at: new Date()');
  const send = processor.indexOf('sendEmail(forwardEmailPayload');
  assert.ok(ledgerInsert >= 0);
  assert.ok(decision > ledgerInsert);
  assert.ok(claim > decision);
  assert.ok(send > claim);
  assert.match(processor, /reason: forwardingDecision\.reason/);
  /* THE WHITELIST IS NOW A WITHHOLD LIST, and this is the assertion that says so.
   *
   * It used to pin the literal `classification === 'submission_confirmation' || classification ===
   * 'interview_request'`, which is the two-outcome allowlist that forwarded nothing for a day and
   * silently dropped an offer letter. What has to stay true is the shape: the default answer is to
   * deliver, and a refusal has to name a reason from a closed set. */
  assert.match(service, /if \(classification === 'applicant_reply'\) return \{ forward: false, reason: 'applicant_reply' \}/);
  assert.match(service, /classification === 'verification_code' && context\.securityCodeInFlight === true/);
  assert.match(service, /\n {2}return \{ forward: true \};\n\}/);
  // A withheld message is annotated on its own row, so it can never look unprocessed again.
  assert.match(processor, /await recordForwardDecision\(message\.id, `withheld:\$\{forwardingDecision\.reason\}`\)/);
  assert.match(processor, /await recordForwardDecision\(message\.id, 'forward'\)/);
  assert.match(service, /set\(\{ forward_decision: decision \}\)/);
  assert.match(processor, /onConflictDoNothing\(\{ target: application_email_messages\.dedupe_key \}\)/);
  assert.match(processor, /sql`\(\$\{application_email_messages\.forwarding_claimed_at\} is null or/);
  assert.match(processor, /storedApplicationEmailClassification\(message\.classification\)/);
  assert.match(processor, /subject: message\.subject \?\? undefined/);
  assert.doesNotMatch(
    processor.slice(processor.indexOf('await sendEmail(forwardEmailPayload'), processor.indexOf("if (storedClassification === 'submission_confirmation'")),
    /inbound: input/,
  );
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
