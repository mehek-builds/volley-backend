import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index';
import {
  users,
  profiles,
  experience_bank,
  application_profile,
  generated_resumes,
  outreach_events,
  autofill_events,
  usage_counters,
  email_verification_codes,
  application_email_aliases,
  application_email_messages,
  applications,
  application_artifacts,
  application_submission_events,
  artifact_versions,
  artifacts,
  billing_subscriptions,
  billing_account_deletion_tombstones,
  browser_provider_resource_cleanups,
  managed_submission_account_deletion_drains,
  entitlement_usage_reservations,
  monetization_events,
  pending_premium_actions,
  pricing_offers,
  trial_answer_applications,
  trial_company_usage,
  trial_generation_usage,
  candidate_visibility_profiles,
  linked_network_accounts,
  network_company_matches,
  network_consents,
  network_edges,
  network_imports,
  network_people,
  user_contact_unlocks,
  outreach_draft_generations,
  contacts,
} from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { specWithoutDocumentPointers } from '../lib/documentStore';
import { deleteBlobsForUser, mintDownloadToken } from '../lib/resumeAccess';
import { apiBaseFor } from '../lib/apiBase';
import { decryptRow } from './applicationProfile';
import { selectApplicationProfileRow } from '../lib/applicationFacts';
import { deleteAnalyticsProfile } from '../lib/serverAnalytics';
import {
  accountDeletionBillingPlan,
  billingSubscriptionTombstoneHash,
  cancelBillingBeforeAccountDeletion,
} from '../lib/accountDeletionBilling';
import { drainManagedTerminalCleanupBeforeAccountDeletion } from './submissionRunner';
import { lockSubmissionAttemptUser } from '../lib/submissionAttemptLedger';
import { drainBrowserProviderResourcesBeforeAccountDeletion } from '../lib/browserProviderResourceCleanup';

type AccountTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function deleteUnreferencedManualContacts(
  executor: Pick<AccountTransaction, 'execute'>,
  contactIds: string[],
): Promise<void> {
  if (contactIds.length === 0) return;
  await executor.execute(sql`
    delete from ${contacts} contact
    where contact.id in (${sql.join(contactIds.map((id) => sql`${id}::uuid`), sql`, `)})
      and not exists (
        select 1 from ${user_contact_unlocks} unlock where unlock.contact_id = contact.id
      )
  `);
}

// The privacy policy promises the student can export or delete everything we hold. Until now
// nothing here backed that claim: there was no delete path in the codebase at all, so the only
// honest options were to build this or to stop making the promise. These are the endpoints
// that make the page true.

