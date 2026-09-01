import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { withLeadFallbackNote } from './resume';
import type { LeadFallbackDecision } from '../engine/leadAlignment';

const FALLBACK: LeadFallbackDecision = {
  entry_org: 'Tonee - AI Texting Tone Detector',
  jd_overlap_terms: ['design', 'requirement'],
  reason: 'Led with Tonee - AI Texting Tone Detector: it is your most recent experience.',
};

test('the fallback note is added when there is one and left alone when there is not', () => {
  assert.deepEqual(withLeadFallbackNote([], null), []);
  const added = withLeadFallbackNote([], FALLBACK);
  assert.equal(added.length, 1);
  assert.equal(added[0]?.entry, FALLBACK.entry_org);
  assert.deepEqual(added[0]?.flags, [FALLBACK.reason]);
});

test('applying it twice does not show the student the same sentence twice', () => {
  /* It is applied at the decision point AND again after the post-fit validation replaces the
     array, so re-application on an array that already carries it must be a no-op. */
  const once = withLeadFallbackNote([], FALLBACK);
  const twice = withLeadFallbackNote(once, FALLBACK);
  assert.deepEqual(twice, once);
});

test('it preserves the warnings it is merged into', () => {
  const existing = [{ entry: 'ats', bullet: '', flags: ['low-keyword-coverage(10% < 18%)'] }];
  const merged = withLeadFallbackNote(existing, FALLBACK);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], existing[0]);
});

test('the post-fit validation overwrite re-applies the note rather than dropping it', () => {
  /* THE BUG THIS FILE EXISTS FOR, pinned against the source because the assignment and the note
     are three hundred lines apart and the failure is silent: the build returns 200 and simply
     never explains itself. Measured live 2026-09-01 on an EQT Corporation midstream-engineering
     posting, where the lead was ordered correctly and the explanation was discarded here. */
  const source = fs.readFileSync(path.join(__dirname, 'resume.ts'), 'utf8');
  const assign = source.indexOf('specWarnings = withLeadFallbackNote(finalSpecValidation.warnings, leadFallback)');
  assert.ok(assign > 0, 'the post-fit assignment must route through withLeadFallbackNote');
  assert.equal(
    source.includes('specWarnings = finalSpecValidation.warnings;'),
    false,
    'a bare assignment here silently drops the lead-fallback note',
  );
});
