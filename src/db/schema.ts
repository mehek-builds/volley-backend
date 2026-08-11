import {
  pgTable,
  primaryKey,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  real,
  doublePrecision,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---- users ----
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Guests are real authenticated principals with no email. A verified email is
  // attached in-place when a first-time guest claims the workspace.
  email: text('email').unique(),
  email_verified: boolean('email_verified').default(false),
  is_guest: boolean('is_guest').default(false).notNull(),
  guest_key_hash: text('guest_key_hash').unique(),
  guest_expires_at: timestamp('guest_expires_at', { withTimezone: true }),
  claimed_at: timestamp('claimed_at', { withTimezone: true }),
  // Stable Google identity. Google explicitly requires account linkage by the
  // immutable `sub` claim, never by an email address that can change.
  google_subject: text('google_subject'),
  // Passwords are never stored or encrypted. This contains only a salted,
  // memory-hard Argon2id PHC string and stays nullable for Google/code users.
  password_hash: text('password_hash'),
  // Incrementing this revokes every previously issued JWT immediately. It
  // avoids timestamp precision races during password changes and recovery.
  session_version: integer('session_version').default(0).notNull(),
  // Billing: 'free' | 'pro' ('plus' is a legacy alias, treated as 'pro' - see quota.ts).
  // Every feature (outreach + resume-gen/autofill) is available on 'free', including 20
  // resume generations per month (recurring, Apollo.io-style credits, not a one-time
  // trial); 'pro' is the single $49.99/mo tier with a 1,000-resume monthly cap
  // (2026-07-02 decision, see quota.ts's LIMITS comments for the full model).
  // Reverse trial runs until trial_ends_at (set at signup) at pro-level limits.
  plan: text('plan').default('free').notNull(),
  trial_ends_at: timestamp('trial_ends_at', { withTimezone: true }),
  billing_provider: text('billing_provider'),
  billing_customer_id: text('billing_customer_id'),
  billing_subscription_id: text('billing_subscription_id'),
  billing_variant_id: text('billing_variant_id'),
  billing_status: text('billing_status'),
  billing_renews_at: timestamp('billing_renews_at', { withTimezone: true }),
  billing_ends_at: timestamp('billing_ends_at', { withTimezone: true }),
  billing_portal_url: text('billing_portal_url'),
  billing_event_updated_at: timestamp('billing_event_updated_at', { withTimezone: true }),
  /* DECLARED TO MATCH THE DATABASE, not because main uses them. These columns are live in prod
     because codex/regional-pricing ran scripts/apply-regional-pricing-schema.mjs against it before
     merging, which is the exact sequence check-schema-drift.mjs exists to catch: undeclared here,
     a `db:push` from main DROPS them. Nothing on main reads or writes these yet; the branch that
     does is still open. Types are introspected from the live columns, not guessed, and match that
     branch's own declarations so the two do not diverge when it lands. */
  pricing_country: text('pricing_country'),
  pricing_band: text('pricing_band'),
  pricing_policy_version: text('pricing_policy_version'),
  pricing_experiment_id: text('pricing_experiment_id'),
  pricing_experiment_variant: text('pricing_experiment_variant'),
  pricing_interval: text('pricing_interval'),
  pricing_currency: text('pricing_currency'),
  pricing_amount_cents: integer('pricing_amount_cents'),
  pricing_verification_status: text('pricing_verification_status'),
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
  // Revocable standing authorization for policy-eligible application submissions. The runner
  // still stops for missing or contradictory facts, sensitive attestations, CAPTCHA, unsupported
  // portal behavior, and any submission whose receipt cannot be verified.
  automatic_submission_enabled: boolean('automatic_submission_enabled').default(false).notNull(),
  automatic_submission_consented_at: timestamp('automatic_submission_consented_at', { withTimezone: true }),
  automatic_submission_consent_version: text('automatic_submission_consent_version'),
  // Separate permission for reading application verification codes from an already-connected
  // Gmail or Outlook account. Submission permission never implies inbox permission.
  automatic_verification_enabled: boolean('automatic_verification_enabled').default(false).notNull(),
  automatic_verification_consented_at: timestamp('automatic_verification_consented_at', { withTimezone: true }),
  /* Same situation as the pricing_* columns above: live in prod via codex/litos-captcha-consent's
     apply-automatic-captcha-migration.mjs, undeclared here until now, so a `db:push` from main
     would have dropped them. automatic_captcha_enabled ALREADY HOLDS DATA on 25 accounts, which
     makes this the one of the twelve that was not merely untidy.
     A separate permission to resume after the applicant solves a CAPTCHA in the open portal tab.
     Submission permission never implies it, and Litos never solves the challenge itself. */
  automatic_captcha_enabled: boolean('automatic_captcha_enabled').default(false).notNull(),
  automatic_captcha_consented_at: timestamp('automatic_captcha_consented_at', { withTimezone: true }),
  automatic_captcha_consent_version: text('automatic_captcha_consent_version'),
  // ---- visa sponsorship ----
  //
  // Answered ONCE, during onboarding, and then permanent. True means the job seeker said they need
  // sponsorship now, will need it later, or is not authorised to work where they are applying; all
  // three end at the same place, so they collapse to one bit (see SponsorshipAnswer in
  // src/lib/sponsorship.ts, which keeps the four answers apart for the record).
  //
  // WHY IT IS NOT AN EDITABLE PREFERENCE. Mehek's rule, 2026-07-28: a declaration made at
  // onboarding filters the board forever, whether or not it is ever repeated. The two mistakes cost
  // wildly different amounts. Leaving the filter on shows someone fewer jobs than they could take.
  // Turning it off by accident - a stray click, a "reset preferences" pressed for another reason -
  // puts them back in front of postings that will reject them at the final question, months later,
  // with no explanation. So the settings toggle below can only ever ADD the filter, and
  // sponsorOnlyBoardRequired() is where that asymmetry is written down and tested.
  //
  // NULL is a real and common state: every account created before this shipped, and every guest.
  // It reads as "never asked", which leaves the board whole.
  sponsorship_required_at_onboarding: boolean('sponsorship_required_at_onboarding'),
  sponsorship_declared_at: timestamp('sponsorship_declared_at', { withTimezone: true }),
  // The exact answer given, kept for the record and for the settings screen to explain itself.
  sponsorship_answer: text('sponsorship_answer'),
  // The settings toggle. Independent of the declaration and strictly additive: someone who did not
  // declare at onboarding can switch the sponsor-only board on here, and off again. Someone who
  // did declare sees it on and locked, with the reason stated.
  sponsor_only_jobs_enabled: boolean('sponsor_only_jobs_enabled').default(false).notNull(),
  /* Where employer mail that arrives at a Litos application alias is delivered.
   *
   * NULL means "use the account email", which is what every existing account gets and what the
   * 50 alias rows already written are pointed at, so this column changes nothing until somebody
   * sets it. It exists because the destination was previously an ACCIDENT: submissionRunner passed
   * the login address, so a student who signs in with a school account she loses at graduation
   * would silently lose every employer reply with it, and had no way to say otherwise.
   *
   * Changing it re-points FUTURE aliases and, on the next write to an existing alias, that one too
   * (ensureApplicationEmailAlias upserts forward_to). Historical rows are deliberately left alone
   * rather than bulk-rewritten: a thread already running to one mailbox should not silently move
   * mid-conversation. */
  application_email_forward_to: text('application_email_forward_to'),
}, (t) => ({
  googleSubjectUnique: uniqueIndex('users_google_subject_unique')
    .on(t.google_subject)
    .where(sql`${t.google_subject} is not null`),
  billingSubscriptionUnique: uniqueIndex('users_billing_subscription_unique')
    .on(t.billing_subscription_id)
    .where(sql`${t.billing_subscription_id} is not null`),
}));

