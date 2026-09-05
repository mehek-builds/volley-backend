/* THE DOCUMENT TUPLE, CHECK BY CHECK.
 *
 * Bear Robotics b822b998, 2026-09-05: parked with the employer's receipt in hand and one label -
 * document_tuple_incomplete - for some twenty conditions. These tests drive generatedDocumentChecks
 * with hand-built rows shaped like Bear's canonical application, its resume link, artifact and
 * version, and show that each condition is named on its own. The published reasons are untouched;
 * only a caller that asks to explain sees the names.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe } from 'node:test';
import type { application_artifacts, applications, artifact_versions, artifacts, generated_resumes } from '../db/schema';
import { generatedDocumentChecks } from './authoritativeSubmissionProjection';
import { immutableDocumentContentHash } from './immutableDocumentHash';
import type { SubmissionAttemptEventRecord } from './submissionAttemptLedger';

type ApplicationRow = typeof applications.$inferSelect;
type PacketRow = typeof generated_resumes.$inferSelect;
type ArtifactRow = typeof artifacts.$inferSelect;
type ArtifactVersionRow = typeof artifact_versions.$inferSelect;
type LinkRow = typeof application_artifacts.$inferSelect;

const PACKET_ID = 'b822b998-be14-452e-9e09-e5a7e48cbc97';
const APPLICATION_ID = '4c791631-0a5e-4a9a-9d8e-2b7f3c1d9e11';
const ARTIFACT_ID = '8c5ca4ce-1111-4222-8333-444455556666';
const ATTACHED_AT = new Date('2026-09-04T21:21:01.871Z');
const RENDERED_KEY = 'resumes/b822b998/render-7.pdf';
const STRUCTURED = { name: 'Mehek Mandal', sections: ['education', 'projects'] };

function application(over: Partial<ApplicationRow> = {}): ApplicationRow {
  return {
    id: APPLICATION_ID,
    legacy_generated_resume_id: PACKET_ID,
    selected_resume_artifact_id: ARTIFACT_ID,
    resume_attached: true,
    resume_source: 'artifact',
    resume_attached_at: ATTACHED_AT,
    ...over,
  } as unknown as ApplicationRow;
}

function packet(over: Partial<PacketRow> = {}): PacketRow {
  return {
    id: PACKET_ID,
    resume_object_key: RENDERED_KEY,
    spec: { _review: { status: 'needs_attention', questions: [], updated_at: '2026-09-05T01:50:46.546Z' } },
    ...over,
  } as unknown as PacketRow;
}

function artifact(over: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: ARTIFACT_ID,
    legacy_generated_resume_id: PACKET_ID,
    rendered_object_key: RENDERED_KEY,
    deleted_at: null,
    ...over,
  } as unknown as ArtifactRow;
}

function version(over: Partial<ArtifactVersionRow> = {}): ArtifactVersionRow {
  return {
    id: 'v1',
    artifact_id: ARTIFACT_ID,
    rendered_object_key: RENDERED_KEY,
    structured_content: STRUCTURED,
    content_hash: immutableDocumentContentHash(STRUCTURED),
    ...over,
  } as unknown as ArtifactVersionRow;
}

function link(over: Partial<LinkRow> = {}): LinkRow {
  return {
    application_id: APPLICATION_ID,
    artifact_id: ARTIFACT_ID,
    purpose: 'resume',
    selected: true,
    attachment_result: null,
    attached_at: ATTACHED_AT,
    created_at: ATTACHED_AT,
    ...over,
  } as unknown as LinkRow;
}

function opening(over: Partial<SubmissionAttemptEventRecord> = {}): SubmissionAttemptEventRecord {
  return {
    attempt_id: '28f6cd3b-13bc-41c5-ac57-76fa2ef46a2b',
    user_id: 'cf48e921-8543-466c-b51f-1598fd723235',
    packet_id: PACKET_ID,
    application_id: APPLICATION_ID,
    event_kind: 'attempt_opened',
    packet_version: 'f'.repeat(64),
    ...over,
  } as unknown as SubmissionAttemptEventRecord;
}

function context(input: { artifacts?: ArtifactRow[]; versions?: ArtifactVersionRow[]; links?: LinkRow[] } = {}) {
  const artifactRows = input.artifacts ?? [artifact()];
  const versionRows = input.versions ?? [version()];
  const linkRows = input.links ?? [link()];
  const artifactVersionsByArtifactId = new Map<string, ArtifactVersionRow[]>();
  for (const row of versionRows) {
    artifactVersionsByArtifactId.set(row.artifact_id, [...(artifactVersionsByArtifactId.get(row.artifact_id) ?? []), row]);
  }
  const linksByApplicationId = new Map<string, LinkRow[]>();
  for (const row of linkRows) {
    linksByApplicationId.set(row.application_id, [...(linksByApplicationId.get(row.application_id) ?? []), row]);
  }
  return {
    artifactsById: new Map(artifactRows.map((row) => [row.id, row])),
    artifactVersionsByArtifactId,
    linksByApplicationId,
  };
}

describe('the document tuple is named check by check', () => {
  test('a coherent linkage names nothing on the linkage side', () => {
    const checks = generatedDocumentChecks(context(), application(), packet(), opening());
    assert.deepEqual(checks.linkage, []);
  });

  test('a re-link that restamped the application but not the link is named with both clocks', () => {
    const restamped = new Date('2026-09-05T01:48:31.908Z');
    const checks = generatedDocumentChecks(context(), application({ resume_attached_at: restamped }), packet(), opening());
    assert.deepEqual(checks.linkage, [
      `link.attached_at!=application.resume_attached_at(${ATTACHED_AT.toISOString()}!=${restamped.toISOString()})`,
    ]);
  });

  test('two rendered versions for one object key, and a stale content hash, are counted', () => {
    const twice = context({ versions: [version(), version({ id: 'v2' })] });
    assert.deepEqual(generatedDocumentChecks(twice, application(), packet(), opening()).linkage, ['exact_rendered_versions=2(of 2)']);
    const stale = context({ versions: [version({ content_hash: 'not-the-content' })] });
    assert.deepEqual(generatedDocumentChecks(stale, application(), packet(), opening()).linkage, ['exact_rendered_versions=0(of 1)']);
  });

  test('a missing or doubled resume link, and an application pointing elsewhere, each say so', () => {
    const none = generatedDocumentChecks(context({ links: [] }), application(), packet(), opening());
    assert.deepEqual(none.linkage, [
      'linked_resume_artifacts=0',
      'links_to_exact_artifact=0',
      'application.selected_resume_artifact_id!=linked_artifact',
      'link.attached_at=null',
      'artifact.rendered_object_key!=packet.resume_object_key',
      'exact_rendered_versions=0(of 0)',
    ]);
    const other = generatedDocumentChecks(
      context(),
      application({ selected_resume_artifact_id: 'someone-else', resume_source: 'base_resume', resume_attached: false }),
      packet(),
      opening(),
    );
    assert.deepEqual(other.linkage, [
      'application.selected_resume_artifact_id!=linked_artifact',
      'application.resume_attached=false',
      'application.resume_source=base_resume',
    ]);
  });

  test('the audit side names what the opening and the audit disagree on', () => {
    const checks = generatedDocumentChecks(context(), application(), packet(), opening({ packet_version: null }));
    assert.deepEqual(checks.audit, [
      'packet_audit:not_submission_ready',
      'opening.packet_version=null',
      'exact_version.pdfGenerationBinding=missing',
    ]);
  });

  test('the classifier explains only when asked, and the read passes the names on', async () => {
    const source = await readFile('src/lib/authoritativeSubmissionProjection.ts', 'utf8');
    assert.match(source, /if \(context\.explain && reasons\.includes\('document_tuple_incomplete'\)\) \{/);
    assert.match(source, /const explanations: string\[\] \| undefined = input\.explain \? \[\] : undefined;/);
    const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
    assert.match(runner, /applicationIds: \[canonical\.id\],\s*explain: true,/);
    const routes = await readFile('src/routes/applications.ts', 'utf8');
    assert.match(routes, /projection_repair_details: parkedRepair\.details/);
  });
});
