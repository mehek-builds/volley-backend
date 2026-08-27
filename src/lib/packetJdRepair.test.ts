/* THE PACKET FROZEN WITH AN APPLICATION FORM AS ITS JOB DESCRIPTION, AND THE REPAIR THAT IS ALLOWED
 * TO TOUCH IT.
 *
 * BELVEDERE_FORM_JD is shaped from packet c4413bff as it was read off the owner's dashboard API on
 * 2026-08-26: a Lever application page, 20,000 characters (exactly MAX_JD_TEXT_CHARS, so the stored
 * text is a TRUNCATED form), whose bulk is a `Name of School` dropdown of roughly three thousand
 * university names. The named schools - Auckland University of Technology, ACAP University College,
 * Japanese Red Cross - are the ones that surfaced in that packet's requirement-gap list, beside
 * `Nursing`, `British Columbia`, `LinkedIn URL` and `Loading`.
 *
 * WHAT IT IS AND IS NOT, because a reconstruction that overclaims is worse than none. The exact
 * stored text is not recoverable - it is in no fixture, and this run has no database access - so
 * this is a rebuild from the measurements, and it reproduces the properties this file depends on:
 * the truncation ceiling, the form chrome, the dropdown consuming the budget, and zero stated asks.
 * It does NOT reproduce the "1 of 12 requirements we counted" gap list. scoreJdMatch on THIS text,
 * on current main, extracts zero requirement terms rather than twelve junk ones. Either the real
 * page carried section structure this rebuild lacks, or the term extraction has moved since the
 * measurement - `Carry the scored sections out of extractJdTerms` and `sharpen every generic
 * posting key` both landed in that window. Which of the two it is cannot be settled from here, so
 * nothing in this file asserts anything about the gap list.
 *
 * No database and no network: every dependency the repair has is injected.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { leadAlignmentIssues, leadRequirementCandidates } from '../engine/leadAlignment';
import type { ResumeSpec } from '../llm/resumeSpec';
import { statesNoRequirement } from './jobDescriptionShape';
import type { NormalizedJob } from './jobMonitor';
import { monitoredDescriptionHash } from './monitoredPortalRepair';
import { jobDescriptionSourceUrl } from '../routes/jobExtract';
import {
  boardPostingFromPortalUrl,
  packetJdIsRepairable,
  REPAIRABLE_STATUSES,
  packetJdStatesNoRequirement,
  planPacketJdRepair,
  recordsAnUnverifiedPress,
  resolvePacketJdReplacement,
  type PacketJdRepairDeps,
} from './packetJdRepair';

// ─── fixtures ───────────────────────────────────────────────────────────────────────────────────

const MAX_JD_TEXT_CHARS = 20_000;

/* The dropdown that ate the description. Lever renders every option as visible text, so
   `extract: 'body'` pulls all of them; the real inventory is ~3,000 entries and the four named ones
   are the schools that reached the packet's gap list. */
function schoolDropdownOptions(): string[] {
  const named = [
    'Auckland University of Technology',
    'ACAP University College',
    'Japanese Red Cross College of Nursing',
    'University of British Columbia',
  ];
  const stems = ['State University', 'Institute of Technology', 'College', 'Polytechnic University', 'University'];
  const generated: string[] = [];
  for (let i = 0; generated.length < 3_000; i += 1) {
    generated.push(`${String.fromCharCode(65 + (i % 26))}${i} ${stems[i % stems.length]}`);
  }
  return [...named, ...generated];
}

/** The Belvedere page as it was stored: form chrome, then the dropdown, clipped at the ceiling. */
const BELVEDERE_FORM_JD = [
  'Software Engineer Intern - Summer 2027',
  'Belvedere Trading',
  'Chicago, IL',
  'SUBMIT YOUR APPLICATION',
  'Resume/CV',
  'Attach, Dropbox, Google Drive, or enter manually',
  'Full name ✱',
  'Email ✱',
  'Phone ✱',
  'Current company',
  'LinkedIn profile',
  'Loading...',
  'Authorize sharing your LinkedIn profile with this employer',
  'LinkedIn URL',
  'Additional information',
  'Name of School ✱',
  ...schoolDropdownOptions(),
  'Are you legally authorized to work in the United States? ✱',
  'Yes',
  'No',
  'Submit application',
].join('\n').slice(0, MAX_JD_TEXT_CHARS);

/** The posting Belvedere actually published, as Lever's own API returns it. */
const BELVEDERE_REAL_JD = [
  'What you will do:',
  'Build and maintain low-latency trading systems in C++ alongside our traders',
  'Own a bounded project end-to-end, from design through production release',
  'Partner with quantitative researchers to move models into production',
  'What we look for:',
  'Pursuing a bachelor degree in computer science or a related engineering field, graduating in 2028',
  'You have hands-on experience with C++ or Python in a systems context',
  'You use analytical skills to make data-driven decisions under time pressure',
].join('\n');

/* THE CASE THAT MUST NOT REGRESS. Most Greenhouse pages carry the description and the application
   form on ONE page, so a detector that keyed on "are form labels present" would flag nearly every
   healthy packet in the account. */
const POSTING_WITH_ITS_FORM_INLINE = `${BELVEDERE_REAL_JD}\n${[
  'Apply for this job',
  '* Required fields',
  'First Name *',
  'Last Name *',
  'Email *',
  'Resume/CV *',
  'LinkedIn Profile',
  'How did you hear about us? *',
  'Select an option',
  'Submit Application',
].join('\n')}`;

/* A spread of the healthy population, in the shapes the account actually holds: a bulleted
   Greenhouse posting, a run-together Lever posting with no line breaks at all, and a posting whose
   requirements are stated as prose under a heading. */
