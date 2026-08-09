import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isGovernmentEmploymentQuestion,
  refreshKnownQuestionAnswers,
  resolveKnownAnswer,
  type ApplicationProfileLike,
} from './questionDiscovery';

/* "Prior US Government Employment?" - Skydio, via Ashby, packet 13bccb2d.
 *
 * The last empty required field on the first packet that could reach a completed submission. It is
 * answerable, and the applicant's own canon says how: questions about her history are answered from
 * her typed job record. A positive exact job match is evidence. A project with the same name and a
 * non-match in a resume-derived bank are not evidence, so both stay with the applicant.
 *
 * LABELS ARE VERBATIM where they exist. "prior us government employment?" is copied out of
 * spec._review on the production packet, lowercased the way discovery lowercases them.
 */

const BANK: ApplicationProfileLike['experience_bank'] = [
  { type: 'job', org: 'Cinematica Labs', title: 'Program Management Intern' },
  { type: 'leadership', org: 'Einstein Bros. Bagels (Mobile Ordering) – USC Assoc. of Innovative Marketing', title: 'Product Lead' },
  { type: 'job', org: 'SoFi', title: 'Product Management Intern' },
  { type: 'leadership', org: 'Spark SC', title: 'VP of Finance & Sponsorships' },
  { type: 'project', org: 'Tonee - AI Texting Tone Detector', title: 'Founder' },
  { type: 'job', org: 'Traeco - AI Agent Cost Infrastructure', title: 'AI Engineer' },
  { type: 'leadership', org: 'Venture Capital Academy', title: 'President' },
];

/** The Skydio label, exactly as Litos stored it. */
const SKYDIO = 'prior us government employment?';

/** Skydio's own gloss, which is what the applicant reads on the page under that label. */
const SKYDIO_GLOSS = 'do you currently, or have you in the last 10 years, worked for the us government '
  + '(e.g. congressional staffer, member of military, state, or federal agencies)?';

function answer(label: string, ap: ApplicationProfileLike): string {
  const resolved = resolveKnownAnswer(label, 'checkbox', ap, undefined);
  if (resolved === null) return 'null';
  return 'value' in resolved ? `VALUE ${resolved.value}` : 'SKIP';
}

