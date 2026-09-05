/* THE LINKAGE A SELECTED ARTIFACT IMPLIES, completed where it is absent.
 *
 * Fixtures are the two production rows this exists for: Bear Robotics b822b998 (application
 * complete, link stamp NULL) and Deepgram 8c6485c4 on 2026-09-05T04:48Z (selected artifact beside
 * resume_attached=false, resume_source=none, resume_attached_at=null, and an unstamped link). */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe } from 'node:test';
import { resumeLinkageCompletionPlan } from './resumeArtifactVersions';

const ARTIFACT = 'aca8552c-1111-4222-8333-444455556666';
const ATTACHED = new Date('2026-09-04T21:21:01.871Z');
const NOW = new Date('2026-09-05T04:50:00.000Z');

describe('the completion plan completes only what is absent', () => {
  test('Bear: a complete application beside an unstamped link stamps the link with the application clock', () => {
    const plan = resumeLinkageCompletionPlan({
      application: { selected_resume_artifact_id: ARTIFACT, resume_attached: true, resume_source: 'artifact', resume_attached_at: ATTACHED },
      artifactBelongsToPacket: true,
      link: { attached_at: null },
      now: NOW,
    });
    assert.deepEqual(plan, { applicationPatch: null, link: 'stamp', clock: ATTACHED });
  });

  test('Deepgram: the legacy tailor shape is completed on one clock, application and link together', () => {
    const plan = resumeLinkageCompletionPlan({
      application: { selected_resume_artifact_id: ARTIFACT, resume_attached: false, resume_source: 'none', resume_attached_at: null },
      artifactBelongsToPacket: true,
      link: { attached_at: null },
      now: NOW,
    });
    assert.deepEqual(plan, {
      applicationPatch: { resume_attached: true, resume_source: 'artifact', resume_attached_at: NOW },
      link: 'stamp',
      clock: NOW,
    });
  });

  test('a missing link is inserted; a link that already knows its clock lends it to the application', () => {
    assert.deepEqual(
      resumeLinkageCompletionPlan({
        application: { selected_resume_artifact_id: ARTIFACT, resume_attached: false, resume_source: 'none', resume_attached_at: null },
        artifactBelongsToPacket: true,
        link: null,
        now: NOW,
      }),
      { applicationPatch: { resume_attached: true, resume_source: 'artifact', resume_attached_at: NOW }, link: 'insert', clock: NOW },
    );
    assert.deepEqual(
      resumeLinkageCompletionPlan({
        application: { selected_resume_artifact_id: ARTIFACT, resume_attached: false, resume_source: 'none', resume_attached_at: null },
        artifactBelongsToPacket: true,
        link: { attached_at: ATTACHED },
        now: NOW,
      }),
      { applicationPatch: { resume_attached: true, resume_source: 'artifact', resume_attached_at: ATTACHED }, link: null, clock: ATTACHED },
    );
  });

  test('nothing is completed where nothing is absent, or where completing would assert something new', () => {
    const complete = { selected_resume_artifact_id: ARTIFACT, resume_attached: true, resume_source: 'artifact', resume_attached_at: ATTACHED };
    assert.equal(resumeLinkageCompletionPlan({ application: complete, artifactBelongsToPacket: true, link: { attached_at: ATTACHED }, now: NOW }), null, 'already whole');
    assert.equal(
      resumeLinkageCompletionPlan({ application: { ...complete, resume_attached_at: new Date('2026-09-05T01:48:31.908Z') }, artifactBelongsToPacket: true, link: { attached_at: ATTACHED }, now: NOW }),
      null,
      'two clocks that disagree are left for the projection to refuse, never rewritten',
    );
    assert.equal(resumeLinkageCompletionPlan({ application: { ...complete, selected_resume_artifact_id: null }, artifactBelongsToPacket: false, link: null, now: NOW }), null, 'no selected artifact, nothing implied');
    assert.equal(resumeLinkageCompletionPlan({ application: complete, artifactBelongsToPacket: false, link: { attached_at: null }, now: NOW }), null, 'an artifact that is not this packet’s own is never linked');
    assert.equal(
      resumeLinkageCompletionPlan({ application: { selected_resume_artifact_id: ARTIFACT, resume_attached: true, resume_source: 'base_resume', resume_attached_at: ATTACHED }, artifactBelongsToPacket: true, link: null, now: NOW }),
      null,
      'an application naming another source beside a selected artifact is a disagreement, not an absence',
    );
  });
});

describe('the parked read completes the linkage before it re-projects', () => {
  test('the runner calls the completion for the packet’s own canonical application, before the commit', async () => {
    const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
    const repair = runner.slice(runner.indexOf('export async function repairParkedConfirmedProjection('));
    const body = repair.slice(0, repair.indexOf('\n}\n'));
    const complete = body.indexOf('completeSelectedResumeLinkage(db, {');
    const commit = body.indexOf('await commitVerifiedSubmissionConfirmed(row, attemptBinding, {');
    assert.ok(complete > 0 && commit > complete);
    assert.match(body, /packetId: row\.id,\s*\}\);/);
    const linker = await readFile('src/lib/resumeArtifactVersions.ts', 'utf8');
    const applied = linker.slice(linker.indexOf('export async function completeSelectedResumeLinkage('));
    assert.match(applied, /eq\(artifacts\.legacy_generated_resume_id, input\.packetId\),/, 'the artifact must be the packet’s own');
    assert.match(applied, /sql`\$\{artifacts\.deleted_at\} is null`,/);
    assert.match(applied, /sql`\$\{application_artifacts\.attached_at\} is null`,/, 'a stamp lands only where none exists');
  });
});
