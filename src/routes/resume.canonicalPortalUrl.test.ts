import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalApplicationPortalUrlFor } from './resume';

// Regression coverage for the null-portal_url canonical rows: 174 of 646 packet-linked canonical
// applications on Railway prod (measured 2026-09-04), 118 of them with a job_id, because
// canonicalApplicationPortalUrlFor's predecessor computed `undefined` for any packet built from a
// job id alone (no `application` in the request body - the shape an extension or job-board-driven
// generate takes). The submission runner derives its own landing URL from that same job id, so
// those rows carried no portal evidence to bind a landed run against and every send on them was
// refused at CANONICAL_PACKET_BINDING_MISSING. See canonicalPacketBinding.ts's own stand-in tier
// for the matcher-side half of this fix, which this data-side fix is meant to make unnecessary for
// every packet generated from here on.

const MONITORED_URL = 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=12345';
const JOB_ID = '28c9a160-ca0a-4cd3-9883-e93b98c9e3ed';

test('a job-id packet with no application in the body now records the monitored URL', () => {
  // This is the exact case that used to fall to `undefined`: a caller sent job_id and nothing
  // else, so `body.application` was never present.
  assert.equal(
    canonicalApplicationPortalUrlFor(JOB_ID, MONITORED_URL, undefined),
    MONITORED_URL,
  );
});

test('a no-job packet is untouched: no job id and no application still yields undefined', () => {
  assert.equal(canonicalApplicationPortalUrlFor(undefined, undefined, undefined), undefined);
});

test('a job-id packet ignores a caller-supplied application.portal_url entirely', () => {
  // Once a job id is in play, only the reconstructed monitored URL may reach a browser runner -
  // never the caller's own text, even when the caller also sent an `application` object naming a
  // different, plausible-looking portal URL for the same posting.
  assert.equal(
    canonicalApplicationPortalUrlFor(JOB_ID, MONITORED_URL, {
      portal_url: 'https://not-the-real-posting.example.com/apply',
      ats_name: 'greenhouse',
    }),
    MONITORED_URL,
  );
});

test('a job-id packet whose posting never resolved a monitored URL stays undefined rather than throwing', () => {
  // resume.ts itself never reaches this call with monitoredApplicationUrl undefined while
  // effectiveJobId is set - it replies 409 job_not_available first - but the function is a pure
  // passthrough for that pairing rather than assuming its caller's guard.
  assert.equal(canonicalApplicationPortalUrlFor(JOB_ID, undefined, undefined), undefined);
});

// ── Unchanged for rows that already carried a URL (no job id) ───────────────────────────────────

test('no job id, application present with a supported ATS: unchanged, canonicalizes the supported URL', () => {
  assert.equal(
    canonicalApplicationPortalUrlFor(undefined, undefined, {
      portal_url: 'https://boards.greenhouse.io/acme/jobs/12345',
      ats_name: 'greenhouse',
    }),
    'https://boards.greenhouse.io/embed/job_app?for=acme&token=12345',
  );
});

test('no job id, application present with an unsupported portal: unchanged, falls back to the raw URL', () => {
  const rawUrl = 'https://example.com/careers/apply/123';
  assert.equal(
    canonicalApplicationPortalUrlFor(undefined, undefined, { portal_url: rawUrl, ats_name: 'unknown_ats' }),
    rawUrl,
  );
});
