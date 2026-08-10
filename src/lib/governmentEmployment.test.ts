import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyField,
  frozenJobEmployerContext,
  frozenJobLocationContext,
  frozenJobRelocationLocationContext,
  isGovernmentEmploymentQuestion,
  isPriorApplicationQuestion,
  isRelocationQuestion,
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

  test('Skydio\'s dated current-or-recent gloss holds when the bank has no dates', () => {
    /* Before this arm existed the bare word "military" inside the gloss put the whole question
     * through EEO_QUESTION, and an employment-history question came back
     * "Decline to self-identify". The bank also has no dates, so it cannot prove either current
     * employment or employment within the stated ten-year window. */
    assert.equal(isGovernmentEmploymentQuestion(SKYDIO_GLOSS), false);
    assert.equal(answer(SKYDIO_GLOSS, { experience_bank: BANK }), 'SKIP');
    const withFederal = {
      experience_bank: [...(BANK ?? []), { type: 'job' as const, org: 'Federal Aviation Administration' }],
    };
    assert.equal(answer(SKYDIO_GLOSS, withFederal), 'SKIP');
    const resolved = resolveKnownAnswer(SKYDIO_GLOSS, 'checkbox', withFederal, undefined);
    assert.ok(resolved && 'skipReason' in resolved);
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

  test('parenthetical examples fail closed when they carry limits or unparsed qualifiers', () => {
    const nasa: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const labels = [
      'Have you worked for government (e.g. federal government only)?',
      'Have you worked for government (e.g. non-federal government)?',
      'Have you worked for government (e.g. excluding local government)?',
      'Have you worked for government (e.g. other than state government)?',
      'Have you worked for government (e.g. internships)?',
      'Have you worked for government (e.g. permanent roles)?',
      'Have you worked for government (e.g. within the last 5 years)?',
    ];
    for (const label of labels) {
      assert.equal(isGovernmentEmploymentQuestion(label), false, label);
      const resolved = resolveKnownAnswer(label, 'checkbox', nasa, undefined);
      assert.ok(resolved && 'skipReason' in resolved, label);
    }
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        labels.map((question) => ({ question, answer: 'Yes' })),
        nasa,
        undefined,
      ),
      labels.map((question) => ({ question, answer: '' })),
    );
    assert.equal(answer('Have you worked for government (e.g. federal, state, or local government agencies)?', nasa), 'VALUE Yes');
  });

  test('safe parenthetical prefixes accept punctuation without weakening qualifier refusal', () => {
    const nasa: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const safe = [
      'Have you worked for government (e.g., federal, state, or local government agencies)?',
      'Have you worked for government (for example: federal or local government agencies)?',
      'Have you worked for government (including: federal or state government agencies)?',
      'Have you worked for government (such as: federal agencies)?',
    ];
    for (const label of safe) {
      assert.equal(answer(label, nasa), 'VALUE Yes', label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: '' }], nasa, undefined),
        [{ question: label, answer: 'Yes' }],
      );
    }
    const restrictive = [
      'Have you worked for government (e.g., federal government only)?',
      'Have you worked for government (including: permanent roles)?',
      'Have you worked for government (such as: non-federal agencies)?',
    ];
    for (const label of restrictive) {
      assert.equal(answer(label, nasa), 'SKIP', label);
    }
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        restrictive.map((question) => ({ question, answer: 'Yes' })),
        nasa,
        undefined,
      ),
      restrictive.map((question) => ({ question, answer: '' })),
    );
  });

  test('parenthetical examples must resolve to targets compatible with the primary scope', () => {
    const federal: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const local: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'City of Los Angeles', title: 'Analyst' }],
    };
    const safe = [
      'Have you worked for government (e.g., NASA, FAA, or DOE)?',
      'Have you worked for federal government (including: NASA, FAA, or DOE)?',
      'Have you worked for a U.S. government agency (for example: NASA or DOE)?',
      'Have you worked for NASA (e.g., National Aeronautics and Space Administration)?',
    ];
    for (const label of safe) {
      assert.equal(answer(label, federal), 'VALUE Yes', label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: '' }], federal, undefined),
        [{ question: label, answer: 'Yes' }],
      );
    }
    const contradictions = [
      ['Have you worked for federal government (e.g., City of Los Angeles)?', federal],
      ['Have you worked for local government (e.g., NASA)?', local],
      ['Have you worked for NASA (e.g., FAA)?', federal],
      ['Have you worked for federal government (e.g., federal or local agencies)?', federal],
    ] as const;
    for (const [label, profile] of contradictions) {
      assert.equal(answer(label, profile), 'SKIP', label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'Yes' }], profile, undefined),
        [{ question: label, answer: '' }],
      );
    }
  });

  test('longest registry aliases stay atomic inside multi-example parentheticals', () => {
    const federal: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const local: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'City of Los Angeles', title: 'Analyst' }],
    };
    const fullFederalList = 'National Aeronautics and Space Administration, Federal Aviation Administration, and Department of Energy';
    const safe = [
      `Have you worked for government (e.g., ${fullFederalList})?`,
      `Have you worked for federal government (including: ${fullFederalList})?`,
      'Have you worked for NASA (for example: National Aeronautics and Space Administration and NASA)?',
    ];
    for (const label of safe) {
      assert.equal(answer(label, federal), 'VALUE Yes', label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: '' }], federal, undefined),
        [{ question: label, answer: 'Yes' }],
      );
    }
    const contradictions = [
      `Have you worked for federal government (e.g., ${fullFederalList}, and City of Los Angeles)?`,
      'Have you worked for local government (e.g., City of Los Angeles and National Aeronautics and Space Administration)?',
    ];
    for (const label of contradictions) {
      assert.equal(answer(label, local), 'SKIP', label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'Yes' }], local, undefined),
        [{ question: label, answer: '' }],
      );
    }
  });

  test('canonical federal aliases resolve directly and at send-time', () => {
    const cases = [
      ['Have you worked for US DOE?', 'U.S. Department of Energy'],
      ['Have you worked for U.S. DOE?', 'US Department of Energy'],
      ['Have you worked for United States DOJ?', 'DOJ'],
      ['Have you worked for US Department of Justice?', 'U.S. DOJ'],
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

  test('negated government levels hold before positive level binding', () => {
    const federal: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const local: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'City of Los Angeles', title: 'Analyst' }],
    };
    const cases: [string, ApplicationProfileLike][] = [
      ['Prior non-federal government employment?', federal],
      ['Prior government employment other than federal?', federal],
      ['Prior government employment outside the federal government?', federal],
      ['Have you worked for a non-federal government agency?', federal],
      ['Prior non-local government employment?', local],
      ['Prior government employment other than local?', local],
      ['Prior government employment outside local government?', local],
      ['Have you worked for a non-local government agency?', local],
    ];
    for (const [label, profile] of cases) {
      assert.equal(isGovernmentEmploymentQuestion(label), false, label);
      const resolved = resolveKnownAnswer(label, 'checkbox', profile, undefined);
      assert.ok(resolved && 'skipReason' in resolved, label);
    }

    for (const [label, profile] of cases) {
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'Yes' }], profile, undefined),
        [{ question: label, answer: '' }],
        label,
      );
    }
  });

  test('the scope parser accepts only complete recognized government scopes', () => {
    const federal: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const local: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'City of Los Angeles', title: 'Analyst' }],
    };
    const cases: [string, ApplicationProfileLike, string][] = [
      ['Prior government employment?', local, 'VALUE Yes'],
      ['Prior U.S. government employment?', federal, 'VALUE Yes'],
      ['Prior federal government employment?', federal, 'VALUE Yes'],
      ['Prior state government employment?', federal, 'SKIP'],
      ['Prior local government employment?', local, 'VALUE Yes'],
      ['Have you worked for NASA?', federal, 'VALUE Yes'],
      ['Have you worked for the federal government?', federal, 'VALUE Yes'],
      ['Have you worked for local government?', local, 'VALUE Yes'],
    ];
    for (const [label, profile, expected] of cases) {
      assert.ok(isGovernmentEmploymentQuestion(label), label);
      assert.equal(answer(label, profile), expected, label);
    }
  });

  test('unparsed qualifiers and exclusions fail closed and clear stale answers', () => {
    const nasa: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const labels = [
      'Prior government employment except federal?',
      'Prior government employment excluding federal?',
      'Prior government employment apart from federal?',
      'Prior government employment that was not federal?',
      'Prior government employment but not federal?',
      'Have you worked for government except federal?',
      'Have you worked for a government excluding local government?',
      'Have you worked for government apart from state government?',
      'Have you worked for government that was not federal?',
      'Have you worked for government but not local government?',
      'Prior non-American government employment?',
      'Prior government employment outside America?',
      'Prior Canadian government employment?',
      'Prior provincial government employment?',
      'Prior tribal government employment?',
      'Prior territorial government employment?',
    ];
    for (const label of labels) {
      assert.equal(isGovernmentEmploymentQuestion(label), false, label);
      const resolved = resolveKnownAnswer(label, 'checkbox', nasa, undefined);
      assert.ok(resolved && 'skipReason' in resolved, label);
      assert.equal(answer(label, nasa), 'SKIP', label);
    }
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        labels.map((question) => ({ question, answer: 'Yes' })),
        nasa,
        undefined,
      ),
      labels.map((question) => ({ question, answer: '' })),
    );
  });

  test('current-status questions hold because employer rows do not prove current employment', () => {
    const nasa: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const labels = [
      'Current government employment?',
      'Are you currently employed by the federal government?',
      'Do you currently work for the U.S. government?',
      'Are you currently a government employee?',
      SKYDIO_GLOSS,
    ];
    for (const label of labels.slice(0, -1)) {
      assert.equal(isGovernmentEmploymentQuestion(label), true, label);
    }
    assert.equal(isGovernmentEmploymentQuestion(SKYDIO_GLOSS), false);
    for (const label of labels) {
      const resolved = resolveKnownAnswer(label, 'checkbox', nasa, undefined);
      assert.ok(resolved && 'skipReason' in resolved, label);
    }
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        labels.map((question) => ({ question, answer: 'Yes' })),
        nasa,
        undefined,
      ),
      labels.map((question) => ({ question, answer: '' })),
    );
  });

  test('current government employment uses only the exact authoritative current employer', () => {
    const federal: ApplicationProfileLike = { current_employer: 'NASA' };
    const local: ApplicationProfileLike = { current_employer: 'City of Los Angeles' };
    const cases: [string, ApplicationProfileLike][] = [
      ['Current federal government employment?', federal],
      ['Are you currently employed by a U.S. government agency?', federal],
      ['Do you currently work for NASA?', federal],
      ['Are you currently a local government employee?', local],
      ['Are you currently an employee of local government?', local],
      ['Are you a current federal government employee?', federal],
      ['Are you a current employee of local government?', local],
    ];
    for (const [label, profile] of cases) {
      assert.equal(answer(label, profile), 'VALUE Yes', label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: '' }], profile, undefined),
        [{ question: label, answer: 'Yes' }],
      );
    }
    assert.equal(answer('Are you currently employed by local government?', federal), 'SKIP');
    assert.equal(answer('Are you currently employed by the federal government?', local), 'SKIP');
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        [{ question: 'Are you currently employed by local government?', answer: 'Yes' }],
        federal,
        undefined,
      ),
      [{ question: 'Are you currently employed by local government?', answer: '' }],
    );
  });

  test('past employee noun and federal government agency forms are exact positives', () => {
    const federal: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const labels = [
      'Were you a federal government employee?',
      'Have you ever been a U.S. government employee?',
      'Were you an employee of the federal government?',
      'Have you previously been an employee of a federal government agency?',
      'Have you worked for a federal government agency?',
      'Have you been employed by a United States federal government agency?',
    ];
    for (const label of labels) {
      assert.equal(answer(label, federal), 'VALUE Yes', label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: '' }], federal, undefined),
        [{ question: label, answer: 'Yes' }],
      );
    }
  });

  test('former employment holds without explicit end-date chronology', () => {
    const currentFederal: ApplicationProfileLike = {
      current_employer: 'NASA',
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const labels = [
      'Are you a former federal government employee?',
      'Are you a former employee of the federal government?',
      'Former government employment?',
      'Have you formerly worked for NASA?',
      'Are you a former NASA employee?',
      'Are you a former employee of FAA?',
      'Former NASA employee?',
      'Former employee of FAA?',
      'Former DOE employment?',
      'Did you formerly work for NASA?',
      'Were you formerly employed by FAA?',
      'Have you formerly been employed by DOE?',
      'Was NASA your former employer?',
      'Is FAA a former employer?',
      'Former employer: DOE?',
    ];
    for (const label of labels) {
      assert.equal(answer(label, currentFederal), 'SKIP', label);
      const resolved = resolveKnownAnswer(label, 'checkbox', currentFederal, undefined);
      assert.ok(resolved && 'skipReason' in resolved, label);
    }
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        labels.map((question) => ({ question, answer: 'Yes' })),
        currentFederal,
        undefined,
      ),
      labels.map((question) => ({ question, answer: '' })),
    );
  });

  test('every named noncurrent status holds across punctuation, aliases, and current-employer evidence', () => {
    const currentFederal: ApplicationProfileLike = {
      current_employer: 'NASA',
      experience_bank: [
        { type: 'job', org: 'NASA', title: 'Research Intern' },
        { type: 'job', org: 'FAA', title: 'Policy Intern' },
        { type: 'job', org: 'Department of Energy', title: 'Analyst' },
      ],
    };
    const labels = [
      'Are you an ex-NASA employee?',
      'Are you an ex employee of FAA?',
      'Ex-employee: U.S. Department of Energy?',
      'Past NASA employee?',
      'Past employee of Federal Aviation Administration?',
      'Past Department of Energy employment?',
      'Are you no longer a NASA employee?',
      'Are you no longer employed by FAA?',
      'Is United States Department of Energy no longer your employer?',
      'Did you formerly work for National Aeronautics and Space Administration?',
      'Was FAA your former-employer?',
    ];
    for (const label of labels) {
      assert.equal(answer(label, currentFederal), 'SKIP', label);
      const resolved = resolveKnownAnswer(label, 'checkbox', currentFederal, undefined);
      assert.ok(resolved && 'skipReason' in resolved, label);
      assert.match(resolved.skipReason, /no chronology proving that employment ended/, label);
    }
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        labels.map((question) => ({ question, answer: 'Yes' })),
        currentFederal,
        undefined,
      ),
      labels.map((question) => ({ question, answer: '' })),
    );
  });

  test('unsupported wording naming a registry employer refuses instead of preserving stale answers', () => {
    const nasa: ApplicationProfileLike = {
      current_employer: 'NASA',
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const labels = [
      'Did NASA once employ you?',
      'Was NASA your employer?',
      'Have you held a job at Federal Aviation Administration?',
    ];
    for (const label of labels) {
      assert.equal(isGovernmentEmploymentQuestion(label), false, label);
      const resolved = resolveKnownAnswer(label, 'checkbox', nasa, undefined);
      assert.ok(resolved && 'skipReason' in resolved, label);
    }
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        labels.map((question) => ({ question, answer: 'Yes' })),
        nasa,
        undefined,
      ),
      labels.map((question) => ({ question, answer: '' })),
    );
    assert.equal(isGovernmentEmploymentQuestion('Did GEICO once employ you?'), false);
  });

  test('NASA mentions route only when their sibling target has exact context evidence', () => {
    const profile: ApplicationProfileLike = {
      prior_application_employers: ['NASA'],
      referral_source_default: 'LinkedIn',
      relocation_willingness: 'yes',
    };
    const context = frozenJobEmployerContext('NASA');
    const cases = [
      ['Have you previously applied to work at NASA?', 'Yes', context],
      ['Have you previously applied to NASA?', 'Yes', context],
      ['How did you hear about NASA?', 'LinkedIn', context],
    ] as const;
    for (const [label, expected, questionContext] of cases) {
      const resolved = resolveKnownAnswer(label, 'text', profile, questionContext);
      assert.deepEqual(resolved, { value: expected }, label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'stale' }], profile, questionContext),
        [{ question: label, answer: expected }],
      );
    }
    for (const label of ['How did you hear about the NASA role?', 'Are you willing to relocate for the NASA role?']) {
      const held = resolveKnownAnswer(label, 'text', profile, context);
      assert.ok(held && 'skipReason' in held, label);
    }
    const unrelated = resolveKnownAnswer('Why are you interested in NASA?', 'text', profile, undefined);
    assert.ok(!unrelated || !('skipReason' in unrelated) || !/prior government employment/.test(unrelated.skipReason));
  });

  test('employment-history subjects do not route by embedded application, referral, or relocation keywords', () => {
    const nasa: ApplicationProfileLike = {
      prior_application_employers: ['NASA'],
      referral_source_default: 'LinkedIn',
      relocation_willingness: 'yes',
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const labels = [
      'Have you worked for NASA in application support?',
      'Were you employed by NASA on application systems?',
      'Have you worked for NASA on a referral program?',
      'Were you employed by NASA on referral systems?',
      'Have you worked for NASA on relocation software?',
      'Please describe your NASA service history.',
      'Please describe your NASA work history.',
      'What is your relationship to FAA?',
    ];
    for (const label of labels) {
      const resolved = resolveKnownAnswer(label, 'text', nasa, undefined);
      assert.ok(resolved && 'skipReason' in resolved, label);
      assert.match(resolved.skipReason, /prior government employment/, label);
    }
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        labels.map((question) => ({ question, answer: 'Yes' })),
        nasa,
        undefined,
      ),
      labels.map((question) => ({ question, answer: '' })),
    );
  });

  test('complete sibling questions route downstream while compound questions hold', () => {
    const profile: ApplicationProfileLike = {
      prior_application_employers: ['NASA'],
      referral_source_default: 'LinkedIn',
      relocation_willingness: 'yes',
      onsite_commitment: 'anywhere',
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const context = [
      frozenJobEmployerContext('NASA'),
      frozenJobRelocationLocationContext(['Boston, MA']),
    ].join('\n');
    const valid = [
      ['Did you previously apply to NASA?', 'Yes'],
      ['Did you ever apply to NASA?', 'Yes'],
      ['Did you apply to NASA before?', 'Yes'],
      ['Have you applied to NASA before?', 'Yes'],
      ['Have you applied to NASA in the past?', 'Yes'],
      ['Have you previously applied to NASA before?', 'Yes'],
      ['Have you ever applied for a role at NASA?', 'Yes'],
      ['Have you ever applied at NASA?', 'Yes'],
      ['Have you applied for NASA?', 'Yes'],
      ['Did you apply for NASA before?', 'Yes'],
      ['Did you apply at NASA before?', 'Yes'],
      ['Have you previously applied for any role at NASA?', 'Yes'],
      ['Where did you hear about NASA?', 'LinkedIn'],
      ['Where did you first hear about NASA?', 'LinkedIn'],
      ['How did you hear of NASA?', 'LinkedIn'],
      ['Where did you first learn about NASA?', 'LinkedIn'],
      ['How did you first learn of NASA?', 'LinkedIn'],
      ['How did you learn about NASA?', 'LinkedIn'],
      ['What is your referral source for NASA?', 'LinkedIn'],
      ['What was the referral source for NASA?', 'LinkedIn'],
      ['Would you be willing to relocate to Boston?', 'Yes'],
      ['Would you be open to relocating to Boston?', 'Yes'],
      ['Would you consider relocating to Boston?', 'Yes'],
      ['Are you comfortable relocating to Boston?', 'Yes'],
      ['Do you agree to relocate to Boston?', 'Yes'],
      ['Would you relocate to Boston?', 'Yes'],
      ['Would relocating to Boston be acceptable to you?', 'Yes'],
    ] as const;
    for (const [label, expected] of valid) {
      if (/appl(?:y|ied)/i.test(label)) assert.equal(isPriorApplicationQuestion(label), true, label);
      if (/hear|learn|referral/i.test(label)) assert.equal(classifyField(label), null, label);
      if (/relocat/i.test(label)) assert.equal(isRelocationQuestion(label), true, label);
      assert.deepEqual(resolveKnownAnswer(label, 'text', profile, context), { value: expected }, label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'stale' }], profile, context),
        [{ question: label, answer: expected }],
      );
    }

    const compound = [
      'How did you hear about NASA, and have you worked for NASA?',
      'How did you hear about NASA, and why do you want to work here?',
      'How did you hear about NASA, and who referred you?',
      'Did you ever apply to NASA and interview there?',
      'Where did you first hear about NASA and who referred you?',
      'What is your referral source for NASA and why did you choose it?',
      'Are you willing to relocate for NASA, and can you work onsite three days per week?',
      'Are you willing to relocate for NASA and work onsite three days per week?',
      'Are you willing to relocate for NASA and travel 25 percent?',
      'Are you willing to relocate for NASA and work weekends?',
      'Would you be willing to relocate for NASA and travel for work?',
      'Would you be open to relocating for NASA and work weekends?',
      'How did you hear of NASA and why are you interested?',
      'Where did you first learn about NASA and who told you?',
      'Would you consider relocating for NASA and work weekends?',
      'Are you comfortable relocating for NASA and traveling for work?',
      'Do you agree to relocate for NASA and work onsite?',
      'Would relocating for NASA and travel be acceptable to you?',
    ];
    for (const label of compound) {
      if (/appl(?:y|ied)/i.test(label)) assert.equal(isPriorApplicationQuestion(label), true, label);
      if (/hear|learn|referral/i.test(label)) assert.equal(classifyField(label), null, label);
      if (/relocat/i.test(label)) assert.equal(isRelocationQuestion(label), true, label);
      const resolved = resolveKnownAnswer(label, 'text', profile, context);
      assert.ok(resolved && 'skipReason' in resolved, label);
    }
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        compound.map((question) => ({ question, answer: 'Yes' })),
        profile,
        context,
      ),
      compound.map((question) => ({ question, answer: '' })),
    );
  });

  test('sibling targets consume exact packet evidence and reject every unparsed tail', () => {
    const profile: ApplicationProfileLike = {
      prior_application_employers: ['Acme'],
      referral_source_default: 'LinkedIn',
      relocation_willingness: 'yes',
    };
    const context = [
      frozenJobEmployerContext('Acme'),
      frozenJobRelocationLocationContext(['Boston, MA']),
    ].join('\n');
    const valid = [
      ['Have you applied to Acme?', 'Yes'],
      ['How did you hear about Acme?', 'LinkedIn'],
      ['Do you agree to relocate to Boston?', 'Yes'],
    ] as const;
    for (const [label, expected] of valid) {
      assert.deepEqual(resolveKnownAnswer(label, 'text', profile, context), { value: expected }, label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'stale' }], profile, context),
        [{ question: label, answer: expected }],
        label,
      );
    }

    const refused = [
      'Have you applied to Acme why did you leave',
      'Have you applied to Acme please explain why',
      'Did you ever apply for Acme describe the outcome',
      'How did you hear about Acme why do you want to work here',
      'Where did you learn about Acme who referred you',
      'What is your referral source for Acme explain your answer',
      'Would you relocate for Acme travel 50 percent',
      'Are you comfortable relocating for Acme work weekends',
      'Do you agree to relocate to Boston start immediately',
    ];
    for (const label of refused) {
      const held = resolveKnownAnswer(label, 'text', profile, context);
      assert.ok(held && 'skipReason' in held, label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'Yes' }], profile, context),
        [{ question: label, answer: '' }],
        label,
      );
    }

    for (const [label, wrongContext] of [
      ['How did you hear about Acme?', frozenJobEmployerContext('Other Corp')],
      ['Do you agree to relocate to Boston?', frozenJobRelocationLocationContext(['Chicago, IL'])],
    ] as const) {
      const held = resolveKnownAnswer(label, 'text', profile, wrongContext);
      assert.ok(held && 'skipReason' in held, label);
    }

    const shortNameLabel = 'Have you applied to Akuna before?';
    const akunaContext = frozenJobEmployerContext('Akuna Capital');
    for (const [declared, expected] of [
      [['Akuna Capital'], 'Yes'],
      [[], 'No'],
      [['Jane Street'], 'No'],
    ] as const) {
      const shortProfile: ApplicationProfileLike = { prior_application_employers: [...declared] };
      assert.deepEqual(
        resolveKnownAnswer(shortNameLabel, 'text', shortProfile, akunaContext),
        { value: expected },
      );
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: shortNameLabel, answer: 'stale' }], shortProfile, akunaContext),
        [{ question: shortNameLabel, answer: expected }],
      );
    }
  });

  test('sibling employer identity is packet-canonical after exact target validation', () => {
    const priorCases = [
      ['National Grid', 'Have you applied to National?', ['National Bank'], 'No'],
      ['Bank of America', 'Have you applied to Bank?', ['Bank of England'], 'No'],
      ['United Airlines', 'Have you applied to United?', ['United Parcel Service'], 'No'],
      ['Akuna Capital', 'Have you applied to Akuna?', ['Akuna Capital'], 'Yes'],
      ['Akuna Capital', 'Have you applied to Akuna?', ['Akuna Quant'], 'No'],
      ['NASA', 'Have you applied to National Aeronautics and Space Administration?', ['NASA'], 'Yes'],
      ['National Aeronautics and Space Administration', 'Have you applied to NASA?', ['National Aeronautics and Space Administration'], 'Yes'],
      ['U.S. Department of Energy', 'Have you applied to DOE?', ['Department of Energy'], 'Yes'],
      ['DOE', 'Have you applied to United States Department of Energy?', ['U.S. Department of Energy'], 'Yes'],
    ] as const;
    for (const [packetEmployer, label, declared, expected] of priorCases) {
      const profile: ApplicationProfileLike = { prior_application_employers: [...declared] };
      const context = frozenJobEmployerContext(packetEmployer);
      assert.deepEqual(resolveKnownAnswer(label, 'text', profile, context), { value: expected }, label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'stale' }], profile, context),
        [{ question: label, answer: expected }],
        label,
      );
    }

    const referralCases = [
      ['NASA', 'How did you hear about National Aeronautics and Space Administration?'],
      ['National Aeronautics and Space Administration', 'How did you hear about NASA?'],
      ['U.S. Department of Energy', 'What is your referral source for DOE?'],
      ['DOE', 'Where did you hear about United States Department of Energy?'],
    ] as const;
    for (const [packetEmployer, label] of referralCases) {
      const profile: ApplicationProfileLike = { referral_source_default: 'LinkedIn' };
      const context = frozenJobEmployerContext(packetEmployer);
      assert.deepEqual(resolveKnownAnswer(label, 'text', profile, context), { value: 'LinkedIn' }, label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'stale' }], profile, context),
        [{ question: label, answer: 'LinkedIn' }],
        label,
      );
    }
  });

  test('the exact measured IMC reminder is one complete prior-application question', () => {
    const label = 'Have you applied to this role or another role @IMC within the last 12-18 months? As a reminder, if you have already applied you will not be reconsidered.';
    const context = frozenJobEmployerContext('IMC');
    for (const [declared, expected] of [
      [['IMC'], 'Yes'],
      [[], 'No'],
    ] as const) {
      const profile: ApplicationProfileLike = { prior_application_employers: [...declared] };
      assert.deepEqual(resolveKnownAnswer(label, 'text', profile, context), { value: expected });
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'stale' }], profile, context),
        [{ question: label, answer: expected }],
      );
    }

    const unsupportedTail = `${label} Please explain why.`;
    const held = resolveKnownAnswer(
      unsupportedTail,
      'text',
      { prior_application_employers: ['IMC'] },
      context,
    );
    assert.ok(held && 'skipReason' in held);
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        [{ question: unsupportedTail, answer: 'Yes' }],
        { prior_application_employers: ['IMC'] },
        context,
      ),
      [{ question: unsupportedTail, answer: '' }],
    );
  });

  test('target-free sibling fields use the same complete parsers for answer and refresh', () => {
    const context = [
      frozenJobEmployerContext('Acme'),
      frozenJobRelocationLocationContext(['Boston, MA']),
    ].join('\n');
    const priorLabels = [
      'Have you applied here before?',
      'Have you previously applied to this company?',
      'Have you applied to us before?',
      'Have you applied to this employer before?',
      'Applied here before',
      'Previously applied to this company',
      'Applied to us before',
      'Applied to this employer before',
      'Have you applied before?',
      'Have you ever applied before?',
      'Applied before',
      'Ever applied before',
      'Previously applied',
      'Have you applied with us before?',
      'Have you applied for this company?',
      'Have you applied to this role before?',
      'Have you previously applied?',
      'Have you ever applied?',
      'Did you previously apply?',
      'Did you ever apply?',
      'Have you applied previously?',
      'Did you apply previously?',
      'Have you applied here?',
      'Did you apply here?',
      'Ever applied',
      'Applied here',
      'Have you applied here previously?',
      'Did you apply here before?',
      'Did you apply here previously?',
      'Have you applied to us previously?',
      'Did you apply to us before?',
      'Did you apply to us previously?',
      'Have you applied with us previously?',
      'Did you apply with us before?',
      'Did you apply with us previously?',
      'Have you applied for us before?',
      'Did you apply for us previously?',
      'Previous applicant',
    ];
    for (const label of priorLabels) {
      assert.equal(isPriorApplicationQuestion(label), true, label);
      for (const [declared, expected] of [
        [['Acme'], 'Yes'],
        [[], 'No'],
        [['Other Corp'], 'No'],
      ] as const) {
        const profile: ApplicationProfileLike = { prior_application_employers: [...declared] };
        assert.deepEqual(resolveKnownAnswer(label, 'text', profile, context), { value: expected }, label);
        assert.deepEqual(
          refreshKnownQuestionAnswers([{ question: label, answer: 'stale' }], profile, context),
          [{ question: label, answer: expected }],
          label,
        );
      }
      const unbound = resolveKnownAnswer(label, 'text', { prior_application_employers: ['Acme'] }, undefined);
      assert.ok(unbound && 'skipReason' in unbound, label);
      assert.deepEqual(
        refreshKnownQuestionAnswers(
          [{ question: label, answer: 'Yes' }],
          { prior_application_employers: ['Acme'] },
          undefined,
        ),
        [{ question: label, answer: '' }],
        label,
      );
    }

    const globalPriorLabels = [
      'Have you applied for any job before?',
      'Have you applied to an employer before?',
      'Have you applied for a company before?',
      'Have you submitted an application for any role?',
      'Have you submitted an application?',
      'Have you ever submitted an application?',
      'Have you previously submitted an application?',
      'Did you submit an application?',
      'Did you ever submit an application?',
      'Submitted an application',
      'Submitted an application before',
      'Have you submitted any applications?',
      'Did you ever submit any applications before?',
    ];
    for (const label of globalPriorLabels) {
      for (const [declared, expected] of [
        [['Other Corp'], 'Yes'],
        [[], 'No'],
      ] as const) {
        const profile: ApplicationProfileLike = { prior_application_employers: [...declared] };
        assert.deepEqual(resolveKnownAnswer(label, 'text', profile, context), { value: expected }, label);
        assert.deepEqual(
          refreshKnownQuestionAnswers([{ question: label, answer: 'stale' }], profile, context),
          [{ question: label, answer: expected }],
          label,
        );
      }
    }
    for (const declared of [['Other Corp'], []] as const) {
      for (const label of [
        'Did you apply for any internship previously?',
        'Have you applied for internships before?',
        'Have you applied for any internships before?',
        'Have you applied to any internships before?',
        'Did you apply for full-time positions previously?',
        'Have you applied for part time jobs before?',
        'Have you submitted an application for an internship?',
        'Have you submitted applications for internships?',
        'Did you submit application for any internships before?',
        'Have you applied for contract roles before?',
        'Have you applied for temporary jobs before?',
        'Have you applied for seasonal positions before?',
        'Have you applied for summer internships before?',
        'Did you apply for graduate roles previously?',
        'Have you applied for entry-level positions before?',
        'Have you applied for co-op programs before?',
        'Did you apply for cooperative opportunities previously?',
        'Have you applied for permanent jobs before?',
        'Have you submitted any applications for summer roles?',
        'Did you submit an application for a graduate program?',
        'Have you submitted applications for entry-level opportunities?',
        'Have you submitted an application for a co-op position?',
        'Did you submit any applications for cooperative programs?',
        'Have you submitted an application for a permanent role?',
        'Have you applied for an internship with NASA?',
      ]) {
        const profile: ApplicationProfileLike = { prior_application_employers: [...declared] };
        const held = resolveKnownAnswer(label, 'text', profile, context);
        assert.ok(held && 'skipReason' in held, label);
        assert.deepEqual(
          refreshKnownQuestionAnswers([{ question: label, answer: 'Yes' }], profile, context),
          [{ question: label, answer: '' }],
          label,
        );
      }
      for (const label of [
        'Submitted the application',
        'Submitted this application',
        'Submitted that application',
        'Submitted your applications',
        'Submitted current application',
        'Submitted the job application',
        'Have you submitted this online application?',
        'Did you submit those job applications?',
        'Submitted our current online application',
        'Have you submitted these applications?',
        'Submitted your updated internal online job application',
        'Did you submit those regional online applications?',
        'Have you submitted your regional application?',
        'Have you previously submitted the application?',
        'Have you already submitted the application?',
        'Did you successfully submit your completed online job application?',
        'Previously submitted our employment application to date',
        'Have you ever submitted this application earlier?',
        'Have you submitted your fully completed online employment application so far?',
        'Have you quietly submitted the regional employment application recently?',
        'Just submitted the completed job application form',
        'Did you finally submit those online application forms?',
        'Submitted the application before',
        'Have you submitted this online application previously?',
        'Did you submit those job applications already?',
        'Submitted our application yet',
        'Have you submitted the current application in the past?',
        'Did you submit your application ever?',
        'Did you submit the application before?',
        'Have you applied for this application before?',
        'Have you applied for fellowships before?',
        'Have you applied for a fellowship?',
        'Did you previously apply for apprenticeships?',
        'Did you apply for an apprenticeship?',
        'Have you applied for graduate schemes in the past?',
        'Have you applied for a graduate scheme?',
        'Have you ever applied for research residencies?',
        'Have you applied for graduate school?',
        'Have you applied for a co-op opportunity?',
        'Have you applied for a quantum fellowship previously?',
        'Have you applied for openings?',
        'Did you apply for a vacancy?',
        'Have you applied for graduate placements?',
        'Have you applied for rotational traineeships?',
        'Did you apply for externships?',
        'Have you applied to openings?',
        'Did you apply to a vacancy?',
        'Have you applied for any machine learning methods before?',
        'Did you previously apply for data science?',
        'Have you applied for algorithms in the past?',
        'Have you ever applied for research?',
        'Have you applied for framework techniques before?',
        'Have you applied for internship projects?',
        'Have you applied to this department before?',
        'Did you apply to another engineering team?',
        'Have you applied to any business unit?',
        'Have you applied to the trading division?',
        'Did you apply to our research group?',
        'Have you applied to a regional office?',
        'Have you applied to the product function?',
        'Did you apply to another machine learning practice?',
        'Have you applied to secure coding practices?',
        'Have you applied to a subsidiary?',
        'Have you applied to an affiliate before?',
        'Did you apply to another regional location?',
        'Have you applied to any branch previously?',
        'Have you applied to the overseas entity?',
        'Have you applied to the source code affiliate?',
        'Have you applied to the data science team?',
        'Did you apply to our research engineering group?',
        'Have you applied to the ML models division?',
      ]) {
        const profile: ApplicationProfileLike = { prior_application_employers: [...declared] };
        const held = resolveKnownAnswer(label, 'text', profile, context);
        assert.ok(held && 'skipReason' in held, label);
        assert.deepEqual(
          refreshKnownQuestionAnswers([{ question: label, answer: 'Yes' }], profile, context),
          [{ question: label, answer: '' }],
          label,
        );
      }
    }

    const referralLabels = [
      'Referral Source',
      'Your referral source',
      'Application source',
      'The application source',
      'Source of application',
      'Source of your application',
      'Referral',
      'How did you hear about this employer?',
      'Source',
      'Application referral',
      'How did you find us?',
      'How did you find out about us?',
      'How did you discover us?',
      'How did you become aware of this opportunity?',
      'How did you find this job?',
      'How did you come across this opportunity?',
      'Where did you find this job?',
      'Where did you discover this job?',
      'Where did you first find this job?',
      'How did you first discover this job?',
      'How did you first become aware of this job?',
      'Where did you first come across this opportunity?',
      'How did you become aware of this vacancy?',
      'Where did you come across this opening?',
      'How were you made aware of this job?',
    ];
    for (const label of referralLabels) {
      const profile: ApplicationProfileLike = { referral_source_default: 'LinkedIn' };
      const packetBound = /^(?:Referral|Source|Application referral|How did you (?:find(?: out about)?|discover) us\?)$/i.test(label)
        || /this employer/i.test(label);
      assert.equal(classifyField(label), packetBound ? null : 'referral_source_default', label);
      assert.deepEqual(resolveKnownAnswer(label, 'text', profile, context), { value: 'LinkedIn' }, label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'stale' }], profile, context),
        [{ question: label, answer: 'LinkedIn' }],
        label,
      );
      if (packetBound) {
        const unbound = resolveKnownAnswer(label, 'text', profile, undefined);
        assert.ok(unbound && 'skipReason' in unbound, label);
        assert.deepEqual(
          refreshKnownQuestionAnswers([{ question: label, answer: 'stale' }], profile, undefined),
          [{ question: label, answer: '' }],
          label,
        );
      }
    }

    const relocationLabels = [
      'Are you willing to move?',
      'Would you be willing to move?',
      'Willing to relocate',
      'Relocation willingness',
      'Open to relocation',
      'Willingness to relocate',
      'Willing to move',
      'Open to moving to Boston',
      'Are you open to relocation?',
      'Would you be open to relocation?',
      'Are you open to relocating to Boston?',
      'Would you be open to relocating to Boston?',
      'Are you open to moving to Boston?',
      'Would you be open to moving to Boston?',
      'Could you be open to moving to Boston?',
      'Could you be open to relocating to Boston?',
      'Can you be willing to move to Boston?',
      'Will you be open to moving to Boston?',
      'Would you be open to move to Boston?',
      'Open to move to Boston',
      'Will you move to Boston?',
      'Would you move?',
      'Would you move for this role?',
      'Would you consider moving?',
      'Would moving be possible?',
      'Open to mobility',
      'Would you consider a move?',
      'Are you open to a move?',
      'Are you willing to move if required?',
      'Would you be open to relocate if necessary?',
      'Could you be prepared to moving if needed?',
      'Will you be willing to move to Boston if required?',
    ];
    for (const label of relocationLabels) {
      const profile: ApplicationProfileLike = { relocation_willingness: 'yes' };
      assert.equal(isRelocationQuestion(label), true, label);
      assert.deepEqual(resolveKnownAnswer(label, 'text', profile, context), { value: 'Yes' }, label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'stale' }], profile, context),
        [{ question: label, answer: 'Yes' }],
        label,
      );
      if (/Boston/i.test(label)) {
        const wrongContext = frozenJobRelocationLocationContext(['Chicago, IL']);
        const held = resolveKnownAnswer(label, 'text', profile, wrongContext);
        assert.ok(held && 'skipReason' in held, label);
        assert.deepEqual(
          refreshKnownQuestionAnswers([{ question: label, answer: 'Yes' }], profile, wrongContext),
          [{ question: label, answer: '' }],
          label,
        );
      }
    }

    const ambiguousRelocation = [
      'Relocation',
      'Able to relocate',
      'Can you move to Boston?',
      'Are you able to relocate?',
      'Would you be able to relocate?',
      'Could you relocate?',
      'Are you able to relocate to Boston?',
      'Would you be able to relocate to Boston?',
      'Could you relocate to Boston?',
      'Are you able to move to Boston?',
      'Would you be able to move to Boston?',
      'Could you move to Boston?',
      'Could you be able to move to Boston?',
      'Could you be able to relocate to Boston?',
      'Able to move to Boston',
    ];
    for (const label of ambiguousRelocation) {
      const profile: ApplicationProfileLike = { relocation_willingness: 'yes' };
      assert.equal(isRelocationQuestion(label), true, label);
      const held = resolveKnownAnswer(label, 'text', profile, context);
      assert.ok(held && 'skipReason' in held, label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'Yes' }], profile, context),
        [{ question: label, answer: '' }],
        label,
      );
    }

    const compounds = [
      'Have you applied here before please explain why',
      'Have you previously applied to this company describe the outcome',
      'Referral Source explain your answer',
      'Source of application and who referred you',
      'Are you willing to move and work weekends',
      'Would you be willing to move travel 50 percent',
      'Willing to relocate start immediately',
      'Relocation willingness explain your answer',
      'Applied before describe the outcome',
      'Previously applied please explain why',
      'Referral who referred you',
      'How did you hear about this employer explain your answer',
      'Open to relocation and work weekends',
      'Willingness to relocate travel 50 percent',
      'Willing to move start immediately',
      'Able to relocate explain your answer',
      'Can you move to Boston work weekends',
      'Open to moving to Boston start immediately',
      'Have you ever applied describe the outcome',
      'Did you previously apply please explain why',
      'Applied here describe the outcome',
      'Source explain your answer',
      'Application referral who referred you',
      'How did you find us and why do you want to work here',
      'Are you open to moving to Boston work weekends',
      'Would you be able to move to Boston start immediately',
      'Could you relocate to Boston travel 50 percent',
      'Submitted an application please explain the outcome',
      'Previous applicant describe your prior application',
      'How did you find out about us and who referred you',
      'How did you discover us please explain',
      'Will you move to Boston and work weekends',
      'Relocation explain your answer',
    ];
    const profile: ApplicationProfileLike = {
      prior_application_employers: ['Acme'],
      referral_source_default: 'LinkedIn',
      relocation_willingness: 'yes',
    };
    for (const label of compounds) {
      const held = resolveKnownAnswer(label, 'text', profile, context);
      assert.ok(held && 'skipReason' in held, label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'stale' }], profile, context),
        [{ question: label, answer: '' }],
        label,
      );
    }

    const unrecognizedSiblingIntent = [
      'How were you referred to us?',
      'Who referred you and in what capacity?',
      'Would moving to Boston affect your availability?',
      'Please provide prior applicant information',
      'How did the recruiter refer you?',
      'Please provide your recruiting source',
      'Please specify the source of application',
      'Please confirm your ability to move to Boston',
      'Past applications',
      'Application history',
      'Any earlier applications?',
      'Any past applications',
      'Mobility willingness',
      'Geographic mobility',
      'Any former applications',
      'Relocation flexibility',
    ];
    for (const label of unrecognizedSiblingIntent) {
      const held = resolveKnownAnswer(label, 'text', profile, context);
      assert.ok(held && 'skipReason' in held, label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'stale' }], profile, context),
        [{ question: label, answer: '' }],
        label,
      );
    }
    for (const unrelated of [
      'Source code experience',
      'Relocation assistance benefit',
      'Application support systems experience',
      'Prior application support systems experience',
      'Experience building referral program systems',
      'Candidate source code experience',
      'Employee relocation assistance benefit',
      'Any earlier applications',
      'Previous applicant tracking system experience',
      'Past applications of machine learning',
      'Application history analytics experience',
      'Recruiting source analytics experience',
      'Source of application telemetry experience',
      'Referral marketing experience',
      'Geographic mobility research experience',
      'Mobility willingness modeling experience',
      'Relocating data services experience',
      'Do you have experience with previous application architecture?',
      'What is your referral marketing experience?',
      'Please describe your recruiting source analytics experience',
      'Do you have experience managing relocation logistics?',
      'What relocation research projects have you completed?',
      'Can you move files between systems?',
      'Prior application details',
      'Relocation preference details',
      'Applicant from a previous application',
      'Mobility details for relocating',
      'Have you previously applied machine learning methods?',
      'Did you apply ML practices before?',
      'Have you previously applied source code?',
      'Have you applied to the App Store?',
      'Have you applied to optimization problems?',
      'Have you applied to optimization problems already?',
      'Did you previously apply to data science techniques?',
      'Have you applied to statistical methods before?',
      'Did you apply to optimization algorithms?',
      'Have you applied to problems at scale?',
      'Did you apply to ML models in production?',
      'Have you applied to distributed systems at scale?',
      'Did you apply to algorithms in production?',
      'Did you apply to a testing framework?',
      'Have you applied to research projects?',
      'Have you applied to research projects previously?',
      'Did you apply to this coding task?',
      'Have you applied to distributed systems concepts?',
      'Did you apply to this technology?',
      'Have you applied to source code?',
      'Did you apply to the codebase?',
      'Have you applied to a vulnerability?',
      'Did you apply to this issue?',
      'Have you applied to a training dataset?',
      'Did you apply to data?',
      'Have you applied to forecasting models?',
      'Did you apply to operating systems?',
      'Have you applied to system architecture?',
      'Did you apply to research?',
      'Have you applied to schoolwork?',
      'Did you apply to coursework?',
      'Have you previously submitted an application for machine learning methods?',
      'Have you previously submitted an application for any project?',
      'Have you applied for this unusually long internal online job application architecture?',
      'Submitted the application architecture document',
      'Have you submitted this application source code review?',
      'Submitted our job application codebase review',
      'Have you already successfully submitted your current online application yet?',
      'Have you submitted the visa application?',
      'Did you already submit your immigration application?',
      'Have you previously submitted this permit application?',
      'Submitted the mobile application',
      'Have you submitted your software application?',
      'Did you submit the web application?',
      'Have you already submitted this app store application?',
      'Submitted your school application',
      'Have you submitted the university application?',
      'Did you submit the college application?',
      'Submitted your loan application',
      'Have you submitted the grant application?',
      'Did you submit the patent application?',
      'Have you submitted your benefits application?',
      'Have you not submitted the application?',
      'Did you never submit this job application?',
      'Have you submitted no application?',
      'Have you applied to a conference?',
      'Did you apply to the developer community?',
      'Did you apply to our local chapter?',
      'Did you apply full time-series methods previously?',
      'Have you submitted applications for seasonal forecasting projects?',
      'Have you submitted any applications for summer forecasting projects?',
      'Did you apply job scheduling algorithms previously?',
      'How did you find this project?',
      'Where did you discover this vulnerability?',
      'How did you become aware of this issue?',
      'Would you move projects?',
      'Would moving deadlines be possible?',
      'Open to moving data pipelines?',
      'Would you consider a move project?',
      'Are you open to a move project?',
    ]) {
      const resolved = resolveKnownAnswer(unrelated, 'text', profile, context);
      assert.equal(resolved, null, unrelated);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: unrelated, answer: 'stale' }], profile, context),
        [{ question: unrelated, answer: 'stale' }],
        unrelated,
      );
    }
    const workAuthorizationApplication = 'Successfully submitted the work authorization application';
    const workAuthorizationResolution = resolveKnownAnswer(workAuthorizationApplication, 'text', profile, context);
    assert.ok(workAuthorizationResolution && 'skipReason' in workAuthorizationResolution);
    assert.match(workAuthorizationResolution.skipReason, /work-eligibility question/);
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        [{ question: workAuthorizationApplication, answer: 'stale' }],
        profile,
        context,
      ),
      [{ question: workAuthorizationApplication, answer: '' }],
    );
  });

  test('unsupported named-employer history noun forms refuse and clear stale answers', () => {
    const nasa: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const labels = [
      'NASA employment history',
      'NASA employment record',
      'NASA career history',
      'Work experience at NASA',
      'Professional history with NASA',
      'Prior experience at NASA',
      'Professional experience with NASA',
      'NASA employment background',
      'NASA job history',
      'NASA occupational history',
      'Experience working at NASA',
      'Experience working with NASA',
      'Experience with NASA',
    ];
    for (const label of labels) {
      const resolved = resolveKnownAnswer(label, 'text', nasa, undefined);
      assert.ok(resolved && 'skipReason' in resolved, label);
      assert.match(resolved.skipReason, /prior government employment/, label);
    }
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        labels.map((question) => ({ question, answer: 'Yes' })),
        nasa,
        undefined,
      ),
      labels.map((question) => ({ question, answer: '' })),
    );
  });

  test('short aliases require exact uppercase spelling and never turn Jane Doe into DOE', () => {
    const federal: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'Department of Energy', title: 'Analyst' }],
    };
    assert.equal(answer('Have you worked for DOE?', federal), 'VALUE Yes');
    assert.deepEqual(
      refreshKnownQuestionAnswers([{ question: 'Have you worked for DOE?', answer: '' }], federal, undefined),
      [{ question: 'Have you worked for DOE?', answer: 'Yes' }],
    );
    assert.equal(answer('Have you worked for Doe?', federal), 'SKIP');
    const janeDoe = resolveKnownAnswer('Is Jane Doe your former manager?', 'checkbox', federal, undefined);
    assert.ok(!janeDoe || !('skipReason' in janeDoe) || !/prior government employment/.test(janeDoe.skipReason));
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        [{ question: 'Is Jane Doe your former manager?', answer: 'Yes' }],
        federal,
        undefined,
      ),
      [{ question: 'Is Jane Doe your former manager?', answer: 'Yes' }],
    );
  });

  test('governmental agency variants preserve broad and federal level binding', () => {
    const federal: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const local: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'City of Los Angeles', title: 'Analyst' }],
    };
    const broad = [
      'Have you worked for a governmental agency?',
      'Have you ever been employed by governmental agencies?',
    ];
    const federalOnly = [
      'Have you worked for a federal governmental agency?',
      'Have you been employed by a U.S. federal governmental agency?',
      'Have you worked for a United States governmental agency?',
    ];
    const localVariants = [
      'Have you worked for a local governmental agency?',
      'Have you worked for a municipal governmental agency?',
      'Have you worked for a county governmental agency?',
    ];
    const stateVariants = [
      'Have you worked for a state governmental agency?',
      'Have you been employed by state governmental agencies?',
    ];
    for (const label of broad) {
      assert.equal(answer(label, federal), 'VALUE Yes', label);
      assert.equal(answer(label, local), 'VALUE Yes', label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: '' }], federal, undefined),
        [{ question: label, answer: 'Yes' }],
      );
    }
    for (const label of federalOnly) {
      assert.equal(answer(label, federal), 'VALUE Yes', label);
      assert.equal(answer(label, local), 'SKIP', label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: '' }], federal, undefined),
        [{ question: label, answer: 'Yes' }],
      );
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'Yes' }], local, undefined),
        [{ question: label, answer: '' }],
      );
    }
    for (const label of localVariants) {
      assert.equal(answer(label, local), 'VALUE Yes', label);
      assert.equal(answer(label, federal), 'SKIP', label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: '' }], local, undefined),
        [{ question: label, answer: 'Yes' }],
      );
    }
    for (const label of stateVariants) {
      assert.equal(answer(label, local), 'SKIP', label);
      assert.equal(answer(label, federal), 'SKIP', label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: 'Yes' }], local, undefined),
        [{ question: label, answer: '' }],
      );
    }
  });

  test('the parser rejects material instructions anywhere outside the complete question', () => {
    const nasa: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const labels = [
      'Exclude internships: Have you worked for the U.S. government?',
      'Do not include internships. Have you worked for the U.S. government?',
      'Other than internships, have you worked for the U.S. government?',
      'Except internships, have you worked for the U.S. government?',
      'Have you worked for the U.S. government? Exclude internships.',
      'Have you worked for the U.S. government? Do not include internships.',
      'Have you worked for the U.S. government, other than internships?',
      'Have you worked for the U.S. government, except internships?',
    ];
    for (const label of labels) {
      assert.equal(isGovernmentEmploymentQuestion(label), false, label);
      const resolved = resolveKnownAnswer(label, 'checkbox', nasa, undefined);
      assert.ok(resolved && 'skipReason' in resolved, label);
    }
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        labels.map((question) => ({ question, answer: 'Yes' })),
        nasa,
        undefined,
      ),
      labels.map((question) => ({ question, answer: '' })),
    );
  });

  test('U.S. and local government agency grammars bind to the correct level', () => {
    const federal: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'NASA', title: 'Research Intern' }],
    };
    const local: ApplicationProfileLike = {
      experience_bank: [{ type: 'job', org: 'City of Los Angeles', title: 'Analyst' }],
    };
    const federalLabels = [
      'Have you worked for a U.S. government agency?',
      'Have you ever been employed by a US government agency?',
    ];
    const localLabels = [
      'Have you worked for a local government agency?',
      'Have you ever been employed by a local government agency?',
    ];
    for (const label of federalLabels) {
      assert.equal(answer(label, federal), 'VALUE Yes', label);
      assert.equal(answer(label, local), 'SKIP', label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: '' }], federal, undefined),
        [{ question: label, answer: 'Yes' }],
      );
    }
    for (const label of localLabels) {
      assert.equal(answer(label, local), 'VALUE Yes', label);
      assert.equal(answer(label, federal), 'SKIP', label);
      assert.deepEqual(
        refreshKnownQuestionAnswers([{ question: label, answer: '' }], local, undefined),
        [{ question: label, answer: 'Yes' }],
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
      'Prior non-federal government employment?',
      'Prior government employment other than federal?',
      'Prior government employment outside the federal government?',
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
