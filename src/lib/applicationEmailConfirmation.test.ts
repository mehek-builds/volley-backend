import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'fs';
import type { ApplicationReviewState } from './applicationReview';
import { isWaitingOnHuman } from './applicationStall';
import {
  confirmationIsStale,
  confirmationSenderAuthenticated,
  handleStoredEmployerMessage,
  reconcileSubmissionConfirmations,
  resolvePacketFromConfirmation,
  reviewFromSubmissionConfirmation,
  type ApplicationEmailClassification,
  type PacketReviewLookup,
  type StoredEmployerMessageDeps,
  type StoredInboundMessage,
  type SubmissionConfirmationOutcome,
} from './applicationEmail';

const USER_ID = 'a18f774b-a306-4804-93f3-cd6020c27fb3';
const OTHER_USER_ID = 'b28f774b-a306-4804-93f3-cd6020c27fb4';
const APPLICATION_ID = '8e29df51-09ed-4c67-b2fc-153966471473';
const MESSAGE_ID = 'd5df7cc3-70d4-4a87-8c20-c91ed68d8c8a';
const ALIAS = 'app-8e29df5109-8fca1550b4f3@garaierkaa.resend.app';
const RECEIVED_AT = new Date('2026-08-10T17:36:04.157Z');

function review(patch: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return {
    jd_text: '',
    status: 'needs_attention',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: '2026-08-10T17:35:04.214Z',
    ...patch,
  };
}

/* The measured Cresta packet, 8e29df51-09ed-4c67-b2fc-153966471473.
 *
 * The employer confirmed receipt at 17:36:04, sixty seconds after the code was requested at
 * 17:35:04, and the row still carried the security-code sentence, the 'security_code' category and
 * the whole security_code object next to `status: submitted`. */
const AWAITING_A_CODE = review({
  status: 'awaiting_security_code',
  portal_url: 'https://boards.greenhouse.io/cresta/jobs/1',
  attention_reason:
    'Litos submitted this application and the employer asked for a human check: a 8-character security code was emailed to '
    + `${ALIAS}, and the application is not filed until that code is entered.`,
  attention_categories: ['security_code'],
  security_code: {
    digits: 8,
    sent_to: ALIAS,
    requested_at: '2026-08-10T17:35:04.214Z',
    submit_was_authorized: false,
    attempts: [{ at: '2026-08-10T17:35:40.000Z', fingerprint: 'abc123', outcome: 'rejected' }],
  },
  submission_attempted_at: '2026-08-10T17:35:04.214Z',
});

// ---- FIX B: what an employer receipt does to the attention state ----

test('an employer receipt clears the attention state it has just answered', () => {
  const next = reviewFromSubmissionConfirmation(AWAITING_A_CODE, {
    alias: ALIAS,
    subject: 'Thank you for applying to Cresta',
    receivedAt: RECEIVED_AT,
  });
  assert.equal(next.status, 'submitted');
  assert.equal(next.submitted_at, RECEIVED_AT.toISOString());
  assert.equal(next.updated_at, RECEIVED_AT.toISOString());
  // The three fields that survived the old bare spread, and the reason the owner was told to go and
  // finish an application the employer had already confirmed.
  assert.equal(next.attention_reason, undefined);
  assert.equal(next.attention_categories, undefined);
  assert.equal(next.security_code, undefined);
  assert.equal(next.submission_error, undefined);
  assert.deepEqual(next.receipt, {
    confirmation_text: 'Thank you for applying to Cresta',
    final_url: 'https://boards.greenhouse.io/cresta/jobs/1',
    captured_at: RECEIVED_AT.toISOString(),
    source: 'email_fallback',
  });
});

test('an email-resolved packet does not keep an open stall', () => {
  const stalled = review({
    attention_reason: 'CAPTCHA requires your attention',
    attention_categories: ['captcha'],
    stall: {
      kind: 'human_verification',
      stalled_at: '2026-08-10T17:30:00.000Z',
      surface: 'server_run',
      provider: 'recaptcha_v2',
      stage: 'at_submit',
      source: 'observed',
    },
  });
  assert.equal(isWaitingOnHuman(stalled), true);
  const next = reviewFromSubmissionConfirmation(stalled, { alias: ALIAS, receivedAt: RECEIVED_AT });
  assert.equal(next.status, 'submitted');
  assert.equal(next.attention_reason, undefined);
  // Closed, never deleted: resolved_at minus stalled_at is the time-to-resolution measurement.
  assert.equal(next.stall?.stalled_at, '2026-08-10T17:30:00.000Z');
  assert.equal(next.stall?.resolved_at, RECEIVED_AT.toISOString());
  assert.equal(isWaitingOnHuman(next), false);
});