const HEALTHY_JDS: Record<string, string> = {
  greenhouse_bulleted: [
    'About the Role',
    'Deepgram is building speech AI. As a Software Engineering Intern you will ship production code.',
    'What you will do:',
    '- Build and ship features in our Python inference stack',
    '- Write tests and participate in code review with your mentor',
    'Requirements:',
    '- Currently pursuing a BS or MS in Computer Science, graduating in 2027 or 2028',
    '- Experience with Python and at least one systems language',
    '- You have built something end-to-end, not just coursework',
  ].join('\n'),
  /* The kos.ai posting exactly as engine/jdMatch.test.ts holds it - a real Lever description that
     arrives as ONE run-together line with no newlines at all. It is in the healthy set because that
     shape is the one most likely to be mistaken for a form, and it clears with 5 asks. */
  lever_run_together: "What you'll do: Build and ship a bounded project in one of: eval infrastructure, "
    + 'ERP integration stubs, internal ops dashboards, or the agent training pipeline Partner with the '
    + "founding team. They're your reviewer and your mentor. Learn how an AI-native product works under "
    + 'the hood. The agent loop, the eval harness, the production plumbing. Not the marketing version. '
    + 'Contribute to code reviews, design discussions, and the culture of the team You Current CS or ML '
    + "undergrad or Master's student with a hands-on project or internship track record Fluent in one of "
    + 'Python, TypeScript, or Go. You pick up whatever else the project needs. '
    + "You've played with LLMs, agents, or computer-use workflows. You've built something, not just read "
    + "about it. You're hungry to ship code into production, not complete a rotational checklist You'd "
    + 'rather ship one thing a customer touches than polish ten projects that live on a demo-day slide '
    + "You're comfortable working in-person at our SF office for the whole internship Comp and Benefits "
    + 'Relocation benefits Visa sponsorship for eligible candidates',
  prose_under_heading: [
    'Qualifications',
    'We are looking for someone pursuing a degree in computer science or mathematics who has written '
    + 'production Python and is comfortable reading somebody else\'s code.',
    'Responsibilities',
    'You will own the ingestion pipeline, work with the data team to define its contracts, and '
    + 'improve the deployment path for the whole service.',
  ].join('\n'),
};

const BELVEDERE_CONTEXT = { company: 'Belvedere Trading', role: 'Software Engineer Intern - Summer 2027' };

// ─── row builders ───────────────────────────────────────────────────────────────────────────────

type Review = Record<string, unknown>;

function review(overrides: Review = {}): Review {
  return {
    jd_text: BELVEDERE_FORM_JD,
    role: BELVEDERE_CONTEXT.role,
    /* THE STORED URL IS THE APPLY ROUTE, read off the live API. That is not incidental - it is why
       `extract: 'body'` returned a form, and it is what separates this row from the Jane Street one,
       whose stored portal_url is already a canonical Greenhouse board page. */
    portal_url: 'https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0/apply',
    status: 'resume_ready',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    ...overrides,
  };
}

function row(overrides: { review?: Review; job_context?: Record<string, unknown>; pipeline_stage?: string | null } = {}) {
  return {
    id: 'c4413bff-5a08-423f-852c-5d60bd360f3b',
    user_id: 'a18f774b-0000-4000-8000-000000000001',
    pipeline_stage: overrides.pipeline_stage ?? null,
    spec: {
      _review: review(overrides.review),
      _contact: { email: 'student@usc.edu', full_name: 'A Student' },
      experience: [],
    },
    job_context: {
      company: BELVEDERE_CONTEXT.company,
      role: BELVEDERE_CONTEXT.role,
      jd_hash: monitoredDescriptionHash(BELVEDERE_FORM_JD),
      ...overrides.job_context,
    },
  };
}

/* Nothing at the employer, no monitored job, an empty board and a page that renders to nothing.
   EVERY dependency is stubbed, including the browser: a test that left renderPage out would reach
   the real runManagedBrowser and pass only because Stratus is unconfigured in this environment,
   which is passing for the wrong reason. Individual tests widen what they need. */
const CLEAN_DEPS: PacketJdRepairDeps = {
  hasExtensionOutcome: async () => false,
  canonicalSubmission: async () => false,
  loadMonitoredJob: async () => null,
  fetchBoardPostings: async () => [],
  renderPage: async () => ({ title: '', url: '', text: '' }),
};

function leverPosting(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    external_id: '10746b3d-1760-4573-9b63-b93f5a5e4fc0',
    title: BELVEDERE_CONTEXT.role,
    description: BELVEDERE_REAL_JD,
    apply_url: 'https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0/apply',
    posting_url: 'https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0',
    remote: false,
    ...overrides,
  };
}

// ─── the fixture is the shape it claims to be ───────────────────────────────────────────────────

describe('the Belvedere fixture reproduces the measured row', () => {
  test('it is the truncation ceiling, not merely a page containing a form', () => {
    assert.equal(BELVEDERE_FORM_JD.length, MAX_JD_TEXT_CHARS);
  });

  test('the school dropdown is what consumed the budget', () => {
    // The form chrome ends where the inventory starts; everything after is options.
    assert.ok(BELVEDERE_FORM_JD.includes('Name of School'));
    assert.ok(BELVEDERE_FORM_JD.includes('Japanese Red Cross'));
    // Truncated before the form's own last control, which is what "hit the ceiling" means.
    assert.ok(!BELVEDERE_FORM_JD.includes('Submit application'));
  });
});

// ─── the detector ───────────────────────────────────────────────────────────────────────────────