/* ---- tables live in prod that main does not otherwise use ----
 *
 * All three were created by codex/regional-pricing's apply script before that branch merged, and
 * were invisible to check-schema-drift.mjs until this change, because it only inspected tables
 * schema.ts already declared. They are empty today, so nothing has been lost; declaring them is
 * what stops a `db:push` from main dropping them once the branch ships and they start holding
 * rows. Column types are introspected from the live tables and match that branch's declarations.
 *
 * No code on main reads these. They are here so the schema is an honest description of the
 * database, which is the whole premise the drift check rests on. */

// ---- billing_webhook_events ----
// Lemon Squeezy retries events. The raw body hash is the idempotency key because the payload does
// not expose a dedicated event id.
export const billing_webhook_events = pgTable('billing_webhook_events', {
  event_key: text('event_key').primaryKey(),
  provider: text('provider').notNull(),
  event_name: text('event_name'),
  result: text('result').default('processing').notNull(),
  received_at: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  processed_at: timestamp('processed_at', { withTimezone: true }),
});

// ---- pricing_experiment_assignments ----
// A user keeps the same variant for the lifetime of an experiment, even when they change browsers
// or an operator changes allocation percentages after launch.
export const pricing_experiment_assignments = pgTable('pricing_experiment_assignments', {
  user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  experiment_id: text('experiment_id').notNull(),
  variant: text('variant').notNull(),
  assigned_at: timestamp('assigned_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.user_id, t.experiment_id] }),
}));

// ---- pricing_offers ----
// One immutable commercial snapshot per checkout attempt. Provider webhooks bind back to this row
// so the amount, country evidence and experiment assignment stay auditable without trusting client
// analytics.
export const pricing_offers = pgTable('pricing_offers', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  subject_id: text('subject_id').notNull(),
  idempotency_key: text('idempotency_key').notNull(),
  quote_token_hash: text('quote_token_hash'),
  policy_version: text('policy_version').notNull(),
  country_code: text('country_code').notNull(),
  detected_country_code: text('detected_country_code'),
  requested_country_code: text('requested_country_code'),
  billing_country_code: text('billing_country_code'),
  country_mismatch: boolean('country_mismatch').default(false).notNull(),
  band: text('band').notNull(),
  experiment_id: text('experiment_id'),
  experiment_variant: text('experiment_variant').notNull(),
  billing_interval: text('billing_interval').notNull(),
  currency: text('currency').notNull(),
  base_amount_cents: integer('base_amount_cents').notNull(),
  amount_cents: integer('amount_cents').notNull(),
  status: text('status').default('creating').notNull(),
  provider_checkout_id: text('provider_checkout_id'),
  provider_checkout_url: text('provider_checkout_url'),
  provider_customer_id: text('provider_customer_id'),
  provider_subscription_id: text('provider_subscription_id'),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  checkout_created_at: timestamp('checkout_created_at', { withTimezone: true }),
  paid_at: timestamp('paid_at', { withTimezone: true }),
  verified_at: timestamp('verified_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
  // Legacy nullable columns. New uploads never write an original file, and the retention sweep
  // clears pointers left by the brief storage implementation before this privacy correction.
  resume_object_key: text('resume_object_key'),
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
  /* NO `coursework` COLUMN HERE, AND THE REASON IS WORTH KEEPING. One was added on this branch and
   * taken back out before merge, because a column on THIS table cannot be shipped the way one on
   * application_profile can.
   *
   * application_profile has exactly one read path, selectApplicationProfileRow, which builds an
   * explicit narrowed projection and so tolerates a database that has not run the migration yet.
   * `profiles` has 27 bare `db.select().from(profiles)` sites and no such helper, and Drizzle names
   * every declared column in every one of them. Declaring a column here before the migration runs
   * therefore 42703s resume generation, the extension's autofill answers, the submission runner, job
   * matching, base resume builds, the account export, and the INSERT in routes/profile.ts that
   * creates a profile row at all - which means new signups. That is not a degraded feature, it is
   * the backend.
   *
   * So the course history needs its own change: either a narrowed-projection helper for `profiles`
   * matching the one its neighbour already has, or a migration confirmed present before the column
   * is declared. The measurement behind it stands and is worth acting on - GET /profile returns four
   * courses, two of them business electives, and all 158 packets print that same list unchanged
   * including a Data Science and a quant trading internship - but it is a separate piece of work
   * and it is not this one.
   */
  // The BASE resume: one ResumeSpec, built once at onboarding from the bank with no job
  // description. It is what the student reviews and approves on /start, and the fallback every
  // later generation falls back TO when a JD is thin, unreadable, or absent.
  //
  // Stored, not derived, and that is the point. Deriving it would rebuild it on every read, so the
  // resume a student approved on Tuesday would quietly become a different resume on Friday because
  // the model picked differently. Approval has to attach to an artifact that cannot move underneath
  // it. Rebuilding is an explicit act (POST /resume/base), which is also what makes the built_at
  // timestamp meaningful.
  //
  // NULL means never built - normal for every account created before this shipped, and the reason
  // /onboarding/state treats the base step as skippable rather than a wall.
  base_resume_json: jsonb('base_resume_json'),
  base_resume_built_at: timestamp('base_resume_built_at', { withTimezone: true }),
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
}, (t) => ({
  companyDomainIdx: index('contacts_company_domain_idx').on(t.company_domain),
}));

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
}, (t) => ({
  contactIdx: index('email_resolutions_contact_id_idx').on(t.contact_id),
}));

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
}, (t) => ({
  userContactChannelIdx: index('outreach_events_user_contact_channel_idx').on(
    t.user_id,
    t.contact_id,
    t.channel,
  ),
  userCreatedIdx: index('outreach_events_user_created_idx').on(t.user_id, t.sent_at),
}));

// ---- resolve_cache ----
// Persists a finished /resolve result per (domain|role) so repeat lookups spend no provider
// or verification credits, surviving process restarts. cache_key = `${domain}|${role}`.
export const resolve_cache = pgTable('resolve_cache', {
  cache_key: text('cache_key').primaryKey(),
  results: jsonb('results').notNull(),
  source: text('source').notNull(),
  cached_at: timestamp('cached_at', { withTimezone: true }).defaultNow().notNull(),
});

// ---- competency_verdicts ----
/**
 * One model judgement about one requirement clause against one resume, cached forever.
 *
 * SAFE TO CACHE FOREVER because both inputs are content-addressed. The key is a hash of the
 * clause text and a hash of the resume bullets, so an edited resume or an edited posting is a
 * different key rather than a stale hit. Nothing here expires; a row simply stops being asked for.
 *
 * WHY IT EXISTS. Judging competency clauses is a Sonnet call, and a student re-opens the same
 * application review across sessions while the posting and their resume sit still. Without this,
 * reading a packet twice costs twice. Measured on the live board, a posting states five to eight
 * competency clauses, so the cache turns a repeat view from one call into none.
 *
 * NOT KEYED BY USER, deliberately. The inputs are the clause and the bullets, and two students with
 * the same bullet would get the same verdict, so keying on user_id would only lower the hit rate.
 * The quote stored here is the STUDENT'S OWN sentence, already in the row that produced the hash.
 */
export const competency_verdicts = pgTable('competency_verdicts', {
  /** sha256(clause) + ':' + sha256(bullets joined). Content-addressed, so it cannot go stale. */
  cache_key: text('cache_key').primaryKey(),
  met: boolean('met').notNull(),
  /** The bullet the verdict was grounded in, verbatim. Null when unmet. */
  quote: text('quote'),
  /** One short sentence for the gap list. */
  why: text('why'),
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
}, (t) => ({
  userCreatedIdx: index('learning_signals_user_created_idx').on(t.user_id, t.created_at),
}));