test('a stall that was already closed is not restamped by a later receipt', () => {
  const settled = review({
    status: 'ready_for_final_approval',
    stall: {
      kind: 'human_verification',
      stalled_at: '2026-08-10T17:30:00.000Z',
      surface: 'server_run',
      provider: 'recaptcha_v2',
      stage: 'at_submit',
      source: 'observed',
      resolved_at: '2026-08-10T17:32:00.000Z',
    },
  });
  const next = reviewFromSubmissionConfirmation(settled, { alias: ALIAS, receivedAt: RECEIVED_AT });
  assert.equal(next.stall?.resolved_at, '2026-08-10T17:32:00.000Z');
});

test('a receipt claims nothing about the application beyond the confirmation', () => {
  const prepared = review({
    status: 'ready_for_final_approval',
    filled_fields: ['first_name', 'email', 'resume'],
    preview_screenshot_url: 'https://blob.example/filled.png',
    applicant_email: {
      address: ALIAS,
      source: 'litos_alias',
      reason: 'deliverable',
      tracked: true,
      decided_at: '2026-08-10T17:20:00.000Z',
    },
  });
  const next = reviewFromSubmissionConfirmation(prepared, { alias: ALIAS, receivedAt: RECEIVED_AT });
  assert.deepEqual(next.filled_fields, ['first_name', 'email', 'resume']);
  assert.equal(next.preview_screenshot_url, 'https://blob.example/filled.png');
  assert.equal(next.applicant_email?.address, ALIAS);
  // No portal_url on the packet, so the alias is the only honest final_url available.
  assert.equal(next.receipt?.final_url, ALIAS);
});

test('a blank confirmation subject does not become a blank receipt', () => {
  const next = reviewFromSubmissionConfirmation(review(), { alias: ALIAS, subject: '   ', receivedAt: RECEIVED_AT });
  assert.equal(next.receipt?.confirmation_text, `Application confirmation received at ${ALIAS}`);
});

// ---- resolving one packet from one receipt ----

type SaveCall = { applicationId: string; userId: string; review: ApplicationReviewState; receivedAt: Date };
type SyncCall = { packetId: string; userId: string };

function resolverDeps(
  lookup: (input: { applicationId: string; userId: string }) => PacketReviewLookup,
  options: { syncFails?: boolean } = {},
) {
  const loads: Array<{ applicationId: string; userId: string }> = [];
  const saves: SaveCall[] = [];
  const syncs: SyncCall[] = [];
  return {
    loads,
    saves,
    syncs,
    deps: {
      loadReview: async (input: { applicationId: string; userId: string }) => {
        loads.push(input);
        return lookup(input);
      },
      saveReview: async (input: SaveCall) => {
        saves.push(input);
      },
      syncCanonicalApplication: async (input: SyncCall) => {
        syncs.push(input);
        if (options.syncFails) throw new Error('applications table is having a bad day');
      },
    },
  };
}

test('a receipt resolves its packet and writes it back under the same owner', async () => {
  const harness = resolverDeps(() => ({ review: AWAITING_A_CODE }));
  const outcome = await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: USER_ID,
    alias: ALIAS,
    subject: 'Thanks for applying',
    receivedAt: RECEIVED_AT,
  }, harness.deps);
  assert.equal(outcome.resolved, true);
  assert.deepEqual(harness.loads, [{ applicationId: APPLICATION_ID, userId: USER_ID }]);
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.saves[0].userId, USER_ID);
  assert.equal(harness.saves[0].review.status, 'submitted');
  assert.equal(harness.saves[0].review.attention_reason, undefined);
});

test('the confirmation resolver delegates the whole live commit with the exact message binding', async () => {
  const committed: unknown[] = [];
  const outcome = await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: USER_ID,
    alias: ALIAS,
    messageId: MESSAGE_ID,
    subject: 'Thanks for applying',
    receivedAt: RECEIVED_AT,
  }, {
    commitConfirmation: async (input) => {
      committed.push(input);
      return { resolved: true, review: review({ status: 'submitted' }) };
    },
  });
  assert.equal(outcome.resolved, true);
  assert.deepEqual(committed, [{
    applicationId: APPLICATION_ID,
    userId: USER_ID,
    alias: ALIAS,
    messageId: MESSAGE_ID,
    subject: 'Thanks for applying',
    receivedAt: RECEIVED_AT,
  }]);
});

/* A packet belongs to the owner of the alias the mail arrived at, and to nobody else. The lookup is
 * scoped by user AND id, so a confirmation carrying another user's application id finds nothing
 * rather than resolving a stranger's application. */