describe('prior government employment, answered from the experience bank', () => {
  test('a nonempty resume-derived bank does not prove the negative', () => {
    assert.equal(answer(SKYDIO, { experience_bank: BANK }), 'SKIP');
  });

  test('the SAME bank plus one government employer answers Yes', () => {
    /* The property that separates a derivation from a constant, and the reason this file exists.
     * Nothing changes but one row. */
    const withGovernment = {
      experience_bank: [...(BANK ?? []), { type: 'job' as const, org: 'U.S. Department of Energy', title: 'Policy Intern' }],
    };
    assert.equal(answer(SKYDIO, withGovernment), 'VALUE Yes');
  });

  test('a government employer is recognised across the shapes employers are actually named in', () => {
    for (const org of [
      'U.S. Department of Energy',
      'Government Accountability Office',
      'City of Los Angeles',
      'Office of Congressman Ted Lieu',
      'United States Senate',
      'Department of Justice',
    ]) {
      assert.equal(answer('prior government employment', { experience_bank: [...(BANK ?? []), { type: 'job', org }] }), 'VALUE Yes', org);
    }
  });

  test('titles and government-adjacent organisation names never become employer evidence', () => {
    for (const entry of [
      { type: 'job' as const, org: 'Acme', title: 'NASA Contractor' },
      { type: 'job' as const, org: 'NASA Space Apps Hackathon', title: 'Project Lead' },
      { type: 'job' as const, org: 'Booz Allen Hamilton', title: 'Federal Government Consultant' },
      { type: 'job' as const, org: 'Ted Lieu for Congress', title: 'Congressional Staffer' },
      { type: 'job' as const, org: 'NASA Jet Propulsion Laboratory', title: 'Research Intern' },
    ]) {
      assert.equal(answer(SKYDIO, { experience_bank: [...(BANK ?? []), entry] }), 'SKIP', entry.org);
    }
  });

  test('an exact Department of Energy employment row is decisive', () => {
    const profile = {
      experience_bank: [{ type: 'job', org: 'Department of Energy', title: 'Policy Analyst' }],
    } satisfies ApplicationProfileLike;
    assert.equal(answer(SKYDIO, profile), 'VALUE Yes');
  });

  test('only vetted canonical government identities are decisive', () => {
    for (const org of ['NASA', 'National Aeronautics and Space Administration']) {
      assert.equal(answer(SKYDIO, { experience_bank: [{ type: 'job', org }] }), 'VALUE Yes', org);
    }
    for (const org of [
      'Federal Marketing Agency',
      'United States Talent Agency',
      'State of Play',
      'City of Angels',
      'NASA Space Apps Hackathon',
      'Department of Energy Contractor',
    ]) {
      assert.equal(answer(SKYDIO, { experience_bank: [{ type: 'job', org }] }), 'SKIP', org);
    }
  });

  test('an organisation that MIGHT be public holds the question instead of answering it', () => {
    // Both measured in production banks on 2026-08-09. Neither is settleable from the name, and a
    // wrong "No" here is a false statement about federal service, so neither gets one.
    for (const org of ['World Bank', 'XYZ Public Charter Schools', 'National Institutes of Health']) {
      assert.equal(answer(SKYDIO, { experience_bank: [...(BANK ?? []), { type: 'job', org }] }), 'SKIP', org);
    }
  });

  test('an empty bank is never told us, not never worked anywhere', () => {
    // Both shapes of nothing: the field absent (never read) and the bank read and empty.
    assert.equal(answer(SKYDIO, {}), 'SKIP');
    assert.equal(answer(SKYDIO, { experience_bank: [] }), 'SKIP');
    // And the refusal says why, rather than failing silently.
    const resolved = resolveKnownAnswer(SKYDIO, 'checkbox', {}, undefined);
    assert.ok(resolved && 'skipReason' in resolved);
    assert.match(resolved.skipReason, /experience is not on file/);
  });

  test('a bank of blank organisations is an empty bank', () => {
    assert.equal(answer(SKYDIO, { experience_bank: [{ type: 'job', org: '   ' }, { type: 'job', org: '' }] }), 'SKIP');
  });

  test('a NASA project is not evidence of government employment', () => {
    const profile = {
      experience_bank: [{ type: 'project', org: 'NASA Space Apps Hackathon', title: 'Project Lead' }],
    } satisfies ApplicationProfileLike;
    assert.equal(answer(SKYDIO, profile), 'SKIP');
    const resolved = resolveKnownAnswer(SKYDIO, 'checkbox', profile, undefined);
    assert.ok(resolved && 'skipReason' in resolved);
    assert.match(resolved.skipReason, /no typed employment entries/);
  });

  test('a stored military record holds the answer, in the one direction it can', () => {
    // Government service that a resume rarely lists, and a column that does not record whose armed
    // forces it was. It can unmake the No; it cannot make the Yes.
    const served = { experience_bank: BANK, military_service: 'Yes, I served in the US Army' };
    assert.equal(answer(SKYDIO, served), 'SKIP');
    const declined = { experience_bank: BANK, military_service: 'No' };
    assert.equal(answer(SKYDIO, declined), 'SKIP');
    const notAVeteran = { experience_bank: BANK, military_service: 'I am not a protected veteran' };
    assert.equal(answer(SKYDIO, notAVeteran), 'SKIP');
  });

  test('Skydio\'s gloss is answered from the bank, not from the EEO block', () => {
    /* Before this arm existed the bare word "military" inside the gloss put the whole question
     * through EEO_QUESTION, and an employment-history question came back
     * "Decline to self-identify". Verified against the real resolver on 2026-08-09. */
    assert.ok(isGovernmentEmploymentQuestion(SKYDIO_GLOSS));
    assert.equal(answer(SKYDIO_GLOSS, { experience_bank: BANK }), 'SKIP');
    assert.equal(
      answer(SKYDIO_GLOSS, { experience_bank: [...(BANK ?? []), { type: 'job', org: 'Federal Aviation Administration' }] }),
      'VALUE Yes',
    );
  });

  test('the other wordings of the same question are recognised', () => {
    for (const label of [
      'have you ever been employed by a government agency?',
      'have you worked in the public sector?',
      'prior government employment',
      'have you previously worked for the u.s. federal government?',
    ]) {
      assert.ok(isGovernmentEmploymentQuestion(label), label);
      assert.equal(answer(label, { experience_bank: BANK }), 'SKIP', label);
    }
  });

  test('government words do not turn named companies or work subjects into government employers', () => {
    const nasa: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    for (const label of [
      'Have you ever worked for Government Employees Insurance Company (GEICO)?',
      'Have you worked for Government Brands LLC?',
    ]) {
      assert.equal(answer(label, nasa), 'SKIP', label);
    }
    for (const label of [
      'Have you worked on government projects?',
      'Have you supported a government contractor?',
      'Have you worked on federal government contracts?',
      'Describe your government relations experience.',
      'Which government function have you worked in?',
      'Is government your professional discipline?',
    ]) {
      assert.equal(isGovernmentEmploymentQuestion(label), false, label);
      assert.equal(answer(label, nasa), 'SKIP', label);
    }
  });

  test('a named employer or government level must match the applicant evidence', () => {
    const nasa: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    for (const label of [
      'Have you worked for the Government Accountability Office?',
      'Have you been employed by a state agency?',
      'Have you worked for local government?',
    ]) {
      assert.equal(answer(label, nasa), 'SKIP', label);
    }

    assert.equal(
      answer('Have you worked for the Government Accountability Office?', {
        experience_bank: [{ type: 'job', org: 'Government Accountability Office' }],
      }),
      'VALUE Yes',
    );
    assert.equal(
      answer('Have you worked for local government?', {
        experience_bank: [{ type: 'job', org: 'City of Los Angeles' }],
      }),
      'VALUE Yes',
    );
    assert.equal(answer('Have you worked for the federal government?', nasa), 'VALUE Yes');
    assert.equal(
      answer('Have you been employed by a government agency?', {
        experience_bank: [{ type: 'job', org: 'Department of Energy' }],
      }),
      'VALUE Yes',
    );
    assert.equal(
      answer('Have you worked for the U.S. Department of Energy?', {
        experience_bank: [{ type: 'job', org: 'United States Department of Energy' }],
      }),
      'VALUE Yes',
    );
  });

  test('nonqualifying government-adjacent employment wording returns an explicit refusal', () => {
    const nasa: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    for (const label of [
      'Have you previously served in the US government?',
      'Have you previously served as a congressional staffer?',
    ]) {
      assert.equal(isGovernmentEmploymentQuestion(label), false, label);
      const resolved = resolveKnownAnswer(label, 'checkbox', nasa, undefined);
      assert.ok(resolved && 'skipReason' in resolved, label);
      assert.match(resolved.skipReason, /does not explicitly ask/, label);
    }
  });

  test('prior government employment preserves explicit level and foreign scope', () => {
    const nasa: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    for (const label of [
      'Prior state government employment?',
      'Prior local government employment?',
      'Prior city government employment?',
      'Prior municipal government employment?',
      'Prior county government employment?',
      'Prior foreign government employment?',
      'Prior non-US government employment?',
      'Prior non-U.S. government employment?',
      'Prior government employment outside the US?',
    ]) {
      assert.equal(answer(label, nasa), 'SKIP', label);
    }
    const local: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'City of Los Angeles', title: 'Analyst' }],
    };
    for (const label of [
      'Prior local government employment?',
      'Prior city government employment?',
      'Prior municipal government employment?',
      'Prior county government employment?',
    ]) {
      assert.equal(answer(label, local), 'VALUE Yes', label);
    }
    assert.equal(answer('Prior government employment?', nasa), 'VALUE Yes');
  });

  test('parenthetical employer disambiguation must resolve to the same canonical identity', () => {
    const nasa: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    assert.equal(answer('Have you worked for NASA (National Auto Sport Association)?', nasa), 'SKIP');
    assert.equal(
      answer('Have you worked for NASA (National Aeronautics and Space Administration)?', nasa),
      'VALUE Yes',
    );
    assert.equal(
      answer('Prior government employment?', {
        experience_bank: [{ type: 'job', org: 'NASA (National Auto Sport Association)' }],
      }),
      'SKIP',
    );
  });

  test('canonical federal aliases resolve directly and at send-time', () => {
    const cases = [
      ['Have you worked for US DOE?', 'U.S. Department of Energy'],
      ['Have you worked for United States DOJ?', 'DOJ'],
      ['Have you worked for U.S. Senate?', 'US Senate'],
      ['Have you worked for FAA?', 'Federal Aviation Administration'],
    ] as const;
    for (const [question, org] of cases) {
      const profile: ApplicationProfileLike = { experience_bank: [{ type: 'job', org }] };
      assert.equal(answer(question, profile), 'VALUE Yes', question);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question, answer: '' }], profile, undefined),
        [{ question, answer: 'Yes' }],
        question,
      );
    }
  });

  test('send-time refresh removes a stale Yes from every government adjacency', () => {
    const nasa: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'National Aeronautics and Space Administration', title: 'Research Intern' }],
    };
    const questions = [
      'Have you ever worked for Government Employees Insurance Company (GEICO)?',
      'Have you worked for Government Brands LLC?',
      'Have you worked on government projects?',
      'Have you supported a government contractor?',
      'Have you worked on federal government contracts?',
      'Describe your government relations experience.',
      'Which government function have you worked in?',
      'Is government your professional discipline?',
      'Have you worked for the Government Accountability Office?',
      'Have you been employed by a state agency?',
      'Have you worked for local government?',
      'Have you previously served in the US government?',
      'Have you previously served as a congressional staffer?',
      'Prior state government employment?',
      'Prior local government employment?',
      'Prior city government employment?',
      'Prior municipal government employment?',
      'Prior county government employment?',
      'Prior foreign government employment?',
      'Prior non-US government employment?',
      'Prior non-U.S. government employment?',
      'Prior government employment outside the US?',
      'Have you worked for NASA (National Auto Sport Association)?',
    ].map((question) => ({ question, answer: 'Yes' }));

    assert.deepEqual(
      refreshKnownQuestionAnswers(questions, nasa, undefined),
      questions.map((question) => ({ ...question, answer: '' })),
    );
  });
});