// ---- experience_bank ----
// Each row is one job/project. bullet_variants holds every phrasing the student
// has ever used for that entry across resume versions, so /resume/generate can
// pick the best-fit variant per posting instead of being locked to one fixed resume.
export const experience_bank = pgTable('experience_bank', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  type: text('type').notNull(), // 'job' | 'project' | 'leadership'
  org: text('org').notNull(),
  title: text('title'),
  date_range: text('date_range'),
  /* Where the work happened, e.g. "Los Angeles, CA". Nullable and usually null on rows created
     before 2026-08-04: the parser only started reading it then, and existing rows are backfilled
     only when the student uploads again. The renderer prints nothing for a null, which is correct
     rather than a gap - a resume line missing its city is not wrong, it is shorter.
     GROUNDED LIKE EVERY OTHER FIELD HERE: applyResumePolicy copies location off this row, never
     off the model's output. A plausible invented city on an employment document is a fabricated
     fact about where someone worked. */
  location: text('location'),
  bullet_variants: jsonb('bullet_variants').notNull(), // string[]
  tags: jsonb('tags'), // string[] of skills/keywords this entry supports
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  userIdx: index('experience_bank_user_id_idx').on(t.user_id),
}));

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
  // Explicit student profile attestations. Harvest never writes these back out of an observed
  // employer form: these are single global flags, while some forms ask a LOCATION-SCOPED question
  // ("authorized to work in the location where this role is based?"). The submission runner may
  // answer only from these stored values, and still holds ambiguous mixed-scope questions.
  work_authorized: boolean('work_authorized'),
  needs_sponsorship: boolean('needs_sponsorship'),
  // The complete country-scoped declaration is encrypted as one authenticated text envelope.
  // Country, authorization, sponsorship, authorization type, and expiry describe a person's
  // immigration status together, so storing only the detail fields encrypted would still expose
  // the sensitive claim through the remaining JSON. The feature layer validates the decoded list
  // and derives the two legacy US booleans above for installed scalar-only clients.
  work_eligibility_by_country: text('work_eligibility_by_country'),
  // WHEN she can start. Stored ISO (YYYY-MM-DD) because onboarding uses <input type="date">:
  // a locale-shaped string is silently dropped by a picker expecting the other order (R-014).
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
  // application parked mid-fill for exactly this (needed "a salary figure + unit").
  //
  // ⚠️ THE COLUMN EXISTS; THE GUARD DOES NOT YET. This comment used to claim fill leaves the field
  // blank unless both are present. It does not: desiredAnswer's rule is still
  // `SALARY_QUESTION.test(l) && ap.desired_salary`, with no currency check, so a figure harvested
  // from a EUR form WILL be typed into a CAD field. Storing the currency is only half the fix -
  // the adapters have to require the pair, and that lives in the extension
  // (rolequick-autofill#7's classifyField/desiredAnswer), not here. Until it lands, treat a
  // populated desired_salary with a null currency as a known mis-fill risk rather than a solved
  // problem.
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
  // string[] of language names the student declared FLUENCY in, e.g. ["English","Hindi"].
  // Plaintext like major and profiles.skills, and for the same reason: a declared fluency list is
  // career data the student volunteers on the face of every resume, not an identity fact, and the
  // fill path reads it on every application - putting it behind ENCRYPTED_FIELDS would make the
  // read side carry decrypt-or-fail handling (R-021's whole ceremony) to protect a list whose
  // entire purpose is to be typed into forms.
  //
  // THE DECLARED LIST IS THE AUTHORITY (R-015's lesson, applied on purpose). This is the student's
  // own enumeration, never an inference: not from citizenship, not from resume text, not from
  // where a posting is based. A language question is exactly where a guessed answer becomes a
  // false claim of fluency to an employer - ZURU asked about Spanish and Enpal about German on
  // live applications (2026-07-17) and Litos had nothing to say either time, which was the
  // CORRECT failure. The fix is asking the student once in onboarding, not inferring. Absent or
  // empty means "never answered", and the fill path must leave language questions alone.
  languages: jsonb('languages'),
  eeo_prefs: jsonb('eeo_prefs'), // nullable, only set if the student explicitly opts in
  /* HOW SHE FOUND THE POSTING, and it is hers to say.
   *
   * The `.default('Company website')` that used to be here is gone. Measured on 2026-08-09: all 16
   * production rows carry "Company website" and NOT ONE of them was typed by a person - the column
   * default put it there, and `resolveKnownAnswer` had a second copy of the same constant as its
   * fallback. So the most-asked question in the whole corpus (25 distinct labels, 20 employers) was
   * answered on every application with a statement of fact nobody had made, and one that is usually
   * false: Litos finds these postings on a monitored job board, not on the employer's own site.
   *
   * Null now means never asked, the resolver refuses on null, and onboarding asks for it. The
   * migration drops the default for new rows; clearing the value on the existing 16 is a separate,
   * explicit step in scripts/apply-onsite-commitment-schema.mjs, because it makes those accounts
   * start being asked a question they were silently answering before. */
  referral_source_default: text('referral_source_default'),

  /* WHEN THE SETUP GAPS SCREEN WAS ASKED, which is what makes that screen exitable.
   *
   * The gaps screen is derived from what is still missing (routes/onboarding.ts SETUP_GAP_FIELDS),
   * and every field on it is optional and skippable. #116 removed the step from the flow for
   * exactly that reason: gating on "still missing" derives 'gaps' FOREVER for anyone who skips it,
   * because skipping leaves the fields missing. Deriving the step again without a record of having
   * ASKED would reintroduce that bug verbatim.
   *
   * So this is the one thing about the screen that is stored rather than derived, for the same
   * reason users.onboarding_completed_at is: "I was asked and chose not to answer" is an act, and
   * no amount of looking at the profile can infer it. Set by POST /onboarding/gaps-asked on both
   * Save and Skip - both mean asked, and only the profile itself records which.
   *
   * NULL means never asked. Absent (this migration has not run) is a THIRD state and is treated as
   * asked, so the step disappears rather than becoming inescapable: see gapsAskedFrom. */
  setup_gaps_asked_at: timestamp('setup_gaps_asked_at', { withTimezone: true }),

  /* ---- application facts asked once in onboarding (2026-08-08) ----
   *
   * Measured, not guessed. Every column below was counted across the 25 most recent production
   * packets for the owner account: each one names a question that BLOCKED at least two distinct
   * job postings with "is required and is still empty", and that no existing column could answer.
   * Fields that appeared on exactly one posting (SAT/ACT scores at IMC) were deliberately left out
   * rather than added speculatively - see the counts in the migration script's header.
   *
   * ALL NULLABLE, and null is a real state everywhere: it means "never asked", and the fill path
   * must leave the question alone rather than substitute a default. That is not a nicety here.
   * Nine of these are SELF-DECLARATIONS about a person (pronouns, military service, politically
   * exposed person status) or CONSENTS given to an employer, and a default value for any of them
   * is a statement Litos would be making on the student's behalf that she never made.
   *
   * PLAINTEXT, all of them, deliberately NOT added to ENCRYPTED_FIELDS. The precedent is
   * `languages` and `eeo_prefs` directly above: their entire purpose is to be typed into an
   * employer form on every application, so putting them behind decrypt-or-fail (R-021) would buy
   * nothing and cost the read path a failure mode. The identity bar is also already set elsewhere
   * - profiles.parsed_json stores full_name, school and grad_date in the clear - so encrypting a
   * legal first name here while the full name sits plaintext one table over would be theatre.
   */

  // "We care about addressing everyone correctly. Add your personal pronouns below." Blocked 2
  // Akuna postings across 9 packets. Stored as the literal string to type ("she/her"), including
  // "Prefer not to say" when that is what the student chose: a pronoun is never inferred from a
  // name, a gender answer, or anything else.
  pronouns: text('pronouns'),
  // "What is your legal first name? (please also ensure that you input your legal first name in
  // the *first name* field above)". Blocked 2 Akuna postings across 7 packets. Null falls back to
  // the first token of the parsed full name, which is what the resolver already did - this column
  // exists for the person whose legal name is NOT the name on their resume, which is the only
  // reason a form asks the question separately.
  legal_first_name: text('legal_first_name'),
  // The other half of that pair. Asked directly by Akuna ("do you have a preferred name, other
  // than the name indicated above?"), and without it "legal first name" has nothing to be
  // distinct FROM. Empty string is not a valid value; null means never answered.
  preferred_first_name: text('preferred_first_name'),
  // "To be considered for this role, you must have earned a high school diploma... please confirm
  // the month and year" (Akuna, 2 postings) and "When did you graduate from High School?" (IMC).
  // Free text month-and-year like grad_date, e.g. "June 2024", because that is what the forms ask
  // for and a full ISO date would be a precision the student does not have to hand.
  high_school_grad_date: text('high_school_grad_date'),
  /* WHEN THE CURRENT PROGRAMME STARTED. "Start date month" / "Start date year", the education
   * block on Greenhouse's own education row, which blocked 7 of the 22 applications that stopped on
   * 2026-08-08: DRW x2, Flow Traders, IMC x2, Five Rings x2. The single widest gap in that run.
   *
   * THREE THINGS THIS IS NOT, and each was tried before this column existed:
   *   Not availability_date. Answering it from job availability put "August 6, 2026" - the date she
   *     could start WORK - into a field asking when she started UNIVERSITY.
   *   Not the graduation date. That is the end of the programme, and education_end_date already is.
   *   Not derived from high_school_grad_date. Hers reads "May 2023" against a graduation of "May
   *     2028". A five-year run at one institution and a gap year followed by four both fit those two
   *     facts exactly, and they give different answers (August 2023 against August 2024). Picking
   *     one is inventing a fact about her education, which is the defect class this whole column
   *     group exists to remove.
   *
   * Nothing on file can supply it, so it is asked. Asked HERE rather than at Apply because
   * answerReuse scopes "start date month" posting_specific - it is not a self-declaration and not a
   * test score - so an answer given on the Apply screen is used once and never carried, and she
   * would retype it at every firm that asks. It is one fixed fact about her, identical on every
   * form, which is exactly what this group is for. The Apply screen still asks it, unchanged,
   * for the window before she answers it here and for anyone who skips onboarding.
   *
   * Free text month-and-year, like grad_date and high_school_grad_date: "August 2024". The forms
   * ask for a month and a year, and narrowDatePart already splits one into either half.
   */
  education_start_date: text('education_start_date'),
  /* "Have you previously applied to work at Point72?" / "...with Akuna in the past?" / "...another
   * role @IMC within the last 12-18 months?" - 4 postings, 3 companies.
   *
   * A string[] of employers the student has applied to before, NOT a global boolean, because the
   * question is per-employer and a single bit cannot answer it. The three states are all real and
   * all different:
   *   null  - never asked. The resolver leaves the question for the applicant.
   *   []    - "I have not applied anywhere before", which answers No for every employer.
   *   [...] - answers Yes for a named match and No otherwise.
   * Before this column the LLM drafter answered these, and it invented the fact: one packet
   * carries a 600-word essay opening "I have not applied to Akuna in the past", which is a claim
   * about the student's history that nothing on file supported.
   */
  prior_application_employers: jsonb('prior_application_employers'),
  // "Do you have any offer deadlines that we should be aware of?" (Akuna), "Are you holding any
  // outstanding offers?" (Five Rings), "Do you currently have any offers?" (IMC), "Do you have any
  // outstanding offers or deadlines?" (Virtu), "Do you currently have an offer? If so, what is
  // your deadline" (Tower). 5 postings, 5 companies - the widest gap measured.
  //
  // The boolean and the detail are separate because the forms ask both shapes and a bare "Yes" is
  // not an answer to "what is your deadline". Before this, the resolver returned a hardcoded "No",
  // which is a factual claim about the student's job search that no stored value backed.
  has_outstanding_offers: boolean('has_outstanding_offers'),
  outstanding_offer_details: text('outstanding_offer_details'),
  // "Have you served in the military?" (Point72, a required Yes/No that is NOT part of an EEO
  // block). Stored as the literal declared answer, "Yes" / "No" / "Prefer not to say". Kept apart
  // from eeo_prefs.veteran_status on purpose: that one answers a voluntary self-identification
  // block whose option list is "I am a veteran / I am not / I decline to self-identify", and
  // pouring "Decline to self-identify" into a required Yes/No select is exactly what left the
  // Point72 field empty.
  military_service: text('military_service'),
  // "Are you or have you been entrusted with a position or function in any government,
  // international organization, or state-owned enterprise?" and the immediate-family variant
  // (Tower Research). Two columns because they are two questions with two different answers.
  //
  // THE REASON THIS IS A STORED DECLARATION AND NOT AN INFERENCE. On 2026-08-06 the live answer
  // Litos gave to the first of these was "Dubai": classifyField's `\b(state|province)\b` residence
  // rule matched the word "state" inside "state-owned", so a politically-exposed-person question
  // was answered with the applicant's home city. Nothing may ever guess at these. Null means the
  // question is left for the applicant, and the classifier now refuses the label outright.
  politically_exposed: text('politically_exposed'),
  politically_exposed_family: text('politically_exposed_family'),
  // "Are you considering or committed to pursuing further education immediately after completing
  // your current academic studies?" (Five Rings), "if you are an undergraduate considering a
  // master's degree following graduation, when is your potential master's graduation date?"
  // (Akuna, 2 postings), "Are you currently enrolled in a PhD program?" (IMC). 4 postings, 3
  // companies - and not on the original list, found by counting.
  //
  // One of 'no' | 'considering' | 'committed'. Akuna's master's-graduation-date question was being
  // answered "May 2028" - the student's UNDERGRADUATE graduation date, replayed onto a question
  // about a degree she has not said she is doing.
  advanced_study_plan: text('advanced_study_plan'),
  /* ---- the two attestations Litos is allowed to tick, and nothing else ----
   *
   * "I certify that all information I have provided is true, complete, and accurate" (Akuna, 2
   * postings), "Privacy Policy Acknowledgement" (Five Rings), "Privacy Statement" (IMC),
   * "Privacy" (Point72). 5 postings, 4 companies.
   *
   * These are the ONLY two categories of checkbox an automated submission may affirm, and each one
   * may only be affirmed from an explicit stored `true` here. A required affirmation that the
   * information is truthful restates something the student already did by building the packet; an
   * acceptance of a candidate privacy notice is the routine condition of applying at all.
   *
   * Everything else stays with the applicant, including things that look adjacent and are not:
   * Akuna's "I acknowledge that this role is my top preference and I will not be considered for
   * other tech and/or quant roles at Akuna this season" is a binding exclusivity commitment, and
   * IMC's "Interview Code of Conduct" is acceptance of a behavioural policy. Both were previously
   * auto-answered "Yes" with nothing stored behind them. Neither is a truthfulness attestation and
   * neither is a privacy notice, so neither may be ticked by us at any price.
   *
   * null and false are treated identically by the resolver (do not tick). They are stored apart so
   * "never asked" and "asked and declined" stay distinguishable in the record.
   */
  attest_truthful_information: boolean('attest_truthful_information'),
  accept_privacy_notices: boolean('accept_privacy_notices'),
  // When the two booleans above were last set. Consent evidence, in the same shape users.* records
  // it for the automation permissions: a permission with no timestamp cannot be audited later.
  application_attestations_consented_at: timestamp('application_attestations_consented_at', { withTimezone: true }),

  /* ---- where she will actually work from (2026-08-09) ----
   *
   * THE DEFECT THESE CLOSE. `resolveKnownAnswer` had `case 'onsite_commitment': return
   * { value: 'Yes' }`, a constant with no column behind it, and a second constant beside it for
   * the same question in prose form. A Redwood Materials packet was ready to send with "Are you
   * available to work from our office in San Francisco?" answered YES, for an applicant with a
   * +971 phone number who studies in Los Angeles. Same class as the Akuna exclusivity Yes, and far
   * more frequent: 15 distinct labels across 12 employers in the stored corpus, which is six times
   * the two-posting bar the columns above were chosen by.
   *
   * WHY THREE COLUMNS AND NOT A BOOLEAN. This is the one fact in the group with a LOCATION
   * DIMENSION. "Yes to Los Angeles, no to New York" is a single coherent answer that no boolean can
   * hold, and collapsing it either commits her to an office she will not go to or refuses one she
   * would. And relocating is a different promise from commuting: someone who will work five days a
   * week from an office in the city she already lives in has said nothing about moving to Seattle.
   *
   *   onsite_commitment      'anywhere' | 'listed_locations' | 'no'
   *   onsite_locations       string[], her own words, ORDERED - the first entry an employer offers
   *                          is also the answer to "what is your preferred work location?"
   *   relocation_willingness 'yes' | 'no'
   *
   * null means never asked on all three, and the resolver refuses rather than defaults. An existing
   * account that has not answered is therefore ASKED, which is the entire point: the previous
   * behaviour and "defaulting after the migration" are the same wrong answer.
   */
  onsite_commitment: text('onsite_commitment'),
  onsite_locations: jsonb('onsite_locations'),
  relocation_willingness: text('relocation_willingness'),

  /* ---- when the internship can actually run (2026-08-09) ----
   *
   * THE GAP THESE CLOSE. Counted across all 112 stored packets, the single largest cluster of
   * required-and-blank questions is this one fact asked five ways: "what dates are you available for
   * an internship" (blocking a live truveta packet), "when do you plan on ending your internship"
   * (6 postings), and the start-date pair. `availability_date` has held a value the whole time and
   * the resolver has always refused to read it, correctly: it carries no recruiting cycle and no
   * expiry, so a date typed for Summer 2026 would answer a Summer 2027 form forever, and that is a
   * commitment to an employer the student never made and could be held to.
   *
   * WHY FOUR COLUMNS AND NOT ONE MORE DATE. Every one of them is a check the legacy field cannot
   * pass, and a record missing any of them answers nothing at all:
   *
   *   availability_window_start   ISO YYYY-MM-DD, the earliest she could begin.
   *   availability_window_end     ISO YYYY-MM-DD, the latest she is available through.
   *   availability_cycle          "Summer 2027". The SCOPE. A window is only allowed to answer a
   *                               posting whose own job description names this same cycle; a
   *                               posting that names none is refused rather than assumed to match.
   *   availability_valid_through  ISO YYYY-MM-DD. The EXPIRY, set by her and not derived from the
   *                               window: a student who accepts an offer in March wants her Summer
   *                               answer to stop being given, and only she knows that date.
   *
   * ISO, not the free text `high_school_grad_date` and `education_start_date` use. Those report a
   * month that already happened; these are compared against a posting and against today, and
   * widening "June 2027" into a day would be Litos choosing the edge of her commitment.
   *
   * PLAINTEXT and NOT in ENCRYPTED_FIELDS, unlike `availability_date` directly above. The reason is
   * the read path: these are read by lib/applicationFacts.ts off the RAW row, which is what lets the
   * resolver survive this migration not having run, and a decrypt step there would hand ciphertext
   * to an employer's form. A recruiting-cycle window is scheduling data, in the same class as the
   * onboarding facts above it, not the movement fact a bare personal date is.
   *
   * null on all four means never asked. The resolver refuses and the question reaches the student,
   * which is the behaviour today and the correct one.
   */
  availability_window_start: text('availability_window_start'),
  availability_window_end: text('availability_window_end'),
  availability_cycle: text('availability_cycle'),
  availability_valid_through: text('availability_valid_through'),

  /* ---- standardized test scores (2026-08-11) ----
   *
   * WHAT THE MEASUREMENT ACTUALLY SAYS, stated in the unit the bar is written in.
   *
   * Counted across the full 158-packet corpus on 2026-08-11, each of the three questions blocked
   * EIGHT distinct packets. In postings, which is how the 2026-08-08 group above counts ("6
   * postings", "5 postings, 5 companies"), those 8 packets are:
   *
   *   2 postings, 1 employer (IMC Trading), retried four times each.
   *
   * An earlier draft of this comment said nine packets and called that "four times the two-posting
   * bar". That compared packets against postings and was wrong twice over: the count was 8, and a
   * retry is not a posting. Restated honestly, this clears the letter of the two-posting bar and
   * nothing more, at a SINGLE employer, which is weaker than every other member of the group above.
   * The original exclusion note at the top of this file called it "exactly one posting"; it is now
   * two. That is a real change and a small one, and it is not on its own a reason to add a column.
   *
   * SO THE ARGUMENT IS NOT THE COUNT. It is that no other mechanism can ever answer these:
   *
   *   Nothing can harvest them. A form ASKS for a test score and never offers one, which is the
   *     same structural argument that put gpa and major on this table rather than in the harvest.
   *   All 24 occurrences were blank and required. Not one was answered by any existing path.
   *   The type question needs a CLOSED LIST. saved_application_answers stores free text keyed by
   *     question wording, and cannot hold an enum the resolver is allowed to rely on.
   *   Onboarding collects them UP FRONT, which is the whole point: the alternative learns a fact
   *     only after it has already blocked an application, and then only for that exact wording.
   *
   * THE HONEST COUNTERPOINT, recorded because it is real. The comment on saved_application_answers
   * below names "a standardized test score" as its own example of what belongs there rather than in
   * a typed column, and lib/answerReuse.ts already scopes exact test scores 'reusable'. That path
   * exists and these columns overlap it. Two things decided it anyway: that path cannot ask up
   * front, and its STANDARDIZED_TEST_SCORE_QUESTION carries the identical defect these matchers
   * were just repaired for, requiring the word "score" where the employer writes "result". Anyone
   * revisiting this should weigh consolidating the two rather than assuming the split is settled.
   *
   * WHY THREE COLUMNS AND NOT ONE. The forms ask all three shapes and they are three different
   * questions. A quant-trading form asks "which standardized test did you take?" as a closed list
   * and then asks for the score of the one named; answering the type question with a number, or
   * the SAT field with an ACT score, is a false claim about an academic record. The type is also
   * the only one of the three that is answerable by a student who took neither ("None"), which no
   * score field can express.
   *
   * SCORES ARE TEXT, NOT INTEGER. "1520", "1520 (superscored)" and "34" are all real answers, and
   * an integer column would force a lossy read of the first. Same reasoning as gpa directly above,
   * which is stored as earned rather than as a number.
   *
   * PLAINTEXT, not in ENCRYPTED_FIELDS, on the same precedent as gpa_scale, major and languages:
   * the entire purpose of the value is to be typed into an employer form on every application, and
   * lib/applicationFacts.ts reads these off the RAW row, so a decrypt step here would hand
   * ciphertext to a form. gpa is encrypted and is read through a decrypt path for that reason;
   * these are read on the raw path and so must not be.
   *
   * NULL means never asked on all three, and the resolver refuses rather than defaults. Inventing
   * a test score is the single worst thing in this file's problem space: it is a checkable claim
   * about an academic record made to an employer.
   */
  // One of 'SAT' | 'ACT' | 'Both' | 'None'. Her own declaration, never inferred from whether a
  // score column happens to be populated: a student may have taken the SAT and not wish to report
  // it, and "None" is a real answer that no score field can carry.
  standardized_test_type: text('standardized_test_type'),
  sat_score: text('sat_score'),
  act_score: text('act_score'),

  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// ---- targeting ----
