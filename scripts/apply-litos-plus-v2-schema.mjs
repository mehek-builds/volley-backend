#!/usr/bin/env node

import { createHash } from 'node:crypto';
import pg from 'pg';

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('Artifact version contains non-JSON content');
}

function canonicalCompanyNameScope(companyName) {
  const normalized = String(companyName ?? '').normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  return `name:${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
}

function cutoff() {
  const raw = process.env.ENTITLEMENT_V2_CUTOVER_AT?.trim();
  const value = raw ? new Date(raw) : null;
  if (!value || Number.isNaN(value.getTime())) {
    throw new Error('ENTITLEMENT_V2_CUTOVER_AT must be one recorded ISO timestamp');
  }
  return value.toISOString();
}

const statements = [
  `alter table "users" add column if not exists "entitlement_policy_version" text not null default 'legacy-v1'`,
  `alter table "users" add column if not exists "grandfather_policy" text`,
  `alter table "users" add column if not exists "grandfathered_at" timestamp with time zone`,
  `alter table "users" add column if not exists "trial_started_at" timestamp with time zone`,
  `alter table "users" add column if not exists "entitlement_revision" uuid not null default gen_random_uuid()`,
  `alter table "users" add column if not exists "manual_access_override" text`,
  `alter table "users" add column if not exists "manual_access_override_ends_at" timestamp with time zone`,
  `alter table "users" add column if not exists "automatic_submission_legacy_granted" boolean not null default false`,
  `alter table "billing_webhook_events" add column if not exists "provider_object_id" text`,
  `alter table "billing_webhook_events" add column if not exists "provider_event_created_at" timestamp with time zone`,
  `alter table "billing_webhook_events" add column if not exists "payload_sha256" text`,
  `alter table "billing_webhook_events" add column if not exists "livemode" boolean`,
  `alter table "billing_webhook_events" add column if not exists "processing_attempts" integer not null default 0`,
  `alter table "billing_webhook_events" add column if not exists "last_error" text`,
  `create index if not exists "billing_events_object_time_idx" on "billing_webhook_events" ("provider", "provider_object_id", "provider_event_created_at")`,
  `create table if not exists "billing_account_deletion_tombstones" (
    "id" uuid primary key default gen_random_uuid(), "provider" text not null,
    "provider_subscription_hash" text not null, "cancellation_confirmed_at" timestamp with time zone,
    "account_deleted_at" timestamp with time zone, "expires_at" timestamp with time zone not null,
    "created_at" timestamp with time zone not null default now()
  )`,
  `create unique index if not exists "billing_account_deletion_tombstone_provider_subscription_unique"
    on "billing_account_deletion_tombstones" ("provider", "provider_subscription_hash")`,
  `create index if not exists "billing_account_deletion_tombstone_expiry_idx"
    on "billing_account_deletion_tombstones" ("expires_at")`,
  `alter table "pricing_offers" add column if not exists "product_code" text`,
  `alter table "pricing_offers" add column if not exists "term_code" text`,
  `alter table "pricing_offers" add column if not exists "provider_price_id" text`,
  `alter table "pricing_offers" add column if not exists "surface" text`,
  `alter table "pricing_offers" add column if not exists "trigger" text`,
  `alter table "pricing_offers" add column if not exists "placement" text`,
  `alter table "pricing_offers" add column if not exists "client_idempotency_key" text`,
  `alter table "pricing_offers" add column if not exists "pending_action_id" uuid`,
  `alter table "pricing_offers" add column if not exists "completed_at" timestamp with time zone`,
  `create unique index if not exists "pricing_offers_user_idempotency_unique" on "pricing_offers" ("user_id", "client_idempotency_key") where "client_idempotency_key" is not null`,
  `create unique index if not exists "pricing_offers_one_live_litos_checkout_idx" on "pricing_offers" ("user_id")
    where "product_code" = 'litos_plus' and "status" in ('creating', 'checkout_created')`,
  `create table if not exists "billing_subscriptions" (
    "id" uuid primary key default gen_random_uuid(), "user_id" uuid not null references "users"("id") on delete cascade,
    "provider" text not null, "provider_customer_id" text not null, "provider_subscription_id" text not null,
    "provider_price_id" text not null, "product_code" text not null, "term_code" text not null, "status" text not null,
    "cancel_at_period_end" boolean not null default false, "current_period_start" timestamp with time zone,
    "current_period_end" timestamp with time zone, "access_ends_at" timestamp with time zone,
    "canceled_at" timestamp with time zone, "ended_at" timestamp with time zone,
    "latest_invoice_id" text, "latest_payment_intent_id" text, "dispute_previous_status" text,
    "provider_event_created_at" timestamp with time zone not null,
    "created_at" timestamp with time zone not null default now(), "updated_at" timestamp with time zone not null default now()
  )`,
  `create unique index if not exists "billing_subscriptions_provider_subscription_id_unique" on "billing_subscriptions" ("provider_subscription_id")`,
  `create index if not exists "billing_subscriptions_user_idx" on "billing_subscriptions" ("user_id", "updated_at")`,
  `drop index if exists "billing_subscriptions_one_effective_idx"`,
  `create table if not exists "trial_generation_usage" (
    "user_id" uuid primary key references "users"("id") on delete cascade,
    "tailored_resumes_used" integer not null default 0 check ("tailored_resumes_used" between 0 and 5),
    "cover_letters_used" integer not null default 0 check ("cover_letters_used" between 0 and 5),
    "answer_applications_used" integer not null default 0 check ("answer_applications_used" between 0 and 5),
    "updated_at" timestamp with time zone not null default now()
  )`,
  `create table if not exists "trial_answer_applications" (
    "user_id" uuid not null references "users"("id") on delete cascade, "application_id" uuid not null,
    "granted_at" timestamp with time zone not null default now(),
    constraint "trial_answer_applications_user_id_application_id_pk" primary key ("user_id", "application_id")
  )`,
  `create table if not exists "trial_company_usage" (
    "id" uuid primary key default gen_random_uuid(), "user_id" uuid not null references "users"("id") on delete cascade,
    "company_scope_key" text not null, "company_name" text not null,
    "contacts_used" integer not null default 0 check ("contacts_used" between 0 and 2),
    "drafts_used" integer not null default 0 check ("drafts_used" between 0 and 2),
    "created_at" timestamp with time zone not null default now(), "updated_at" timestamp with time zone not null default now()
  )`,
  `create unique index if not exists "trial_company_usage_user_scope_unique" on "trial_company_usage" ("user_id", "company_scope_key")`,
  `create index if not exists "trial_company_usage_user_idx" on "trial_company_usage" ("user_id", "created_at")`,
  `create table if not exists "entitlement_usage_reservations" (
    "id" uuid primary key default gen_random_uuid(), "user_id" uuid not null references "users"("id") on delete cascade,
    "feature_key" text not null, "usage_kind" text not null, "scope_key" text not null,
    "request_hash" text not null default '', "idempotency_key" text not null,
    "requested_units" integer not null default 1 check ("requested_units" >= 0),
    "units" integer not null check ("units" >= 0), "metered" boolean not null default true, "status" text not null,
    "trial_company_usage_id" uuid references "trial_company_usage"("id") on delete set null,
    "expires_at" timestamp with time zone not null, "committed_at" timestamp with time zone,
    "released_at" timestamp with time zone, "result_status_code" integer,
    "result_envelope" jsonb, "result_expires_at" timestamp with time zone,
    "created_at" timestamp with time zone not null default now()
  )`,
  `alter table "entitlement_usage_reservations" add column if not exists "requested_units" integer not null default 1`,
  `alter table "entitlement_usage_reservations" add column if not exists "request_hash" text not null default ''`,
  `alter table "entitlement_usage_reservations" add column if not exists "metered" boolean not null default true`,
  `alter table "entitlement_usage_reservations" add column if not exists "result_status_code" integer`,
  `alter table "entitlement_usage_reservations" add column if not exists "result_envelope" jsonb`,
  `alter table "entitlement_usage_reservations" add column if not exists "result_expires_at" timestamp with time zone`,
  `do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'entitlement_reservations_requested_units_check') then
      alter table "entitlement_usage_reservations"
        add constraint "entitlement_reservations_requested_units_check" check ("requested_units" >= 0);
    end if;
  end $$`,
  `create unique index if not exists "entitlement_reservations_user_kind_idempotency_unique" on "entitlement_usage_reservations" ("user_id", "usage_kind", "idempotency_key")`,
  `create index if not exists "entitlement_reservations_expiry_idx" on "entitlement_usage_reservations" ("status", "expires_at")`,
  `create index if not exists "entitlement_reservations_result_expiry_idx" on "entitlement_usage_reservations" ("result_expires_at")`,
  `create table if not exists "artifacts" (
    "id" uuid primary key default gen_random_uuid(), "user_id" uuid not null references "users"("id") on delete cascade,
    "legacy_generated_resume_id" uuid,
    "kind" text not null, "structured_content" jsonb, "rendered_object_key" text, "rendered_blob_url" text,
    "retention_class" text not null default 'generated_spec', "source" text not null, "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone not null default now(), "updated_at" timestamp with time zone not null default now()
  )`,
  `create index if not exists "artifacts_user_kind_idx" on "artifacts" ("user_id", "kind", "created_at")`,
  `create unique index if not exists "artifacts_legacy_resume_unique" on "artifacts" ("legacy_generated_resume_id") where "legacy_generated_resume_id" is not null`,
  `create table if not exists "applications" (
    "id" uuid primary key default gen_random_uuid(), "user_id" uuid not null references "users"("id") on delete cascade,
    "legacy_generated_resume_id" uuid, "job_id" uuid, "company_scope_key" text not null, "company_name" text not null,
    "role" text not null, "portal_url" text, "source_surface" text not null,
    "tracker_state" text not null default 'saved', "review_state" text not null default 'not_started',
    "submission_state" text not null default 'not_started', "selected_resume_artifact_id" uuid references "artifacts"("id") on delete set null,
    "resume_attached" boolean not null default false, "resume_source" text not null default 'none',
    "resume_attached_at" timestamp with time zone,
    "application_fingerprint" text not null, "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    constraint "applications_resume_attachment_state_check" check (
      ("resume_attached" = false and "resume_source" = 'none')
      or ("resume_attached" = true and "resume_source" = 'artifact' and "selected_resume_artifact_id" is not null)
      or ("resume_attached" = true and "resume_source" = 'base_resume')
    )
  )`,
  `alter table "applications" add column if not exists "resume_attached" boolean not null default false`,
  `alter table "applications" add column if not exists "resume_source" text not null default 'none'`,
  `alter table "applications" add column if not exists "resume_attached_at" timestamp with time zone`,
  `do $$ begin
    alter table "applications" drop constraint if exists "applications_resume_attachment_state_check";
    alter table "applications" add constraint "applications_resume_attachment_state_check" check (
      ("resume_attached" = false and "resume_source" = 'none')
      or ("resume_attached" = true and "resume_source" = 'artifact' and "selected_resume_artifact_id" is not null)
      or ("resume_attached" = true and "resume_source" = 'base_resume')
    );
  end $$`,
  `create unique index if not exists "applications_legacy_resume_unique" on "applications" ("legacy_generated_resume_id") where "legacy_generated_resume_id" is not null`,
  `create unique index if not exists "applications_user_fingerprint_unique" on "applications" ("user_id", "application_fingerprint")`,
  `create index if not exists "applications_user_updated_idx" on "applications" ("user_id", "updated_at")`,
  /* Taking a row off the Tracker is a stamp, not a delete: nine tables carry an application_id with
     no foreign key, the attempt ledger among them, and that ledger is what stops a second send to
     the same employer. See applications.removed_at in schema.ts and
     scripts/apply-application-removal-migration.mjs, which applies this same pair on its own for an
     already-migrated production database. */
  `alter table "applications" add column if not exists "removed_at" timestamp with time zone`,
  `create index if not exists "applications_user_live_updated_idx" on "applications" ("user_id", "updated_at") where "removed_at" is null`,
  `create table if not exists "artifact_versions" (
    "id" uuid primary key default gen_random_uuid(), "artifact_id" uuid not null references "artifacts"("id") on delete cascade,
    "version_number" integer not null, "generation_source" text not null, "job_context" jsonb,
    "content_hash" text not null, "structured_content" jsonb not null, "rendered_object_key" text,
    "rendered_blob_url" text, "created_at" timestamp with time zone not null default now()
  )`,
  `alter table "artifact_versions" add column if not exists "rendered_object_key" text`,
  `alter table "artifact_versions" add column if not exists "rendered_blob_url" text`,
  `create unique index if not exists "artifact_versions_artifact_version_unique" on "artifact_versions" ("artifact_id", "version_number")`,
  `drop index if exists "artifact_versions_rendered_object_key_unique"`,
  `create table if not exists "application_artifacts" (
    "application_id" uuid not null references "applications"("id") on delete cascade,
    "artifact_id" uuid not null references "artifacts"("id") on delete cascade,
    "purpose" text not null, "selected" boolean not null default false, "attachment_result" text,
    "attached_at" timestamp with time zone, "created_at" timestamp with time zone not null default now(),
    constraint "application_artifacts_application_id_artifact_id_purpose_pk" primary key ("application_id", "artifact_id", "purpose")
  )`,
  `create table if not exists "application_submission_events" (
    "id" uuid primary key default gen_random_uuid(), "user_id" uuid not null references "users"("id") on delete cascade,
    "application_id" uuid not null references "applications"("id") on delete cascade, "event_id" uuid not null,
    "outcome" text not null, "final_url" text not null, "portal_identity" text not null,
    "confirmation_text" text, "applied_submission_state" text not null,
    "observed_at" timestamp with time zone not null default now(), "created_at" timestamp with time zone not null default now()
  )`,
  `create unique index if not exists "application_submission_events_user_event_unique" on "application_submission_events" ("user_id", "event_id")`,
  `create index if not exists "application_submission_events_application_time_idx" on "application_submission_events" ("application_id", "observed_at")`,
  `create table if not exists "pending_premium_actions" (
    "id" uuid primary key default gen_random_uuid(), "nonce_hash" text not null,
    "user_id" uuid not null references "users"("id") on delete cascade, "feature_key" text not null,
    "application_id" uuid, "job_id" uuid, "contact_id" uuid, "return_route" text not null,
    "context_hash" text not null default '', "idempotency_key" text not null, "idempotency_binding" text,
    "state" text not null default 'pending', "offer_id" uuid, "expires_at" timestamp with time zone not null,
    "consumed_at" timestamp with time zone, "created_at" timestamp with time zone not null default now()
  )`,
  `alter table "pending_premium_actions" add column if not exists "contact_id" uuid`,
  `alter table "pending_premium_actions" add column if not exists "context_hash" text not null default ''`,
  `alter table "pending_premium_actions" add column if not exists "idempotency_binding" text`,
  `create unique index if not exists "pending_premium_actions_nonce_hash_unique" on "pending_premium_actions" ("nonce_hash")`,
  `create unique index if not exists "pending_premium_actions_user_idempotency_binding_unique" on "pending_premium_actions" ("user_id", "idempotency_binding") where "idempotency_binding" is not null`,
  `create index if not exists "pending_premium_actions_user_idx" on "pending_premium_actions" ("user_id", "created_at")`,
  `create table if not exists "monetization_events" (
    "id" uuid primary key default gen_random_uuid(), "event_key" text not null,
    "user_id" uuid references "users"("id") on delete set null, "event_name" text not null, "surface" text not null,
    "placement" text, "trigger" text, "feature_key" text, "plan_id" text, "offer_id" uuid,
    "application_id" uuid, "job_id" uuid, "session_id" text, "properties" jsonb not null default '{}'::jsonb,
    "occurred_at" timestamp with time zone not null, "received_at" timestamp with time zone not null default now()
  )`,
  `create unique index if not exists "monetization_events_event_key_unique" on "monetization_events" ("event_key")`,
  `create index if not exists "monetization_events_user_time_idx" on "monetization_events" ("user_id", "occurred_at")`,
  `create index if not exists "monetization_events_funnel_idx" on "monetization_events" ("event_name", "occurred_at")`,
  `create table if not exists "network_consents" (
    "id" uuid primary key default gen_random_uuid(), "user_id" uuid not null references "users"("id") on delete cascade,
    "consent_version" text not null, "data_source" text not null, "scopes" jsonb not null,
    "disclosure_hash" text not null, "granted_at" timestamp with time zone not null default now(),
    "revoked_at" timestamp with time zone, "created_at" timestamp with time zone not null default now()
  )`,
  `create unique index if not exists "network_consents_one_active_idx" on "network_consents" ("user_id", "data_source") where "revoked_at" is null`,
  `create index if not exists "network_consents_user_idx" on "network_consents" ("user_id", "granted_at")`,
  `create table if not exists "linked_network_accounts" (
    "id" uuid primary key default gen_random_uuid(), "user_id" uuid not null references "users"("id") on delete cascade,
    "provider" text not null, "encrypted_access_token" text, "encrypted_refresh_token" text,
    "granted_scopes" jsonb not null, "token_expires_at" timestamp with time zone,
    "refresh_state" text not null, "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone not null default now(), "updated_at" timestamp with time zone not null default now()
  )`,
  `create unique index if not exists "linked_network_accounts_user_provider_unique" on "linked_network_accounts" ("user_id", "provider")`,
  `create table if not exists "network_imports" (
    "id" uuid primary key default gen_random_uuid(), "user_id" uuid not null references "users"("id") on delete cascade,
    "source" text not null, "file_sha256" text not null, "consent_version" text not null,
    "disclosure_hash" text not null, "row_count" integer not null, "accepted_rows" integer not null,
    "rejected_rows" integer not null, "validation_result" jsonb not null, "preview_rows" jsonb,
    "status" text not null, "expires_at" timestamp with time zone not null,
    "committed_at" timestamp with time zone, "raw_deleted_at" timestamp with time zone not null,
    "deleted_at" timestamp with time zone, "created_at" timestamp with time zone not null default now()
  )`,
  `create index if not exists "network_imports_user_idx" on "network_imports" ("user_id", "created_at")`,
  `create table if not exists "network_people" (
    "id" uuid primary key default gen_random_uuid(), "user_id" uuid not null references "users"("id") on delete cascade,
    "canonical_identity_key" text not null, "first_name" text, "last_name" text, "full_name" text not null,
    "profile_url" text, "company_scope_key" text, "company_name" text, "title" text, "source" text not null,
    "source_import_id" uuid references "network_imports"("id") on delete set null,
    "source_timestamp" timestamp with time zone, "provenance" jsonb not null,
    "created_at" timestamp with time zone not null default now(), "updated_at" timestamp with time zone not null default now()
  )`,
  `create unique index if not exists "network_people_user_identity_unique" on "network_people" ("user_id", "canonical_identity_key")`,
  `create index if not exists "network_people_user_company_idx" on "network_people" ("user_id", "company_scope_key")`,
  `create table if not exists "network_edges" (
    "id" uuid primary key default gen_random_uuid(), "user_id" uuid not null references "users"("id") on delete cascade,
    "person_id" uuid not null references "network_people"("id") on delete cascade,
    "relationship_type" text not null, "source" text not null,
    "source_import_id" uuid references "network_imports"("id") on delete set null,
    "source_timestamp" timestamp with time zone, "confidence" text not null,
    "created_at" timestamp with time zone not null default now()
  )`,
  `create unique index if not exists "network_edges_user_person_relationship_unique" on "network_edges" ("user_id", "person_id", "relationship_type", "source")`,
  `create index if not exists "network_edges_user_idx" on "network_edges" ("user_id", "created_at")`,
  `create table if not exists "network_company_matches" (
    "id" uuid primary key default gen_random_uuid(), "user_id" uuid not null references "users"("id") on delete cascade,
    "company_scope_key" text not null, "company_name" text not null, "supporting_edge_ids" jsonb not null,
    "connection_count" integer not null, "last_calculated_at" timestamp with time zone not null default now(),
    "expires_at" timestamp with time zone
  )`,
  `create unique index if not exists "network_company_matches_user_company_unique" on "network_company_matches" ("user_id", "company_scope_key")`,
  `create index if not exists "network_company_matches_user_count_idx" on "network_company_matches" ("user_id", "connection_count")`,
  `create table if not exists "user_contact_unlocks" (
    "user_id" uuid not null references "users"("id") on delete cascade,
    "contact_id" uuid not null references "contacts"("id") on delete cascade,
    "company_scope_key" text not null, "source" text not null,
    "unlocked_at" timestamp with time zone not null default now(),
    constraint "user_contact_unlocks_user_id_contact_id_pk" primary key ("user_id", "contact_id")
  )`,
  `create index if not exists "user_contact_unlocks_user_company_idx"
    on "user_contact_unlocks" ("user_id", "company_scope_key", "unlocked_at")`,
  `create table if not exists "outreach_draft_generations" (
    "id" uuid primary key default gen_random_uuid(),
    "user_id" uuid not null references "users"("id") on delete cascade,
    "operation_id" uuid not null, "request_hash" text not null,
    "contact_id" uuid not null references "contacts"("id") on delete restrict,
    "application_id" uuid not null references "applications"("id") on delete cascade,
    "company_scope_key" text not null, "company_name" text not null, "role" text not null,
    "draft_type" text not null, "generation_source" text not null default 'ai_generated',
    "contact_email" text, "original_subject" text not null, "original_body" text not null,
    "subject" text not null, "body" text not null,
    "word_count" integer not null, "warnings" jsonb not null default '[]'::jsonb,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    constraint "outreach_draft_generations_draft_type_check" check (
      "draft_type" in ('first_note','follow_up','thank_you','referral_ask','offer_stage')
    ),
    constraint "outreach_draft_generations_generation_source_check" check (
      "generation_source" in ('ai_generated','user_written')
    )
  )`,
  `alter table "outreach_draft_generations" add column if not exists "generation_source" text not null default 'ai_generated'`,
  `alter table "outreach_draft_generations" add column if not exists "contact_email" text`,
  `alter table "outreach_draft_generations" add column if not exists "original_subject" text`,
  `alter table "outreach_draft_generations" add column if not exists "original_body" text`,
  `alter table "outreach_draft_generations" add column if not exists "updated_at" timestamp with time zone not null default now()`,
  `update "outreach_draft_generations" set
    "original_subject" = coalesce("original_subject", "subject"),
    "original_body" = coalesce("original_body", "body")
    where "original_subject" is null or "original_body" is null`,
  `alter table "outreach_draft_generations" alter column "original_subject" set not null`,
  `alter table "outreach_draft_generations" alter column "original_body" set not null`,
  `update "outreach_draft_generations" set "draft_type" = 'first_note' where "draft_type" = 'cold_email'`,
  `do $$ begin
    alter table "outreach_draft_generations" drop constraint if exists "outreach_draft_generations_draft_type_check";
    alter table "outreach_draft_generations" add constraint "outreach_draft_generations_draft_type_check"
      check ("draft_type" in ('first_note','follow_up','thank_you','referral_ask','offer_stage'));
  end $$`,
  `do $$ begin
    alter table "outreach_draft_generations" drop constraint if exists "outreach_draft_generations_generation_source_check";
    alter table "outreach_draft_generations" add constraint "outreach_draft_generations_generation_source_check"
      check ("generation_source" in ('ai_generated','user_written'));
  end $$`,
  `create unique index if not exists "outreach_draft_generations_user_operation_unique"
    on "outreach_draft_generations" ("user_id", "operation_id")`,
  `create index if not exists "outreach_draft_generations_user_created_idx"
    on "outreach_draft_generations" ("user_id", "created_at")`,
  `create index if not exists "outreach_draft_generations_application_created_idx"
    on "outreach_draft_generations" ("application_id", "created_at")`,
  `create table if not exists "candidate_visibility_profiles" (
    "user_id" uuid primary key references "users"("id") on delete cascade,
    "enabled" boolean not null default false, "consent_version" text, "disclosure_hash" text,
    "approved_fields" jsonb not null default '[]'::jsonb,
    "resume_artifact_id" uuid references "artifacts"("id") on delete set null,
    "indexed_state" text not null default 'private', "granted_at" timestamp with time zone,
    "withdrawn_at" timestamp with time zone, "updated_at" timestamp with time zone not null default now()
  )`,
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const cutover = cutoff();
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("set lock_timeout = '5s'");
    await client.query("set statement_timeout = '5min'");
    await client.query('begin');
    for (const statement of statements) await client.query(statement);
    await client.query(
      `update "users" set
        "entitlement_policy_version" = 'litos-entitlements-v2',
        "grandfather_policy" = case when "plan" in ('pro','plus') then 'legacy_paid_v1' else 'legacy_free_v1' end,
        "grandfathered_at" = $1,
        "automatic_submission_legacy_granted" = "automatic_submission_enabled",
        "entitlement_revision" = gen_random_uuid()
       where "created_at" < $1
         and "grandfather_policy" is null
         and "entitlement_policy_version" <> 'litos-entitlements-v2'`,
      [cutover],
    );
    // Accounts created during a schema-first rollout gap are new-policy accounts, not legacy
    // accounts. Anchor their no-card trial to their own creation time so every rerun is stable.
    await client.query(
      `update "users" set
        "entitlement_policy_version" = 'litos-entitlements-v2',
        "trial_started_at" = "created_at",
        "trial_ends_at" = "created_at" + interval '7 days',
        "entitlement_revision" = gen_random_uuid()
       where "created_at" >= $1
         and "grandfather_policy" is null
         and "entitlement_policy_version" <> 'litos-entitlements-v2'`,
      [cutover],
    );
    // Preserve legacy IDs across the compatibility bridge. The canonical application and resume
    // artifact live in separate tables, so both can safely reuse the generated_resumes UUID.
    await client.query(`
      insert into "artifacts" (
        "id", "user_id", "legacy_generated_resume_id", "kind", "structured_content",
        "rendered_object_key", "retention_class", "source", "created_at", "updated_at"
      )
      select "id", "user_id", "id", 'resume', "spec", "resume_object_key",
        'generated_spec', 'legacy_generated_resume', coalesce("created_at", now()), coalesce("created_at", now())
      from "generated_resumes"
      on conflict ("id") do nothing
    `);
    await client.query(`
      insert into "applications" (
        "id", "user_id", "legacy_generated_resume_id", "job_id", "company_scope_key",
        "company_name", "role", "portal_url", "source_surface", "tracker_state", "review_state",
        "submission_state", "selected_resume_artifact_id", "application_fingerprint", "created_at", "updated_at"
      )
      select gr."id", gr."user_id", gr."id",
        case when (gr."job_context"->>'job_id') ~* '^[0-9a-f-]{36}$' then (gr."job_context"->>'job_id')::uuid else null end,
        'name:' || substr(encode(sha256(convert_to(
          trim(regexp_replace(lower(normalize(coalesce(gr."job_context"->>'company', 'unknown'), NFKD)), '[^a-z0-9]+', ' ', 'g')),
          'UTF8'
        )), 'hex'), 1, 24),
        coalesce(nullif(gr."job_context"->>'company', ''), 'Unknown company'),
        coalesce(nullif(gr."job_context"->>'role', ''), 'Unknown role'),
        nullif(gr."spec"->'_review'->>'portal_url', ''), 'dashboard', coalesce(gr."pipeline_stage", 'saved'),
        coalesce(gr."spec"->'_review'->>'status', 'not_started'),
        coalesce(gr."spec"->'_review'->>'status', 'not_started'), gr."id", 'legacy:' || gr."id"::text,
        coalesce(gr."created_at", now()), coalesce(gr."created_at", now())
      from "generated_resumes" gr
      on conflict ("id") do nothing
    `);
    const legacyApplications = await client.query(`
      select "id", "company_name" from "applications" where "application_fingerprint" like 'legacy:%'
    `);
    for (const application of legacyApplications.rows) {
      await client.query(
        'update "applications" set "company_scope_key" = $1 where "id" = $2',
        [canonicalCompanyNameScope(application.company_name), application.id],
      );
    }
    await client.query(`
      insert into "artifact_versions" (
        "artifact_id", "version_number", "generation_source", "job_context", "content_hash", "structured_content",
        "rendered_object_key", "rendered_blob_url", "created_at"
      )
      select gr."id", 1, 'legacy_generated_resume', gr."job_context", 'pending-sha256', gr."spec",
        gr."resume_object_key", null, coalesce(gr."created_at", now())
      from "generated_resumes" gr
      on conflict ("artifact_id", "version_number") do nothing
    `);
    await client.query(`
      update "artifact_versions" av set
        "rendered_object_key" = coalesce(av."rendered_object_key", a."rendered_object_key"),
        "rendered_blob_url" = coalesce(av."rendered_blob_url", a."rendered_blob_url")
      from "artifacts" a
      where av."artifact_id" = a."id"
        and av."generation_source" = 'legacy_generated_resume'
    `);
    const legacyVersions = await client.query(`
      select "id", "structured_content" from "artifact_versions"
      where "generation_source" = 'legacy_generated_resume'
    `);
    for (const version of legacyVersions.rows) {
      const contentHash = createHash('sha256').update(canonicalJson(version.structured_content)).digest('hex');
      await client.query('update "artifact_versions" set "content_hash" = $1 where "id" = $2', [contentHash, version.id]);
    }
    // Historical resume writes could reuse one object key for several generated rows. The blob at
    // that key can represent only the newest write, but every stored spec remains an immutable
    // document version. Keep the newest active version on the original key and give every loser a
    // stable user-scoped recovery key. No blob is claimed at a recovery key: the download route
    // deliberately falls through to the immutable-spec renderer when object storage has no match.
    await client.query(`
      create temporary table "litos_artifact_version_key_repairs" on commit drop as
      with ranked as (
        select
          av."id" as "version_id",
          av."artifact_id",
          av."rendered_object_key" as "original_key",
          a."user_id",
          row_number() over (
            partition by av."rendered_object_key"
            order by
              case when a."deleted_at" is null then 0 else 1 end,
              av."created_at" desc nulls last,
              av."version_number" desc,
              av."id" desc
          ) as "global_rank",
          row_number() over (
            partition by av."artifact_id", av."rendered_object_key"
            order by av."version_number" desc, av."created_at" desc nulls last, av."id" desc
          ) as "artifact_rank"
        from "artifact_versions" av
        inner join "artifacts" a on a."id" = av."artifact_id"
        where av."rendered_object_key" is not null
      )
      select
        "version_id",
        "artifact_id",
        "original_key",
        "artifact_rank",
        'users/' || "user_id"::text || '/resumes/recovery-' || "version_id"::text || '.pdf'
          as "replacement_key"
      from ranked
      where "global_rank" > 1
    `);
    await client.query(`
      update "generated_resumes" gr set
        "resume_object_key" = repair."replacement_key"
      from "artifacts" a
      inner join "litos_artifact_version_key_repairs" repair
        on repair."artifact_id" = a."id" and repair."artifact_rank" = 1
      where gr."id" = a."legacy_generated_resume_id"
        and gr."user_id" = a."user_id"
        and gr."resume_object_key" = repair."original_key"
    `);
    await client.query(`
      update "artifacts" a set
        "rendered_object_key" = repair."replacement_key",
        "rendered_blob_url" = null,
        "updated_at" = now()
      from "litos_artifact_version_key_repairs" repair
      where a."id" = repair."artifact_id"
        and repair."artifact_rank" = 1
        and a."rendered_object_key" = repair."original_key"
    `);
    await client.query(`
      update "artifact_versions" av set
        "rendered_object_key" = repair."replacement_key",
        "rendered_blob_url" = null
      from "litos_artifact_version_key_repairs" repair
      where av."id" = repair."version_id"
    `);
    await client.query(`
      create unique index "artifact_versions_rendered_object_key_unique"
        on "artifact_versions" ("rendered_object_key") where "rendered_object_key" is not null
    `);
    await client.query(`
      insert into "application_artifacts" ("application_id", "artifact_id", "purpose", "selected", "created_at")
      select gr."id", gr."id", 'resume', true, coalesce(gr."created_at", now())
      from "generated_resumes" gr
      on conflict ("application_id", "artifact_id", "purpose") do nothing
    `);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  console.log(`Ready: Litos+ v2 schema and grandfathering are present at cutoff ${cutover}.`);
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Litos+ v2 migration failed:', message);
  process.exit(1);
});
