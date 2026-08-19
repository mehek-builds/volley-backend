import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DAILY_CAP,
  NOTIFICATION_KINDS,
  dailySlotFor,
  isNotificationKind,
  notificationPreferenceUpdate,
  notificationPreferencesFrom,
} from './notificationPreferences';

test('the kinds are a closed list, and it is the two questions screen 08 asks', () => {
  /* Pinned as a value rather than as a shape. The Guardrails ban streaks and daily-login rewards
     outright, and a notification subsystem is the machinery somebody reaches for to build one, so
     a third kind appearing here should read as a deliberate edit in a diff and not as a detail. */
  assert.deepEqual([...NOTIFICATION_KINDS], ['strong_match', 'employer_reply']);
  assert.equal(isNotificationKind('strong_match'), true);
  assert.equal(isNotificationKind('weekly_digest'), false);
  assert.equal(isNotificationKind(''), false);
});

test('one a day caps the match alert and deliberately does not cap an employer reply', () => {
  assert.equal(DAILY_CAP.strong_match, 1);
  assert.equal(DAILY_CAP.employer_reply, null, 'holding somebody mail because they already had an alert is not politeness');
});

test('the daily slot is a UTC day, and an uncapped kind reserves nothing', () => {
  const morning = new Date('2026-08-19T00:04:00.000Z');
  const night = new Date('2026-08-19T23:59:59.000Z');
  const next = new Date('2026-08-20T00:00:00.000Z');
  assert.equal(dailySlotFor('strong_match', morning), 'strong_match:2026-08-19');
  assert.equal(dailySlotFor('strong_match', night), 'strong_match:2026-08-19', 'the same UTC day is the same slot');
  assert.equal(dailySlotFor('strong_match', next), 'strong_match:2026-08-20');
  /* Null rather than a per-day string, and the null is what makes the unique index ignore this
     kind: Postgres never collides NULLs. An uncapped kind that wrote a slot would silently become
     capped. */
  assert.equal(dailySlotFor('employer_reply', morning), null);
});

test('absent columns read as nothing switched on', () => {
  // The state a database that has not run the migration is effectively in, and the state every
  // account is in until it turns something on. Anything else would blank screen 08 in the window.
  const preferences = notificationPreferencesFrom(undefined);
  assert.deepEqual(preferences, {
    strong_match: { enabled: false, granted_at: null },
    employer_reply: { enabled: false, granted_at: null },
  });
  assert.deepEqual(notificationPreferencesFrom({}), preferences);
});

test('a stored grant is reported with the date it was given', () => {
  const granted = new Date('2026-08-19T09:30:00.000Z');
  assert.deepEqual(
    notificationPreferencesFrom({
      notify_strong_match_enabled: true,
      notify_strong_match_granted_at: granted,
      notify_employer_reply_enabled: false,
      notify_employer_reply_granted_at: null,
    }),
    {
      strong_match: { enabled: true, granted_at: '2026-08-19T09:30:00.000Z' },
      employer_reply: { enabled: false, granted_at: null },
    },
  );
});

test('a grant stamps, a revoke clears, and an untouched permission is not written at all', () => {
  const at = new Date('2026-08-19T09:30:00.000Z');

  assert.deepEqual(notificationPreferenceUpdate({ strong_match: true }, at), {
    notify_strong_match_enabled: true,
    notify_strong_match_granted_at: at,
  });

  assert.deepEqual(notificationPreferenceUpdate({ strong_match: false }, at), {
    notify_strong_match_enabled: false,
    notify_strong_match_granted_at: null,
  });

  /* THE CASE THAT MATTERS. Saving screen 08 with only one toggle touched must not re-date the
     other permission's consent, and the only way to guarantee that is to write no key for it. An
     update that included `notify_employer_reply_granted_at: null` would silently erase a grant the
     student never touched. */
  const partial = notificationPreferenceUpdate({ strong_match: true }, at);
  assert.equal('notify_employer_reply_enabled' in partial, false);
  assert.equal('notify_employer_reply_granted_at' in partial, false);

  assert.deepEqual(notificationPreferenceUpdate({}, at), {}, 'a change set with nothing in it writes nothing');
});

test('re-granting re-dates the grant rather than preserving the first one', () => {
  // Somebody who turned an alert off in March and back on in June granted it in June. Back-dating
  // it would misreport when Litos was allowed to start mailing them.
  const june = new Date('2026-06-01T00:00:00.000Z');
  assert.deepEqual(notificationPreferenceUpdate({ employer_reply: true }, june), {
    notify_employer_reply_enabled: true,
    notify_employer_reply_granted_at: june,
  });
});