test('a confirmation cannot resolve a packet belonging to another user', async () => {
  const harness = resolverDeps((input) => (input.userId === USER_ID ? { review: AWAITING_A_CODE } : null));
  const outcome = await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: OTHER_USER_ID,
    alias: ALIAS,
    receivedAt: RECEIVED_AT,
  }, harness.deps);
  assert.deepEqual(outcome, { resolved: false, reason: 'packet_not_found' });
  assert.equal(harness.saves.length, 0);
});

test('a packet already submitted is left exactly as it is', async () => {
  const harness = resolverDeps(() => ({
    review: review({ status: 'submitted', submitted_at: '2026-08-10T17:20:00.000Z' }),
  }));
  const outcome = await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: USER_ID,
    alias: ALIAS,
    receivedAt: RECEIVED_AT,
  }, harness.deps);
  assert.deepEqual(outcome, { resolved: false, reason: 'already_submitted' });
  assert.equal(harness.saves.length, 0);
});

/* THE CANONICAL ROW LEARNS WHAT THE PACKET LEARNED. Measured on 2026-08-18: four employer
 * receipts (DV Trading, Nuro, ForSight, Skydio) resolved their packets to submitted/applied while
 * the applications row the tracker renders stayed at ready_to_submit/saved, so the dashboard kept
 * offering to send applications the employers had already confirmed. A resolution now carries the
 * same fact to the canonical row, and the already-submitted branch carries it too, because every
 * receipt resolved before this sync existed left exactly that split behind for the reconciler to
 * find. */
test('resolving a receipt advances the canonical application row with the packet', async () => {
  const harness = resolverDeps(() => ({ review: AWAITING_A_CODE }));
  const outcome = await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: USER_ID,
    alias: ALIAS,
    subject: 'Thanks for applying',
    receivedAt: RECEIVED_AT,
  }, harness.deps);
  assert.equal(outcome.resolved, true);
  assert.deepEqual(harness.syncs, [{ packetId: APPLICATION_ID, userId: USER_ID }]);
});

test('an already-submitted packet still heals its canonical row on replay', async () => {
  const harness = resolverDeps(() => ({
    review: review({ status: 'submitted', submitted_at: '2026-08-10T17:20:00.000Z' }),
  }));
  const outcome = await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: USER_ID,
    alias: ALIAS,
    receivedAt: RECEIVED_AT,
  }, harness.deps);
  assert.deepEqual(outcome, { resolved: false, reason: 'already_submitted' });
  assert.deepEqual(harness.syncs, [{ packetId: APPLICATION_ID, userId: USER_ID }]);
});

/* The already-submitted branch was a pure read before the sync existed, and a duplicate delivery
 * must keep costing what it used to cost: nothing. A canonical write that throws would otherwise
 * 500 the webhook and put a long-settled receipt into Resend's redelivery loop. */
test('a canonical sync failure never blocks the confirmation', async () => {
  const replay = resolverDeps(() => ({
    review: review({ status: 'submitted', submitted_at: '2026-08-10T17:20:00.000Z' }),
  }), { syncFails: true });
  const replayOutcome = await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: USER_ID,
    alias: ALIAS,
    receivedAt: RECEIVED_AT,
  }, replay.deps);
  assert.deepEqual(replayOutcome, { resolved: false, reason: 'already_submitted' });
  assert.equal(replay.syncs.length, 1);

  const fresh = resolverDeps(() => ({ review: AWAITING_A_CODE }), { syncFails: true });
  const freshOutcome = await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: USER_ID,
    alias: ALIAS,
    subject: 'Thanks for applying',
    receivedAt: RECEIVED_AT,
  }, fresh.deps);
  assert.equal(freshOutcome.resolved, true);
  assert.equal(fresh.saves.length, 1);
});

/* A receipt the guards refuse must not advance the canonical row either: a stale replay proves
 * nothing about the CURRENT attempt, and an unowned or missing packet proves nothing at all. */
test('a stale or unresolvable receipt does not touch the canonical row', async () => {
  const stale = resolverDeps(() => ({
    review: review({
      status: 'awaiting_security_code',
      submission_attempted_at: '2026-08-11T09:00:00.000Z',
    }),
  }));
  const staleOutcome = await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: USER_ID,
    alias: ALIAS,
    receivedAt: RECEIVED_AT,
  }, stale.deps);
  assert.deepEqual(staleOutcome, { resolved: false, reason: 'stale_confirmation' });
  assert.equal(stale.syncs.length, 0);

  const unowned = resolverDeps(() => null);
  await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: OTHER_USER_ID,
    alias: ALIAS,
    receivedAt: RECEIVED_AT,
  }, unowned.deps);
  assert.equal(unowned.syncs.length, 0);
});

