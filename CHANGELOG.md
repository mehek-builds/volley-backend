# Changelog

## Unreleased

### Changed

- Resume parsing now races both configured model providers inside one short deadline, cancels the
  losing request, and falls back to bounded local extraction when neither provider responds.
- Base and job-tailored resume creation now share a 15-second model budget and can continue from
  grounded uploaded evidence without spending another provider retry on wording-only repairs.
- Eligible postings remain discoverable for 90 days rather than 14, so the board keeps a role for
  as long as its employer is still listing it. Closed postings still leave the board immediately;
  the window governs only how long an untouched posting date is treated as believable. Rows are
  correspondingly purged at 180 days rather than 28.
- Internships remain discoverable for 180 days rather than 90, keeping their window at twice the
  board's so a req posted in the August burst is still listed through the following spring. Their
  rows are correspondingly purged at 360 days rather than 180.

### Fixed

- Resume uploads no longer fail onboarding only because model-inferred target roles are unavailable.
- PDF text reconstruction and local parsing now enforce item, character, entry, bullet, and skill
  ceilings so malformed or unusually large documents cannot create unbounded work.
- Provider-outage resume creation preserves every grounded sparse entry for review while keeping
  factual, contact, grounding, selection, and PDF safety checks as hard requirements.
- Managed application email receiving proofs now renew through append-only signed delivery events
  before the seven-day health window expires.
- Managed receiving canaries use a PostgreSQL-compatible legacy-proof timestamp bound, preventing
  production inbound webhooks from failing before a fresh proof can be stored.
- Workable submissions can retain and promote exact same-job receipt evidence across the public
  short-link redirect and the delayed no-click continuation.

## [1.1.0] - 2026-08-02

### Added

- Resume uploads now identify the newest or user-selected high-value experience and assess its
  bullets for an action, subject, metric or scope, and outcome.
- Applicants can enrich that experience with missing facts or explicitly continue with the
  evidence Litos found, with accepted bullets appended to the matched experience-bank entry.

### Changed

- Base and tailored resumes always lead with the selected recent experience and normally print
  exactly three grounded bullets for every included experience.
- Sparse secondary experiences are omitted instead of weakening the three-bullet contract, while
  an explicitly continued recent experience remains eligible with its available evidence.

### Fixed

- One-page fitting preserves the selected recent experience while reducing lower-priority entries.
- Resume generation no longer repeats a metric follow-up already handled during onboarding.

## [1.0.7] - 2026-08-01

### Changed

- Resume parsing now returns five ordered, distinct target-role suggestions based on dated work
  experience, past titles, projects, skills, and supported seniority.
- Onboarding now requires a usable resume before job focus and recognizes the new title and role
  type selections for both new and existing accounts.

### Fixed

- Model role suggestions are normalized, deduplicated, bounded, and safely filled without
  rejecting an otherwise valid resume parse.
- Live job-board logo coverage is enforced at a minimum of 75%, and configuration can only raise
  that threshold rather than weakening it.

## [1.0.6] - 2026-07-31

### Added

- Every monitor result reports both raw job postings and distinct roles grouped by employer,
  title, and ATS family.
- The board now enforces independent 10,000-posting and 10,000-grouped-role hard floors.
- Monitoring reports job-family and employer-industry breadth, classification coverage, and
  aggregate zero-result coverage for user-entered target roles without copying literal role text.

### Changed

- Eligible postings remain discoverable for 14 days.
- Grouped-role inventory warns below 11,000, while posting inventory continues to warn below
  12,000.
- Polling selects at most 400 oldest sources per invocation and drains later segments through
  bounded follow-up passes that share a run watermark, so a 401-source catalog completes on pass two.

## [1.0.5] - 2026-07-31

### Added

- Litos can ingest and automatically apply to eligible Workable postings.
- Operators can measure job-board variety across role families, industries, locations,
  employment types, ATS providers, remote status, and employer concentration.

### Changed

- Scheduled polling can safely process up to 800 sources across five bounded passes.
- Inventory monitoring now enforces floors of 10,000 surfaced jobs and 5,000 sponsor-eligible
  jobs, with an early warning below 12,000 total jobs.

### Fixed

- Overlapping monitor runs are excluded with a connection-bound database lock.
- Polling source failures, unsafe Workable application URLs, and incomplete polling passes now
  fail visibly instead of producing a misleading healthy result.

## [1.0.4] - 2026-07-31

### Performance

- Concurrent requests carrying the same session token now share one verification lookup while it is
  in flight, reducing duplicate database reads without caching settled authentication results.

## [1.0.3] - 2026-07-26

### Changed

- Pro and trial plans now allow up to 1,000 resume generations per month.
- Quota responses and account usage report the same 1,000-resume limit.
- Verified users can create, change, recover, and use a password while keeping Google and email-code sign-in available.
- Password updates rotate all existing sessions and require either the current password or a fresh verified identity session.

### Fixed

- Concurrent resume requests atomically reserve quota so the monthly cap cannot be exceeded.
- Password credentials are protected with Argon2id, generic login failures, and layered per-IP and per-account rate limits.

## [1.0.2] - 2026-07-25

### Added

- Applicants can grant and revoke versioned standing consent for automatic application submission.
- Safe applications can proceed directly from portal preparation to verified submission, with authorization and receipt evidence recorded on the application.
- Connected Gmail or Outlook accounts can supply tightly scoped application verification codes when separately authorized.

### Changed

- Grounded open-ended answers no longer require a separate review when standing submission consent is active.
- Missing facts, contradictions, sensitive questions, CAPTCHA, unsupported portal behavior, and uncertain confirmations pause the flow for human attention.

### Fixed

- Final submission rechecks standing consent and uses an atomic claim so concurrent runners cannot click the employer submit control twice.
