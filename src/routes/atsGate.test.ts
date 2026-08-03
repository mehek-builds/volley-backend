import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { contactHeaderFrom, targetRoleText, metricGapsIn, sanitizeEditedSpec, VERB_SUGGESTIONS } from './baseResume';
import { startsWithStrongVerb } from '../engine/resumeValidate';
import type { ResumeSpec } from '../llm/resumeSpec';

function spec(over: Partial<ResumeSpec> = {}): ResumeSpec {
  return {
    school: 'USC', degree: 'BS', grad_date: 'May 2028', coursework: '',
    experience: [], skills: [], ...over,
  } as ResumeSpec;
}

describe('contactHeaderFrom', () => {
  test('takes the account email over anything the parse guessed', () => {
    const c = contactHeaderFrom({ full_name: 'Mehek Mandal', email: 'old@x.com' }, undefined, 'me@usc.edu');
    assert.equal(c.email, 'me@usc.edu');
    assert.equal(c.full_name, 'Mehek Mandal');
  });

  test('an empty harvest is a header with no links, not a broken one', () => {
    const c = contactHeaderFrom({ full_name: 'Mehek Mandal' }, {}, 'me@usc.edu');
    assert.equal(c.linkedin_url, undefined);
    assert.equal(c.github_url, undefined);
  });

  test('reads the links the harvest did fill', () => {
    const c = contactHeaderFrom({ full_name: 'A B' }, { linkedin_url: 'https://li/x', github_url: '  ' }, 'a@b.c');
    assert.equal(c.linkedin_url, 'https://li/x');
    assert.equal(c.github_url, undefined, 'whitespace is not a link');
  });

  test('never renders a nameless resume', () => {
    assert.equal(contactHeaderFrom(null, undefined, undefined).full_name, 'Applicant');
  });
});

describe('targetRoleText', () => {
  test('category slugs lose their hyphens so the scorer can see the words', () => {
    const said = targetRoleText({ categories: ['software-engineering', 'data-ml'] }, null);
    assert.ok(said.includes('software engineering'), said);
    assert.ok(!said.includes('-'), said);
  });

  test('falls back to the roles the parse inferred, which is most students at this step', () => {
    assert.equal(targetRoleText(undefined, { target_roles: ['Software Engineer'] }), 'Software Engineer');
  });

  test('does not repeat a role the student typed and the parse also guessed', () => {
    const said = targetRoleText({ titles: ['Software Engineer'] }, { target_roles: ['Software Engineer'] });
    assert.equal(said, 'Software Engineer');
  });

  test('nothing on file is an empty string, not the word undefined', () => {
    assert.equal(targetRoleText(undefined, null), '');
  });
});

describe('metricGapsIn', () => {
  const withBullets = (bullets: string[]) => spec({ experience: [{ org: 'Acme', title: 'X', date_range: 'Y', bullets }] });

  test('finds only the bullets carrying no number at all', () => {
    const gaps = metricGapsIn(withBullets(['Built the thing for 3 teams.', 'Built the other thing.']));
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].bullet, 'Built the other thing.');
  });

  test('asks about the longest ones first, where a number buys the most', () => {
    const gaps = metricGapsIn(withBullets(['Short one.', 'A considerably longer bullet describing real work.']));
    assert.equal(gaps[0].bullet, 'A considerably longer bullet describing real work.');
  });

  test('caps the ask, because a federal resume has fifteen of these', () => {
    const many = Array.from({ length: 15 }, (_, i) => `Bullet number ${'x'.repeat(i)} with no metric.`);
    assert.equal(metricGapsIn(withBullets(many)).length, 5);
  });

  test('a resume where every bullet has a number asks nothing', () => {
    assert.deepEqual(metricGapsIn(withBullets(['Cut latency 40%.'])), []);
    assert.deepEqual(metricGapsIn(spec()), []);
  });
});

/* A CV written in the present tense is describing a current role, not breaking the rule. Measured
 * on a real WVU biochemistry CV, 2026-07-27: three bullets flagged while their past-tense forms
 * were on the whitelist the whole time. */