describe('the neighbours this arm must not reach', () => {
  /* Every label here is verbatim from the stored corpus, found with scripts/_corpus-labels.mts over
   * the 507 distinct labels. Each already has a rule of its own; the point of the assertion is that
   * the new predicate does not claim it. */
  const NEIGHBOURS: [string, string][] = [
    ['export control', 'astranis complies with u.s. government space technology export regulations, therefore will you state which of the following applies to you'],
    ['politically exposed person', 'are you or have you been entrusted with a position or function in any government, international organization (such as the un or world bank), or state-controlled or state-owned bank, brokerage firm, or other enterprise?'],
    ['someone else\'s public office', 'do you have any close friends or relatives who are public officers? if so, please list their names and their position in their government agency. (private)'],
    ['clearance level held', 'if you have held a u.s. security clearance in the past, what clearance level have you held?'],
    ['clearance eligibility', 'u.s. person status and/or u.s. clearance eligibility is required for this role due to access requirements for u.s. export-controlled information/facilities and/or depending on program, are you eligible to meet this requirement?'],
  ];

  for (const [name, label] of NEIGHBOURS) {
    test(`${name} is not this family`, () => {
      assert.equal(isGovernmentEmploymentQuestion(label), false);
    });
  }

  test('the two clearance labels are still not answered from the bank', () => {
    /* A clearance is not an employment fact and eligibility for one is a self-declaration. Neither
     * may become answerable because a list of employers exists. */
    for (const [, label] of NEIGHBOURS.filter(([name]) => name.startsWith('clearance'))) {
      const resolved = resolveKnownAnswer(label, 'checkbox', { experience_bank: BANK }, undefined);
      assert.ok(resolved === null || 'skipReason' in resolved, label);
    }
  });

  test('a work-authorization question about the federal government stays a work-authorization question', () => {
    // Status, not history. Answering it from an employer list would be a false legal declaration.
    const label = 'are you legally authorized to work for the federal government?';
    assert.equal(isGovernmentEmploymentQuestion(label), false);
    const resolved = resolveKnownAnswer(label, 'checkbox', { experience_bank: BANK }, undefined);
    assert.ok(resolved && 'skipReason' in resolved);
    assert.match(resolved.skipReason, /work-eligibility/);
  });
});