/* THE REPLAY WINDOW the reordering opens, closed before anything can wire the reconciler.
 *
 * Resolution now runs on every delivery, so the same receipt can arrive twice and the reconciler can
 * replay one from weeks ago. Safe while the packet stays submitted; the moment a re-run takes it out
 * of that state, a stale receipt would stamp itself over the new attempt and clear the very
 * attention_reason and security_code that run had just written. */
test('a receipt older than the packet\'s latest attempt cannot re-resolve it', async () => {
  const reRun = review({
    status: 'awaiting_security_code',
    attention_reason: 'a fresh code was emailed for the second attempt',
    submission_attempted_at: '2026-08-11T09:00:00.000Z',
    receipt: {
      confirmation_text: 'the first receipt',
      final_url: ALIAS,
      captured_at: '2026-08-10T17:36:04.157Z',
      source: 'email_fallback',
    },
  });
  const harness = resolverDeps(() => ({ review: reRun }));
  const outcome = await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: USER_ID,
    alias: ALIAS,
    subject: 'Thank you for applying to Cresta',
    receivedAt: RECEIVED_AT,
  }, harness.deps);
  assert.deepEqual(outcome, { resolved: false, reason: 'stale_confirmation' });
  assert.equal(harness.saves.length, 0);
});

test('a redelivery cannot restamp a receipt the packet already holds', async () => {
  const held = review({
    status: 'needs_attention',
    attention_reason: 'a later run stopped on something new',
    receipt: {
      confirmation_text: 'the same receipt',
      final_url: ALIAS,
      captured_at: RECEIVED_AT.toISOString(),
      source: 'email_fallback',
    },
  });
  const harness = resolverDeps(() => ({ review: held }));
  const outcome = await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: USER_ID,
    alias: ALIAS,
    receivedAt: RECEIVED_AT,
  }, harness.deps);
  assert.deepEqual(outcome, { resolved: false, reason: 'stale_confirmation' });
  assert.equal(harness.saves.length, 0);
});

/* The guard must not refuse the case it exists beside: the measured Cresta ordering, where the run
 * attempted a submission at 17:35:04 and the employer confirmed at 17:36:04. An attempt BEFORE the
 * receipt is what a receipt is for. */
test('a receipt newer than the attempt it answers still resolves', async () => {
  const harness = resolverDeps(() => ({ review: AWAITING_A_CODE }));
  const outcome = await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: USER_ID,
    alias: ALIAS,
    receivedAt: RECEIVED_AT,
  }, harness.deps);
  assert.equal(outcome.resolved, true);
  assert.equal(harness.saves.length, 1);
  assert.equal(confirmationIsStale(AWAITING_A_CODE, RECEIVED_AT), false);
  // A packet with no submission history at all is never stale.
  assert.equal(confirmationIsStale(review(), RECEIVED_AT), false);
  // An older managed receipt does not block a genuine later email receipt.
  assert.equal(
    confirmationIsStale(
      review({
        receipt: {
          confirmation_text: 'earlier',
          final_url: ALIAS,
          captured_at: '2026-08-10T17:00:00.000Z',
          source: 'managed_browser',
        },
      }),
      RECEIVED_AT,
    ),
    false,
  );
});

test('a claim taken after the confirmation arrived also makes it stale', () => {
  assert.equal(
    confirmationIsStale(review({ submission_claimed_at: '2026-08-11T09:00:00.000Z' }), RECEIVED_AT),
    true,
  );
  assert.equal(
    confirmationIsStale(review({ submitted_at: '2026-08-11T09:00:00.000Z' }), RECEIVED_AT),
    true,
  );
});

test('a packet with no review yet is not invented one', async () => {
  const harness = resolverDeps(() => ({ review: null }));
  const outcome = await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: USER_ID,
    alias: ALIAS,
    receivedAt: RECEIVED_AT,
  }, harness.deps);
  assert.deepEqual(outcome, { resolved: false, reason: 'review_missing' });
  assert.equal(harness.saves.length, 0);
});

// ---- FIX A: resolution is not a side effect of a successful first forward ----

type HandlerCalls = {
  resolved: Array<{ applicationId: string; userId: string; subject?: string; receivedAt: Date }>;
  forwarded: number;
  claimed: number;
  markedForwarded: number;
  failures: string[];
  order: string[];
};