// What the student is going after: the five questions /start asks last (category, titles,
// role types, locations, remote preference, main period, backup period).
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
  // Places where the student wants to work. These are search preferences, not the home address
  // stored in application_profile, so they stay plaintext and may safely steer job discovery.
  locations: jsonb('locations'),
  remote_only: boolean('remote_only').default(false).notNull(),
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
  // { company, role, jd_hash, job_id? }. job_id is the monitored_jobs row this application was
  // started from and is ABSENT on every row written before 2026-07-28, plus on any row generated
  // from the extension or a hand-typed link, which have no posting to point at. Readers must treat
  // it as optional forever; it is the precise identity when it is there, not a guaranteed one.
  job_context: jsonb('job_context').notNull(),
  spec: jsonb('spec').notNull(), // the tailoring decision, kept for audit/debugging
  resume_object_key: text('resume_object_key').notNull(),
  template_id: uuid('template_id').references(() => resume_templates.id),
  // Where the STUDENT says this stands: saved / applied / interview / offer / closed. A different
  // axis from spec._review.status, which is submission machinery and records what Litos did. They
  // move independently, and an interview must not be indistinguishable from a submission retry.
  // NULL means never moved; the reader derives a starting stage from the submission status.
  pipeline_stage: text('pipeline_stage'),
  pipeline_stage_at: timestamp('pipeline_stage_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  userCreatedIdx: index('generated_resumes_user_created_idx').on(t.user_id, t.created_at),
}));

