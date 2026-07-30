import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  composeDashboardBootstrap,
  type DashboardBootstrapResource,
} from './dashboardBootstrap';

describe('dashboard bootstrap projection', () => {
  test('returns all resources through one versioned contract', async () => {
    const values: Record<DashboardBootstrapResource, unknown> = {
      me: { email: 'me@example.com' },
      jobs: { jobs: [{ id: 'job-1' }] },
      targeting: { categories: ['software-engineering'] },
      profile: { full_name: 'Me' },
      resume_history: { resumes: [{ id: 'resume-1' }] },
      application_profile: { address_city: 'Dubai' },
      outreach: [{ id: 'outreach-1' }],
      onboarding: { automatic_submission_enabled: true },
    };

    const result = await composeDashboardBootstrap(async (resource) => values[resource]);

    assert.equal(result.schema_version, 1);
    assert.deepEqual(result.jobs, values.jobs);
    assert.deepEqual(result.resume_history, values.resume_history);
    assert.deepEqual(result.warnings, []);
  });

  test('fails soft for optional resources and records which projections degraded', async () => {
    const result = await composeDashboardBootstrap(async (resource) => {
      if (resource === 'profile' || resource === 'outreach') throw new Error('temporarily unavailable');
      return resource === 'me' ? { email: null } : resource === 'jobs' ? { jobs: [] } : {};
    });

    assert.deepEqual(result.profile, { skills: [], target_roles: [] });
    assert.deepEqual(result.outreach, []);
    assert.deepEqual(result.warnings.sort(), ['outreach', 'profile']);
  });

  test('does not hide a critical identity or jobs failure', async () => {
    await assert.rejects(
      composeDashboardBootstrap(async (resource) => {
        if (resource === 'jobs') throw new Error('jobs unavailable');
        return {};
      }),
      /jobs unavailable/,
    );
  });
});