function handlerDeps(overrides: {
  resolveConfirmation?: StoredEmployerMessageDeps['resolveConfirmation'];
  forward?: StoredEmployerMessageDeps['forward'];
  claim?: boolean;
} = {}): { deps: StoredEmployerMessageDeps; calls: HandlerCalls } {
  const calls: HandlerCalls = {
    resolved: [],
    forwarded: 0,
    claimed: 0,
    markedForwarded: 0,
    failures: [],
    order: [],
  };
  const deps: StoredEmployerMessageDeps = {
    resolveConfirmation: async (input) => {
      calls.order.push('resolve');
      calls.resolved.push(input);
      if (overrides.resolveConfirmation) return overrides.resolveConfirmation(input);
      return { resolved: true, review: review({ status: 'submitted' }) } as SubmissionConfirmationOutcome;
    },
    claimForwarding: async () => {
      calls.claimed += 1;
      return overrides.claim ?? true;
    },
    forward: async (input) => {
      calls.order.push('forward');
      calls.forwarded += 1;
      if (overrides.forward) await overrides.forward(input);
    },
    markForwarded: async () => {
      calls.markedForwarded += 1;
    },
    recordForwardFailure: async ({ error }) => {
      calls.failures.push(error);
    },
  };
  return { deps, calls };
}

type AliasRow = { alias: string; user_id: string; generated_resume_id: string | null; forward_to: string };

const ALIAS_ROW: AliasRow = {
  alias: ALIAS,
  user_id: USER_ID,
  generated_resume_id: APPLICATION_ID,
  forward_to: 'owner@example.com',
};

function storedMessage(patch: Partial<StoredInboundMessage> = {}): StoredInboundMessage {
  return {
    id: '4d1e7934-f34f-44db-bf42-347c69be0ff3',
    forwarded_at: null,
    from_email: 'no-reply@greenhouse.io',
    subject: 'Thank you for applying to Cresta',
    text: 'We have received your application.',
    html: null,
    received_at: RECEIVED_AT,
    ...patch,
  };
}

function handle(
  classification: ApplicationEmailClassification,
  message: StoredInboundMessage | null,
  deps: StoredEmployerMessageDeps,
  aliasRow = ALIAS_ROW,
) {
  return handleStoredEmployerMessage({ aliasRow, message, classification, receivedAt: RECEIVED_AT }, deps);
}

/* The gate that made every row written before the resolution existed unresolvable forever: the call
 * used to sit BELOW `if (!message || message.forwarded_at) return`. */
test('a confirmation that was already forwarded still resolves its packet', async () => {
  const { deps, calls } = handlerDeps();
  const result = await handle(
    'submission_confirmation',
    storedMessage({ forwarded_at: new Date('2026-08-10T17:36:10.000Z') }),
    deps,
  );
  assert.equal(result.resolved, true);
  assert.equal(result.forwarded, false);
  assert.equal(result.reason, 'already_forwarded');
  assert.equal(calls.resolved.length, 1);
  assert.equal((calls.resolved[0] as { messageId?: string }).messageId, storedMessage().id);
  assert.equal(calls.forwarded, 0);
  assert.equal(calls.claimed, 0);
});

/* The gate that made a degraded mailer look like an unsent application: the resolution was below a
 * `throw`, so a provider outage of any length silently unfiled every confirmation that arrived
 * during it. */
test('a forward that throws still resolves the packet', async () => {
  const { deps, calls } = handlerDeps({
    forward: async () => {
      throw new Error('Resend returned 503');
    },
  });
  await assert.rejects(
    () => handle('submission_confirmation', storedMessage(), deps),
    /Resend returned 503/,
  );
  assert.deepEqual(calls.order, ['resolve', 'forward']);
  assert.equal(calls.resolved.length, 1);
  // The claim is released and the error is recorded, exactly as before.
  assert.equal(calls.failures.length, 1);
  assert.match(calls.failures[0], /Resend returned 503/);
  assert.equal(calls.markedForwarded, 0);
});

test('a forwarding claim held elsewhere does not withhold the resolution', async () => {
  const { deps, calls } = handlerDeps({ claim: false });
  const result = await handle('submission_confirmation', storedMessage(), deps);
  assert.equal(result.resolved, true);
  assert.equal(result.forwarded, false);
  assert.equal(result.reason, 'claimed_elsewhere');
  assert.equal(calls.resolved.length, 1);
  assert.equal(calls.forwarded, 0);
});

