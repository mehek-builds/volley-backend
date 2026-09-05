# Automatic outcome recovery

Unknown managed submissions are checked by the existing submission worker and by an authenticated dashboard status read. The check uses the original immutable attempt, never a fresh application. A database lease prevents concurrent workers from checking the same attempt. Three checks use persisted backoff; a crashed lease expires after five minutes.

Recovery reads the retained initial result and the exact receipt-observation execution. If the original continuation is still available, it can observe that same page with an empty action list. The shared acceptance validator owns the verdict. The additional held-page path covers Lever, Recruitee, Teamtailor, Breezy, Pinpoint, Personio and Crelate; Ashby, Greenhouse and Workable retain their stricter identity readers. Unknown, unrelated and conditional receipts cannot become a confirmation.

Terminal cleanup preserves unresolved result artifacts until recovery finishes, with a two-hour maximum. Explicit account-deletion cleanup bypasses that retention window. Confirmation persists before cleanup, and a concurrent confirmation outranks the recovery finalizer. Recovery metadata never releases the duplicate lock, changes applicant answers or authorizes another submission.

An expired session, missing result or employer verification barrier can still prevent an answer. Those applications remain unverified after bounded recovery. Existing confirmation-email reconciliation can resolve them later under its own evidence checks. This feature does not resurrect an expired employer login, bypass a human challenge, or infer rejection from the absence of confirmation.

The dashboard displays automatic recovery status instead of asking the applicant to inspect an external page or attest to its result. Backend deployment must precede the matching website deployment. No database migration or new service secret is required; the existing scheduled submission runner must be enabled.
