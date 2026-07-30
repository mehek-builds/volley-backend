# Changelog

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