describe('the verb gate reads both tenses', () => {
  for (const bullet of [
    'Synthesize organic ligands for the target assay.',
    'Measure interactions of synthesized compounds.',
    'Analyze the resulting spectra against the control.',
    'Design the fixture for the third iteration.',
    'Lead a team of four through the migration.',
    'Present findings to the department each term.',
  ]) {
    test(`accepts present-tense "${bullet.split(' ')[0]}"`, () => {
      assert.equal(startsWithStrongVerb(bullet), true);
    });
  }

  test('the past tense still works, and co- still inherits', () => {
    assert.equal(startsWithStrongVerb('Synthesized the ligands.'), true);
    assert.equal(startsWithStrongVerb('Co-authored the paper.'), true);
    assert.equal(startsWithStrongVerb('Co-author the paper.'), true);
  });

  test('accepts added as a concrete implementation action', () => {
    for (const bullet of [
      'Added automated tests and improved release confidence across the deployment pipeline.',
      'Add automated tests and improve release confidence across the deployment pipeline.',
      'Added: automated tests improved release confidence across the deployment pipeline.',
      '"Added" automated tests and improved release confidence across the deployment pipeline.',
    ]) {
      assert.equal(startsWithStrongVerb(bullet), true, bullet);
    }
  });

  test('malformed or derived lookalikes cannot collapse into added', () => {
    for (const bullet of [
      'Ad,ded automated tests to the deployment pipeline.',
      'Added123 automated tests to the deployment pipeline.',
      'Readded automated tests to the deployment pipeline.',
      'Addedness improved across the deployment pipeline.',
      'Added-value improved across the deployment pipeline.',
    ]) {
      assert.equal(startsWithStrongVerb(bullet), false, bullet);
    }
  });

  test('tense does not widen the vocabulary: a weak verb stays weak in every tense', () => {
    for (const bullet of [
      'Maintain the lab inventory.',
      'Maintained the lab inventory.',
      'Assist with sample collection.',
      'Assisted with sample collection.',
      'Help the team with reporting.',
      'Follow SOPs and OSHA regulations.',
      'Participate in the weekly standup.',
    ]) {
      assert.equal(startsWithStrongVerb(bullet), false, bullet);
    }
  });
});

describe('the verbs we suggest when a rewrite pass fails', () => {
  test('every suggestion is one the gate will actually accept', () => {
    for (const verb of VERB_SUGGESTIONS) {
      assert.equal(startsWithStrongVerb(`${verb} the thing.`), true, verb);
    }
  });

  test('the menu spans more than software work, which is where bullets stall', () => {
    for (const verb of ['Organized', 'Processed', 'Trained', 'Prepared']) {
      assert.ok(VERB_SUGGESTIONS.includes(verb), verb);
    }
  });
});

/* Findings from the code review of this branch, pinned so they cannot come back. */
describe('verb derivation cannot admit what the vocabulary rules reject', () => {
  test('"Found" does not ride in on "founded"', () => {
    // found -> founded is on the list because founding a company is a real act.
    // "Found and fixed 12 defects" is not that.
    assert.equal(startsWithStrongVerb('Found and fixed 12 defects in the intake pipeline.'), false);
    assert.equal(startsWithStrongVerb('Founded a student consultancy.'), true, 'the real verb still passes');
  });

  test('a doubled final consonant is derived, so a present-tense CV is not punished', () => {
    // The bound used to sit on the whole word and demanded five letters, which excluded every word
    // the rule is for. "shipped" and "planned" were on the list the whole time.
    assert.equal(startsWithStrongVerb('Ship weekly releases to production.'), true);
    assert.equal(startsWithStrongVerb('Shipped weekly releases to production.'), true);
  });

  test('the doubling rule still does not invent strength', () => {
    for (const bullet of ['Chat with the team daily.', 'Nap between shifts.', 'Beg for an extension.']) {
      assert.equal(startsWithStrongVerb(bullet), false, bullet);
    }
  });
});

/* PUT /resume/base takes user text into the document every tailored resume is built from. Before
 * this it stored exactly what was sent, routing around the rules the build had just enforced. */
describe('sanitizeEditedSpec', () => {
  const withBullet = (bullet: string) => ({
    school: 'USC', degree: 'BS', grad_date: 'May 2028', coursework: '', skills: [],
    experience: [{ org: 'Acme', title: 'X', date_range: 'Y', bullets: [bullet] }],
  });

  test('an em dash typed into the metrics box cannot reach storage', () => {
    const { spec } = sanitizeEditedSpec(withBullet('Managed intake — 12 clients a week.'));
    assert.equal(spec!.experience[0].bullets[0], 'Managed intake - 12 clients a week.');
  });

  test('a bullet too long for the page is refused, not silently cut', () => {
    const { spec, error } = sanitizeEditedSpec(withBullet(`Managed ${'x'.repeat(300)}`));
    assert.equal(spec, undefined);
    assert.ok(error?.includes('Acme'), error);
    assert.ok(error?.includes('Shorten it'), error);
  });

  test('an ordinary edit passes through untouched', () => {
    const { spec, error } = sanitizeEditedSpec(withBullet('Managed a caseload of 12 clients a week.'));
    assert.equal(error, undefined);
    assert.equal(spec!.experience[0].bullets[0], 'Managed a caseload of 12 clients a week.');
  });

  test('a spec with no experience is not a crash', () => {
    assert.equal(sanitizeEditedSpec({}).error, undefined);
  });
});