// ---- application_email_aliases ----
// Litos-owned applicant addresses. Employers see the alias; Litos forwards inbound mail to the
// verified user email and records the thread against the application packet.
export const application_email_aliases = pgTable('application_email_aliases', {
  alias: text('alias').primaryKey(),
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  generated_resume_id: uuid('generated_resume_id').references(() => generated_resumes.id, { onDelete: 'cascade' }),
  forward_to: text('forward_to').notNull(),
  status: text('status').default('active').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userIdx: index('application_email_aliases_user_id_idx').on(t.user_id),
  resumeIdx: index('application_email_aliases_resume_id_idx').on(t.generated_resume_id),
}));

// ---- application_email_messages ----
// Minimal inbound/outbound ledger for application aliases. raw_json is kept for provider-specific
// debugging, while the dashboard reads only the normalized columns.
export const application_email_messages = pgTable('application_email_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  alias: text('alias').references(() => application_email_aliases.alias, { onDelete: 'cascade' }).notNull(),
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  generated_resume_id: uuid('generated_resume_id').references(() => generated_resumes.id, { onDelete: 'cascade' }),
  direction: text('direction').notNull(),
  provider: text('provider'),
  provider_message_id: text('provider_message_id'),
  dedupe_key: text('dedupe_key').notNull(),
  from_email: text('from_email'),
  to_email: text('to_email'),
  subject: text('subject'),
  text: text('text'),
  html: text('html'),
  classification: text('classification').default('other').notNull(),
  raw_json: jsonb('raw_json'),
  received_at: timestamp('received_at', { withTimezone: true }),
  forwarding_claimed_at: timestamp('forwarding_claimed_at', { withTimezone: true }),
  forwarded_at: timestamp('forwarded_at', { withTimezone: true }),
  forward_error: text('forward_error'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userCreatedIdx: index('application_email_messages_user_created_idx').on(t.user_id, t.created_at),
  aliasCreatedIdx: index('application_email_messages_alias_created_idx').on(t.alias, t.created_at),
  dedupeKeyUnique: uniqueIndex('application_email_messages_dedupe_key_unique').on(t.dedupe_key),
  providerMessageUnique: uniqueIndex('application_email_messages_provider_id_unique')
    .on(t.provider, t.provider_message_id)
    .where(sql`${t.provider_message_id} is not null`),
}));