test('the ordinary confirmation both resolves and forwards', async () => {
  const { deps, calls } = handlerDeps();
  const result = await handle('submission_confirmation', storedMessage(), deps);
  assert.equal(result.resolved, true);
  assert.equal(result.forwarded, true);
  assert.deepEqual(calls.order, ['resolve', 'forward']);
  assert.equal(calls.markedForwarded, 1);
  assert.equal(calls.resolved[0].applicationId, APPLICATION_ID);
  assert.equal(calls.resolved[0].userId, USER_ID);
  assert.equal(calls.resolved[0].subject, 'Thank you for applying to Cresta');
});

/* THE FALSE POSITIVE THIS MUST NOT HAVE. Only a submission confirmation files an application.
 * Interview logistics are forwarded and change nothing about whether the employer received it, and
 * an internal-only classification is neither forwarded nor allowed to file anything. */
test('no classification but a submission confirmation resolves a packet', async () => {
  for (const classification of ['interview_request', 'verification_code', 'recruiter_reply', 'applicant_reply', 'other'] as const) {
    const { deps, calls } = handlerDeps();
    const result = await handle(classification, storedMessage(), deps);
    assert.equal(result.resolved, false, `${classification} must not resolve a packet`);
    assert.equal(calls.resolved.length, 0, `${classification} must not reach the resolver`);
    assert.equal(result.forwarded, classification === 'interview_request');
  }
});

test('a confirmation on an alias with no packet has nothing to resolve', async () => {
  const { deps, calls } = handlerDeps();
  const result = await handle(
    'submission_confirmation',
    storedMessage(),
    deps,
    { ...ALIAS_ROW, generated_resume_id: null },
  );
  assert.equal(result.resolved, false);
  assert.equal(calls.resolved.length, 0);
  assert.equal(result.forwarded, true);
});

test('a receipt whose row carried no timestamp falls back to the delivery time', async () => {
  const { deps, calls } = handlerDeps();
  await handle('submission_confirmation', storedMessage({ received_at: null, subject: null }), deps);
  assert.equal(calls.resolved[0].receivedAt.toISOString(), RECEIVED_AT.toISOString());
  assert.equal(calls.resolved[0].subject, undefined);
});

/* A resolution that throws is a real error and must reach the webhook, so the delivery is retried.
 * It must not take the forward down with it on the way: the copy in her mailbox is not contingent on
 * the bookkeeping, which is the same rule as the reverse case above pointed the other way. */
test('a resolution failure is rethrown but does not withhold the forward', async () => {
  const { deps, calls } = handlerDeps({
    resolveConfirmation: async () => {
      throw new Error('packet read timed out');
    },
  });
  const seen: unknown[] = [];
  await assert.rejects(
    () => handleStoredEmployerMessage({
      aliasRow: ALIAS_ROW,
      message: storedMessage(),
      classification: 'submission_confirmation',
      receivedAt: RECEIVED_AT,
    }, { ...deps, onResolutionError: (error) => seen.push(error) }),
    /packet read timed out/,
  );
  assert.equal(calls.forwarded, 1);
  assert.equal(calls.markedForwarded, 1);
  assert.equal(seen.length, 1);
});

/* A packet that says "submitted, from an email" owes a message anyone can go and read. Only the
 * three FORWARDING gates were removed; the ledger row stays required, so the state and the evidence
 * for it cannot come apart. Unreachable in practice, since a conflicting insert means the row is
 * there to be selected, and a redelivery resolves it either way. */
test('a confirmation with no ledger row is not resolved from thin air', async () => {
  const { deps, calls } = handlerDeps();
  const result = await handle('submission_confirmation', null, deps);
  assert.equal(result.forwarded, false);
  assert.equal(result.reason, 'message_not_stored');
  assert.equal(calls.resolved.length, 0);
  assert.equal(result.resolved, false);
});

// ---- reconciling the confirmations that are already stored ----

test('reconciliation resolves the newest receipt per packet, once', async () => {
  const resolved: string[] = [];
  const outcome = await reconcileSubmissionConfirmations({}, {
    listConfirmations: async () => [
      { messageId: MESSAGE_ID, applicationId: APPLICATION_ID, userId: USER_ID, alias: ALIAS, subject: 'newest', receivedAt: RECEIVED_AT },
      {
        messageId: 'older-message',
        applicationId: APPLICATION_ID,
        userId: USER_ID,
        alias: ALIAS,
        subject: 'older',
        receivedAt: new Date('2026-08-09T10:00:00.000Z'),
      },
    ],
    resolve: async (input) => {
      resolved.push(input.subject ?? '');
      return { resolved: true, review: review({ status: 'submitted' }) };
    },
  });
  assert.deepEqual(resolved, ['newest']);
  assert.deepEqual(outcome, { scanned: 1, resolved: 1, unchanged: 0, reasons: {} });
});

