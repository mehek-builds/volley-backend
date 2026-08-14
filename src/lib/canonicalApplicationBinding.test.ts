import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalApplicationBindingMismatches } from './canonicalApplicationBinding';

const stored = {
  jobId: 'c65b2e3f-af68-4667-bbde-7849815970a6',
  company: 'Example   Labs',
  role: 'Software Engineer',
  portalUrl: 'https://jobs.example.com/apply/7?team=platform',
};

test('canonical application binding accepts normalized equivalent generation context', () => {
  assert.deepEqual(canonicalApplicationBindingMismatches(stored, {
    jobId: stored.jobId,
    company: '  EXAMPLE LABS ',
    role: 'software   engineer',
    portalUrl: 'https://jobs.example.com/apply/7/?utm_source=litos&team=platform#form',
  }), []);
});

test('canonical application binding reports every conflicting generation field', () => {
  assert.deepEqual(canonicalApplicationBindingMismatches(stored, {
    jobId: '36ada589-da60-4a5b-aa3d-64c0bbfa456e',
    company: 'Other Company',
    role: 'Product Manager',
    portalUrl: 'https://other.example.com/apply/7',
  }), ['job_id', 'company', 'role', 'portal_url']);
});

test('resume generation rejects canonical context mismatches before reservation or model work', () => {
  const source = readFileSync('src/routes/resume.ts', 'utf8');
  const route = source.slice(source.indexOf("fastify.post('/resume/generate'"), source.indexOf("fastify.get('/resume/download"));
  const mismatch = route.indexOf("code: 'application_context_mismatch'");
  assert.ok(mismatch > 0);
  assert.ok(mismatch < route.indexOf('reserveEntitledUsage({'));
  assert.ok(mismatch < route.indexOf('readExperienceBankOrSeedFromBaseResume(userId)'));
  assert.ok(mismatch < route.indexOf('generateResumeSpec('));
});