// ---- application_email_receiving_proofs ----
// A provider-key-independent proof that Resend delivered one exact, operator-configured canary to
// the selected managed receiving route. The webhook handler writes only hashes and routing facts:
// never the canary recipient, provider payload, message body, headers, or signing secrets.
export const application_email_receiving_proofs = pgTable('application_email_receiving_proofs', {
  provider_message_hash: text('provider_message_hash').primaryKey(),
  route_fingerprint: text('route_fingerprint').notNull(),
  proof_version: integer('proof_version').notNull(),
  domain: text('domain').notNull(),
  verified_at: timestamp('verified_at', { withTimezone: true }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  routeFingerprintUnique: uniqueIndex('application_email_receiving_proofs_route_fingerprint_unique')
    .on(t.route_fingerprint),
  verifiedAtIdx: index('application_email_receiving_proofs_verified_at_idx').on(t.verified_at),
}));

// ---- career_page_sources ----
// Operator-managed company career boards. The polling worker reads the public ATS APIs rather
// than scraping job aggregators, so Litos can show first-party postings with a stable apply URL.
export const career_page_sources = pgTable('career_page_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  company_name: text('company_name').notNull(),
  ats_name: text('ats_name').notNull(), // 'greenhouse' | 'lever' | 'ashby' | 'workable'
  board_token: text('board_token').notNull(),
  career_url: text('career_url').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  last_polled_at: timestamp('last_polled_at', { withTimezone: true }),
  last_error: text('last_error'),
  // Set when this company has an H-1B filing record (see sponsor_employers). NULL means either
  // "checked, nothing found" or "never checked" - the difference is visible in the generated data
  // file, and a test asserts every board company appears there, so it cannot silently be the
  // second. Denormalised onto the source rather than joined through sponsor_employers on every
  // request because the join key is a normalised NAME, and normalising in SQL would mean the board
  // query carried its own second copy of normalizeEmployerName.
  sponsor_employer_id: uuid('sponsor_employer_id').references(() => sponsor_employers.id, { onDelete: 'set null' }),
  // The company as the PORTAL names itself, recorded on every poll (Greenhouse publishes it on
  // every job; Lever and Ashby publish none, so it stays NULL there).
  //
  // It exists because six sources were not the company their token suggested - `sas` is Superior
  // Alarm Systems, `tcs` is Thornbury Community Services - and the portal was saying so the entire
  // time. Storing it makes the disagreement visible in one query instead of a hand audit.
  portal_company_name: text('portal_company_name'),
  // Set when the portal's name shares no identifying word with ours. A source in this state is
  // NEVER linked to a sponsoring employer: we do not know whose board it is, so we cannot claim
  // anything about who sponsors on it. See portalNameAgrees in lib/sponsorIdentity.ts.
  portal_name_mismatch: boolean('portal_name_mismatch').default(false).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  boardUnique: uniqueIndex('career_page_sources_ats_board_unique').on(t.ats_name, t.board_token),
  enabledIdx: index('career_page_sources_enabled_idx').on(t.enabled),
}));

