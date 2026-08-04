import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuild, resolveRevision } from './buildInfo';

/**
 * The health endpoint's answer to "which commit is serving this request", which DEPLOY.md tells you
 * to compare against the merge commit after every deploy.
 *
 * These are pinned because the field is a VERIFICATION step: a check that silently returns null is
 * worse than no check, since it looks like it ran. The 2026-08-04 incident is in buildInfo.ts.
 */
describe('resolveRevision', () => {
  test('the GitHub integration path answers, and says so', () => {
    const r = resolveRevision({ VERCEL_GIT_COMMIT_SHA: 'cf071b61' } as NodeJS.ProcessEnv);
    assert.equal(r.revision, 'cf071b61');
    assert.equal(r.revision_source, 'vercel-git');
  });

  test('a CLI deploy that passed GIT_SHA answers, and is distinguishable from the git path', () => {
    const r = resolveRevision({ GIT_SHA: '7ccc4363' } as NodeJS.ProcessEnv);
    assert.equal(r.revision, '7ccc4363');
    assert.equal(r.revision_source, 'git-sha');
  });

  test('a bare vercel --prod reports none, not a bare null', () => {
    // THE CASE THIS MODULE EXISTS FOR. `revision: null` on its own cannot distinguish "nobody
    // passed a SHA" from "this field is broken", and those need different responses. 'none' says
    // which, and sends the reader to `build`.
    const r = resolveRevision({} as NodeJS.ProcessEnv);
    assert.equal(r.revision, null);
    assert.equal(r.revision_source, 'none');
  });

  test('Vercel wins over GIT_SHA when both are set', () => {
    // GIT_SHA is passed by a shell script from whatever checkout it ran in; the platform's value
    // cannot have been typed wrong or gone stale.
    const r = resolveRevision({
      VERCEL_GIT_COMMIT_SHA: 'from-vercel',
      GIT_SHA: 'from-script',
    } as NodeJS.ProcessEnv);
    assert.equal(r.revision, 'from-vercel');
    assert.equal(r.revision_source, 'vercel-git');
  });

  test('an empty or whitespace value is absent, not an answer', () => {
    // `vercel -e GIT_SHA=` on a deploy with no git available sets the variable to the empty string.
    // The old inline `a || b || null` treated that correctly by luck for '', and would have
    // returned a single space as a revision. Both must read as absent.
    for (const blank of ['', '   ', '\n']) {
      const onlyVercel = resolveRevision({ VERCEL_GIT_COMMIT_SHA: blank } as NodeJS.ProcessEnv);
      assert.equal(onlyVercel.revision_source, 'none', `VERCEL_GIT_COMMIT_SHA=${JSON.stringify(blank)}`);

      // ...and a blank platform value must not mask a good GIT_SHA underneath it.
      const both = resolveRevision({
        VERCEL_GIT_COMMIT_SHA: blank,
        GIT_SHA: 'real-sha',
      } as NodeJS.ProcessEnv);
      assert.equal(both.revision, 'real-sha');
      assert.equal(both.revision_source, 'git-sha');
    }
  });

  test('the value is trimmed, so it compares equal to git rev-parse output', () => {
    // The whole point is `revision === $(git rev-parse origin/main)`. A trailing newline picked up
    // from a shell substitution would fail that comparison while looking identical when printed.
    assert.equal(resolveRevision({ GIT_SHA: '7ccc4363\n' } as NodeJS.ProcessEnv).revision, '7ccc4363');
  });
});

describe('resolveBuild', () => {
  test('prefers the deployment id, which every Vercel surface keys on', () => {
    const env = { VERCEL_DEPLOYMENT_ID: 'dpl_abc', VERCEL_URL: 'x.vercel.app' } as NodeJS.ProcessEnv;
    assert.equal(resolveBuild(env), 'dpl_abc');
  });

  test('falls back to the URL, which is set on every deployment that has ever existed', () => {
    assert.equal(resolveBuild({ VERCEL_URL: 'x.vercel.app' } as NodeJS.ProcessEnv), 'x.vercel.app');
  });

  test('is null locally, where there is no deployment', () => {
    assert.equal(resolveBuild({} as NodeJS.ProcessEnv), null);
  });
});

describe('the two fields together answer the runbook question', () => {
  test('there is always at least one handle on what is deployed', () => {
    // A deployment can lack git metadata entirely, but it cannot lack an identity. Whatever the
    // deploy path, /health must hand back something that resolves to a commit, either directly or
    // through `vercel inspect <build>`.
    const bare = { VERCEL_DEPLOYMENT_ID: 'dpl_xyz' } as NodeJS.ProcessEnv;
    const { revision, revision_source } = resolveRevision(bare);
    assert.equal(revision, null);
    assert.equal(revision_source, 'none');
    assert.ok(resolveBuild(bare), 'the deployment id is the handle when the SHA is missing');
  });
});