describe('the detector finds the corrupted row and leaves the healthy ones alone', () => {
  test('Belvedere states no requirement at all', () => {
    assert.deepEqual(leadRequirementCandidates(BELVEDERE_FORM_JD, BELVEDERE_CONTEXT), []);
    assert.equal(packetJdStatesNoRequirement(row()), true);
  });

  test('the posting Belvedere actually published does state requirements', () => {
    assert.ok(leadRequirementCandidates(BELVEDERE_REAL_JD, BELVEDERE_CONTEXT).length > 0);
    assert.equal(packetJdStatesNoRequirement(row({ review: { jd_text: BELVEDERE_REAL_JD } })), false);
  });

  /* THE MUST-NOT-REGRESS CASE. A posting whose application form sits on the same page keeps every
     ask it had; the predicate asks whether an ask SURVIVES, not whether a form is present. */
  test('a real posting with its application form inline is not flagged', () => {
    assert.ok(
      leadRequirementCandidates(POSTING_WITH_ITS_FORM_INLINE, BELVEDERE_CONTEXT).length
        >= leadRequirementCandidates(BELVEDERE_REAL_JD, BELVEDERE_CONTEXT).length,
      'appending a form must not remove asks',
    );
    assert.equal(packetJdStatesNoRequirement(row({ review: { jd_text: POSTING_WITH_ITS_FORM_INLINE } })), false);
  });

  for (const [name, jd] of Object.entries(HEALTHY_JDS)) {
    test(`a healthy packet in the ${name} shape is not flagged`, () => {
      assert.equal(packetJdStatesNoRequirement(row({ review: { jd_text: jd } })), false);
    });
  }

  /* An empty frozen description is a DIFFERENT defect - there is nothing to compare a replacement
     against and `job_extract_empty` already refuses it at intake - so it must not be swept in here
     just because it also states no ask. */
  test('an empty frozen description is not this defect', () => {
    assert.equal(statesNoRequirement('   '), true, 'the raw predicate would say yes');
    assert.equal(packetJdStatesNoRequirement(row({ review: { jd_text: '   ' } })), false);
  });

  test('a row with no _review at all is not flagged', () => {
    assert.equal(packetJdStatesNoRequirement({ spec: { experience: [] } }), false);
    assert.equal(packetJdStatesNoRequirement({ spec: null }), false);
  });
});

// ─── the employer-held gate ─────────────────────────────────────────────────────────────────────

describe('a row an employer may already hold is never rewritten', () => {
  type GateReview = Parameters<typeof packetJdIsRepairable>[0];
  const base: GateReview = { status: 'resume_ready' };

  test('the clean shape is repairable, so every refusal below is about its own fact', () => {
    assert.equal(packetJdIsRepairable(base), true);
  });

  const refusals: Array<[string, Partial<GateReview>, string | null | undefined]> = [
    ['a submitted status', { status: 'submitted' }, null],
    ['an awaiting_security_code status', { status: 'awaiting_security_code' }, null],
    /* `needs_attention` was here, and it refused the only row this module exists for: Belvedere
       c4413bff sits in that status having provably never been sent. It moved to the suite below,
       where BOTH real needs_attention rows are asserted - the one that was never sent is
       repairable, and Jane Street, in the same status with two employer holds, is not. That is a
       stronger assertion than this row was making, not a weaker one: it pins that the refusal
       comes from the evidence rather than from the status label. */
    ['a ready_for_final_approval status', { status: 'ready_for_final_approval' }, null],
    ['a held submission claim', { submission_claimed_at: '2026-08-20T00:00:00.000Z' }, null],
    ['a recorded submitted_at', { submitted_at: '2026-08-20T00:00:00.000Z' }, null],
    ['a captured receipt', { receipt: { at: '2026-08-20T00:00:00.000Z' } as never }, null],
    ['a standing security code wall', { security_code: { at: '2026-08-20T00:00:00.000Z' } as never }, null],
    ['an unresolved unverified submission', { unverified_submission: { at: '2026-08-20T00:00:00.000Z' } as never }, null],
    ['a recorded submission attempt', { submission_attempted_at: '2026-08-20T00:00:00.000Z' }, null],
    [
      "the pre-extension runner's prose",
      { attention_reason: 'The final submission was attempted, but Litos could not verify the employer confirmation.' },
      null,
    ],
    [
      "the extension's prose",
      { attention_reason: 'Litos clicked submit but could not verify the employer confirmation' },
      null,
    ],
    ['a pipeline stage of applied', {}, 'applied'],
  ];

  for (const [name, patch, stage] of refusals) {
    test(`refused on ${name}`, () => {
      assert.equal(packetJdIsRepairable({ ...base, ...patch }, stage), false);
    });
  }

  /* HER LOOK IS THE RELEASE. A resolution of 'not_sent' neutralises the press she looked into, and
     the repair must honour that or the resolution route's promise is unfulfillable. */
  test('an unverified submission she looked at and found not sent stops being a hold', () => {
    assert.equal(
      packetJdIsRepairable({
        ...base,
        submission_attempted_at: '2026-08-20T00:00:00.000Z',
        unverified_submission: { at: '2026-08-20T00:00:00.000Z', resolution: 'not_sent' } as never,
      }),
      true,
    );
  });

  test('both unverified-press producers are recognised, and ordinary prose is not', () => {
    assert.equal(recordsAnUnverifiedPress('The final submission was attempted, but Litos could not verify the employer confirmation. Check your inbox.'), true);
    assert.equal(recordsAnUnverifiedPress('Litos clicked submit but could not verify the employer confirmation'), true);
    assert.equal(recordsAnUnverifiedPress('The run stopped before the submit control was found.'), false);
    assert.equal(recordsAnUnverifiedPress(undefined), false);
  });
});