// ---- sponsor_employers ----
// Employers Litos can show to someone who needs visa sponsorship, and the filing that proves it.
//
// Synced on every monitor run from src/data/h1bSponsors.ts (generated by
// scripts/build-h1b-sponsors.mjs out of the USCIS H-1B Employer Data Hub). The manual
// `npm run db:sponsorship -- --seed` command remains available for migrations and repairs. A table
// AND a checked-in file
// because they do different jobs: the file is the reviewable copy, where a change to who Litos
// claims will sponsor a visa arrives as a diff carrying approval counts and legal entity names;
// the table is what the board query joins against, because the filter has to run in SQL or the
// count, the pagination and the tiles stop describing the same set.
//
// approvals/fiscal_years are not decoration. Every surface that hides jobs from someone has to be
// able to say why it kept the ones it kept, and "PALANTIR TECHNOLOGIES INC, 134 approvals, FY2021-
// 2023" is an answer. A bare boolean would let the product claim more than it knows.
export const sponsor_employers = pgTable('sponsor_employers', {
  id: uuid('id').primaryKey().defaultRandom(),
  // normalizeEmployerName(company). The join key, because a brand and a legal entity never match
  // literally. See src/lib/sponsorship.ts for why the normalisation stops where it does.
  normalized_name: text('normalized_name').notNull(),
  company_name: text('company_name').notNull(),
  // The employer's legal names exactly as filed. The audit trail for a wrong match.
  legal_names: jsonb('legal_names').$type<string[]>().notNull(),
  // 'uscis_h1b' (an approved petition), 'dol_lca' (a certified labor condition application), or
  // 'both'. Two different claims, so the column records which one this row rests on rather than
  // flattening them: an approval means somebody actually got a visa, a certification means the
  // employer filed and attested. See SponsorEvidenceSource in lib/sponsorEmployers.ts.
  evidence_source: text('evidence_source').notNull(),
  approvals: integer('approvals').default(0).notNull(),
  denials: integer('denials').default(0).notNull(),
  fiscal_years: jsonb('fiscal_years').$type<number[]>().notNull(),
  // Certified H-1B labor condition applications. The current half of the evidence: USCIS has
  // published nothing past FY2023, so every company founded since is confirmed by this or not
  // at all.
  lca_certifications: integer('lca_certifications').default(0).notNull(),
  verified_at: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  normalizedUnique: uniqueIndex('sponsor_employers_normalized_unique').on(t.normalized_name),
}));

// ---- monitored_jobs ----
// Normalized first-party postings from career_page_sources. first_seen_at is the Litos discovery
// time; posted_at is the employer-provided timestamp when the ATS exposes one.
export const monitored_jobs = pgTable('monitored_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  source_id: uuid('source_id').references(() => career_page_sources.id, { onDelete: 'cascade' }).notNull(),
  external_id: text('external_id').notNull(),
  company_name: text('company_name').notNull(),
  title: text('title').notNull(),
  location: text('location'),
  department: text('department'),
  employment_type: text('employment_type'),
  description: text('description').notNull(),
  /* The ~2 KB slice of `description` that ranking actually scores, built at poll time by
   * lib/descriptionDigest.ts.
   *
   * Stored rather than derived per request, like sponsorship_status and job_country above, but for
   * a different reason than either of those. Those two exist because a filter has to be a SQL
   * predicate. This one exists because of BYTES: ranking reads scoring text for every pooled row on
   * every cache miss, and reading a multi-kilobyte prefix of this column was the largest single
   * reader of transfer out of Neon in the backend. It exhausted the free tier's monthly allowance
   * and suspended the compute. Computing the digest at poll time moves that cost to the write side,
   * which is ingress, which is not billed.
   *
   * NULLABLE ON PURPOSE, and the null is not a defect. Rows polled before this column existed have
   * no digest, and there is deliberately no backfill: a backfill would have to read all 22k
   * descriptions out of Neon, spending exactly the transfer this column exists to save, to populate
   * a value the daily poll rewrites for free anyway. The read path coalesces to the old capped
   * prefix, so the board is correct throughout, and the column fills itself within one poll cycle.
   */
  description_digest: text('description_digest'),
  apply_url: text('apply_url').notNull(),
  posting_url: text('posting_url').notNull(),
  remote: boolean('remote').default(false).notNull(),
  posted_at: timestamp('posted_at', { withTimezone: true }),
  first_seen_at: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  last_seen_at: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  is_active: boolean('is_active').default(true).notNull(),
  // What THIS posting's own text says about visa sponsorship: 'offers' | 'refuses' | 'unstated'.
  //
  // Computed at poll time by readPostingSponsorship (src/lib/sponsorship.ts) and stored, rather
  // than evaluated per request, for one reason: the board filter has to be a SQL predicate. A
  // regex pass over 7,000 descriptions cannot run inside a WHERE clause, and doing it in the route
  // would mean the count, the pagination and the page were each computed over a different set.
  //
  // 'refuses' is the veto and outranks everything, including an employer with hundreds of
  // approvals: a company that sponsors heavily still publishes roles it will not sponsor (a
  // government contract, a country it has no entity in), and the posting is the authority on
  // itself. Defaults to 'unstated', which surfaces nothing on its own.
  sponsorship_status: text('sponsorship_status').default('unstated').notNull(),
  // 'us' | 'non_us' | 'unknown', from the location string at poll time (see lib/jobLocation.ts).
  //
  // An H-1B is a US work visa, so an EMPLOYER's filing record is evidence about its US roles and
  // nothing else. Without this column the sponsor-only board showed 2,781 foreign postings -
  // Bengaluru, Tokyo, London - to people who need US sponsorship, each labelled as a company "we
  // can confirm sponsors visas" on the strength of a petition filed for a different country's
  // hiring. A posting that states its OWN sponsorship is unaffected: that is the employer speaking
  // about that role, wherever it is.
  job_country: text('job_country').default('unknown').notNull(),
  /* WHAT THE EMPLOYER PUBLISHED ABOUT PAY. All four are null together or set together.
   *
   * Null on roughly two thirds of the board, and that is the employer's silence rather than a gap
   * in the crawl: 7,205 of 22,124 live postings publish a range (Greenhouse 31%, Ashby 46%, Lever
   * 10%). A null here renders NOTHING - no "competitive", no "not listed" - for the same reason the
   * board says UPDATED rather than POSTED on Greenhouse rows.
   *
   * Stored rather than derived per request, like sponsorship_status and for the same reason: the
   * period on a Greenhouse figure is inferred from its magnitude (see lib/compensation.ts), and
   * re-running that over thousands of descriptions inside a WHERE clause is not possible. Storing
   * it also means a future "pay published" filter or a sort by salary is a plain column predicate.
   *
   * doublePrecision, not real: the largest annual figure on the live board is 14,878,400 (JPY), and
   * float4 carries about 7 significant digits, so `real` would round it. Not numeric either, which
   * drizzle hands back as a string - these values are displayed and range-compared, never summed,
   * so binary float is exact enough and keeps the API sending a JSON number. */
  salary_min: doublePrecision('salary_min'),
  salary_max: doublePrecision('salary_max'),
  /* ISO 4217. 19 distinct codes appear live, so this is NOT safe to assume is USD. */
  salary_currency: text('salary_currency'),
  /* 'year' | 'month' | 'hour'. Text rather than an enum to match every other vocabulary column on
   * this table (sponsorship_status, job_country), which schema-push handles without a type
   * migration dance. The period is the whole point of the column: Greenhouse states a number and
   * never states its period, and a salary rendered as an hourly rate is worse than no salary at
   * all, so a posting whose period could not be established stores null here AND in the three
   * columns above. */
  salary_interval: text('salary_interval'),
  /* Kept as a column and now limited to small, reviewed ingestion metadata.
   *
   * The old full provider payload was write-only and cost 38 MB of the jobs board's 166 MB, so it
   * remains gone. The only supported shape is now `{ portal_country?: string }`, preserving the
   * ATS's authoritative country through resume generation without adding a production column.
   *
   * Existing rows may be null and fill naturally on their next normal poll. No backfill is needed
   * or safe. If a future feature needs more provider data, add only a bounded reviewed key rather
   * than restoring the raw payload. */
  raw_json: jsonb('raw_json'),
}, (t) => ({
  sourceExternalUnique: uniqueIndex('monitored_jobs_source_external_unique').on(t.source_id, t.external_id),
  activePostedIdx: index('monitored_jobs_active_posted_idx').on(t.is_active, t.posted_at),
  companyIdx: index('monitored_jobs_company_idx').on(t.company_name),
  // The sponsor-only board reads (is_active, sponsorship_status) on every request it serves.
  sponsorshipIdx: index('monitored_jobs_sponsorship_idx').on(t.is_active, t.sponsorship_status, t.job_country),
  /* Added with the job-type filter and the internship window (2026-08-04). Two query shapes need
     it and activePostedIdx serves neither:
       1. `employment_type = 'Internship'` selects ~2% of the table, and without an index on the
          column that is a full scan on the board's flagship filter.
       2. freshnessPredicate is now `posted_at >= now()-14d OR (employment_type = 'Internship' AND
          posted_at >= now()-90d)`. Postgres will not collapse that OR into one range, so
          activePostedIdx stops being usable as a range scan on EVERY board surface - /jobs,
          /jobs/grouped, /jobs/facets, surfacedJobCount and boardInventoryMetrics all share it. */
  typePostedIdx: index('monitored_jobs_type_posted_idx').on(t.is_active, t.employment_type, t.posted_at),
}));

