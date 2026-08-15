import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeEmailForUpload, resumeEmailOfRecord, resumePacketEmailIsCurrent } from './resumeEmail';

/* THE INCIDENT THESE PIN, 2026-08-16.
 *
 * Nothing wrote `resume_email`, so 16 of 17 production profiles had none, so the base resume's ATS
 * gate refused to save a resume for almost every account with "Add a personal resume email to your
 * profile before generating this resume" - pointing at a text box in Documents that onboarding
 * never mentions, while the student looked at a preview with their own address printed on it. */

test('an upload seeds the address from the verified login email', () => {
  assert.equal(
    resumeEmailForUpload({ full_name: 'Mehek Mandal' }, 'mehekman@usc.edu'),
    'mehekman@usc.edu',
    'a new account must not be left with no address an employer can reply to',
  );
});

test('an address the student typed survives their next upload', () => {
  // parsed_json is replaced WHOLESALE by each upload, so without this the student's own value is
  // destroyed by a re-upload and the account silently falls back to its login email.
  assert.equal(
    resumeEmailForUpload({ resume_email: 'hire.me@personal.com' }, 'mehekman@usc.edu'),
    'hire.me@personal.com',
  );
});

test('the login email is normalised, so casing cannot fork the address of record', () => {
  // packetAudit compares stored against current by exact string, so " Mehek@USC.edu " and
  // "mehek@usc.edu" reading as different values would flag a real packet as stale.
  assert.equal(resumeEmailForUpload({}, '  Mehek@USC.edu  '), 'mehek@usc.edu');
});

test('a guest with no login email gets nothing rather than a fabricated address', () => {
  assert.equal(resumeEmailForUpload({}, undefined), undefined);
  assert.equal(resumeEmailForUpload({}, ''), undefined);
  assert.equal(resumeEmailForUpload(null, '   '), undefined);
});

test('a malformed address is not stored as if it were one', () => {
  assert.equal(resumeEmailForUpload({}, 'not-an-email'), undefined);
  assert.equal(resumeEmailForUpload({ resume_email: 'also not one' }, 'mehekman@usc.edu'), 'mehekman@usc.edu');
});

test('resumeEmailOfRecord still reads only the stored field', () => {
  // Unchanged on purpose. The application-resume path documents that neither login identity nor a
  // portal alias may become the PDF email, so the fallback belongs at the upload, where the value
  // becomes visible and editable, and NOT inside this reader.
  assert.equal(resumeEmailOfRecord({ resume_email: 'a@b.com' }), 'a@b.com');
  assert.equal(resumeEmailOfRecord({}, 'account@example.com'), undefined);
  assert.equal(resumeEmailOfRecord(undefined), undefined);
  assert.equal(resumeEmailOfRecord([{ resume_email: 'a@b.com' }]), undefined, 'an array is not a profile');
});

test('packet freshness still compares exact stored addresses', () => {
  assert.equal(resumePacketEmailIsCurrent('a@b.com', 'a@b.com'), true);
  assert.equal(resumePacketEmailIsCurrent('a@b.com', 'c@d.com'), false);
  assert.equal(resumePacketEmailIsCurrent(undefined, 'a@b.com'), false);
});