describe('the two facts that live off the packet fail closed', () => {
  test('an extension outcome event stops the repair', async () => {
    assert.equal(
      await planPacketJdRepair(row(), { ...CLEAN_DEPS, hasExtensionOutcome: async () => true }),
      null,
    );
  });

  test('an extension-outcome lookup that throws stops the repair', async () => {
    assert.equal(
      await planPacketJdRepair(row(), {
        ...CLEAN_DEPS,
        hasExtensionOutcome: async () => { throw new Error('database unreachable'); },
        fetchBoardPostings: async () => [leverPosting()],
      }),
      null,
    );
  });

  /* The cheap refusals run FIRST, so a row nobody may touch never costs a board fetch on its
     behalf - and never tells a board that this posting is being looked at. */
  test('a row an employer may hold never reaches the network', async () => {
    let touched = 0;
    const planned = await planPacketJdRepair(
      row({ review: { submitted_at: '2026-08-20T00:00:00.000Z' } }),
      {
        ...CLEAN_DEPS,
        loadMonitoredJob: async () => { touched += 1; return null; },
        fetchBoardPostings: async () => { touched += 1; return [leverPosting()]; },
        renderPage: async (url) => { touched += 1; return { title: '', url, text: BELVEDERE_REAL_JD }; },
      },
    );
    assert.equal(planned, null);
    assert.equal(touched, 0, 'no lookup, no board fetch and no managed-browser run');
  });

  test('a healthy row never reaches the network either', async () => {
    let touched = 0;
    const planned = await planPacketJdRepair(
      row({ review: { jd_text: BELVEDERE_REAL_JD } }),
      {
        ...CLEAN_DEPS,
        loadMonitoredJob: async () => { touched += 1; return null; },
        fetchBoardPostings: async () => { touched += 1; return [leverPosting()]; },
        renderPage: async (url) => { touched += 1; return { title: '', url, text: BELVEDERE_REAL_JD }; },
      },
    );
    assert.equal(planned, null);
    assert.equal(touched, 0, 'no lookup, no board fetch and no managed-browser run');
  });

  test('the canonical ledger recording a submission stops the repair', async () => {
    assert.equal(
      await planPacketJdRepair(row(), { ...CLEAN_DEPS, canonicalSubmission: async () => true }),
      null,
    );
  });

  test('a ledger lookup that throws stops the repair', async () => {
    assert.equal(
      await planPacketJdRepair(row(), {
        ...CLEAN_DEPS,
        canonicalSubmission: async () => { throw new Error('database unreachable'); },
        fetchBoardPostings: async () => [leverPosting()],
      }),
      null,
    );
  });
});

// ─── where the replacement comes from ───────────────────────────────────────────────────────────

describe('the board and posting a portal URL names', () => {
  const cases: Array<[string, ReturnType<typeof boardPostingFromPortalUrl>]> = [
    ['https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0',
      { ats_name: 'lever', board_token: 'belvederetrading', external_id: '10746b3d-1760-4573-9b63-b93f5a5e4fc0' }],
    ['https://job-boards.greenhouse.io/akunacapital/jobs/8018893',
      { ats_name: 'greenhouse', board_token: 'akunacapital', external_id: '8018893' }],
    ['https://jobs.ashbyhq.com/quandela/2a5b0d90-1111-4222-8333-444455556666',
      { ats_name: 'ashby', board_token: 'quandela', external_id: '2a5b0d90-1111-4222-8333-444455556666' }],
    ['https://apply.workable.com/acme/j/ABCD1234/apply',
      { ats_name: 'workable', board_token: 'acme', external_id: 'ABCD1234' }],
  ];
  for (const [url, expected] of cases) {
    test(`reads ${url}`, () => assert.deepEqual(boardPostingFromPortalUrl(url), expected));
  }

  /* THE SHAPE THE MEASURED ROW ACTUALLY HAS. Belvedere's stored portal_url is the APPLY route, and
     the posting-id parsers read straight through the trailing segment - which is what lets the board
     API be asked without first deriving a description URL at all. */
  test('an apply route names the same posting as its overview', () => {
    assert.deepEqual(
      boardPostingFromPortalUrl('https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0/apply'),
      boardPostingFromPortalUrl('https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0'),
    );
    assert.deepEqual(
      boardPostingFromPortalUrl('https://apply.workable.com/acme/j/ABCD1234/apply'),
      boardPostingFromPortalUrl('https://apply.workable.com/acme/j/ABCD1234/'),
    );
  });

  /* AND THE ROUTE-LEVEL DERIVATION AGREES WITH IT. jobDescriptionSourceUrl now turns that apply
     route into Lever's own overview, so live intake stops creating this row shape; the two fixes
     meet on the same URL and must not disagree about which posting it is. */
  test('the intake derivation and the repair binding name the same posting', () => {
    const stored = 'https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0/apply';
    assert.equal(
      jobDescriptionSourceUrl(stored),
      'https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0',
    );
    assert.deepEqual(boardPostingFromPortalUrl(jobDescriptionSourceUrl(stored)), boardPostingFromPortalUrl(stored));
  });

  /* Every other provider genericKnownPosting can name returns null on purpose: there is no board
     endpoint in this codebase to ask one of them, and a repair must not start inventing scrapes. */
  test('a provider with no board endpoint here is refused rather than guessed at', () => {
    assert.equal(boardPostingFromPortalUrl('https://acme.wd1.myworkdayjobs.com/careers/job/Chicago/SWE_R-123'), null);
    assert.equal(boardPostingFromPortalUrl('https://jobs.smartrecruiters.com/acme/743999000000000'), null);
    assert.equal(boardPostingFromPortalUrl(undefined), null);
    assert.equal(boardPostingFromPortalUrl('not a url'), null);
  });
});

