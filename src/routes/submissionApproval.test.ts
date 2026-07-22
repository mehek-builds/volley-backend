import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('portal preparation and final employer submission remain separate backend actions', async () => {
  const applications = await readFile(new URL('./applications.ts', import.meta.url), 'utf8');
  const runner = await readFile(new URL('./submissionRunner.ts', import.meta.url), 'utf8');

  assert.match(applications, /Preparation endpoint only/);
  assert.match(applications, /status: 'submit_requested'/);
  assert.match(applications, /current\.status !== 'ready_for_final_approval'/);
  assert.match(applications, /final_approved_at: now/);
  assert.match(applications, /single user approval gate for the employer's final submit action/);
  assert.match(runner, /review\?\.status === 'submit_requested'\) await prepare/);
  assert.match(runner, /review\?\.status === 'submitting'\) await submit/);
});
