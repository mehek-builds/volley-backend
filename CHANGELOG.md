# Changelog

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
