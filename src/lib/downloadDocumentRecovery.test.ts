import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  immutableDocumentContentHash,
  recoverOwnedGeneratedDocument,
  sourceFromImmutableVersion,
  type OwnedDownloadSource,
} from './downloadDocumentRecovery';

describe('expired generated-document download recovery', () => {
  test('re-renders an owned frozen resume without a model call or current-profile read', async () => {
    const calls: Array<{ userId: string; objectKey: string }> = [];
    const source: OwnedDownloadSource = {
      kind: 'resume',
      inputs: { spec: { school: 'Example' }, jdText: 'Frozen JD', role: 'Engineer' },
    };
    const result = await recoverOwnedGeneratedDocument({
      userId: '7e8de6fb-236b-4e9b-863a-7b4f2952e1a7',
      objectKey: 'users/7e8de6fb-236b-4e9b-863a-7b4f2952e1a7/resumes/expired.pdf',
      findSource: async (userId, objectKey) => {
        calls.push({ userId, objectKey });
        return source;
      },
      renderResume: async (inputs) => {
        assert.deepEqual(inputs, source.inputs);
        return Buffer.from('same frozen resume content');
      },
    });
    assert.equal(result.status, 'rendered');
    if (result.status === 'rendered') assert.equal(result.buffer.toString(), 'same frozen resume content');
    assert.deepEqual(calls, [{
      userId: '7e8de6fb-236b-4e9b-863a-7b4f2952e1a7',
      objectKey: 'users/7e8de6fb-236b-4e9b-863a-7b4f2952e1a7/resumes/expired.pdf',
    }]);
  });

  test('re-renders a saved cover letter with its frozen generated date', async () => {
    const inputs = {
      fullName: 'Ada Lovelace',
      email: 'ada@example.test',
      company: 'Analytical Engines',
      body: 'Frozen letter body',
      generatedAt: '2026-07-01T00:00:00.000Z',
    };
    const result = await recoverOwnedGeneratedDocument({
      userId: 'owner',
      objectKey: 'users/owner/resumes/expired-cover.pdf',
      findSource: async () => ({ kind: 'cover_letter', inputs }),
      renderCoverLetter: async (received) => {
        assert.deepEqual(received, inputs);
        return Buffer.from('same frozen cover letter content');
      },
    });
    assert.equal(result.status, 'rendered');
    if (result.status === 'rendered') assert.equal(result.kind, 'cover_letter');
  });

  test('uses 404 only when no owned immutable source exists and distinguishes unsafe rerenders', async () => {
    assert.deepEqual(await recoverOwnedGeneratedDocument({
      userId: 'owner',
      objectKey: 'users/owner/resumes/missing.pdf',
      findSource: async () => null,
    }), { status: 'not_found' });
    assert.deepEqual(await recoverOwnedGeneratedDocument({
      userId: 'owner',
      objectKey: 'users/owner/resumes/unsafe.pdf',
      findSource: async () => ({ kind: 'resume', inputs: { spec: {}, jdText: '' } }),
      renderResume: async () => { throw new Error('unsafe frozen document'); },
    }), { status: 'unrecoverable' });
  });

  test('recovery uses the immutable version after the current generated record is mutated', () => {
    const frozen = {
      summary: 'Original retained summary',
      _review: { jd_text: 'Original retained JD', role: 'Original role' },
    };
    const mutableCurrentRecord = {
      summary: 'Later mutable summary',
      _review: { jd_text: 'Later mutable JD', role: 'Different role' },
    };
    const source = sourceFromImmutableVersion({
      kind: 'tailored_resume',
      structured_content: frozen,
      content_hash: immutableDocumentContentHash(frozen),
      job_context: { role: 'Frozen fallback role' },
    });
    assert.equal(source.kind, 'resume');
    if (source.kind === 'resume') {
      assert.deepEqual(source.inputs.spec, frozen);
      assert.notDeepEqual(source.inputs.spec, mutableCurrentRecord);
      assert.equal(source.inputs.jdText, 'Original retained JD');
    }
  });

  test('fails closed when immutable structured content no longer matches its hash', async () => {
    const original = { summary: 'Original retained summary' };
    const tampered = { summary: 'Mutated after hashing' };
    assert.throws(() => sourceFromImmutableVersion({
      kind: 'resume',
      structured_content: tampered,
      content_hash: immutableDocumentContentHash(original),
      job_context: { role: 'Engineer' },
    }), /immutable content binding/);
    assert.deepEqual(await recoverOwnedGeneratedDocument({
      userId: 'owner',
      objectKey: 'users/owner/resumes/hash-mismatch.pdf',
      findSource: async () => sourceFromImmutableVersion({
        kind: 'resume',
        structured_content: tampered,
        content_hash: immutableDocumentContentHash(original),
        job_context: { role: 'Engineer' },
      }),
    }), { status: 'unrecoverable' });
  });

  test('content binding survives a jsonb round trip that reorders object keys', () => {
    const beforeRoundTrip = {
      zeta: 3,
      alpha: { second: 2, first: 1 },
      _review: { role: 'Engineer', jd_text: 'Frozen JD text' },
    };
    const afterRoundTrip = {
      _review: { jd_text: 'Frozen JD text', role: 'Engineer' },
      alpha: { first: 1, second: 2 },
      zeta: 3,
    };
    assert.equal(
      immutableDocumentContentHash(beforeRoundTrip),
      immutableDocumentContentHash(afterRoundTrip),
    );
    const source = sourceFromImmutableVersion({
      kind: 'resume',
      structured_content: afterRoundTrip,
      content_hash: immutableDocumentContentHash(beforeRoundTrip),
      job_context: { role: 'Engineer' },
    });
    assert.equal(source.kind, 'resume');
  });

  test('download route verifies the capability before exact owner lookup and only recovers confirmed misses', () => {
    const route = readFileSync('src/routes/resume.ts', 'utf8');
    const handler = route.slice(
      route.indexOf("fastify.get('/resume/download'"),
      route.indexOf("fastify.post('/autofill/event'"),
    );
    assert.ok(handler.indexOf('readDownloadToken(token)') < handler.indexOf('recoverOwnedGeneratedDocument'));
    assert.ok(handler.indexOf('storageConfirmedMissing') < handler.indexOf('recoverOwnedGeneratedDocument'));
    assert.match(handler, /recoverOwnedGeneratedDocument\(\{ userId: payload\.u, objectKey: payload\.k \}\)/);
    assert.match(handler, /recovery\.status === 'not_found'[\s\S]*?status\(404\)/);
    assert.match(handler, /recovery\.status === 'unrecoverable'[\s\S]*?status\(409\)/);

    const finder = readFileSync('src/lib/downloadDocumentRecovery.ts', 'utf8');
    assert.match(finder, /from\(artifact_versions\)\.innerJoin\(artifacts/);
    assert.match(finder, /eq\(artifacts\.user_id, userId\)[\s\S]*?eq\(artifact_versions\.rendered_object_key, objectKey\)/);
    assert.doesNotMatch(finder, /generated_resumes\.spec|artifacts\.structured_content/);
    assert.match(finder, /immutableDocumentContentHash\(version\.structured_content\) !== version\.content_hash/);
  });
});
