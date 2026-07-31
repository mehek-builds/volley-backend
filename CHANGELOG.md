# Changelog

## [1.0.6] - 2026-07-31

### Added

- Every monitor result reports both raw job postings and distinct roles grouped by employer,
  title, and ATS family.
- The board now enforces independent 10,000-posting and 10,000-grouped-role hard floors.

### Changed

- Eligible postings remain discoverable for 14 days.
- Grouped-role inventory warns below 11,000, while posting inventory continues to warn below
  12,000.

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
