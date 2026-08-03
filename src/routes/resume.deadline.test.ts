import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RESUME_DEADLINE_FOR_TEST } from './resume';

/* The drift this file exists to prevent.
 *
 * REQUEST_DEADLINE_MS was the literal 55000, sized on 2026-07-17 for a maxDuration of 60. On
 * 2026-07-23 maxDuration went to 300 and the literal did not move. For eleven days /resume/generate
 * gave itself 46s of model budget out of an available 300 and answered
 * "Resume generation is taking too long" to any student whose first Claude call ran past 46s, which
 * a long JD plus the whole experience bank reliably does. baseResume.ts was updated for the new
 * ceiling; this route was missed. Nothing failed, because the coupling between the config and the
 * code existed only in a comment.
 *
 * These tests read vercel.json, so the next maxDuration change either updates the route or goes
 * red here. */

function vercelMaxDurationSeconds(): number {
  // __dirname, not import.meta: tsconfig compiles this package as commonjs.
  const config = JSON.parse(readFileSync(path.join(__dirname, '../../vercel.json'), 'utf8'));
  const seconds = config?.functions?.['api/index.ts']?.maxDuration;
  assert.equal(typeof seconds, 'number', 'vercel.json must declare functions["api/index.ts"].maxDuration');
  return seconds;
}

describe('resume generation request deadline', () => {
  test('tracks the maxDuration actually declared in vercel.json', () => {
    assert.equal(
      RESUME_DEADLINE_FOR_TEST.vercelMaxDurationMs,
      vercelMaxDurationSeconds() * 1000,
      'VERCEL_MAX_DURATION_MS in src/routes/resume.ts disagrees with vercel.json. Update the constant.',
    );
  });

  test('leaves the platform room to tear the function down', () => {
    const { vercelMaxDurationMs, requestDeadlineMs } = RESUME_DEADLINE_FOR_TEST;
    assert.ok(
      requestDeadlineMs < vercelMaxDurationMs,
      'the request deadline must land before Vercel kills the function, or a slow call 504s instead of returning a handled error',
    );
    // Enough margin to absorb cold start, which happens before reqStart is ever read.
    assert.ok(
      vercelMaxDurationMs - requestDeadlineMs >= 30_000,
      'leave at least 30s between the request deadline and the platform ceiling',
    );
  });

  test('leaves a usable model budget after the post-generation reserve', () => {
    const { requestDeadlineMs, postGenReserveMs } = RESUME_DEADLINE_FOR_TEST;
    const modelBudget = requestDeadlineMs - postGenReserveMs;
    // The failure that started this was a single Claude call on a 5,770-character JD running past
    // the whole 46s budget. One call needs materially more room than that, not marginally more.
    assert.ok(
      modelBudget >= 120_000,
      `model budget is ${Math.round(modelBudget / 1000)}s; a long JD plus the full experience bank needs at least 120s`,
    );
    assert.ok(postGenReserveMs > 0, 'render, parse, upload and audit inserts all happen after the last spec');
  });
});