describe('a replacement is only taken from a source bound to this posting', () => {
  test('the monitored_jobs row job_id names is preferred, and needs no network', async () => {
    let fetched = 0;
    const replacement = await resolvePacketJdReplacement(
      row({ job_context: { job_id: '11111111-2222-4333-8444-555566667777' } }),
      {
        ...CLEAN_DEPS,
        loadMonitoredJob: async () => ({
          company: 'Belvedere Trading',
          title: BELVEDERE_CONTEXT.role,
          description: BELVEDERE_REAL_JD,
        }),
        fetchBoardPostings: async () => { fetched += 1; return []; },
      },
    );
    assert.equal(replacement?.source, 'monitored_job');
    assert.equal(replacement?.binding, 'job_id');
    assert.equal(replacement?.text, BELVEDERE_REAL_JD);
    assert.equal(fetched, 0, 'tier 1 must not reach the network');
  });

  test('a monitored job whose employer has drifted is not this posting', async () => {
    const replacement = await resolvePacketJdReplacement(
      row({ job_context: { job_id: '11111111-2222-4333-8444-555566667777' } }),
      {
        ...CLEAN_DEPS,
        loadMonitoredJob: async () => ({
          company: 'Jump Trading',
          title: BELVEDERE_CONTEXT.role,
          description: BELVEDERE_REAL_JD,
        }),
        fetchBoardPostings: async () => [],
      },
    );
    assert.equal(replacement, null);
  });

  test('a monitored job whose title has drifted is not this posting', async () => {
    const replacement = await resolvePacketJdReplacement(
      row({ job_context: { job_id: '11111111-2222-4333-8444-555566667777' } }),
      {
        ...CLEAN_DEPS,
        loadMonitoredJob: async () => ({
          company: 'Belvedere Trading',
          title: 'Quantitative Trading Intern',
          description: BELVEDERE_REAL_JD,
        }),
        fetchBoardPostings: async () => [],
      },
    );
    assert.equal(replacement, null);
  });

  test('the board API is the second tier, keyed on the posting id in the portal URL', async () => {
    const replacement = await resolvePacketJdReplacement(row(), {
      ...CLEAN_DEPS,
      loadMonitoredJob: async () => null,
      fetchBoardPostings: async (source) => {
        assert.deepEqual(source, { ats_name: 'lever', board_token: 'belvederetrading' });
        return [leverPosting({ external_id: 'some-other-posting' }), leverPosting()];
      },
    });
    assert.equal(replacement?.source, 'board_api');
    assert.equal(replacement?.binding, 'ats_posting');
    assert.equal(replacement?.text, BELVEDERE_REAL_JD);
  });

  /* Ashby and Lever both use UUIDs, and a URL and an API payload need not agree on their case. A
     case-sensitive comparison would silently refuse a posting that is right there on the board. */
  test('the posting id is matched without regard to case', async () => {
    const replacement = await resolvePacketJdReplacement(row(), {
      ...CLEAN_DEPS,
      loadMonitoredJob: async () => null,
      fetchBoardPostings: async () => [leverPosting({ external_id: '10746B3D-1760-4573-9B63-B93F5A5E4FC0' })],
    });
    assert.equal(replacement?.text, BELVEDERE_REAL_JD);
  });

  test('a board that no longer lists this posting is a refusal, not a nearest match', async () => {
    const replacement = await resolvePacketJdReplacement(row(), {
      ...CLEAN_DEPS,
      loadMonitoredJob: async () => null,
      fetchBoardPostings: async () => [leverPosting({ external_id: 'a-different-posting' })],
    });
    assert.equal(replacement, null);
  });

  test('a board fetch that throws is a refusal', async () => {
    const replacement = await resolvePacketJdReplacement(row(), {
      ...CLEAN_DEPS,
      loadMonitoredJob: async () => null,
      fetchBoardPostings: async () => { throw new Error('HTTP 429'); },
    });
    assert.equal(replacement, null);
  });

  /* THE ONE THAT MATTERS MOST: a repair must never swap a form for a second form, or for a board's
     empty stub. The replacement clears the poller's own ingest gate AND states an ask. */
  test('a replacement that states no ask is refused', async () => {
    /* A DIFFERENT form from the one already stored. Feeding the row's own text back was the first
       version of this test, and a mutation sweep showed it proved nothing: the identical-replacement
       guard refused it before the ask check was ever reached. */
    const otherForm = [
      'Apply for this job',
      '* Required fields',
      'Legal first name *', 'Legal last name *', 'Email confirmation *', 'Phone *',
      'How did you hear about us? *', 'Select an option', 'Submit Application',
      'Belvedere Trading is an Equal Opportunity Employer',
    ].join('\n');
    assert.notEqual(otherForm, BELVEDERE_FORM_JD);
    const replacement = await resolvePacketJdReplacement(row(), {
      ...CLEAN_DEPS,
      loadMonitoredJob: async () => null,
      fetchBoardPostings: async () => [leverPosting({ description: otherForm })],
    });
    assert.equal(replacement, null);
  });

  test('a replacement the poller itself would not have stored is refused', async () => {
    for (const description of ['Placeholder', 'Software Engineer Intern - Summer 2027', 'Apply within.']) {
      const replacement = await resolvePacketJdReplacement(row(), {
        ...CLEAN_DEPS,
        loadMonitoredJob: async () => null,
        fetchBoardPostings: async () => [leverPosting({ description })],
      });
      assert.equal(replacement, null, description);
    }
  });

  test('a posting that declares itself fake is refused even though it states asks', async () => {
    const replacement = await resolvePacketJdReplacement(row(), {
      ...CLEAN_DEPS,
      loadMonitoredJob: async () => null,
      fetchBoardPostings: async () => [leverPosting({
        description: `This is a fake job. Do not apply unless you are a Greenhouse employee.\n${BELVEDERE_REAL_JD}`,
      })],
    });
    assert.equal(replacement, null);
  });

  /* Bounded so a board that publishes a very long description cannot push the packet past what
     POST /resume/generate will accept when it is regenerated. */
  test('an over-long board description is clipped rather than refused', async () => {
    const long = `${BELVEDERE_REAL_JD}\n${'padding sentence about the team. '.repeat(4_000)}`;
    assert.ok(long.length > 60_000);
    const replacement = await resolvePacketJdReplacement(row(), {
      ...CLEAN_DEPS,
      loadMonitoredJob: async () => null,
      fetchBoardPostings: async () => [leverPosting({ description: long })],
    });
    assert.equal(replacement?.text.length, 60_000);
    assert.ok(replacement?.text.startsWith('What you will do:'));
  });

  /* ─── the last tier: render the description page the stored URL resolves to ─────────────────── */

  /* THE ASSERTION THIS WHOLE TIER EXISTS FOR. Belvedere's stored portal_url is the APPLY route, and
     rendering that is what produced the form in the first place. jobDescriptionSourceUrl must have
     turned it into Lever's overview before a single character is read. */
  test('re-extraction renders the derived overview, never the stored apply route', async () => {
    let rendered: string | undefined;
    const replacement = await resolvePacketJdReplacement(row(), {
      ...CLEAN_DEPS,
      renderPage: async (url) => {
        rendered = url;
        return { title: BELVEDERE_CONTEXT.role, url, text: BELVEDERE_REAL_JD };
      },
    });
    assert.equal(rendered, 'https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0');
    assert.doesNotMatch(rendered ?? '', /\/apply$/);
    assert.equal(replacement?.source, 'reextraction');
    assert.equal(replacement?.binding, 'portal_url');
    assert.equal(replacement?.text, BELVEDERE_REAL_JD);
  });

  /* The Jane Street shape: the stored URL is ALREADY a description page, so nothing is rewritten
     and the same tier reads it directly. */
  test('a stored URL that is already a description page is rendered untouched', async () => {
    let rendered: string | undefined;
    const stored = 'https://job-boards.greenhouse.io/janestreet/jobs/8018893';
    const replacement = await resolvePacketJdReplacement(row({ review: { portal_url: stored } }), {
      ...CLEAN_DEPS,
      renderPage: async (url) => {
        rendered = url;
        return { title: BELVEDERE_CONTEXT.role, url, text: BELVEDERE_REAL_JD };
      },
    });
    assert.equal(rendered, stored);
    assert.equal(replacement?.source, 'reextraction');
  });

  /* THE CHEAPER TIERS WIN. A render costs a managed-browser run and can be rate limited or bot
     walled; the board's own description field costs neither. */
  test('the board API is preferred, and no page is rendered when it answers', async () => {
    let renders = 0;
    const replacement = await resolvePacketJdReplacement(row(), {
      ...CLEAN_DEPS,
      fetchBoardPostings: async () => [leverPosting()],
      renderPage: async (url) => { renders += 1; return { title: '', url, text: BELVEDERE_REAL_JD }; },
    });
    assert.equal(replacement?.source, 'board_api');
    assert.equal(renders, 0);
  });

  /* A board that answers with something UNUSABLE must not block the last tier - otherwise a stub
     posting on the board would make an otherwise repairable row permanently unrepairable. */
  test('an unusable board answer falls through to re-extraction rather than ending the search', async () => {
    const replacement = await resolvePacketJdReplacement(row(), {
      ...CLEAN_DEPS,
      fetchBoardPostings: async () => [leverPosting({ description: 'Placeholder' })],
      renderPage: async (url) => ({ title: '', url, text: BELVEDERE_REAL_JD }),
    });
    assert.equal(replacement?.source, 'reextraction');
  });

  /* THE DEFECT MUST NOT COME BACK THROUGH THIS DOOR. Re-extraction is the same operation that broke
     the row, clip included, so a page that still truncates past its description states no ask and is
     refused - the same answer the deployed guard gives that page live. */
  test('a re-extracted page that is still a form is refused', async () => {
    const replacement = await resolvePacketJdReplacement(row({ review: { jd_text: 'What we look for:\nSomething real to say about the job.' } }), {
      ...CLEAN_DEPS,
      renderPage: async (url) => ({ title: '', url, text: BELVEDERE_FORM_JD }),
    });
    assert.equal(replacement, null);
  });

  test('re-extraction is clipped at the same cap the extraction route applies', async () => {
    const long = `${BELVEDERE_REAL_JD}\n${'padding sentence about the team. '.repeat(4_000)}`;
    const replacement = await resolvePacketJdReplacement(row(), {
      ...CLEAN_DEPS,
      renderPage: async (url) => ({ title: '', url, text: long }),
    });
    /* accept() trims again after this tier's own clip, so a cut landing on whitespace loses one
       more character. The claim is the BOUND, not an exact length. */
    assert.ok((replacement?.text.length ?? 0) <= 20_000, 'must not exceed MAX_JD_TEXT_CHARS');
    assert.ok((replacement?.text.length ?? 0) > 19_900, 'and must not be clipped harder than that');
  });

  test('a render that throws is a refusal, not an exception', async () => {
    const replacement = await resolvePacketJdReplacement(row(), {
      ...CLEAN_DEPS,
      renderPage: async () => { throw new Error('Stratus managed browser is not configured'); },
    });
    assert.equal(replacement, null);
  });

  test('a packet with no portal URL at all has nothing to render', async () => {
    let renders = 0;
    const replacement = await resolvePacketJdReplacement(row({ review: { portal_url: undefined } }), {
      ...CLEAN_DEPS,
      renderPage: async (url) => { renders += 1; return { title: '', url, text: BELVEDERE_REAL_JD }; },
    });
    assert.equal(replacement, null);
    assert.equal(renders, 0);
  });

  /* jobDescriptionSourceUrl throws on a string that is not a URL - it is written for a route that
     validated one first, and a stored packet carries no such guarantee. */
  test('an unparseable or non-https stored URL is refused rather than thrown', async () => {
    for (const portal_url of ['not a url', 'http://jobs.lever.co/acme/abc/apply', 'javascript:alert(1)']) {
      const replacement = await resolvePacketJdReplacement(row({ review: { portal_url } }), {
        ...CLEAN_DEPS,
        renderPage: async (url) => ({ title: '', url, text: BELVEDERE_REAL_JD }),
      });
      assert.equal(replacement, null, portal_url);
    }
  });

  test('a replacement identical to what is stored is not a repair', async () => {
    const healthy = row({ review: { jd_text: BELVEDERE_REAL_JD } });
    const replacement = await resolvePacketJdReplacement(healthy, {
      ...CLEAN_DEPS,
      loadMonitoredJob: async () => null,
      fetchBoardPostings: async () => [leverPosting()],
    });
    assert.equal(replacement, null);
  });
});

