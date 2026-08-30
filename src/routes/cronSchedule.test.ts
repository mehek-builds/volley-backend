import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const repositoryRoot = process.cwd();

function workflow(name: string): string {
  return fs.readFileSync(`${repositoryRoot}/.github/workflows/${name}`, 'utf8');
}

test('Vercel owns no scheduled job after the Railway migration', () => {
  const config = JSON.parse(fs.readFileSync(`${repositoryRoot}/vercel.json`, 'utf8')) as {
    crons?: unknown[];
  };
  assert.deepEqual(config.crons ?? [], []);
});

test('Railway maintenance workflow keeps every former daily Vercel task scheduled', () => {
  const source = workflow('railway-scheduled-maintenance.yml');
  for (const contract of [
    ["'30 3 * * *'", 'resume-retention-sweep'],
    ["'0 13 * * *'", 'adapter-health-check'],
    ["'30 13 * * *'", 'activity-digest'],
    ["'0 15 * * *'", 'managed-receiving-canary'],
  ] as const) {
    assert.match(source, new RegExp(contract[0].replaceAll('*', '\\*')));
    assert.match(source, new RegExp(`route='${contract[1]}'`));
  }
  assert.match(source, /vars\.LITOS_SCHEDULED_MAINTENANCE_ENABLED == 'true'/);
  assert.match(source, /vars\.LITOS_API_BASE/);
  assert.match(source, /secrets\.INTERNAL_CRON_SECRET/);
});

test('sub-daily API jobs remain owned by dedicated GitHub workflows', () => {
  for (const [file, route] of [
    ['autopilot-matcher.yml', '/internal/autopilot-matcher'],
    ['strong-match-notifications.yml', '/internal/strong-match-notifications'],
    ['submission-runner.yml', '/internal/application-submission-runner'],
  ] as const) {
    const source = workflow(file);
    assert.match(source, /schedule:/, `${file} must keep a schedule`);
    assert.match(source, new RegExp(route), `${file} must call ${route}`);
    assert.match(source, /vars\.LITOS_API_BASE/);
    assert.match(source, /secrets\.INTERNAL_CRON_SECRET/);
  }
});
