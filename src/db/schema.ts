import {
  pgTable,
  primaryKey,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  real,
  boolean,
} from 'drizzle-orm/pg-core';

// ---- users ----
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique().notNull(),
  email_verified: boolean('email_verified').default(false),
  // Billing: 'free' | 'pro' | 'plus'. 'pro' ($19.99/mo) is v0 outreach-only (contacts+drafts).
  // 'plus' ($39.99/mo, PRD-v2 Section 12.1) is pro's limits plus resume-gen + autofill access.
  // Reverse trial runs until trial_ends_at (set at signup) at plus-level limits.
  plan: text('plan').default('free').notNull(),
  trial_ends_at: timestamp('trial_ends_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---- usage_counters ----
// Quota + rate-limit ledger. key = user id (or email for pre-auth endpoints),
// period = 'YYYY-MM' for monthly quotas or 'YYYY-MM-DDTHH' for hourly rate limits,
// kind = what is being counted ('verified_contacts', 'drafts', 'rate:resolve', ...).
export const usage_counters = pgTable('usage_counters', {
  key: text('key').notNull(),
  period: text('period').notNull(),
  kind: text('kind').notNull(),
  count: integer('count').default(0).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.key, t.period, t.kind] }),
}));

// ---- email_verification_codes ----
// One active code per email; re-requesting overwrites. Codes are stored as
// SHA-256 hashes so a DB leak never exposes a usable code.
export const email_verification_codes = pgTable('email_verification_codes', {
  email: text('email').primaryKey(),
  code_hash: text('code_hash').notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').default(0).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---- profiles ----
export const profiles = pgTable('profiles', {
  user_id: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  parsed_json: jsonb('parsed_json'),
  resume_object_key: text('resume_object_key'),
  voice_pref: text('voice_pref'),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// ---- companies ----
export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  domain: text('domain').unique().notNull(),
  name: text('name'),
  employee_count: integer('employee_count'),
  size_bucket: text('size_bucket'),
  mx_provider: text('mx_provider'),
});

// ---- domain_patterns ----
export const domain_patterns = pgTable('domain_patterns', {
  domain: text('domain').primaryKey(),
  pattern: text('pattern').notNull(),
  confidence: real('confidence').default(0.5),
  confirmations: integer('confirmations').default(1),
  last_confirmed_at: timestamp('last_confirmed_at', { withTimezone: true }),
});

// ---- contacts ----
export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  full_name: text('full_name'),
  first_name: text('first_name'),
  last_name: text('last_name'),
  linkedin_url: text('linkedin_url'),
  company_domain: text('company_domain').references(() => companies.domain),
  title: text('title'),
  persona: text('persona'),
  school_match: boolean('school_match').default(false),
});

// ---- email_resolutions ----
export const email_resolutions = pgTable('email_resolutions', {
  id: uuid('id').primaryKey().defaultRandom(),
  contact_id: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
  email: text('email'),
  status: text('status'),
  tier: text('tier'),
  source: text('source'),
  verifier_raw_json: jsonb('verifier_raw_json'),
  resolved_at: timestamp('resolved_at', { withTimezone: true }).defaultNow(),
});

// ---- outreach_events ----
export const outreach_events = pgTable('outreach_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  contact_id: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
  channel: text('channel'),
  draft_text: text('draft_text'),
  subject: text('subject'),
  sent_at: timestamp('sent_at', { withTimezone: true }),
  opened_at: timestamp('opened_at', { withTimezone: true }),
  replied_at: timestamp('replied_at', { withTimezone: true }),
  bounced: boolean('bounced').default(false),
  follow_up_count: integer('follow_up_count').default(0),
});

// ---- resolve_cache ----
// Persists a finished /resolve result per (domain|role) so repeat lookups spend no provider
// or verification credits, surviving process restarts. cache_key = `${domain}|${role}`.
export const resolve_cache = pgTable('resolve_cache', {
  cache_key: text('cache_key').primaryKey(),
  results: jsonb('results').notNull(),
  source: text('source').notNull(),
  cached_at: timestamp('cached_at', { withTimezone: true }).defaultNow().notNull(),
});

