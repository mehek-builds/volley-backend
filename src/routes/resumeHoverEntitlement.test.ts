import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { featuresForAccess } from '../lib/entitlements';
import { resumeGenerationFeatureSequence } from './resumeRequestSchema';

function canInitiate(
  accessClass: Parameters<typeof featuresForAccess>[0]['accessClass'],
  initiation: 'explicit_click' | 'hover_prewarm',
): boolean {
  const features = featuresForAccess({ accessClass });
  return resumeGenerationFeatureSequence(initiation).every((feature) => features[feature]);
}

test('trial tailoring stays click-only while both paid classes can initiate hover generation', () => {
  assert.equal(canInitiate('trial_plus', 'explicit_click'), true);
  assert.equal(canInitiate('trial_plus', 'hover_prewarm'), false);
  assert.equal(canInitiate('plus_paid', 'hover_prewarm'), true);
  assert.equal(canInitiate('legacy_paid', 'hover_prewarm'), true);
});

test('hover entitlement is checked before posting work, reservation, or generation', () => {
  const source = readFileSync('src/routes/resume.ts', 'utf8');
  const gate = source.indexOf('for (const feature of resumeGenerationFeatureSequence(body.initiation))');
  const postingRead = source.indexOf('resolvedPosting = await actionPostingRowForUser(effectiveJobId, userId)');
  const reservation = source.indexOf('const entitlementReservation = await reserveEntitledUsage');
  const generation = source.indexOf('await generateResumeSpec');
  assert.ok(gate >= 0);
  assert.ok(postingRead > gate);
  assert.ok(reservation > gate);
  assert.ok(generation > gate);
});