// ---- posting_questions ----
/* THE PRE-SCRIPT: what one posting's application form asks, discovered once and shared by everyone.
 *
 * Litos owns the board, so it can know a posting's questions before anybody clicks Apply. This is
 * where that knowledge lives. One row per monitored_jobs posting, holding the FORM'S INVENTORY and
 * nothing about any applicant: the employer's question text, the control shape, its option list
 * when it has a closed one, and whether the employer marks it required.
 *
 * USER-INDEPENDENT ON PURPOSE, and that split is the whole design. The expensive half of answering
 * a form is looking at it, and the form is the same form for every applicant. The cheap half is
 * deciding which questions a particular profile already answers, and that is a pure function
 * (resolveKnownAnswer) run per applicant at Apply time over the rows below. So the browser cost is
 * paid once per posting and amortised over every applicant and every retry, while the answers stay
 * per-person and never touch this table.
 *
 * WHY THIS IS NOT POPULATED EAGERLY, which was the first thing considered and is the wrong answer.
 * There are 22,644 active postings. A discovery pass is a managed browser run against a live
 * employer page. The submission cron is a Vercel Hobby daily job with maxDuration 300s, so at the
 * ~15s a page load and DOM walk actually take, an eager sweep clears about 20 postings a day and
 * needs roughly three years to cover the board once - by which time every row it started with has
 * gone inactive. That is not an expense to weigh, it is a plan that does not terminate. Two thirds
 * of the board would also never be applied to, and Neon's free tier has a 5 GB monthly transfer
 * ceiling that a much smaller read already exhausted once (docs/incidents/2026-08-04).
 *
 * So this table is filled LAZILY, one posting at a time, at the moment somebody applies to it, and
 * then kept. The read is one row of a few kilobytes on the Apply path only; it is deliberately not
 * joined into any board list query, because 50 rows of question JSON per board page is a transfer
 * regression on the surface that is loaded most and needs it least.
 */
export const posting_questions = pgTable('posting_questions', {
  job_id: uuid('job_id').primaryKey().references(() => monitored_jobs.id, { onDelete: 'cascade' }),
  // The URL that was actually scanned. Stored rather than re-derived: monitored_jobs.apply_url can
  // be rewritten by a later poll, and a question set discovered against a different URL than the
  // one on file today is a stale scan, not a valid one.
  apply_url: text('apply_url').notNull(),
  // The detected SupportedPortal at scan time, e.g. 'greenhouse'. Null when detection failed.
  portal: text('portal'),
  /* PostingQuestion[]: { label, input_type, options, required, max_length }.
   *
   * The employer's own words, normalized only by normalizeReviewQuestionLabel. No answers, no
   * per-user classification, no skip reasons: every one of those depends on who is applying, and
   * baking one applicant's verdict into a shared row is how a cache becomes a wrong answer. */
  questions: jsonb('questions').notNull(),
  /* 'ok' | 'form_not_reached' | 'failed'. A scan that found nothing is a RESULT and is stored as
   * one, so the next applicant on the same posting does not pay for the same empty browser run.
   * It is stored with a shorter life than a good scan (see postingQuestions.ts), because
   * "we could not reach the form" is usually about the moment rather than the posting. */
  discovery_status: text('discovery_status').notNull(),
  discovered_at: timestamp('discovered_at', { withTimezone: true }).defaultNow().notNull(),
  // How many times this posting has been scanned. Purely an operational counter: it is the number
  // that says whether the cache is working, and it costs one integer.
  scan_count: integer('scan_count').default(1).notNull(),
}, (t) => ({
  discoveredAtIdx: index('posting_questions_discovered_at_idx').on(t.discovered_at),
}));

// ---- saved_application_answers ----
/* The answers she gave once and should never be asked for again.
 *
 * The same idea as PR #366's onboarding facts, for the questions that could not be foreseen. Those
 * became typed columns on application_profile because they were measured across many postings and
 * each one has its own resolution rule. This is the open-ended half: an export-control declaration,
 * a "rate your skill level in C++", a standardized test score. There is no way to enumerate them in
 * advance, so they are stored by the question's own text.
 *
 * WHAT MUST NOT LAND HERE is the reason lib/answerReuse.ts exists rather than a `insert every
 * answer` line at the end of submit-request. "Which opening would you be most interested in?" has
 * an answer, and that answer is about one posting; carrying it to the next employer would be Litos
 * making a statement she never made. answerReuseScope decides, defaults to posting-specific, and is
 * consulted on the write AND on the read.
 */
export const saved_application_answers = pgTable('saved_application_answers', {
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  // savedAnswerKey(label): the case-folded, punctuation-stripped question text. `+` and `#` survive
  // it, because C, C++ and C# are three skills and three answers.
  question_key: text('question_key').notNull(),
  // The label as the employer wrote it, kept for display and for audit. The key is lossy on
  // purpose; this is what she is shown when she edits a remembered answer.
  question: text('question').notNull(),
  answer: text('answer').notNull(),
  // The posting she first answered it on. Audit only, and nullable because an answer may arrive
  // from an application with no board posting behind it (the extension, a hand-typed link).
  first_answered_job_id: uuid('first_answered_job_id'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.user_id, t.question_key] }),
}));

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
  // R-030's measurement channel, not its fix. The register's verdict on the link classifier is
  // "do not fix it from first principles; get a real label off a real board first", so the
  // extension (fix/r027-tags-r030-log) logs the labels in exactly the R-030 population - where
  // linkQuestion matched, asksForLink is false, and the control is a text input - and ships them
  // here as a string[]. Nullable on purpose: events from older extension versions and fills with
  // no candidate labels simply omit it, and nothing reads the column yet. Whether the real fix is
  // "the platform must be the subject", a per-product veto, or nothing at all gets decided from
  // this data, not invented ahead of it.
  r030_candidate_labels: jsonb('r030_candidate_labels'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  userCreatedIdx: index('autofill_events_user_created_idx').on(t.user_id, t.created_at),
  atsCreatedIdx: index('autofill_events_ats_created_idx').on(t.ats_name, t.created_at),
}));

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
export type CareerPageSource = typeof career_page_sources.$inferSelect;
export type NewCareerPageSource = typeof career_page_sources.$inferInsert;
export type MonitoredJob = typeof monitored_jobs.$inferSelect;
export type NewMonitoredJob = typeof monitored_jobs.$inferInsert;
export type PostingQuestionsRow = typeof posting_questions.$inferSelect;
export type NewPostingQuestionsRow = typeof posting_questions.$inferInsert;
export type SavedApplicationAnswer = typeof saved_application_answers.$inferSelect;
export type NewSavedApplicationAnswer = typeof saved_application_answers.$inferInsert;
export type AtsAdapter = typeof ats_adapters.$inferSelect;
export type AutofillEvent = typeof autofill_events.$inferSelect;
export type NewAutofillEvent = typeof autofill_events.$inferInsert;
export type CompetencyVerdictRow = typeof competency_verdicts.$inferSelect;
export type NewCompetencyVerdictRow = typeof competency_verdicts.$inferInsert;