// ---- learning_signals ----
export const learning_signals = pgTable('learning_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  persona: text('persona'),
  channel: text('channel'),
  company_size: text('company_size'),
  template_id: text('template_id'),
  outcome: text('outcome'),
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---- experience_bank ----
// Each row is one job/project. bullet_variants holds every phrasing the student
// has ever used for that entry across resume versions, so /resume/generate can
// pick the best-fit variant per posting instead of being locked to one fixed resume.
export const experience_bank = pgTable('experience_bank', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  type: text('type').notNull(), // 'job' | 'project'
  org: text('org').notNull(),
  title: text('title'),
  date_range: text('date_range'),
  bullet_variants: jsonb('bullet_variants').notNull(), // string[]
  tags: jsonb('tags'), // string[] of skills/keywords this entry supports
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---- application_profile ----
// Section 4B of PRD-v2: more sensitive than `profiles` (phone/address/work-auth), so it
// is stored separately and must never be included in a drafting-LLM prompt.
export const application_profile = pgTable('application_profile', {
  user_id: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  phone: text('phone'),
  address_city: text('address_city'),
  address_state: text('address_state'),
  address_zip: text('address_zip'),
  linkedin_url: text('linkedin_url'),
  github_url: text('github_url'),
  portfolio_url: text('portfolio_url'),
  citizenship: text('citizenship'),
  work_authorized: boolean('work_authorized'),
  needs_sponsorship: boolean('needs_sponsorship'),
  availability_date: text('availability_date'),
  desired_salary: text('desired_salary'),
  eeo_prefs: jsonb('eeo_prefs'), // nullable, only set if the student explicitly opts in
  referral_source_default: text('referral_source_default').default('Company website'),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// ---- resume_templates ----
export const resume_templates = pgTable('resume_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  base_docx_object_key: text('base_docx_object_key'),
  slot_map: jsonb('slot_map'),
});

// ---- generated_resumes ----
export const generated_resumes = pgTable('generated_resumes', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  job_context: jsonb('job_context').notNull(), // { company, role, jd_hash }
  spec: jsonb('spec').notNull(), // the tailoring decision, kept for audit/debugging
  resume_object_key: text('resume_object_key').notNull(),
  template_id: uuid('template_id').references(() => resume_templates.id),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---- ats_adapters ----
// Health tracking for the per-ATS field-mapping adapters (Section 7 of PRD-v2). Populated
// by a scheduled spot-check (src/routes/adapterHealth.ts), not written to by the extension
// itself. One row per ATS, upserted in place - ats_name is unique so each scheduled run
// updates the same row rather than accumulating history.
export const ats_adapters = pgTable('ats_adapters', {
  id: uuid('id').primaryKey().defaultRandom(),
  ats_name: text('ats_name').notNull().unique(),
  version: text('version').notNull(),
  selectors: jsonb('selectors').notNull(),
  last_verified_at: timestamp('last_verified_at', { withTimezone: true }),
  status: text('status').default('healthy'), // 'healthy' | 'degraded' | 'broken' | 'unknown'
});

// ---- autofill_events ----
export const autofill_events = pgTable('autofill_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  ats_name: text('ats_name').notNull(),
  job_context: jsonb('job_context').notNull(),
  fields_filled: integer('fields_filled').default(0),
  fields_skipped: integer('fields_skipped').default(0), // e.g. SSN, open-ended questions
  submitted_by_user: boolean('submitted_by_user'), // self-reported; Volley never touches Submit
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---- TypeScript inference types ----
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type DomainPattern = typeof domain_patterns.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type EmailResolution = typeof email_resolutions.$inferSelect;
export type NewEmailResolution = typeof email_resolutions.$inferInsert;
export type OutreachEvent = typeof outreach_events.$inferSelect;
export type NewOutreachEvent = typeof outreach_events.$inferInsert;
export type LearningSignal = typeof learning_signals.$inferSelect;
export type NewLearningSignal = typeof learning_signals.$inferInsert;
export type ResolveCache = typeof resolve_cache.$inferSelect;
export type NewResolveCache = typeof resolve_cache.$inferInsert;
export type ExperienceBankEntry = typeof experience_bank.$inferSelect;
export type NewExperienceBankEntry = typeof experience_bank.$inferInsert;
export type ApplicationProfile = typeof application_profile.$inferSelect;
export type NewApplicationProfile = typeof application_profile.$inferInsert;
export type ResumeTemplate = typeof resume_templates.$inferSelect;
export type GeneratedResume = typeof generated_resumes.$inferSelect;
export type NewGeneratedResume = typeof generated_resumes.$inferInsert;
export type AtsAdapter = typeof ats_adapters.$inferSelect;
export type AutofillEvent = typeof autofill_events.$inferSelect;
export type NewAutofillEvent = typeof autofill_events.$inferInsert;
