import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/** Every TypeScript source file under a directory, tests excluded, in a stable order. */
function sourceFilesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return sourceFilesUnder(path);
      return entry.isFile() && path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
    });
}

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

/* Storing and disposing are two functions now, so this reads across both instead of inside one.
 *
 * The property is exactly what it always was: the ledger row is written FIRST, and only then does
 * anything decide whether that message may leave Litos. What moved is where the deciding happens -
 * handleStoredEmployerMessage - and why: resolution of a submission confirmation had to stop being a
 * side effect of a successful first forward. The second property is newer: whatever is decided, the
 * row is annotated with it, so a message that was stored and withheld can never again be mistaken
 * for one nothing has looked at. */
test('employer mail is stored before the forwarding decision, and every decision is recorded', () => {
  const handlerStart = service.indexOf('export async function handleStoredEmployerMessage');
  const processorStart = service.indexOf('export async function processInboundApplicationEmail');
  const handler = service.slice(handlerStart, processorStart);
  const processor = service.slice(processorStart, service.indexOf('export async function reconcileSubmissionConfirmations'));
  const ledgerInsert = processor.indexOf("direction: 'inbound'");
  const handoff = processor.indexOf('return handleStoredEmployerMessage({');
  assert.ok(ledgerInsert >= 0);
  assert.ok(handoff > ledgerInsert, 'the message must be in the ledger before anything decides what to do with it');
  const decision = handler.indexOf('applicationEmailForwardingDecision(classification, {');
  const claim = handler.indexOf('deps.claimForwarding(');
  const send = handler.indexOf('deps.forward(');
  assert.ok(decision >= 0);
  assert.ok(claim > decision);
  assert.ok(send > claim);
  assert.match(handler, /reason: forwardingDecision\.reason/);
  /* THE WHITELIST IS A WITHHOLD LIST NOW, and this is the assertion that says so.
   *
   * It used to pin the literal `classification === 'submission_confirmation' || classification ===
   * 'interview_request'`, the two-outcome allowlist that forwarded nothing for a day and silently
   * dropped an offer letter. What has to stay true is the shape: the default answer is to deliver,
   * and a refusal has to name a reason from a closed set. */
  assert.match(service, /if \(classification === 'applicant_reply'\) return \{ forward: false, reason: 'applicant_reply' \}/);
  assert.match(service, /classification === 'verification_code' && context\.securityCodeInFlight === true/);
  assert.match(service, /\n {2}return \{ forward: true \};\n\}/);
  assert.doesNotMatch(service, /classification === 'submission_confirmation' \|\| classification === 'interview_request'/);
  /* THE GATE THE WIDENED POLICY PAYS FOR, and the reason it lives here rather than at the door.
   *
   * routeInboundApplicationEmail returns employer_message at `sender !== forwardTo`, BEFORE it
   * reaches its own senderAuthenticationFailed call, so an employer message's SPF, DKIM and DMARC
   * verdicts were never consulted at all. Harmless while two classifications forwarded; a spoofing
   * and deliverability problem the moment forwarding became the default, because the relay leaves
   * from Litos's own verified sending identity.
   *
   * It must be checked ahead of the classification, since what a forgery calls itself is not
   * evidence, and it must be reached by employer mail, which the route's own check is not. */
  assert.match(service, /if \(context\.senderAuthenticationFailed === true\) \{\n\s*return \{ forward: false, reason: 'sender_authentication_failed' \};/);
  const authGate = service.indexOf("context.senderAuthenticationFailed === true");
  const codeGate = service.indexOf("classification === 'verification_code' && context.securityCodeInFlight");
  assert.ok(authGate > 0 && codeGate > authGate, 'an untrusted sender is refused before anything else is weighed');
  assert.match(processor, /senderAuthenticationFailed: senderAuthenticationFailed\(input\.authentication\)/);
  assert.match(handler, /senderAuthenticationFailed: senderRefused/);
  /* THE REFUSAL IS REMEMBERED, not recomputed from whatever the current delivery says.
   *
   * Measured before this existed: delivery one failed authentication and was withheld, delivery two
   * arrived with the header absent, and the message was both forwarded and its annotation
   * overwritten to 'forward'. A control with no memory can be replayed around. */
  assert.match(handler, /const senderRefused = input\.senderAuthenticationFailed === true\s*\n\s*\|\| forwardDecisionRefusedSender\(message\?\.forward_decision\)/);
  assert.match(service, /forward_decision: application_email_messages\.forward_decision,\n\} as const/);
  assert.match(service, /export function forwardDecisionRefusedSender/);
  // The stored decision has to be SELECTED for any of that to be readable.
  assert.match(service, /const LEDGER_ROW_SELECTION = \{\n\s*\.\.\.LEDGER_ROW_SELECTION_BEFORE_FORWARD_DECISION/);
  // Absent stays fail-open, and DMARC is authoritative when it has spoken.
  assert.match(service, /if \(!authentication\) return false;/);
  assert.match(service, /if \(dmarc === 'fail'\) return true;\n\s*if \(dmarc === 'pass'\) return false;/);
  assert.doesNotMatch(service, /=== 'softfail'/);
  // Every decision is annotated on the row, and the withhold is annotated before the early return.
  assert.match(handler, /deps\.recordDecision\(\{ messageId: message\.id, decision: withheldForwardDecision\(forwardingDecision\.reason\) \}\)/);
  assert.match(handler, /await deps\.recordDecision\(\{ messageId: message\.id, decision: 'forward' \}\)/);
  // The withhold value has one spelling, so the writer and the sticky reader cannot drift apart.
  assert.match(service, /export function withheldForwardDecision\(reason: ApplicationEmailWithholdReason\): string \{\n\s*return `withheld:\$\{reason\}`;/);
  assert.match(service, /storedForwardDecision === withheldForwardDecision\('sender_authentication_failed'\)/);
  const withheldRecord = handler.indexOf('decision: withheldForwardDecision(');
  assert.ok(withheldRecord > decision && withheldRecord < claim, 'the drop is recorded before the function returns from it');
  assert.ok(handler.indexOf("decision: 'forward'") < claim, 'a lost claim still leaves the decision on the row');
  assert.match(service, /set\(\{ forward_decision: decision \}\)/);
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

/* EVERY PLACE forward_decision IS TOUCHED SURVIVES ITS OWN MIGRATION NOT HAVING RUN, because on
 * Vercel a merge is a deploy and the two land in either order.
 *
 * The three that only annotate degrade to "unmeasurable" and carry on. The fourth is the ledger
 * INSERT, which cannot degrade: Drizzle names every declared column in an INSERT, so an unmigrated
 * database rejects the statement that stores employer mail. That one is repeated without the
 * column instead. The behaviour is measured in applicationEmailForwardDecision.test.ts against a
 * database with the column dropped; these assertions are here so the shim is not deleted by
 * somebody tidying up before the migration has run everywhere. */
test('forward_decision is written by code that works before its migration', () => {
  // The writer: swallows undefined_column and nothing else.
  assert.match(service, /set\(\{ forward_decision: decision \}\)[\s\S]{0,200}if \(!isUndefinedColumnError\(error\)\) throw error;/);
  // The health count: null when it cannot be taken, never 0.
  assert.match(service, /like 'withheld:%'[\s\S]{0,600}\.catch\(\(\) => null\)/);
  // The ledger route: falls back to the pre-migration shape rather than 500ing the inbox.
  assert.match(route, /forward_decision: application_email_messages\.forward_decision/);
  assert.match(route, /if \(!isUndefinedColumnError\(error\)\) throw error;[\s\S]{0,400}forward_decision: null as string \| null/);
  /* BOTH inserts: repeated without the column, because storing a message may not depend on the
   * column that only annotates it. The relay one was missed the first time round, because the sweep
   * that found the other hazards looked for bare SELECTs and an INSERT is the statement Drizzle
   * fills out with every declared column. On an unmigrated database the applicant's reply threw,
   * the webhook 500d, and her answer never reached the employer. */
  assert.match(service, /async function insertLedgerRowWithoutForwardDecision/);
  assert.match(service, /return insertLedgerRowWithoutForwardDecision\(ledgerValues\)/);
  assert.match(service, /return insertLedgerRowWithoutForwardDecision\(relayValues\)/);
  assert.doesNotMatch(service, /insert into application_email_messages[\s\S]{0,700}forward_decision/);
  /* Nothing anywhere in src may insert into this table without going through one of those two
   * guarded call sites. Scanned across the whole tree rather than this one file: the first version
   * of this guard counted inserts in applicationEmail.ts alone, so a third insert added HERE failed
   * the suite as intended while an identical one added to routes/applicationEmail.ts passed
   * uncaught. A guard that only looks where the bug already happened is not a guard. */
  const insertSites = sourceFilesUnder('src')
    .map((file) => ({ file, hits: (readFileSync(file, 'utf8').match(/db\.insert\(application_email_messages\)/g) ?? []).length }))
    .filter(({ hits }) => hits > 0);
  assert.deepEqual(insertSites, [{ file: 'src/lib/applicationEmail.ts', hits: 2 }]);
  // The re-read after a conflict is the redelivery path, so it needs the same fallback.
  assert.match(service, /\.select\(LEDGER_ROW_SELECTION_BEFORE_FORWARD_DECISION\)/);
  /* The account export: a BARE select is the form that breaks, because Drizzle names every declared
   * column whether or not the caller wants it. Measured against production on this branch's head as
   * `column "forward_decision" does not exist`, taking GET /account/export down for every user. */
  const accountRoute = readFileSync('src/routes/account.ts', 'utf8');
  assert.match(accountRoute, /selectApplicationEmailMessagesForUser\(userId\)/);
  assert.doesNotMatch(accountRoute, /db\.select\(\)\.from\(application_email_messages\)/);
  assert.match(service, /export async function selectApplicationEmailMessagesForUser/);
  assert.match(service, /forward_decision: _notMigratedYet, \.\.\.columns \} = getTableColumns\(application_email_messages\)/);
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
