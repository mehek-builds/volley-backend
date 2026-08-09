import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isGovernmentEmploymentQuestion,
  resolveKnownAnswer,
  type ApplicationProfileLike,
} from './questionDiscovery';

/* "Prior US Government Employment?" - Skydio, via Ashby, packet 13bccb2d.
 *
 * The last empty required field on the first packet that could reach a completed submission. It is
 * answerable, and the applicant's own canon says how: questions about her history are answered from
 * her record, and absence on that record is itself the answer.
 *
 * What these tests are actually for is the difference between that and a constant. "No" is the
 * right answer for this applicant today and would also be the output of `return { value: 'No' }`,
 * so a test that only asserts "No" proves nothing about which of the two shipped. Every case below
 * is therefore about the OTHER inputs: a bank with a government employer in it, a bank that is
 * empty, a bank that could not be read, and the neighbouring question families that must stay
 * refused. A hardcoded negative fails all of them.
 *
 * LABELS ARE VERBATIM where they exist. "prior us government employment?" is copied out of
 * spec._review on the production packet, lowercased the way discovery lowercases them.
 */

const BANK: ApplicationProfileLike['experience_bank'] = [
  { org: 'Cinematica Labs', title: 'Program Management Intern' },
  { org: 'Einstein Bros. Bagels (Mobile Ordering) – USC Assoc. of Innovative Marketing', title: 'Product Lead' },
  { org: 'SoFi', title: 'Product Management Intern' },
  { org: 'Spark SC', title: 'VP of Finance & Sponsorships' },
  { org: 'Tonee - AI Texting Tone Detector', title: 'Founder' },
  { org: 'Traeco - AI Agent Cost Infrastructure', title: 'AI Engineer' },
  { org: 'Venture Capital Academy', title: 'President' },
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
  test('the Skydio blocker is answered No from a bank with no government employer in it', () => {
    assert.equal(answer(SKYDIO, { experience_bank: BANK }), 'VALUE No');
  });

  test('the SAME bank plus one government employer answers Yes', () => {
    /* The property that separates a derivation from a constant, and the reason this file exists.
     * Nothing changes but one row. */
    const withGovernment = {
      experience_bank: [...(BANK ?? []), { org: 'U.S. Department of Energy', title: 'Policy Intern' }],
    };
    assert.equal(answer(SKYDIO, withGovernment), 'VALUE Yes');
  });

  test('a government employer is recognised across the shapes employers are actually named in', () => {
    for (const org of [
      'U.S. Department of Energy',
      'Government Accountability Office',
      'City of Los Angeles',
      'Office of Congressman Ted Lieu',
      'NASA Jet Propulsion Laboratory',
      'United States Senate',
      'Department of Justice',
    ]) {
      assert.equal(answer(SKYDIO, { experience_bank: [...(BANK ?? []), { org }] }), 'VALUE Yes', org);
    }
  });

  test('a government TITLE at a differently-named employer also flips it', () => {
    // "Congressional staffer" is one of the examples Skydio's own gloss lists, and the org it sits
    // under need not say "government" anywhere.
    const withTitle = { experience_bank: [...(BANK ?? []), { org: 'Ted Lieu for Congress', title: 'Congressional Staffer' }] };
    assert.equal(answer(SKYDIO, withTitle), 'VALUE Yes');
  });

  test('an organisation that MIGHT be public holds the question instead of answering it', () => {
    // Both measured in production banks on 2026-08-09. Neither is settleable from the name, and a
    // wrong "No" here is a false statement about federal service, so neither gets one.
    for (const org of ['World Bank', 'XYZ Public Charter Schools', 'National Institutes of Health']) {
      assert.equal(answer(SKYDIO, { experience_bank: [...(BANK ?? []), { org }] }), 'SKIP', org);
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
    assert.equal(answer(SKYDIO, { experience_bank: [{ org: '   ' }, { org: '' }] }), 'SKIP');
  });

  test('a stored military record holds the answer, in the one direction it can', () => {
    // Government service that a resume rarely lists, and a column that does not record whose armed
    // forces it was. It can unmake the No; it cannot make the Yes.
    const served = { experience_bank: BANK, military_service: 'Yes, I served in the US Army' };
    assert.equal(answer(SKYDIO, served), 'SKIP');
    const declined = { experience_bank: BANK, military_service: 'No' };
    assert.equal(answer(SKYDIO, declined), 'VALUE No');
    const notAVeteran = { experience_bank: BANK, military_service: 'I am not a protected veteran' };
    assert.equal(answer(SKYDIO, notAVeteran), 'VALUE No');
  });

  test('Skydio\'s gloss is answered from the bank, not from the EEO block', () => {
    /* Before this arm existed the bare word "military" inside the gloss put the whole question
     * through EEO_QUESTION, and an employment-history question came back
     * "Decline to self-identify". Verified against the real resolver on 2026-08-09. */
    assert.ok(isGovernmentEmploymentQuestion(SKYDIO_GLOSS));
    assert.equal(answer(SKYDIO_GLOSS, { experience_bank: BANK }), 'VALUE No');
    assert.equal(
      answer(SKYDIO_GLOSS, { experience_bank: [...(BANK ?? []), { org: 'Federal Aviation Administration' }] }),
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
      assert.equal(answer(label, { experience_bank: BANK }), 'VALUE No', label);
    }
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
    { org: 'SoFi' },
    { org: 'Cinematica Labs' },
    { org: 'Tonee - AI Texting Tone Detector' },
    { org: 'Traeco - AI Agent Cost Infrastructure' },
    { org: 'Spark SC' },
  ];
  // Exactly what the parse yielded in production. Traeco and Spark SC are missing from it.
  const PARSED_ONLY = ['Tonee - AI Texting Tone Detector', 'Cinematica Labs', 'SoFi'];

  test('an employer that is only in the bank answers Yes, not No', () => {
    const ap: ApplicationProfileLike = { employer_history: PARSED_ONLY, experience_bank: REAL_BANK };
    assert.equal(answer('have you ever worked for traeco?', ap), 'VALUE Yes');
    assert.equal(answer('have you ever worked for spark sc?', ap), 'VALUE Yes');
  });

  test('an employer in neither record still answers No', () => {
    // The negative is still available and still derived; this is the corpus label it is for.
    const ap: ApplicationProfileLike = { employer_history: PARSED_ONLY, experience_bank: REAL_BANK };
    assert.equal(answer('have you ever worked for redwood materials?', ap), 'VALUE No');
  });

  test('the widened match is a prefix, not a substring', () => {
    /* The reason the helper is anchored at the first token. A bank entry may carry a suffix the
     * form omits ("Traeco - AI Agent Cost Infrastructure" answering "Traeco"), but a name that
     * merely starts the same way is a different company and still answers No. */
    const ap: ApplicationProfileLike = { employer_history: PARSED_ONLY, experience_bank: REAL_BANK };
    assert.equal(answer('have you ever worked for sofia?', ap), 'VALUE No');
    assert.equal(answer('have you ever worked for traeco labs?', ap), 'VALUE No');
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
  });
});