// ─── the plan ───────────────────────────────────────────────────────────────────────────────────

describe('the plan writes the description and its hash, and nothing else', () => {
  const deps: PacketJdRepairDeps = {
    ...CLEAN_DEPS,
    fetchBoardPostings: async () => [leverPosting()],
  };

  test('a healthy packet is left alone even when the board has a better copy', async () => {
    const healthy = row({ review: { jd_text: POSTING_WITH_ITS_FORM_INLINE } });
    assert.equal(await planPacketJdRepair(healthy, deps), null);
  });

  test('the corrupted packet gets the real description', async () => {
    const planned = await planPacketJdRepair(row(), deps);
    assert.ok(planned);
    assert.equal((planned.spec._review as Record<string, unknown>).jd_text, BELVEDERE_REAL_JD);
    assert.equal(planned.replacement.askCount, leadRequirementCandidates(BELVEDERE_REAL_JD, BELVEDERE_CONTEXT).length);
  });

  test('job_context.jd_hash moves with it, because generation computes it as sha256(jd_text)', async () => {
    const planned = await planPacketJdRepair(row(), deps);
    assert.ok(planned);
    assert.equal(planned.jobContext.jd_hash, monitoredDescriptionHash(BELVEDERE_REAL_JD));
    assert.notEqual(planned.jobContext.jd_hash, monitoredDescriptionHash(BELVEDERE_FORM_JD));
  });

  test('every other key of the spec, the review and the job context is carried through untouched', async () => {
    const before = row();
    const planned = await planPacketJdRepair(before, deps);
    assert.ok(planned);
    const { _review: nextReview, ...restSpec } = planned.spec;
    const { _review: priorReview, ...priorRest } = before.spec as Record<string, unknown>;
    assert.deepEqual(restSpec, priorRest, 'no spec key outside _review may move');
    /* `portal_supported` is the ONE other key that can appear, and it is not this repair writing a
       decision. readApplicationReview derives it at the choke point every reader already goes
       through, for packets stored before the field existed, and a planner built on that reader
       persists the derived value. The sibling repair in packetApplicantEmailBackfill.ts writes it
       back the same way. Named here rather than tolerated silently, because "nothing else moves" is
       the claim this test exists to make and it is not quite true. */
    const { jd_text: _next, portal_supported: derived, ...restReview } = nextReview as Record<string, unknown>;
    const { jd_text: _prior, ...priorReviewRest } = priorReview as Record<string, unknown>;
    assert.deepEqual(restReview, priorReviewRest, 'no _review key outside jd_text may move');
    assert.equal(derived, true, 'portal_supported is readApplicationReview\'s derivation, not a new decision');
    const { jd_hash: _nextHash, ...restContext } = planned.jobContext;
    const { jd_hash: _priorHash, ...priorContext } = before.job_context;
    assert.deepEqual(restContext, priorContext, 'no job_context key outside jd_hash may move');
  });

  test('the plan is pure: the row it was given is not mutated', async () => {
    const before = row();
    const snapshot = structuredClone(before);
    await planPacketJdRepair(before, deps);
    assert.deepEqual(before, snapshot);
  });
});