test('reconciliation counts the packets it deliberately left alone', async () => {
  const outcome = await reconcileSubmissionConfirmations({}, {
    listConfirmations: async () => [
      { messageId: 'a', applicationId: 'a', userId: USER_ID, alias: ALIAS, subject: null, receivedAt: RECEIVED_AT },
      { messageId: 'b', applicationId: 'b', userId: USER_ID, alias: ALIAS, subject: null, receivedAt: RECEIVED_AT },
      { messageId: 'c', applicationId: 'c', userId: USER_ID, alias: ALIAS, subject: null, receivedAt: RECEIVED_AT },
    ],
    resolve: async (input) => (input.applicationId === 'a'
      ? { resolved: true, review: review({ status: 'submitted' }) }
      : { resolved: false, reason: input.applicationId === 'b' ? 'already_submitted' : 'packet_not_found' }),
  });
  assert.deepEqual(outcome, {
    scanned: 3,
    resolved: 1,
    unchanged: 2,
    reasons: { already_submitted: 1, packet_not_found: 1 },
  });
});

/* The rows iterate in a stable order, so before this guard a single throwing packet did not just
 * lose one pass's counters, it aborted every future pass at the same position and the
 * one-pass-fixes-all heal could never complete. */
test('one failing packet does not abort the reconciliation pass', async () => {
  const attempted: string[] = [];
  const outcome = await reconcileSubmissionConfirmations({}, {
    listConfirmations: async () => [
      { messageId: 'a', applicationId: 'a', userId: USER_ID, alias: ALIAS, subject: null, receivedAt: RECEIVED_AT },
      { messageId: 'poison', applicationId: 'poison', userId: USER_ID, alias: ALIAS, subject: null, receivedAt: RECEIVED_AT },
      { messageId: 'c', applicationId: 'c', userId: USER_ID, alias: ALIAS, subject: null, receivedAt: RECEIVED_AT },
    ],
    resolve: async (input) => {
      attempted.push(input.applicationId);
      if (input.applicationId === 'poison') throw new Error('the applications table hiccuped');
      return { resolved: true, review: review({ status: 'submitted' }) };
    },
  });
  assert.deepEqual(attempted, ['a', 'poison', 'c']);
  assert.deepEqual(outcome, { scanned: 3, resolved: 2, unchanged: 1, reasons: { resolver_error: 1 } });
});

test('reconciliation passes its owner filter down and clamps an absurd limit', async () => {
  const queries: Array<{ userId?: string; limit: number }> = [];
  await reconcileSubmissionConfirmations({ userId: USER_ID, limit: 10_000 }, {
    listConfirmations: async (query) => {
      queries.push(query);
      return [];
    },
  });
  await reconcileSubmissionConfirmations({ limit: 0 }, {
    listConfirmations: async (query) => {
      queries.push(query);
      return [];
    },
  });
  assert.deepEqual(queries, [{ userId: USER_ID, limit: 1000 }, { userId: undefined, limit: 1 }]);
});

// ---- the shape of the live wiring, which no fake can check ----

const service = readFileSync('src/lib/applicationEmail.ts', 'utf8');

test('the live packet read and write are both scoped by owner', () => {
  const load = service.slice(service.indexOf('async function loadPacketReview'));
  assert.match(load.slice(0, 600), /eq\(generated_resumes\.user_id, input\.userId\)/);
  const save = service.slice(service.indexOf('async function savePacketReview'));
  assert.match(save.slice(0, 900), /eq\(generated_resumes\.user_id, input\.userId\)/);
  // The optimistic guard that stops a second receipt restamping the first one's evidence.
  assert.match(save.slice(0, 900), /'_review'->>'status' <> 'submitted'/);
});