describe('the sibling family: prior employment with the hiring company', () => {
  /* Checked because the same root cause reached it. "Have you ever worked for X?" was answered
   * from `employer_history`, which is scraped out of parsed_json.experience and held 4 of the
   * owner's 9 organisations on 2026-08-09. Three of her real employers were invisible to it, so
   * the arm returned a confident "No" about a company she works at today. */
  const REAL_BANK: ApplicationProfileLike['experience_bank'] = [
    { type: 'job', org: 'SoFi' },
    { type: 'job', org: 'Cinematica Labs' },
    { type: 'project', org: 'Tonee - AI Texting Tone Detector' },
    { type: 'job', org: 'Traeco - AI Agent Cost Infrastructure' },
    { type: 'leadership', org: 'Spark SC' },
  ];
  // Exactly what the parse yielded in production. Traeco and Spark SC are missing from it.
  const PARSED_ONLY = ['Tonee - AI Texting Tone Detector', 'Cinematica Labs', 'SoFi'];

  test('an employer that is only in the bank answers Yes, not No', () => {
    const ap: ApplicationProfileLike = { employer_history: PARSED_ONLY, experience_bank: REAL_BANK };
    assert.equal(answer('have you ever worked for traeco?', ap), 'VALUE Yes');
    assert.equal(answer('have you ever worked for spark sc?', ap), 'SKIP');
  });

  test('an employer in neither record is held because the records are not exhaustive', () => {
    const ap: ApplicationProfileLike = { employer_history: PARSED_ONLY, experience_bank: REAL_BANK };
    assert.equal(answer('have you ever worked for redwood materials?', ap), 'SKIP');
  });

  test('the widened match is a prefix, not a substring', () => {
    /* The reason the helper is anchored at the first token. A bank entry may carry a suffix the
     * form omits ("Traeco - AI Agent Cost Infrastructure" answering "Traeco"), but a name that
     * merely starts the same way is a different company and still answers No. */
    const ap: ApplicationProfileLike = { employer_history: PARSED_ONLY, experience_bank: REAL_BANK };
    assert.equal(answer('have you ever worked for sofia?', ap), 'SKIP');
    assert.equal(answer('have you ever worked for traeco labs?', ap), 'SKIP');
  });

  test('nothing declared at all leaves the question alone', () => {
    // No history and no bank is "never told us". It must not become a No.
    const resolved = resolveKnownAnswer('have you ever worked for redwood materials?', 'text', {}, undefined);
    assert.ok(resolved === null || 'skipReason' in resolved);
  });
});

describe('the bank actually reaches the resolver', () => {
  /* The arm above is only worth anything if the shape it reads is populated on the real path. This
   * asserts the wiring at its single load point rather than mocking a database. */
  const source = fs.readFileSync(path.join(__dirname, 'applicationProfileLike.ts'), 'utf8');

  test('loadApplicationProfileLike reads the bank the one sanctioned way', () => {
    assert.match(source, /import \{ readExperienceBankOrSeedFromBaseResume \} from '\.\.\/db\/experienceBank'/);
    assert.match(source, /readExperienceBankOrSeedFromBaseResume\(userId\)/);
  });

  test('an unreadable bank degrades to an empty one rather than throwing', () => {
    // Empty is the case the resolver refuses on, which is the honest outcome; a throw here would
    // stall every submission over a question that is allowed to be left blank.
    assert.match(source, /readExperienceBankOrSeedFromBaseResume\(userId\)\.catch\(\(\) => \[\]\)/);
  });

  test('the loaded profile carries experience_bank', () => {
    assert.match(source, /experience_bank:\s*bankRows/);
    assert.match(source, /experienceBankType\(entry\.type\)/);
  });
});