// ─── what a repair costs, asserted rather than promised ─────────────────────────────────────────

describe('the price of a repair is real and is stated in the header', () => {
  /* PACKET IDENTITY. jd_text is hashed into packetBindings.jdSha256 and packet_version is a hash
     over the bindings, so a stored acknowledgement for this packet goes stale. Asserted through
     monitoredDescriptionHash, which is the same one-way dependence, because packetVersion itself is
     private to lib/packetAudit.ts. */
  test('the frozen-description hash changes, which is what packet_version is built on', () => {
    assert.notEqual(
      monitoredDescriptionHash(BELVEDERE_FORM_JD),
      monitoredDescriptionHash(BELVEDERE_REAL_JD),
    );
  });

  /* THE PACKET BECOMES UNSENDABLE UNTIL IT IS REGENERATED, and the before/after below is the whole
     shape of the defect in two assertions.
     
     A packet generated against a form has NO lead_alignment: resumeSpec stores null rather than
     "fabricating a citation from boilerplate or form labels", and leadAlignmentIssues answers the
     empty array for "no alignment, and the posting states no ask" - it calls that unscoreable job
     fit rather than a defect. So the send gate saw nothing wrong. That silence is why a resume
     tailored to a school dropdown could be sent. */
  const REPAIRED_SPEC: ResumeSpec = {
    target_role: 'Software Engineer Intern',
    coursework: 'Distributed Systems',
    school: 'USC',
    degree: 'BS Computer Science',
    grad_date: '2028',
    education_position: 'top' as const,
    experience: [{
      type: 'job' as const,
      org: 'Northwind Labs',
      title: 'Software Engineer Intern',
      date_range: '2025',
      bullets: ['Built low-latency services in C++ for the trading desk'],
    }],
    skills: ['C++'],
  };

  test('before the repair the send gate has nothing to say, which is why this was silent', () => {
    assert.deepEqual(
      leadAlignmentIssues(REPAIRED_SPEC, BELVEDERE_FORM_JD, { context: BELVEDERE_CONTEXT }),
      [],
    );
  });

  test('after the repair the send gate withholds the packet until it is regenerated', () => {
    const issues = leadAlignmentIssues(REPAIRED_SPEC, BELVEDERE_REAL_JD, { context: BELVEDERE_CONTEXT });
    assert.deepEqual(issues, [
      'lead_alignment is missing: name the posting requirement the first experience entry proves',
    ]);
  });

  /* And a packet that WAS tailored against the form and does carry a citation is caught by the hash
     instead. Both arms end at withholdInvalidLeadAlignment, which parks the row at needs_attention
     with "Regenerate or edit it before sending." - a MODEL call, and both provider keys report
     `model_reason: "credit"` today. */
  test('a packet carrying a citation from the form is caught by the jd_hash instead', () => {
    const issues = leadAlignmentIssues(
      {
        ...REPAIRED_SPEC,
        lead_alignment: {
          entry_org: 'Northwind Labs',
          requirement: 'Name of School',
          evidence: 'Built low-latency services in C++ for the trading desk',
          jd_hash: monitoredDescriptionHash(BELVEDERE_FORM_JD),
        },
      },
      BELVEDERE_REAL_JD,
      { context: BELVEDERE_CONTEXT },
    );
    assert.ok(
      issues.some((issue) => /jd_hash does not match the frozen job description/.test(issue)),
      `expected a jd_hash mismatch, got ${JSON.stringify(issues)}`,
    );
  });
});

