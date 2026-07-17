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
  // Billing: 'free' | 'pro' ('plus' is a legacy alias, treated as 'pro' - see quota.ts).
  // Every feature (outreach + resume-gen/autofill) is available on 'free', including 20
  // resume generations per month (recurring, Apollo.io-style credits, not a one-time
  // trial); 'pro' is the single $49.99/mo tier that removes the monthly resume cap
  // (2026-07-02 decision, see quota.ts's LIMITS comments for the full model).
  // Reverse trial runs until trial_ends_at (set at signup) at pro-level limits.
  plan: text('plan').default('free').notNull(),
  trial_ends_at: timestamp('trial_ends_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  // Token epoch: JWTs issued before this instant are rejected by requireAuth.
  // Set when verify-code adopts a pre-existing unverified account, so any token
  // minted during a no-RESEND break-glass window dies on the owner's first
  // verified login instead of surviving its full 30 days.
  session_valid_from: timestamp('session_valid_from', { withTimezone: true }),
  // Onboarding: set when the student finishes /start (resume -> install -> first
  // application -> gaps -> targeting). NULL means onboarding is still open.
  //
  // This gates HARVEST, and that is its real job. While it is NULL the extension may read
  // values back out of a form the student is filling by hand and write them to
  // application_profile; once set, it stops. Harvesting forever would be a materially
  // different consent bargain than "we watch the first one so you never type it again",
  // and the student is told which one is happening. Deriving this from "has a profile"
  // would make the bargain implicit and un-revocable, so it is stored.
  onboarding_completed_at: timestamp('onboarding_completed_at', { withTimezone: true }),
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
  // The stored original. resume_object_key has always been written and never read, and it pointed
  // at a blob that was never uploaded: POST /profile parsed the PDF and dropped the buffer on the
  // floor. A Vercel Blob URL carries a random token, so the key alone cannot reconstruct it - the
  // URL has to be kept or the file is unreachable even once it is really uploaded.
  // NULL is normal: the upload is best-effort and a blob outage must not fail a signup.
  resume_url: text('resume_url'),
  voice_pref: text('voice_pref'),
  // string[] of the skills the student ACTUALLY has, in their own words. The one authoritative
  // source for the resume's SKILLS line (R-015).
  //
  // Before this column there was no skills data in the system at all: ResumeSpec demanded
  // `skills: string[]` and nothing was ever passed in, so the model had to invent the field. It
  // did the only two things it could - reuse the seeded `experience_bank.tags` junk (the identical
  // gRPC/SDK-design array on 6 of 7 rows, including a Product Management internship and a VP of
  // Finance role), and lift keywords straight out of the JD. A submitted Monzo application claims
  // BigQuery and Looker; both return zero rows across the entire bank.
  //
  // NULL is meaningful and is NOT the same as []. NULL means "the student never gave us a list",
  // and the validator falls back to soft bank-grounding. A populated list is AUTHORITATIVE: skills
  // outside it are hard-rejected, which is only safe BECAUSE the list is the student's own
  // statement rather than something inferred from their bullets.
  skills: jsonb('skills'),
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
  // Country the student is BASED IN (residence / where they work from). Distinct from
  // `citizenship` below: "which country do you intend to work from" and "country of residence"
  // ask about location, not nationality. Encrypted at rest like the other address fields.
  address_country: text('address_country'),
  linkedin_url: text('linkedin_url'),
  github_url: text('github_url'),
  portfolio_url: text('portfolio_url'),
  citizenship: text('citizenship'),
  // Kept for the student's own reference ONLY. NEVER written into a form and never harvested
  // back out of one: these are single global flags, but every real form asks a LOCATION-SCOPED
  // question ("authorized to work in the location where this role is based?"), and deriving one
  // from the other shipped a false legal declaration on a live application (R-004, Lever/Xsolla
  // 2026-07-16). The adapters skip both via WORK_ELIGIBILITY_QUESTION and auto-submit HOLDS while
  // either sits unanswered. Harvest treats them as a denylist for the same reason: a Berlin answer
  // is not a Toronto answer, so replaying a captured one is the original bug wearing a new hat.
  work_authorized: boolean('work_authorized'),
  needs_sponsorship: boolean('needs_sponsorship'),
  availability_date: text('availability_date'),
  // HOW LONG she is available ("14 weeks"), which is a different question from when she can start.
  // Without this column the extension could recognise a duration question but never answer it, so
  // "Length or term/length of availability (10-14 weeks)" got "Immediately" - a start time in
  // answer to a duration (R-014 facet b). Free text, not a date: "14 weeks", "3 months", "a
  // semester" are all legitimate and none of them parse.
  availability_term: text('availability_term'),
  desired_salary: text('desired_salary'),
  // The currency `desired_salary` is denominated in, e.g. "EUR". Separate and plaintext: a bare
  // "80000" is not an answer, it is an ambiguity, and replaying a figure earned against one
  // currency onto a posting in another states something the student never said. A Munich
  // application parked mid-fill for exactly this (needed "a salary figure + unit"). Fill leaves
  // the field blank unless BOTH are present, the same way gpa needs gpa_scale to be readable.
  desired_salary_currency: text('desired_salary_currency'),
  date_of_birth: text('date_of_birth'), // encrypted; filled only where a form explicitly asks (never SSN)
  // Academic record (R-005). PRD-v2 Section 4D promised "GPA (if listed)" as auto-extract-no-ask,
  // but no column, route, or adapter ever handled it, so every GPA-gated intern form was
  // unfillable - and GPA is among the most common REQUIRED intern fields.
  // gpa and gpa_scale are stored SEPARATELY and deliberately: a bare "3.89" is meaningless without
  // the scale it was earned on, and a form asking for a UK percentage needs to know the source
  // scale to say anything honest about it. Storing a pre-converted number instead would bake one
  // form's convention into the profile and lose the original.
  gpa: text('gpa'), // encrypted; the value as earned, e.g. "3.89"
  gpa_scale: text('gpa_scale'), // plaintext, e.g. "4.0" - meaningless alone, and needed to read gpa
  major: text('major'), // plaintext, e.g. "Computer Science"; no more sensitive than school
  eeo_prefs: jsonb('eeo_prefs'), // nullable, only set if the student explicitly opts in
  referral_source_default: text('referral_source_default').default('Company website'),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// ---- targeting ----
// What the student is going after: the five questions /start asks last (category, titles,
// role types, main period, backup period).
//
// Deliberately its OWN table, not columns on the two that already exist:
//   - NOT application_profile, whose contract is "sensitive, encrypted, and never included in a
//     drafting-LLM prompt". Targeting is the opposite on both counts: it is a stated preference,
//     not an identity record, and resume tailoring WANTS it in the prompt. Filing it there would
//     either leak it into a table that promises encryption or lock it out of the one consumer
//     that needs it.
//   - NOT profiles.parsed_json, which is overwritten wholesale by every resume upload
//     (routes/profile.ts). Targeting would silently vanish the next time the student swapped
//     their resume, which is a data-loss bug with a long fuse.
//
// Asked LAST in onboarding on purpose: everything else /start needs can be learned by watching
// one real application. This cannot, because it is about the NEXT hundred postings rather than
// the one in front of them.
export const targeting = pgTable('targeting', {
  user_id: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  // string[] of category slugs, e.g. ['software-engineering', 'data-ml'].
  categories: jsonb('categories'),
  // string[] of literal titles the student would accept, e.g. ['Software Engineer Intern'].
  // Seeded from ParsedProfile.target_roles, which the resume parser has written since v0 and
  // which nothing has ever read. This is the first consumer.
  titles: jsonb('titles'),
  // string[] from ['internship','co-op','new-grad','full-time']. Plural because a student
  // hunting a summer internship will usually take a co-op, and the distinction is the
  // employer's vocabulary rather than the student's intent.
  role_types: jsonb('role_types'),
  // Season slugs, e.g. 'summer-2027'. Free text rather than an enum: the set is derived from
  // grad_year at render time and slides forward every term, so pinning it in the DB would need
  // a migration each year to say nothing new.
  primary_period: text('primary_period'),
  // Where they'd go if the main one doesn't land. Stored separately rather than as an ordered
  // array so "main" and "backup" keep their meaning - a ranked list would lose the distinction
  // the student actually drew.
  backup_period: text('backup_period'),
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
  submitted_by_user: boolean('submitted_by_user'), // self-reported; unused since auto_submitted below covers it
  // true = the extension clicked Submit itself, after the student's own cancelable countdown
  // (2026-07-02 opt-in auto-submit toggle in AutofillSetupScreen, off by default). false = the
  // student either has the toggle off or cancelled the countdown on this application.
  auto_submitted: boolean('auto_submitted').default(false),
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
