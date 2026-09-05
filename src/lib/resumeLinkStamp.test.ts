/* THE LINK CARRIES THE CLOCK THE APPLICATION CARRIES.
 *
 * Bear Robotics b822b998, 2026-09-05: Breezy's receipt bound (#967), and the parked read named the
 * one failing document check (#969): `link.attached_at=null`. The linker wrote the application's
 * four resume-linkage columns and the link's `selected` flag, and never the link's attached_at, so
 * every link it selected after the 2026-09-04 migration carried NULL where the projection wants the
 * application's clock. These pin the two writes that close that: the linker stamps the link it
 * selects, and the parked read completes an absent stamp before it re-projects.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe } from 'node:test';

describe('the selected resume link carries the application clock', () => {
  test('the linker stamps the link it selects, coalescing so a re-tailor is not a re-attach', async () => {
    const source = await readFile('src/lib/resumeArtifactVersions.ts', 'utf8');
    const linker = source.slice(
      source.indexOf('export async function linkGeneratedPacketToCanonicalApplication('),
      source.indexOf('export async function stampSelectedResumeLinkAttachedAt('),
    );
    const applicationWrite = linker.indexOf('...resumeLinkageColumns(');
    const selectedWrite = linker.indexOf('selected: true,');
    assert.ok(applicationWrite > 0 && selectedWrite > applicationWrite, 'the application is written first, then the link it selects');
    assert.match(
      linker,
      /selected: true,\s*attached_at: sql`coalesce\(\$\{application_artifacts\.attached_at\}, \$\{linked\.resume_attached_at \?\? new Date\(\)\}\)`,/,
      'the selected link takes the application clock only where it has none',
    );
  });

  test('completing an absent stamp copies the application clock and touches nothing that already has one', async () => {
    const source = await readFile('src/lib/resumeArtifactVersions.ts', 'utf8');
    const stamp = source.slice(source.indexOf('export async function stampSelectedResumeLinkAttachedAt('));
    assert.match(stamp, /application\.resume_source !== 'artifact'\) return false;/, 'only an artifact-backed application has a link to stamp');
    assert.match(stamp, /attached_at: application\.resume_attached_at,/);
    assert.match(stamp, /eq\(application_artifacts\.artifact_id, application\.selected_resume_artifact_id\),/);
    assert.match(stamp, /sql`\$\{application_artifacts\.attached_at\} is null`,/, 'an existing stamp, agreeing or not, is never overwritten');
  });

  test('the parked read completes the stamp before it re-projects', async () => {
    const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
    const repair = runner.slice(runner.indexOf('export async function repairParkedConfirmedProjection('));
    const body = repair.slice(0, repair.indexOf('\n}\n'));
    const stamp = body.indexOf('stampSelectedResumeLinkAttachedAt(db, { userId: row.user_id, applicationId: canonicalForPacket.id })');
    const commit = body.indexOf('await commitVerifiedSubmissionConfirmed(row, attemptBinding, {');
    assert.ok(stamp > 0 && commit > stamp, 'the stamp lands before the one commit that reads it');
    assert.match(body, /eq\(applications\.legacy_generated_resume_id, row\.id\),/, 'the canonical application is the packet’s own');
  });
});