/* NEEDS_ATTENTION IS A REASON, NOT A DESTINATION.
 *
 * Excluding it by name refused the only row this module was written for. Measured 2026-08-27
 * against the deployed plan-only route: both candidates answered `planned: false`, and Belvedere
 * c4413bff was refused on status alone despite provably never having been sent.
 *
 * These two fixtures are the real shapes of the two rows, and they are the whole argument for the
 * change: the same status, opposite answers, decided by evidence rather than by the status. */
describe('needs_attention is decided by evidence, not by the status', () => {
  type GateReview = Parameters<typeof packetJdIsRepairable>[0];

  /* Belvedere c4413bff, verbatim: attention_reason says it was not sent, and every one of
     employerMayHoldApplication's four facts is absent. */
  const belvedere: GateReview = {
    status: 'needs_attention',
    attention_reason:
      'This application changed after you approved the exact packet Litos prepared, so it was not sent.'
      + ' What changed: the application questions, how Litos read them.',
  };

  /* Jane Street 496cff97, verbatim: the SAME status, and two independent holds. Its
     attention_reason is NOT either unverified-press producer's prose, which is exactly why the
     evidence fields have to carry this and the reason string cannot. */
  const janeStreet: GateReview = {
    status: 'needs_attention',
    submission_attempted_at: '2026-08-17T16:14:01.000Z',
    security_code: { requested_at: '2026-08-17T16:15:00.000Z' } as never,
    attention_reason:
      'Litos entered the employer verification step, but could not prove the final result.'
      + ' Check the employer portal before trying anything again.',
  };

  test('a needs_attention row that was never sent is repairable', () => {
    assert.equal(packetJdIsRepairable(belvedere), true);
  });

  test('the same status with an employer hold is still refused', () => {
    assert.equal(packetJdIsRepairable(janeStreet), false);
  });

  /* The load-bearing half. If this ever passes for the wrong reason - because someone re-narrowed
     the status set rather than because the evidence refused it - the next person to widen the set
     re-opens the hole. Assert the refusal survives with the status explicitly allowed. */
  test('the Jane Street refusal comes from its evidence, not from its status', () => {
    assert.ok(REPAIRABLE_STATUSES.has('needs_attention'), 'this test is vacuous unless the status is allowed');
    assert.equal(packetJdIsRepairable({ ...janeStreet, status: 'ready_to_submit' }), false);
    assert.equal(packetJdIsRepairable({ ...janeStreet, status: 'resume_ready' }), false);
  });

  test('each of its two holds refuses on its own', () => {
    const { security_code, submission_attempted_at, ...noHolds } = janeStreet;
    assert.equal(packetJdIsRepairable(noHolds), true, 'the fixture must be repairable once both holds are removed');
    assert.equal(packetJdIsRepairable({ ...noHolds, security_code }), false);
    assert.equal(packetJdIsRepairable({ ...noHolds, submission_attempted_at }), false);
  });
});