test('the live confirmation commits one exact message fact under the shared owner lock', () => {
  const commit = service.slice(
    service.indexOf('async function commitPacketConfirmationAtomically'),
    service.indexOf('export async function resolvePacketFromConfirmation'),
  );
  const lock = commit.indexOf('await lockSubmissionAttemptUser(tx, input.userId)');
  const packetLock = commit.indexOf(".for('update')", lock);
  const messageId = commit.indexOf('eq(application_email_messages.id, messageId)', packetLock);
  const append = commit.indexOf('await appendSubmissionAttemptEvent({', messageId);
  const packetUpdate = commit.indexOf('await tx.update(generated_resumes)', append);
  const canonicalSync = commit.indexOf('await syncCanonicalApplicationRow({', packetUpdate);
  const projection = commit.indexOf('await authoritativeSubmissionProjection({', canonicalSync);
  assert.ok(lock >= 0 && packetLock > lock && messageId > packetLock && append > messageId
    && packetUpdate > append && canonicalSync > packetUpdate && projection > canonicalSync);
  assert.match(commit, /eq\(application_email_messages\.user_id, input\.userId\)/);
  assert.match(commit, /eq\(application_email_messages\.generated_resume_id, input\.applicationId\)/);
  assert.match(commit, /eq\(application_email_messages\.classification, 'submission_confirmation'\)/);
  assert.match(commit, /employerEmailConfirmationEvidenceCode\([\s\S]*?messageId: message\.id/);
  assert.match(commit, /authoritativeConfirmedProjectionMatches/);
});

test('resolution is ordered ahead of the forwarding claim, not after the send', () => {
  const handler = service.slice(service.indexOf('export async function handleStoredEmployerMessage'));
  const resolve = handler.indexOf('deps.resolveConfirmation(');
  const forwardingDecision = handler.indexOf('applicationEmailForwardingDecision(');
  const claim = handler.indexOf('deps.claimForwarding(');
  const send = handler.indexOf('deps.forward(');
  assert.ok(resolve > 0);
  assert.ok(resolve < forwardingDecision, 'the confirmation must resolve before the forwarding decision');
  assert.ok(forwardingDecision < claim && claim < send);
  // The write goes through the one review merge, never a bare spread beside a jsonb_set.
  assert.match(service, /return applyReviewPatch\(current, \{\s*\n\s*status: 'submitted'/);
});

test('the reconciliation path is a function and not a scheduled job', () => {
  assert.match(service, /export async function reconcileSubmissionConfirmations/);
  const vercel = readFileSync('vercel.json', 'utf8');
  assert.doesNotMatch(vercel, /reconcile/i);
});

/* AUTHENTICATED, OR IT FILES NOTHING. A confirmation moves a packet to submitted without anyone
 * looking, so the receiving provider's own verdicts have to vouch for the sender first. Silence is
 * not a pass here (the opposite of the applicant-reply rule in senderAuthenticationFailed). */
test('a confirmation files only when DKIM or SPF passed and nothing failed', () => {
  assert.equal(confirmationSenderAuthenticated({ spf: 'pass', dkim: 'pass', dmarc: 'pass' }), true);
  assert.equal(confirmationSenderAuthenticated({ dkim: 'pass' }), true);
  assert.equal(confirmationSenderAuthenticated({ spf: 'PASS' }), true);
  assert.equal(confirmationSenderAuthenticated({ spf: 'pass', dkim: 'fail' }), false, 'one failing verdict refuses');
  assert.equal(confirmationSenderAuthenticated({ dmarc: 'pass' }), false, 'DMARC alone names a policy, not a sender proof');
  assert.equal(confirmationSenderAuthenticated({ spf: 'none', dkim: 'none' }), false);
  assert.equal(confirmationSenderAuthenticated({}), false);
  assert.equal(confirmationSenderAuthenticated(undefined), false, 'no verdicts is not a pass');
});

test('an unauthenticated confirmation is stored and forwarded but never resolves the packet', async () => {
  const harness = resolverDeps(() => ({ review: AWAITING_A_CODE }));
  const outcome = await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: USER_ID,
    alias: ALIAS,
    subject: 'Thanks for applying',
    receivedAt: RECEIVED_AT,
    authentication: { spf: 'pass', dkim: 'fail' },
  }, harness.deps);
  assert.deepEqual(outcome, { resolved: false, reason: 'sender_unauthenticated' });
  assert.equal(harness.saves.length, 0, 'nothing is written for an unauthenticated confirmation');
  const passed = await resolvePacketFromConfirmation({
    applicationId: APPLICATION_ID,
    userId: USER_ID,
    alias: ALIAS,
    subject: 'Thanks for applying',
    receivedAt: RECEIVED_AT,
    authentication: { dkim: 'pass' },
  }, harness.deps);
  assert.equal(passed.resolved, true);
  assert.equal(harness.saves.length, 1);
});

test('the stored handler carries the provider verdicts to the resolver', async () => {
  const { deps, calls } = handlerDeps();
  await handleStoredEmployerMessage({
    aliasRow: ALIAS_ROW,
    message: storedMessage(),
    classification: 'submission_confirmation',
    receivedAt: RECEIVED_AT,
    authentication: { spf: 'pass', dkim: 'pass' },
  }, deps);
  assert.deepEqual((calls.resolved[0] as { authentication?: unknown }).authentication, { spf: 'pass', dkim: 'pass' });
});
