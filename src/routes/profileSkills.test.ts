import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyParsedProfilePatch, declaredSkillsList, parsedTargetRolesForSeed, serveProfileJson } from './profile';
import { applyDeclaredSkills } from './draft';
import { SYSTEM_PROMPT as DRAFT_SYSTEM_PROMPT } from '../llm/draft';
import { resumePacketEmailIsCurrent } from '../lib/resumeEmail';

// R-027 regression coverage. R-015 made profiles.skills the authoritative skills source, but the
// shipped serving leg spread bare parsed_json, so everything downstream of GET /profile (outreach
// drafting above all) kept running on the resume-INFERRED array. Verified live 2026-07-17:
// profiles.skills held the 19 confirmed skills while GET /profile simultaneously served
// ["gRPC","SDK design",...]. These tests pin both serving legs: the profile route and the draft
// route's server-side override.

const EMAIL = 'student@usc.edu';
const PARSED = { full_name: 'Mehek Mandal', school: 'USC', skills: ['gRPC', 'SDK design', 'BigQuery'] };

describe('declaredSkillsList', () => {
  test('passes a clean declared list through', () => {
    assert.deepEqual(declaredSkillsList(['Python', 'SQL']), ['Python', 'SQL']);
  });

  test('NULL/absent/malformed all mean "never declared", not "no skills"', () => {
    assert.deepEqual(declaredSkillsList(null), []);
    assert.deepEqual(declaredSkillsList(undefined), []);
    assert.deepEqual(declaredSkillsList('Python'), []);
    assert.deepEqual(declaredSkillsList({ skills: ['Python'] }), []);
  });

  test('filters junk out of a hand-edited jsonb row instead of forwarding it', () => {
    assert.deepEqual(declaredSkillsList(['Python', '', '   ', 42, null, 'SQL']), ['Python', 'SQL']);
  });
});

describe('parsedTargetRolesForSeed', () => {
  test('trims, deduplicates, bounds and rejects malformed parsed roles', () => {
    assert.deepEqual(
      parsedTargetRolesForSeed([' Nurse ', 'nurse', '', 42, 'A'.repeat(100)]),
      ['Nurse', 'A'.repeat(80)],
    );
    assert.equal(parsedTargetRolesForSeed(Array.from({ length: 20 }, (_, i) => `Role ${i}`)).length, 12);
    assert.deepEqual(parsedTargetRolesForSeed(null), []);
  });
});

describe('GET /profile serving (serveProfileJson)', () => {
  test('OVERRIDE: a non-empty declared list beats parsed_json.skills', () => {
    const served = serveProfileJson(PARSED, ['Python', 'SQL', 'Figma'], EMAIL);
    assert.deepEqual(served.skills, ['Python', 'SQL', 'Figma']);
    // the rest of parsed_json still comes through untouched
    assert.equal(served.full_name, 'Mehek Mandal');
    assert.equal(served.school, 'USC');
    assert.equal(served.email, EMAIL);
  });

  test('FALLBACK: declared NULL serves parsed_json.skills exactly as before', () => {
    const served = serveProfileJson(PARSED, null, EMAIL);
    assert.deepEqual(served.skills, ['gRPC', 'SDK design', 'BigQuery']);
  });

  test('FALLBACK: declared [] is "never declared" and does not blank the served skills', () => {
    const served = serveProfileJson(PARSED, [], EMAIL);
    assert.deepEqual(served.skills, ['gRPC', 'SDK design', 'BigQuery']);
  });

  test('a declared list of only junk falls back rather than serving an empty override', () => {
    const served = serveProfileJson(PARSED, ['', '  '], EMAIL);
    assert.deepEqual(served.skills, ['gRPC', 'SDK design', 'BigQuery']);
  });

  test('email always comes from the verified login, even when parsed_json carries one', () => {
    const served = serveProfileJson({ ...PARSED, email: 'stale@resume.pdf' }, null, EMAIL);
    assert.equal(served.email, EMAIL);
    assert.equal(served.resume_email, undefined);
  });

  test('resume email is independently editable and never replaces login identity', () => {
    const next = applyParsedProfilePatch(PARSED, { resume_email: 'MehekMan@USC.edu' });
    const served = serveProfileJson(next, null, EMAIL);
    assert.equal(served.email, EMAIL);
    assert.equal(served.resume_email, 'mehekman@usc.edu');
  });

  test('survives a NULL parsed_json row', () => {
    const served = serveProfileJson(null, ['Python'], EMAIL);
    assert.deepEqual(served.skills, ['Python']);
    assert.equal(served.email, EMAIL);
  });
});

describe('draft input (applyDeclaredSkills)', () => {
  const bodyProfile = {
    experience: [{ company: 'Traeco', title: 'Founder', start: '2025', end: '2026', description: 'Built it' }],
    skills: ['gRPC', 'SDK design'],
    school: 'USC',
    grad_year: 2028,
  };

  test('OVERRIDE: the declared list replaces client-supplied skills before drafting', () => {
    const out = applyDeclaredSkills(bodyProfile, ['Python', 'SQL']);
    assert.deepEqual(out.skills, ['Python', 'SQL']);
    // nothing else about the profile is touched
    assert.equal(out.school, 'USC');
    assert.deepEqual(out.experience, bodyProfile.experience);
  });

  test('FALLBACK: no declared list leaves the client profile alone (same object, no copy)', () => {
    assert.equal(applyDeclaredSkills(bodyProfile, []), bodyProfile);
  });

  test('the override does not mutate the input profile', () => {
    applyDeclaredSkills(bodyProfile, ['Python']);
    assert.deepEqual(bodyProfile.skills, ['gRPC', 'SDK design']);
  });
});

test('resume edit identity requires the exact current explicit personal email', () => {
  assert.equal(resumePacketEmailIsCurrent('mehekman@usc.edu', 'mehekman@usc.edu'), true);
  assert.equal(resumePacketEmailIsCurrent('mehekmandal05@gmail.com', 'mehekman@usc.edu'), false);
  assert.equal(resumePacketEmailIsCurrent('mehekman@usc.edu', undefined), false);
  assert.equal(resumePacketEmailIsCurrent(undefined, 'mehekman@usc.edu'), false);
});

describe('outreach drafting prompt (R-015 discipline, outreach half)', () => {
  test('pins the never-claim-an-unheld-skill rule in the draft system prompt', () => {
    assert.match(DRAFT_SYSTEM_PROMPT, /SKILLS GROUNDING/);
    assert.match(DRAFT_SYSTEM_PROMPT, /NEVER state or imply a skill/);
    assert.match(DRAFT_SYSTEM_PROMPT, /the applicant does not have it: leave it out/);
  });
});