export async function accountRoutes(fastify: FastifyInstance) {
  // GET /account/export - everything we store about the caller, as one JSON document.
  fastify.get('/account/export', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return reply.status(404).send({ error: 'Account not found' });

    const [profile] = await db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
    // Tolerant read (lib/applicationFacts.ts): an export must not 500 during the window where
    // this code is deployed and the facts migration has not been run yet.
    const appProfile = await selectApplicationProfileRow(userId);
    const bank = await db.select().from(experience_bank).where(eq(experience_bank.user_id, userId));
    const resumes = await db.select().from(generated_resumes).where(eq(generated_resumes.user_id, userId));
    const outreach = await db.select().from(outreach_events).where(eq(outreach_events.user_id, userId));
    const fills = await db.select().from(autofill_events).where(eq(autofill_events.user_id, userId));
    const applicationEmailAliases = await db.select().from(application_email_aliases).where(eq(application_email_aliases.user_id, userId));
    const applicationEmailMessages = await db.select().from(application_email_messages).where(eq(application_email_messages.user_id, userId));
    const [
      subscriptions,
      generationUsage,
      answerApplications,
      companyUsage,
      reservations,
      canonicalApplications,
      canonicalArtifacts,
      offers,
      pendingActions,
      monetization,
      networkConsents,
      linkedNetworkAccounts,
      networkImports,
      networkPeople,
      networkEdges,
      networkCompanyMatches,
      recruiterVisibility,
      contactUnlocks,
      submissionEvents,
      outreachDraftGenerations,
      manualContacts,
    ] = await Promise.all([
      db.select().from(billing_subscriptions).where(eq(billing_subscriptions.user_id, userId)),
      db.select().from(trial_generation_usage).where(eq(trial_generation_usage.user_id, userId)),
      db.select().from(trial_answer_applications).where(eq(trial_answer_applications.user_id, userId)),
      db.select().from(trial_company_usage).where(eq(trial_company_usage.user_id, userId)),
      db.select().from(entitlement_usage_reservations).where(eq(entitlement_usage_reservations.user_id, userId)),
      db.select().from(applications).where(eq(applications.user_id, userId)),
      db.select().from(artifacts).where(and(eq(artifacts.user_id, userId), isNull(artifacts.deleted_at))),
      db.select().from(pricing_offers).where(eq(pricing_offers.user_id, userId)),
      db.select().from(pending_premium_actions).where(eq(pending_premium_actions.user_id, userId)),
      db.select().from(monetization_events).where(eq(monetization_events.user_id, userId)),
      db.select().from(network_consents).where(eq(network_consents.user_id, userId)),
      db.select({
        id: linked_network_accounts.id,
        provider: linked_network_accounts.provider,
        granted_scopes: linked_network_accounts.granted_scopes,
        token_expires_at: linked_network_accounts.token_expires_at,
        refresh_state: linked_network_accounts.refresh_state,
        revoked_at: linked_network_accounts.revoked_at,
        created_at: linked_network_accounts.created_at,
        updated_at: linked_network_accounts.updated_at,
      }).from(linked_network_accounts).where(eq(linked_network_accounts.user_id, userId)),
      db.select().from(network_imports).where(eq(network_imports.user_id, userId)),
      db.select().from(network_people).where(eq(network_people.user_id, userId)),
      db.select().from(network_edges).where(eq(network_edges.user_id, userId)),
      db.select().from(network_company_matches).where(eq(network_company_matches.user_id, userId)),
      db.select().from(candidate_visibility_profiles).where(eq(candidate_visibility_profiles.user_id, userId)),
      db.select().from(user_contact_unlocks).where(eq(user_contact_unlocks.user_id, userId)),
      db.select().from(application_submission_events).where(eq(application_submission_events.user_id, userId)),
      db.select().from(outreach_draft_generations).where(eq(outreach_draft_generations.user_id, userId)),
      db.select({
        id: contacts.id,
        full_name: contacts.full_name,
        first_name: contacts.first_name,
        last_name: contacts.last_name,
        linkedin_url: contacts.linkedin_url,
        company_domain: contacts.company_domain,
        title: contacts.title,
        persona: contacts.persona,
        school_match: contacts.school_match,
        company_scope_key: user_contact_unlocks.company_scope_key,
        unlocked_at: user_contact_unlocks.unlocked_at,
      }).from(user_contact_unlocks).innerJoin(contacts, eq(contacts.id, user_contact_unlocks.contact_id)).where(and(
        eq(user_contact_unlocks.user_id, userId),
        eq(user_contact_unlocks.source, 'manual'),
      )),
    ]);
    const artifactIds = canonicalArtifacts.map((artifact) => artifact.id);
    const applicationIds = canonicalApplications.map((application) => application.id);
    const [artifactVersions, applicationArtifacts] = await Promise.all([
      artifactIds.length > 0
        ? db.select().from(artifact_versions).where(inArray(artifact_versions.artifact_id, artifactIds))
        : Promise.resolve([]),
      applicationIds.length > 0
        ? db.select().from(application_artifacts).where(inArray(application_artifacts.application_id, applicationIds))
        : Promise.resolve([]),
    ]);
    // usage_counters has no FK to users (it is keyed by a plain string so pre-auth endpoints can
    // rate-limit by email), so it has to be queried - and later deleted - by key explicitly. Both
    // keys: auth.ts rate-limits the pre-auth endpoints by EMAIL, so an export keyed only on the
    // user id would omit rows we hold about her.
    const counterKeys = request.jwtPayload!.email ? [userId, request.jwtPayload!.email] : [userId];
    const counters = await db
      .select()
      .from(usage_counters)
      .where(inArray(usage_counters.key, counterKeys));

    const base = apiBaseFor(request);

    return reply.status(200).send({
      exported_at: new Date().toISOString(),
      account: user,
      resume_profile: profile ?? null,
      // Decrypted deliberately: these columns are encrypted at rest, but this is the owner
      // asking for their own copy, over an authed request.
      application_profile: appProfile ? decryptRow(appProfile) : null,
      experience_bank: bank,
      generated_resumes: resumes.map((row) => ({
        ...row,
        /* THE ROW IS SPREAD WHOLE, WHICH IS WHY THE SPEC IS OVERRIDDEN AFTER IT.
         *
         * An export is every column of every application, so it picks up a new jsonb field the day
         * that field is written and without a line of this file changing: it began shipping
         * _documents.transcript.object_key, for every application with an attachment, as soon as
         * attachments existed. A Blob object is written `access: 'public'` because that is the only
         * mode the SDK has, so the key plus the store's stable base URL is permanent
         * unauthenticated access to the file, and an export is a JSON document a student is
         * expected to save, mail to herself and hand to whoever asks for it.
         *
         * The override has to come AFTER the spread or the raw spec wins and the strip is
         * decoration. That ordering is asserted in documentResponseContract.test.ts, because it is
         * a one-line move away from being wrong and looking right.
         *
         * She loses nothing by it: the file itself is not in the export either way, and what the
         * spec still records is that a transcript was attached, under what name and when. */
        spec: specWithoutDocumentPointers(row.spec),
        // Links expire (DOWNLOAD_TOKEN_TTL_MS), and files past the retention window are already
        // gone, so this 404s rather than resolving. Called out in `notes` so an empty download
        // does not read as data loss.
        download_url: `${base}/resume/download?t=${mintDownloadToken(userId, row.resume_object_key)}`,
      })),
      outreach_events: outreach,
      autofill_events: fills,
      application_email_aliases: applicationEmailAliases,
      application_email_messages: applicationEmailMessages,
      billing_subscriptions: subscriptions,
      pricing_offers: offers.map(({ provider_checkout_url: _checkoutUrl, ...offer }) => offer),
      trial_generation_usage: generationUsage,
      trial_answer_applications: answerApplications,
      trial_company_usage: companyUsage,
      entitlement_usage_reservations: reservations,
      canonical_applications: canonicalApplications,
      artifacts: canonicalArtifacts.map(({
        rendered_object_key: _objectKey,
        rendered_blob_url: _blobUrl,
        ...artifact
      }) => artifact),
      artifact_versions: artifactVersions.map(({
        rendered_object_key: _objectKey,
        rendered_blob_url: _blobUrl,
        ...version
      }) => version),
      application_artifacts: applicationArtifacts,
      application_submission_events: submissionEvents,
      outreach_draft_generations: outreachDraftGenerations,
      manual_contacts: manualContacts,
      pending_premium_actions: pendingActions.map(({ nonce_hash: _nonceHash, ...action }) => action),
      monetization_events: monetization,
      network_consents: networkConsents,
      linked_network_accounts: linkedNetworkAccounts,
      network_imports: networkImports,
      network_people: networkPeople,
      network_edges: networkEdges,
      network_company_matches: networkCompanyMatches,
      recruiter_visibility: recruiterVisibility[0] ?? null,
      contact_unlocks: contactUnlocks,
      usage_counters: counters,
      notes: {
        generated_resume_files:
          'download_url links are valid for one hour from this export. Files older than the retention window remain deleted; while this capability is valid, Litos can safely re-render the saved immutable document content without another AI generation.',
        contacts:
          'Contact facts and verified email addresses are shared lookup data. Your contact_unlocks and outreach_events are account data, are included here, and are removed when your account is deleted.',
        learning_signals:
          'Anonymous outcome rows (which persona/template performed well) are retained with the link to your account removed, so they cannot be traced back to you.',
      },
    });
  });

  // DELETE /account - irreversible. Requires the caller to echo their own email in the body:
  // a bare authed DELETE is one mis-wired client away from destroying an account by accident,
  // and there is no undo behind this.
  const deleteSchema = z.object({ confirm_email: z.string().min(1).optional(), confirm_guest: z.literal('DELETE').optional() });

  fastify.delete('/account', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const email = request.jwtPayload!.email;

    const parsed = deleteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Send account confirmation to continue' });
    }
    if (request.jwtPayload!.isGuest && parsed.data.confirm_guest !== 'DELETE') {
      return reply.status(400).send({ error: 'Send { confirm_guest: "DELETE" } to confirm' });
    }
    if (!request.jwtPayload!.isGuest && (!email || parsed.data.confirm_email?.trim().toLowerCase() !== email.toLowerCase())) {
      return reply.status(400).send({ error: 'confirm_email does not match your account email' });
    }

    const [billingAccounts, renewableSubscriptions] = await Promise.all([
      db.select({
        plan: users.plan,
        billing_provider: users.billing_provider,
        billing_subscription_id: users.billing_subscription_id,
        billing_status: users.billing_status,
        billing_portal_url: users.billing_portal_url,
      }).from(users).where(eq(users.id, userId)).limit(1),
      db.select({
        provider: billing_subscriptions.provider,
        provider_subscription_id: billing_subscriptions.provider_subscription_id,
        status: billing_subscriptions.status,
      }).from(billing_subscriptions).where(eq(billing_subscriptions.user_id, userId)),
    ]);
    const billingAccount = billingAccounts[0];
    if (!billingAccount) return reply.status(404).send({ error: 'Account not found' });
    const billingPlan = accountDeletionBillingPlan({
      account: billingAccount,
      subscriptions: renewableSubscriptions,
    });
    if (billingPlan.block) {
      return reply.status(409).send({
        error: billingPlan.block.message,
        code: billingPlan.block.code,
        provider: billingPlan.block.provider,
        management_url: billingPlan.block.management_url,
        account_preserved: true,
      });
    }
    try {
      await db.transaction(async (tx) => {
        await lockSubmissionAttemptUser(tx, userId);
        const [ownedAccount] = await tx.select({ id: users.id }).from(users)
          .where(eq(users.id, userId)).limit(1);
        if (!ownedAccount) throw new Error('Account disappeared before deletion could be fenced');
        await tx.insert(managed_submission_account_deletion_drains).values({
          user_id: userId,
        }).onConflictDoNothing();
      });
    } catch (err) {
      fastify.log.error({ err, userId }, 'account deletion aborted: could not establish managed cleanup fence');
      return reply.status(503).send({
        error: 'Litos could not safely pause employer submissions, so your account and files were not deleted. Please retry.',
        code: 'managed_submission_cleanup_fence_failed',
        account_preserved: true,
      });
    }
    const tombstoneHashes = billingPlan.stripeSubscriptionIds.map((subscriptionId) =>
      billingSubscriptionTombstoneHash('stripe', subscriptionId));
    try {
      if (tombstoneHashes.length > 0) {
        await db.insert(billing_account_deletion_tombstones).values(tombstoneHashes.map((hash) => ({
          provider: 'stripe',
          provider_subscription_hash: hash,
          expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        }))).onConflictDoNothing();
      }
      const billingCancellation = await cancelBillingBeforeAccountDeletion({
        userId,
        account: billingAccount,
        subscriptions: renewableSubscriptions,
      });
      if (billingCancellation.block) {
        throw new Error('Billing state changed while account deletion was being prepared');
      }
      if (tombstoneHashes.length > 0) {
        await db.update(billing_account_deletion_tombstones).set({
          cancellation_confirmed_at: new Date(),
        }).where(inArray(billing_account_deletion_tombstones.provider_subscription_hash, tombstoneHashes));
      }
    } catch (err) {
      fastify.log.error({ err, userId }, 'account deletion aborted: recurring billing cancellation failed');
      return reply.status(502).send({
        error: 'Could not cancel recurring billing, so your account and files were not deleted. Please retry.',
        code: 'billing_cancellation_failed',
        account_preserved: true,
      });
    }

    try {
      const managedCleanup = await drainManagedTerminalCleanupBeforeAccountDeletion(userId, fastify);
      if (!managedCleanup.ready) {
        return reply.status(409).send({
          error: 'Litos is still removing an active employer-session copy of your application data. Your account and files remain intact. Retry shortly.',
          code: 'managed_submission_cleanup_pending',
          account_preserved: true,
        });
      }
    } catch (err) {
      fastify.log.error({ err, userId }, 'account deletion aborted: managed submission cleanup failed');
      return reply.status(503).send({
        error: 'Litos could not verify employer-session cleanup, so your account and files were not deleted. Please retry.',
        code: 'managed_submission_cleanup_failed',
        account_preserved: true,
      });
    }

    try {
      const providerCleanup = await drainBrowserProviderResourcesBeforeAccountDeletion(userId);
      if (!providerCleanup.ready) {
        return reply.status(409).send({
          error: 'Litos is still closing company-hosted work that may contain your application data. Your account and files remain intact. Retry shortly.',
          code: 'browser_provider_cleanup_pending',
          account_preserved: true,
        });
      }
    } catch (err) {
      fastify.log.error({ err, userId }, 'account deletion aborted: browser provider cleanup failed');
      return reply.status(503).send({
        error: 'Litos could not confirm company browser cleanup, so your account and files were not deleted. Please retry.',
        code: 'browser_provider_cleanup_failed',
        account_preserved: true,
      });
    }

    // Blobs FIRST, and abort if they fail. generated_resumes cascades on users.id, so deleting
    // the user row destroys resume_object_key - the only pointer we have to these files. Doing
    // the DB first and the storage second would, on any storage hiccup, permanently strand
    // public PII PDFs with nothing left to find them by. Leaving the account intact and
    // returning an error is the recoverable failure; the other order is not.
    let deletedFiles: number;
    try {
      deletedFiles = await deleteBlobsForUser(userId);
    } catch (err) {
      fastify.log.error({ err, userId }, 'account deletion aborted: could not delete resume files');
      return reply.status(500).send({
        error: 'Could not delete your stored resume files, so nothing was deleted. Please retry.',
      });
    }

    try {
      // Neither of these has an FK to users, so the cascade does not reach them.
      //
      // BOTH keys, not just the user id. usage_counters.key is a plain string precisely so
      // pre-auth endpoints could rate-limit before a user id exists (auth.ts no longer does this
      // as of 2026-08-29, but older email-keyed rows can still exist from before that change).
      // Deleting only the userId rows left every one of those keyed by her email address, tying
      // her address to a deleted account forever, with nothing else in the codebase that would
      // ever purge them.
      const counterKeys = email ? [userId, email] : [userId];
      await db.transaction(async (tx) => {
        await lockSubmissionAttemptUser(tx, userId);
        const [providerCleanupPending] = await tx.select({
          total: sql<number>`count(*)::int`,
        }).from(browser_provider_resource_cleanups).where(and(
          eq(browser_provider_resource_cleanups.user_id, userId),
          isNull(browser_provider_resource_cleanups.provider_confirmed_gone_at),
        ));
        if ((providerCleanupPending?.total ?? 0) !== 0) {
          throw new Error('Browser provider cleanup changed before account deletion');
        }
        const manualContactRows = await tx.select({ contact_id: user_contact_unlocks.contact_id })
          .from(user_contact_unlocks).where(and(
            eq(user_contact_unlocks.user_id, userId),
            eq(user_contact_unlocks.source, 'manual'),
          ));
        await tx.delete(usage_counters).where(inArray(usage_counters.key, counterKeys));
        if (email) await tx.delete(email_verification_codes).where(eq(email_verification_codes.email, email));
        if (tombstoneHashes.length > 0) {
          await tx.update(billing_account_deletion_tombstones).set({
            account_deleted_at: new Date(),
          }).where(inArray(billing_account_deletion_tombstones.provider_subscription_hash, tombstoneHashes));
        }
        // Cascades to profiles, application_profile, experience_bank, generated_resumes,
        // application email aliases, routed application email, outreach_events and autofill_events;
        // learning_signals is onDelete:'set null', which
        // anonymizes those aggregate rows rather than keeping them tied to a deleted account.
        await tx.delete(users).where(eq(users.id, userId));
        await deleteUnreferencedManualContacts(tx, manualContactRows.map((row) => row.contact_id));
      });
    } catch (err) {
      fastify.log.error({ err, userId }, 'account deletion failed after resume files were deleted');
      return reply.status(500).send({ error: 'Could not delete your account. Please contact support.' });
    }

    /* The privacy policy promises the PostHog profile goes too.
     *
     * Deliberately AFTER the account row is gone and deliberately not able to
     * fail the request: the destructive, irreversible part has already
     * succeeded, and returning 500 here would tell someone their deletion
     * failed when their data is in fact deleted. A profile that outlives its
     * account is a promise to fix, not a reason to alarm the person who just
     * asked to leave. Failures are logged loudly instead.
     *
     * Awaited for the same serverless reason as everywhere else: this handler
     * resolves at response flush and the container may freeze immediately
     * after, so un-awaited cleanup would simply not happen. */
    const analyticsDeleted = await deleteAnalyticsProfile(userId, fastify.log);

    fastify.log.info({ userId, deletedFiles, analyticsDeleted }, 'account deleted at user request');
    return reply.status(200).send({ deleted: true, resume_files_deleted: deletedFiles });
  });
}
