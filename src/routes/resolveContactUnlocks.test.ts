import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const source = readFileSync('src/routes/resolve.ts', 'utf8');

describe('contact discovery ownership contract', () => {
  test('publishes the uncached result, contact ownership, and trial usage in one commit', () => {
    assert.match(source, /const selectedVerified = verifiedContacts\(results\)\.slice/);
    assert.match(source, /await commitContactUnlocks\(\{[\s\S]*?contactIds: selectedVerified\.map[\s\S]*?reservationId: reservation\.reservationId,[\s\S]*?cache: \{ key: cacheKey, results, source: contactSource \}/);
    assert.match(source, /units: selectedVerified\.length/);
    assert.match(source, /contactIds: selectedVerified\.map\(\(row\) => row\.contact\.id\)/);
    assert.match(source, /contacts: selectedVerified\.filter/);
  });

  test('a cached retry returns user-owned contacts before reserving new units', () => {
    const ownershipRead = source.indexOf('const previouslyUnlocked = await unlockedContactIds');
    const cacheReservation = source.indexOf('reservation = await reserveEntitledUsage', ownershipRead);
    assert.ok(ownershipRead >= 0);
    assert.ok(cacheReservation > ownershipRead);
    assert.match(source, /const existing = verified\.filter\(\(row\) => previouslyUnlocked\.has\(row\.contact\.id\)\)/);
    assert.match(source, /contacts: verified\.filter\(\(row\) => finalUnlocks\.has\(row\.contact\.id\)\)\.slice\(0, 2\)/);
  });

  test('does not use the generic trial commit on the resolve response path', () => {
    assert.doesNotMatch(source, /\bcommitEntitledUsage\b/);
  });
});
