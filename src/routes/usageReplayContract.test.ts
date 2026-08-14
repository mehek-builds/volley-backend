import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { entitledUsageRequestHash } from '../lib/entitlements';

const source = (name: string) => readFileSync(`src/routes/${name}`, 'utf8');

test('request hashes are canonical but change with semantic operation content', () => {
  assert.equal(
    entitledUsageRequestHash('draft', { company: 'Acme', role: 'Engineer', contact: { id: 'one', name: 'A' } }),
    entitledUsageRequestHash('draft', { contact: { name: 'A', id: 'one' }, role: 'Engineer', company: 'Acme' }),
  );
  assert.notEqual(
    entitledUsageRequestHash('draft', { company: 'Acme', role: 'Engineer', contact: { id: 'one' } }),
    entitledUsageRequestHash('draft', { company: 'Acme', role: 'Engineer', contact: { id: 'two' } }),
  );
});

test('every metered or generative route binds full content and returns committed receipts', () => {
  const resume = source('resume.ts');
  const coverLetter = source('coverLetter.ts');
  const answer = source('applicationAnswer.ts');
  const resolve = source('resolve.ts');
  const draft = source('draft.ts');

  assert.match(resume, /entitledUsageRequestHash\('tailored_resume',[\s\S]*?company: body\.company\.trim\(\)[\s\S]*?role: body\.role\.trim\(\)/);
  assert.match(resume, /getEntitledUsageReplay\([\s\S]*?requestHash/);
  assert.match(resume, /commitEntitledUsage\([\s\S]*?statusCode: 200, body: successResponse/);

  assert.match(coverLetter, /entitledUsageRequestHash\('cover_letter',[\s\S]*?application_id: target\.canonicalApplicationId[\s\S]*?company: target\.application\.company_name[\s\S]*?role: target\.application\.role[\s\S]*?jd_text: jdText/);
  assert.match(coverLetter, /reservation\.replay/);
  assert.match(coverLetter, /statusCode: 200, body: response/);

  assert.match(answer, /entitledUsageRequestHash\('answer_application',[\s\S]*?question[\s\S]*?company[\s\S]*?role[\s\S]*?jd_text/);
  assert.match(answer, /reservation\.replay/);
  assert.match(answer, /statusCode: 200, body: response/);

  assert.match(resolve, /entitledUsageRequestHash\('contact',[\s\S]*?company_scope_key[\s\S]*?user_school/);
  assert.match(resolve, /getEntitledUsageReplay/);
  assert.match(resolve, /replay: \{ statusCode: 200, body: response \}/);

  assert.match(draft, /entitledUsageRequestHash\('draft',[\s\S]*?company_scope_key[\s\S]*?contact[\s\S]*?user_profile/);
  assert.match(draft, /reservation\.replay/);
  assert.match(draft, /commitOutreachDraftGeneration\(\{[\s\S]*?requestHash[\s\S]*?draft,[\s\S]*?return reply\.status\(200\)\.send\(persisted\)/);
});
